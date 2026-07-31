// POST /api/analyze — 帳票解析ストリーム(SSE)。
// ANTHROPIC_API_KEY があり画像が送られてきた場合はライブ解析、
// それ以外はシナリオのデモリプレイ。イベント形式は完全に共通。

import { buildDemoSequence } from "@/lib/demo";
import { getScenario } from "@/lib/scenarios";
import { streamLiveAnalysis } from "@/lib/claude-live";
import { sseLine, type AnalyzeEvent } from "@/lib/events";
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
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const useLive = hasKey && !!body.image?.data;

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AnalyzeEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseLine(e)));
        } catch {
          closed = true;
        }
      };

      const runDemo = async (scenarioId: string) => {
        const scenario = getScenario(scenarioId);
        for (const { delay, event } of buildDemoSequence(scenario)) {
          if (closed) return;
          await sleep(delay);
          emit(event);
        }
      };

      try {
        if (useLive) {
          try {
            await streamLiveAnalysis(body.image!, emit);
          } catch (err) {
            // 本番ピッチの保険: ライブ解析が死んでもデモは止めない
            console.error("live analysis failed:", err);
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
