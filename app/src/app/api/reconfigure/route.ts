// POST /api/reconfigure — 「日本語で書いて直す」の自由文入力の解釈(SSE)。
// LIVE: Claudeのtool useで、閉じた6種のSpecDiff操作だけを発行させる
// (targetのenumに現行specの実IDを注入済み → 存在しない項目は指定できない)。
// APIキーなし/失敗時: キーワードフォールバックで定型差分に変換。
// なお提案チップはこのルートを通らず、クライアント側で直接applyDiffされる。

import type Anthropic from "@anthropic-ai/sdk";
import type { AppSpec } from "@/lib/appspec";
import type { LlmUsage, PricingSource } from "@/lib/events";
import { getLlmClient, hasLlmClient } from "@/lib/llm-client";
import { estimateCostUsd, getModelRates } from "@/lib/llm-pricing";
import { appendAudit, sha16 } from "@/lib/audit";
import { payloadTooLarge, readJsonLimited } from "@/lib/http";
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
- 変更指示として解釈できない入力(挨拶・感想・質問など)にはツールを呼ばず、短くその旨だけ返す
- 変更指示の場合、テキストでの説明は不要。ツール呼び出しのみ`;

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

async function liveInterpret(
  spec: AppSpec,
  instruction: string,
): Promise<{
  diffs: SpecDiff[];
  usage?: LlmUsage;
  costUsd?: number;
  pricingSource?: PricingSource;
}> {
  const llm = getLlmClient();
  if (!llm) return { diffs: [] };
  const tools = buildReconfigureTools(spec);

  const res = await llm.client.messages.create(
    {
      model: llm.model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      })),
      // auto: 変更意図がない入力ではツールを呼ばせない(diffs空→呼び出し元でフォールバック/エラー表示)
      tool_choice: { type: "auto" },
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
  // usage はプロキシ経路(OrcaRouter)では欠落しうるため防御的に読む。
  // ここで落とすと「解釈は成功したのに usage 取り出しで例外→キーワードフォールバック」
  // という live 破棄が起きるので、欠落時は undefined のまま返す(捏造しない)。
  const u = res.usage as Anthropic.Usage | null | undefined;
  const usage: LlmUsage | undefined = u
    ? {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      }
    : undefined;
  if (!usage) return { diffs, usage };
  // 推定原価は usage の実測があるときだけ計算する(捏造しない)。
  // getModelRates は絶対に throw しない(失敗時は定数$5/$25にフォールバック)
  const { rates, source } = await getModelRates(llm.model, llm.route);
  return { diffs, usage, costUsd: estimateCostUsd(usage, rates), pricingSource: source };
}

/**
 * ボディ上限。spec+instruction はどちらもそのままモデルへのプロンプトになるため、
 * ここが開いていると1リクエストで任意量のトークンを焼ける。
 * 実測の最大シナリオでも spec JSON は約3KB なので 256KB は80倍の余裕がある。
 */
const MAX_BODY_BYTES = 256 * 1024;
/** 自由文指示の上限。デモの指示は数十文字で、2000字は口頭指示として十分な余裕 */
const MAX_INSTRUCTION_CHARS = 2000;
/**
 * spec の形状上限。ボディ上限(256KB)だけでは守れない——specBrief は fields と
 * lineItems.columns を1件1行で展開してプロンプト本文にし、buildReconfigureTools は
 * field id から enum を組むため、**項目数に比例してトークンが線形に伸びる**。
 * 256KB の JSON は数千項目を許してしまう。実測の最大シナリオは fields 13・columns 6。
 * 会場では LAN 越しに iPad から叩く構成(認証なし)のため、形状側にも天井を置く。
 */
const MAX_SPEC_FIELDS = 80;
const MAX_SPEC_COLUMNS = 40;
const MAX_LABEL_CHARS = 120;

export async function POST(req: Request) {
  const parsed = await readJsonLimited<ReconfigureRequest>(req, MAX_BODY_BYTES);
  if (!parsed.ok && parsed.reason === "too-large") return payloadTooLarge();
  const body: ReconfigureRequest | null = parsed.ok ? parsed.body : null;
  if (
    !body?.spec ||
    typeof body.instruction !== "string" ||
    !body.instruction.trim() ||
    body.instruction.length > MAX_INSTRUCTION_CHARS
  ) {
    return new Response(JSON.stringify({ error: "spec and instruction required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, instruction } = body;
  // 形状ゲート: 項目数・ラベル長がプロンプト長を線形に押し上げるため、ここで止める
  const fieldCount = Array.isArray(spec.fields) ? spec.fields.length : 0;
  const columnCount = Array.isArray(spec.lineItems?.columns) ? spec.lineItems.columns.length : 0;
  const tooLongLabel =
    (Array.isArray(spec.fields) &&
      spec.fields.some((f) => typeof f?.label === "string" && f.label.length > MAX_LABEL_CHARS)) ||
    (Array.isArray(spec.lineItems?.columns) &&
      spec.lineItems.columns.some(
        (c) => typeof c?.label === "string" && c.label.length > MAX_LABEL_CHARS,
      ));
  if (fieldCount > MAX_SPEC_FIELDS || columnCount > MAX_SPEC_COLUMNS || tooLongLabel) {
    return new Response(
      JSON.stringify({
        error: `spec too large (fields<=${MAX_SPEC_FIELDS}, columns<=${MAX_SPEC_COLUMNS}, label<=${MAX_LABEL_CHARS}chars)`,
      }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }
  const hasKey = hasLlmClient();

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

      const emitDiffs = (
        diffs: SpecDiff[],
        usage?: LlmUsage,
        costUsd?: number,
        pricingSource?: PricingSource,
      ) => {
        const { results } = applyDiffs(spec, diffs);
        let applied = 0;
        results.forEach((r, i) => {
          if (r.ok) applied++;
          emit({ type: "patch", diff: diffs[i], ok: r.ok, reason: r.reason, summary: r.summary });
        });
        emit({ type: "rdone", applied, usage, costUsd, pricingSource });
        // 監査ログ: 「日本語で書いて直す」=人間がモデル出力を作り替えた記録(操作種別とfieldIdのみ)
        void appendAudit({
          ts: new Date().toISOString(),
          event: "reconfigure",
          spec_hash_before: sha16(JSON.stringify(spec)),
          diff_applied: diffs.map((d, i) => ({
            op: d.op,
            fieldId:
              "fieldId" in d && typeof (d as { fieldId?: unknown }).fieldId === "string"
                ? (d as { fieldId: string }).fieldId
                : undefined,
            ok: results[i]?.ok ?? false,
          })),
          tokens: usage
            ? {
                in: usage.inputTokens,
                out: usage.outputTokens,
                cacheRead: usage.cacheReadInputTokens,
                cacheCreation: usage.cacheCreationInputTokens,
              }
            : undefined,
          cost_usd: costUsd,
        });
      };

      try {
        let diffs: SpecDiff[] = [];
        let usage: LlmUsage | undefined;
        let costUsd: number | undefined;
        let pricingSource: PricingSource | undefined;
        if (hasKey) {
          emit({ type: "rphase", label: "指示を解釈しています…(ライブ)" });
          try {
            ({ diffs, usage, costUsd, pricingSource } = await liveInterpret(spec, instruction));
          } catch (err) {
            console.error("reconfigure live failed:", err);
            emit({ type: "rphase", label: "ライブ解釈に失敗 — キーワード解釈に切り替えます" });
            diffs = keywordFallback(spec, instruction);
          }
          if (diffs.length === 0) {
            // usage(と推定原価)はライブ呼び出しの実測値なので、フォールバックしても保持する
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
          emitDiffs(diffs, usage, costUsd, pricingSource);
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
