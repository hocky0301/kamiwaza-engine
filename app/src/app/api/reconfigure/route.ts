// POST /api/reconfigure — 「日本語で書いて直す」の自由文入力の解釈(SSE)。
// LIVE: Claudeのtool useで、閉じた6種のSpecDiff操作だけを発行させる
// (targetのenumに現行specの実IDを注入済み → 存在しない項目は指定できない)。
// APIキーなし/失敗時: キーワードフォールバックで定型差分に変換。
// なお提案チップはこのルートを通らず、クライアント側で直接applyDiffされる。

import Anthropic from "@anthropic-ai/sdk";
import type { AppSpec } from "@/lib/appspec";
import {
  applyDiffs,
  buildReconfigureTools,
  keywordFallback,
  toolCallToDiff,
  type ReconfigureEvent,
  type SpecDiff,
} from "@/lib/specdiff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ReconfigureRequest {
  spec: AppSpec;
  instruction: string;
}

const SYSTEM_PROMPT = `あなたは「カミワザ」の再構成エージェントです。ユーザーが生成済みの業務アプリに対して行った日本語の指示を、与えられたツールの呼び出しに変換してください。

ルール:
- ツールで表現できる変更だけを行う。ツール外の変更は提案しない
- 1つの指示に複数の変更が含まれる場合は、ツールを複数回呼ぶ(例:「承認を2段階にして単価に上限を」→ add_approval_step と set_number_limit)
- 金額の「万円」は円に換算する(1万円 = 10000)
- fieldIdは必ずツール定義のenumから選ぶ
- テキストでの説明は不要。ツール呼び出しのみ`;

function sseLine(ev: ReconfigureEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function specBrief(spec: AppSpec): string {
  const fields = spec.fields
    .map((f) => `- ${f.id}: ${f.label} (${f.type}${f.unit ? `, ${f.unit}` : ""})`)
    .join("\n");
  const cols =
    spec.lineItems?.columns
      .map((c) => `- ${c.id}: ${c.label} (明細列, ${c.type}${c.unit ? `, ${c.unit}` : ""})`)
      .join("\n") ?? "";
  const flow = (spec.approvalFlow ?? []).map((s) => `${s.name}(${s.role})`).join(" → ") || "なし";
  return `# 現在のアプリ「${spec.appName}」\n## 項目\n${fields}\n${cols}\n## 承認フロー\n${flow}\n## 一覧の列\n${spec.listColumns.join(", ")}`;
}

async function liveInterpret(spec: AppSpec, instruction: string): Promise<SpecDiff[]> {
  const client = new Anthropic();
  const tools = buildReconfigureTools(spec);

  const res = await client.messages.create(
    {
      model: "claude-opus-4-8",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      })),
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: `${specBrief(spec)}\n\n# ユーザーの指示\n${instruction}`,
        },
      ],
    },
    { timeout: 20_000, maxRetries: 1 },
  );

  const diffs: SpecDiff[] = [];
  for (const block of res.content) {
    if (block.type !== "tool_use") continue;
    const diff = toolCallToDiff(block.name, block.input as Record<string, unknown>);
    if (diff) diffs.push(diff);
  }
  return diffs;
}

export async function POST(req: Request) {
  const body: ReconfigureRequest | null = await req.json().catch(() => null);
  if (!body?.spec || typeof body.instruction !== "string" || !body.instruction.trim()) {
    return new Response(JSON.stringify({ error: "spec and instruction required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, instruction } = body;
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (ev: ReconfigureEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseLine(ev)));
        } catch {
          closed = true;
        }
      };

      const emitDiffs = (diffs: SpecDiff[]) => {
        const { results } = applyDiffs(spec, diffs);
        let applied = 0;
        results.forEach((r, i) => {
          if (r.ok) applied++;
          emit({ type: "patch", diff: diffs[i], ok: r.ok, reason: r.reason, summary: r.summary });
        });
        emit({ type: "rdone", applied });
      };

      try {
        let diffs: SpecDiff[] = [];
        if (hasKey) {
          emit({ type: "rphase", label: "指示を解釈しています…(ライブ)" });
          try {
            diffs = await liveInterpret(spec, instruction);
          } catch (err) {
            console.error("reconfigure live failed:", err);
            emit({ type: "rphase", label: "ライブ解釈に失敗 — キーワード解釈に切り替えます" });
            diffs = keywordFallback(spec, instruction);
          }
          if (diffs.length === 0) {
            diffs = keywordFallback(spec, instruction);
          }
        } else {
          emit({ type: "rphase", label: "指示を解釈しています…" });
          diffs = keywordFallback(spec, instruction);
        }

        if (diffs.length === 0) {
          emit({
            type: "rerror",
            message: "指示を操作に変換できませんでした。言い換えてもう一度お試しください",
          });
        } else {
          emitDiffs(diffs);
        }
      } catch (err) {
        emit({
          type: "rerror",
          message: err instanceof Error ? err.message : "再構成に失敗しました",
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
