import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSpec } from "../appspec";
import { sseLine, type AnalyzeEvent, type LlmUsage } from "../events";
import type { ReconfigureEvent } from "../specdiff";
import {
  FALLBACK_RATES,
  PRICING_TTL_MS,
  _resetPricingCacheForTest,
  estimateCostUsd,
  getModelRates,
  warmPricingCache,
} from "../llm-pricing";

/* ============================================================================
 * llm-pricing — 推定原価の単価取得と保守的上限式
 *
 * 誠実性の要:
 *   - cache_read も prompt 単価で計上(実際は約0.1×)= 実際より高い見積り。
 *     「安く見せる嘘」を構造的に防ぐ
 *   - 単価取得は絶対に throw しない(原価表示の失敗で解析ストリームを殺さない)
 * ==========================================================================*/

const OPUS_ID = "anthropic/claude-opus-4.8";

function usage(partial: Partial<LlmUsage> = {}): LlmUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...partial,
  };
}

/** OrcaRouter /v1/models 実測形状(pricingは文字列)のモックレスポンス */
function modelsResponse(
  models: { id: string; pricing?: Record<string, unknown> }[] = [
    {
      id: OPUS_ID,
      pricing: { prompt_per_million: "5.000000", completion_per_million: "25.000000" },
    },
  ],
) {
  return {
    ok: true,
    json: async () => ({ data: models }),
  } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  _resetPricingCacheForTest();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ORCAROUTER_API_KEY", "orca-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("estimateCostUsd: 保守的上限式(純関数)", () => {
  it("cacheRead は公式掛け率0.1×で加算される(落ちも満額計上もしない)", () => {
    // input=4120, cacheRead=980 → 実効プロンプト 4120 + 0.1×980 = 4218 tok。
    // 公式レート(OrcaRouterモデルページ公表値・2026-08-11): read $0.50/M = 入力単価の0.1×。
    const cost = estimateCostUsd(
      usage({ inputTokens: 4120, cacheReadInputTokens: 980, outputTokens: 3540 }),
      FALLBACK_RATES,
    );
    // 4218×$5/MTok + 3540×$25/MTok = $0.021090 + $0.0885 = $0.10959
    expect(cost).toBe(0.10959);
    // cacheRead を丸ごと落とした誤式(4120×p)とも旧満額計上(5100×p)とも一致しない
    expect(cost).not.toBe(0.1091);
    expect(cost).not.toBe(0.114);
  });

  it("cacheCreation は公式掛け率1.25×(5分TTL write)で計上される", () => {
    // 100 + 1.25×900 = 1225 tok 相当。write $6.25/M = 入力単価の1.25×(公表値)。
    const cost = estimateCostUsd(
      usage({ inputTokens: 100, cacheCreationInputTokens: 900 }),
      FALLBACK_RATES,
    );
    expect(cost).toBe((1225 * 5) / 1e6);
    // 旧満額計上(1000×p)なら過小、との境界を固定
    expect(cost).not.toBe((1000 * 5) / 1e6);
  });

  it("全ゼロの usage は 0", () => {
    expect(estimateCostUsd(usage(), FALLBACK_RATES)).toBe(0);
  });

  it("出力トークンは completion 単価で計上される", () => {
    expect(estimateCostUsd(usage({ outputTokens: 1_000_000 }), FALLBACK_RATES)).toBe(25);
  });

  it("1e-6 USD で丸める(FPノイズ排除)", () => {
    // 3 tok × $5/MTok = 0.000015 ちょうど。7 tok なら 0.000035
    const cost = estimateCostUsd(usage({ inputTokens: 7 }), FALLBACK_RATES);
    expect(cost).toBe(0.000035);
    // 丸め粒度: 小数第6位までしか持たない
    const noisy = estimateCostUsd(usage({ inputTokens: 1, outputTokens: 1 }), {
      promptUsdPerMTok: 5.1234567,
      completionUsdPerMTok: 25.7654321,
    });
    expect(noisy).toBe(Math.round((5.1234567 / 1e6 + 25.7654321 / 1e6) * 1e6) / 1e6);
  });
});

describe("getModelRates: 単価取得とフォールバック", () => {
  it("orcarouter経路: /v1/models の文字列単価をパースして live で返す", async () => {
    fetchMock.mockResolvedValue(modelsResponse());
    const { rates, source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("live");
    expect(rates).toEqual({ promptUsdPerMTok: 5, completionUsdPerMTok: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.orcarouter.ai/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer orca-key");
  });

  it("anthropic経路は fetch せず即 fallback(/v1/models に pricing なし)", async () => {
    const { rates, source } = await getModelRates("claude-opus-4-8", "anthropic");
    expect(source).toBe("fallback");
    expect(rates).toBe(FALLBACK_RATES);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("モデルIDが一覧に無ければ fallback", async () => {
    fetchMock.mockResolvedValue(modelsResponse());
    const { source } = await getModelRates("anthropic/unknown-model", "orcarouter");
    expect(source).toBe("fallback");
  });

  it.each([
    ["NaN文字列", { prompt_per_million: "abc", completion_per_million: "25.0" }],
    ["負値", { prompt_per_million: "-5", completion_per_million: "25.0" }],
    ["欠落", { completion_per_million: "25.0" }],
    ["pricingなし", undefined],
  ])("不正な単価(%s)はミス扱いで fallback", async (_label, pricing) => {
    fetchMock.mockResolvedValue(modelsResponse([{ id: OPUS_ID, pricing }]));
    const { rates, source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("fallback");
    expect(rates).toBe(FALLBACK_RATES);
  });

  it("fetch 失敗(ネットワーク断)でも throw せず fallback", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(getModelRates(OPUS_ID, "orcarouter")).resolves.toEqual({
      rates: FALLBACK_RATES,
      source: "fallback",
    });
  });

  it("HTTPエラー(401等)でも throw せず fallback", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);
    const { source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("fallback");
  });

  it("JSONの形状が想定外(dataが配列でない)でも fallback", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    const { source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("fallback");
  });
});

describe("キャッシュ: TTL 10分・失敗60秒ネガティブキャッシュ", () => {
  it("TTL内の2回目は fetch されない", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(modelsResponse());
    await getModelRates(OPUS_ID, "orcarouter");
    vi.advanceTimersByTime(PRICING_TTL_MS - 1000);
    const { source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("TTL経過後は再fetchする", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(modelsResponse());
    await getModelRates(OPUS_ID, "orcarouter");
    vi.advanceTimersByTime(PRICING_TTL_MS + 1000);
    await getModelRates(OPUS_ID, "orcarouter");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("失敗は60秒だけネガティブキャッシュされ、その間は再fetchしない", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("down"));
    await getModelRates(OPUS_ID, "orcarouter");
    vi.advanceTimersByTime(30_000);
    const { source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 60秒経過後は再試行する(回線復帰なら live に戻る)
    fetchMock.mockResolvedValue(modelsResponse());
    vi.advanceTimersByTime(31_000);
    const retry = await getModelRates(OPUS_ID, "orcarouter");
    expect(retry.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("warmPricingCache で温めておくと本取得は fetch なしで live を返す", async () => {
    fetchMock.mockResolvedValue(modelsResponse());
    warmPricingCache("orcarouter");
    // fire-and-forget の完了を待つ(モックfetchは即解決)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { source } = await getModelRates(OPUS_ID, "orcarouter");
    expect(source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warmPricingCache は anthropic経路では何もしない", () => {
    warmPricingCache("anthropic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同時多発の取得は1回のfetchに合流する", async () => {
    fetchMock.mockResolvedValue(modelsResponse());
    const [a, b] = await Promise.all([
      getModelRates(OPUS_ID, "orcarouter"),
      getModelRates(OPUS_ID, "orcarouter"),
    ]);
    expect(a.source).toBe("live");
    expect(b.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("イベントスキーマ: done/rdone の costUsd/pricingSource 拡張", () => {
  // 型チェック用の最小spec(実行時はJSONシリアライズのみに使う)
  const minimalSpec = {} as AppSpec;

  it("done: costUsd/pricingSource 付きでSSEシリアライズ→パースが往復する", () => {
    const ev: AnalyzeEvent = {
      type: "done",
      spec: minimalSpec,
      mode: "live",
      usage: usage({ inputTokens: 4120, cacheReadInputTokens: 980, outputTokens: 3540 }),
      llmRoute: "orcarouter",
      costUsd: 0.114,
      pricingSource: "live",
    };
    const line = sseLine(ev);
    expect(line.startsWith("data: ")).toBe(true);
    const parsed = JSON.parse(line.slice(6)) as typeof ev;
    expect(parsed.costUsd).toBe(0.114);
    expect(parsed.pricingSource).toBe("live");
    expect(parsed.usage?.cacheReadInputTokens).toBe(980);
  });

  it("done: costUsd/pricingSource はオプショナル(デモ経路=usage欠落で捏造しない)", () => {
    // デモ経路のdone: usage/costUsdとも欠落したまま型が通る(後方互換)
    const ev: AnalyzeEvent = { type: "done", spec: minimalSpec, mode: "demo" };
    const parsed = JSON.parse(sseLine(ev).slice(6)) as Extract<AnalyzeEvent, { type: "done" }>;
    expect(parsed.costUsd).toBeUndefined();
    expect(parsed.pricingSource).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
  });

  it("rdone: costUsd/pricingSource 付きでJSON往復する", () => {
    const ev: ReconfigureEvent = {
      type: "rdone",
      applied: 2,
      usage: usage({ inputTokens: 800, outputTokens: 120 }),
      costUsd: 0.007,
      pricingSource: "fallback",
    };
    const parsed = JSON.parse(JSON.stringify(ev)) as typeof ev;
    expect(parsed.costUsd).toBe(0.007);
    expect(parsed.pricingSource).toBe("fallback");
  });

  it("rdone: キーワードフォールバック単独(usageなし)は cost も欠落のまま型が通る", () => {
    const ev: ReconfigureEvent = { type: "rdone", applied: 1 };
    const parsed = JSON.parse(JSON.stringify(ev)) as Extract<ReconfigureEvent, { type: "rdone" }>;
    expect(parsed.usage).toBeUndefined();
    expect(parsed.costUsd).toBeUndefined();
  });
});
