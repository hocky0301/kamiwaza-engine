// LLM原価の推定単価モジュール(サーバー専用)。
// OrcaRouter /v1/models の pricing フィールドから実単価を取得し、
// トークン実測(LlmUsage)×公表単価で「推定原価」を計算する。
//
// 誠実性の設計:
//   - 課金の正はプロバイダのダッシュボード。ここで出すのはあくまで
//     「トークン実測×公表単価の推定」であり、UIもそう自称する(突合で正当性を示す)
//   - キャッシュトークンの課金単価はAPIに載らないため、保守的上限で計上する:
//     cache_read も prompt 単価(実際は約0.1×)→ 実際より高い見積り
//     = 安く見せる嘘を構造的に防ぐ
//   - cache_creation は OrcaRouter 経由では常時0報告のため実質計上不能。
//     式には含める(直接Anthropic経路の保険)が、表示側で注記する
//   - 取得失敗・ID不一致・Anthropic直接経路(/v1/modelsにpricingなし)は
//     定数 FALLBACK_RATES($5/$25)へフォールバックし、絶対に throw しない
//     (原価表示の失敗で解析ストリームを殺さない)

import type { LlmUsage, PricingSource } from "./events";
import type { LlmRoute } from "./llm-client";
import { ORCAROUTER_BASE_URL } from "./llm-client";

/** 100万トークンあたりのUSD単価 */
export interface ModelRates {
  promptUsdPerMTok: number;
  completionUsdPerMTok: number;
}

/**
 * claude-opus-4.8 の公表単価。OrcaRouter実測(2026-08-08)の
 * pricing = {prompt_per_million:"5.000000", completion_per_million:"25.000000"} と
 * Anthropic公表 $5/$25 per MTok に一致。
 */
export const FALLBACK_RATES: ModelRates = {
  promptUsdPerMTok: 5,
  completionUsdPerMTok: 25,
};

export const PRICING_TTL_MS = 10 * 60_000;
/** 取得失敗のネガティブキャッシュ。回線断のブースで解析のたびに3秒待たないため */
const NEGATIVE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

interface PricingCache {
  at: number;
  /** 空Map = 取得失敗(ネガティブキャッシュ)。TTLはat+NEGATIVE_TTL_MSで判定 */
  byId: Map<string, ModelRates>;
  ok: boolean;
}

let cache: PricingCache | null = null;
/** 同時多発リクエストの重複fetch防止(warmと本取得の合流) */
let inflight: Promise<Map<string, ModelRates> | null> | null = null;

export function _resetPricingCacheForTest(): void {
  cache = null;
  inflight = null;
}

function parseRate(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function fetchOrcaPricing(): Promise<Map<string, ModelRates> | null> {
  try {
    const res = await fetch(`${ORCAROUTER_BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${process.env.ORCAROUTER_API_KEY ?? ""}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        id?: string;
        pricing?: { prompt_per_million?: unknown; completion_per_million?: unknown };
      }[];
    };
    if (!Array.isArray(json.data)) return null;
    const byId = new Map<string, ModelRates>();
    for (const m of json.data) {
      if (typeof m?.id !== "string") continue;
      // 単価は文字列(例: "5.000000")。NaN・負値・欠落はミス扱いで登録しない
      const prompt = parseRate(m.pricing?.prompt_per_million);
      const completion = parseRate(m.pricing?.completion_per_million);
      if (prompt === null || completion === null) continue;
      byId.set(m.id, { promptUsdPerMTok: prompt, completionUsdPerMTok: completion });
    }
    return byId;
  } catch {
    return null;
  }
}

/** キャッシュ有効なら返す。無効ならfetch(同時実行は合流)してキャッシュを更新する */
async function getPricingMap(): Promise<Map<string, ModelRates> | null> {
  const now = Date.now();
  if (cache) {
    const ttl = cache.ok ? PRICING_TTL_MS : NEGATIVE_TTL_MS;
    if (now - cache.at < ttl) return cache.ok ? cache.byId : null;
  }
  if (!inflight) {
    inflight = fetchOrcaPricing()
      .then((byId) => {
        cache = { at: Date.now(), byId: byId ?? new Map(), ok: byId !== null };
        return byId;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * モデルの単価を返す。orcarouter経路のみ /v1/models を参照し、
 * anthropic直接経路(pricingフィールドなし)・取得失敗・ID不一致は
 * FALLBACK_RATES($5/$25)にフォールバックする。絶対に throw しない。
 */
export async function getModelRates(
  orcaModelId: string,
  route: LlmRoute,
): Promise<{ rates: ModelRates; source: PricingSource }> {
  if (route !== "orcarouter") {
    return { rates: FALLBACK_RATES, source: "fallback" };
  }
  try {
    const map = await getPricingMap();
    const rates = map?.get(orcaModelId);
    if (rates) return { rates, source: "live" };
  } catch {
    // getPricingMap は throw しない設計だが、二重に防御する
  }
  return { rates: FALLBACK_RATES, source: "fallback" };
}

/**
 * 保守的上限の原価推定(USD・純関数)。
 *
 *   costUsd = (input + cacheRead + cacheCreation) × prompt/1e6 + output × completion/1e6
 *
 * Anthropicのusage語義では input_tokens はキャッシュ分を含まない
 * (合計プロンプト = input + cacheCreation + cacheRead)ため、
 * cacheRead を prompt 単価(実際は約0.1×)で足す=実際より高い見積り。
 * cacheCreation の実単価は1.25×だが1×で計上(0.25×分の過小は表示注記で担保。
 * OrcaRouter経由では常時0報告のため実質影響なし)。
 * 返値は1e-6 USDで丸める(FPノイズ排除)。
 */
export function estimateCostUsd(usage: LlmUsage, rates: ModelRates): number {
  const promptTokens =
    usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const cost =
    (promptTokens * rates.promptUsdPerMTok) / 1e6 +
    (usage.outputTokens * rates.completionUsdPerMTok) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * 単価キャッシュの事前ウォーム(fire-and-forget)。
 * 解析開始時に呼んでおくと、解析中(実測中央値27.3秒)に取得が終わり
 * done 発行時の待ちがゼロになる。失敗しても何もしない。
 */
export function warmPricingCache(route: LlmRoute): void {
  if (route !== "orcarouter") return;
  void getPricingMap().catch(() => {
    // 失敗はネガティブキャッシュに記録済み。ここでは握りつぶす
  });
}
