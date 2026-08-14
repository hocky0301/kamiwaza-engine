// ライブ解析が失敗してデモへフォールバックしたとき、画面が「原価 $0」と
// 言い切らないことを守るテスト。
//
// 背景: デモの done は mode:"demo" で usage を持たないため、UIは
// 「デモ再生: LLM呼び出しなし(原価 $0)」を出す。しかしライブ側は
// finalMessage 取得後(refusal / max_tokens / JSON抽出失敗 / スキーマ違反)にも
// throw しうる。その時点でトークンは課金済みなので、$0 表示は誤認になる。
// ブースではこのフォールバックを実際に見せる設計のため、表示の誠実さが直接効く。

import { describe, expect, it } from "vitest";
import { withAbortedLiveCost } from "../events";
import type { AnalyzeEvent, LlmUsage } from "../events";
import type { AppSpec } from "../appspec";

const emptyUsage: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const spec = { appName: "テスト", icon: "📄" } as unknown as AppSpec;
const demoDone: AnalyzeEvent = { type: "done", spec, mode: "demo", scenarioId: "chumonsho" };

describe("withAbortedLiveCost", () => {
  it("消費ゼロなら何も足さない(本当に $0 のデモ再生)", () => {
    const out = withAbortedLiveCost(demoDone, { usage: emptyUsage, costUsd: null });
    expect(out).toEqual(demoDone);
    expect("abortedLiveCostUsd" in out).toBe(false);
  });

  it("消費があれば done に実額を載せる(=UIが $0 と言えなくなる)", () => {
    const usage: LlmUsage = {
      inputTokens: 4200,
      outputTokens: 130,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const out = withAbortedLiveCost(demoDone, { usage, costUsd: 0.0245 });
    expect(out.type).toBe("done");
    if (out.type !== "done") throw new Error("done であること");
    expect(out.mode).toBe("demo");
    expect(out.abortedLiveCostUsd).toBe(0.0245);
    expect(out.abortedLiveUsage).toEqual(usage);
  });

  it("回転検出だけ消費して本解析前に落ちた場合も計上する", () => {
    const usage: LlmUsage = {
      inputTokens: 1800,
      outputTokens: 12,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const out = withAbortedLiveCost(demoDone, { usage, costUsd: 0.0091 });
    if (out.type !== "done") throw new Error("done であること");
    expect(out.abortedLiveCostUsd).toBe(0.0091);
  });

  it("キャッシュ読み込みだけでも消費として扱う(cache_read も課金される)", () => {
    const usage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4182,
    };
    const out = withAbortedLiveCost(demoDone, { usage, costUsd: 0.0002 });
    if (out.type !== "done") throw new Error("done であること");
    expect(out.abortedLiveUsage).toEqual(usage);
  });

  it("単価が取れなくても、消費があれば usage は残す(額は undefined)", () => {
    const usage: LlmUsage = { ...emptyUsage, inputTokens: 500 };
    const out = withAbortedLiveCost(demoDone, { usage, costUsd: null });
    if (out.type !== "done") throw new Error("done であること");
    expect(out.abortedLiveCostUsd).toBeUndefined();
    expect(out.abortedLiveUsage).toEqual(usage);
  });

  it("done 以外のイベントは素通しする", () => {
    const usage: LlmUsage = { ...emptyUsage, inputTokens: 999 };
    for (const ev of [
      { type: "phase", label: "解析中" },
      { type: "field", field: { id: "a" } },
      { type: "error", message: "失敗" },
    ] as unknown as AnalyzeEvent[]) {
      expect(withAbortedLiveCost(ev, { usage, costUsd: 0.01 })).toBe(ev);
    }
  });

  it("ライブ成功時の done(mode:live)には触らない", () => {
    const liveDone: AnalyzeEvent = {
      type: "done",
      spec,
      mode: "live",
      usage: { ...emptyUsage, inputTokens: 100 },
      costUsd: 0.05,
    };
    const out = withAbortedLiveCost(liveDone, { usage: emptyUsage, costUsd: null });
    expect(out).toEqual(liveDone);
  });
});
