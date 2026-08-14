// POST /api/analyze — 帳票解析ストリーム(SSE)。
// LLMキー(ORCAROUTER_API_KEY / ANTHROPIC_API_KEY)があり画像が送られてきた場合はライブ解析、
// それ以外はシナリオのデモリプレイ。イベント形式は完全に共通。

import { buildDemoSequence } from "@/lib/demo";
import { getScenario } from "@/lib/scenarios";
import { streamLiveAnalysis, type LiveUsageSink } from "@/lib/claude-live";
import { withAbortedLiveCost } from "@/lib/events";
import { appendAudit, sha16 } from "@/lib/audit";
import { sseLine, type AnalyzeEvent } from "@/lib/events";
import { hasLlmClient } from "@/lib/llm-client";
import { payloadTooLarge, readJsonLimited } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AnalyzeRequest {
  scenarioId?: string;
  image?: { data: string; mediaType: string };
}

/**
 * ボディ上限。クライアントは長辺1600pxのJPEG(q0.85)に縮小して送るため
 * 実際のライブ解析ペイロードは概ね1MB前後、Anthropic APIの画像上限も5MB。
 * 12MB は十分な余裕を残しつつ、未認証POSTでメモリを焼く経路を閉じる値。
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** base64画像の上限(APIの5MB制限に対しても余裕を持たせた値) */
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const parsed = await readJsonLimited<AnalyzeRequest>(req, MAX_BODY_BYTES);
  if (!parsed.ok && parsed.reason === "too-large") return payloadTooLarge();
  // 不正JSONは従来どおりデモへフォールバックする(挙動を変えない)
  const body: AnalyzeRequest = parsed.ok ? (parsed.body ?? {}) : {};
  if (body.image && (body.image.data?.length ?? 0) > MAX_IMAGE_BASE64) {
    return payloadTooLarge();
  }
  const useLive = hasLlmClient() && !!body.image?.data;

  const startedAt = Date.now();
  const inputHash = body.image?.data ? sha16(body.image.data) : undefined;
  let fallbackReason: string | undefined;
  let lastValidation: { ok: boolean; violations: number } | undefined;
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AnalyzeEvent) => {
        if (closed) return;
        if (e.type === "done") {
          // 監査ログ(1解析=1行・画像はハッシュのみ)。awaitしない=主機能に劣後
          void appendAudit({
            ts: new Date().toISOString(),
            event: "analyze",
            mode: e.mode,
            input_hash: inputHash,
            spec_hash: sha16(JSON.stringify(e.spec)),
            route: e.llmRoute,
            tokens: e.usage
              ? {
                  in: e.usage.inputTokens,
                  out: e.usage.outputTokens,
                  cacheRead: e.usage.cacheReadInputTokens,
                  cacheCreation: e.usage.cacheCreationInputTokens,
                }
              : undefined,
            cost_usd: e.costUsd,
            duration_ms: Date.now() - startedAt,
            validation: lastValidation,
            fallback_reason: fallbackReason,
            aborted_live_cost_usd: e.abortedLiveCostUsd,
          });
        }
        if (e.type === "validation") lastValidation = { ok: e.ok, violations: e.violations };
        try {
          controller.enqueue(encoder.encode(sseLine(e)));
        } catch {
          closed = true;
        }
      };

      // ライブ失敗時に「消費済みトークン」を持ち越す受け皿。
      // これが非ゼロのままデモへ落ちた場合、原価$0と表示すると誤認になる。
      const sink: LiveUsageSink = {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        route: null,
        costUsd: null,
      };

      const runDemo = async (scenarioId: string) => {
        const scenario = getScenario(scenarioId);
        for (const { delay, event } of buildDemoSequence(scenario)) {
          if (closed) return;
          await sleep(delay);
          // done にライブ失敗分の実消費を載せて、画面が$0と言い切らないようにする
          emit(withAbortedLiveCost(event, sink));
        }
      };

      try {
        if (useLive) {
          try {
            await streamLiveAnalysis(body.image!, emit, sink);
          } catch (err) {
            // 本番ピッチの保険: ライブ解析が死んでもデモは止めない
            console.error("live analysis failed:", err);
            fallbackReason = err instanceof Error ? err.message.slice(0, 200) : "unknown";
            emit({
              type: "phase",
              label: "ライブ解析に失敗したため、デモデータで続行します",
            });
            await runDemo(body.scenarioId ?? "chumonsho");
          }
        } else {
          await runDemo(body.scenarioId ?? "chumonsho");
        }
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "解析に失敗しました",
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
