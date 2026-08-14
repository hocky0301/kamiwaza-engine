// 決定論のゴールデンテスト: 「デモリプレイは決定論」という対外主張を機械で固定する。
// 同じシナリオから常に同一のイベント列(内容+順序)が出ることをハッシュで検証。
// レンダラー側の決定論は「同一イベント列 → 同一UI」(React純関数)に還元されるため、
// イベント列の固定が主張の反証可能性を担保する。ハッシュが変わったら、
// それは「デモの内容を変えた」という自覚的な変更のはず——このテストがその検問になる。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDemoSequence } from "../demo";
import { SCENARIOS, getScenario } from "../scenarios";

const digest = (scenarioId: string): string => {
  const seq = buildDemoSequence(getScenario(scenarioId));
  // delayは演出パラメータ、eventが内容。両方を含めて固定する
  const canon = JSON.stringify(seq);
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
};

// 2026-08-14 固定(実在社名の排除後)。変更時はこの表を意図的に更新すること
const GOLDEN: Record<string, string> = {
  seikyu: "e81eb3257b3cb965",
  chumonsho: "6653b1aabe092662",
  nippo: "e5eefb4e6a8b7f4b",
  tenken: "47d091c1b499e7d7",
  hacchusho: "f120368452ebf451",
};

describe("デモリプレイの決定論(ゴールデン)", () => {
  it("全シナリオが定義されている", () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(Object.keys(GOLDEN).sort());
  });
  for (const id of Object.keys(GOLDEN)) {
    it(`${id}: イベント列がゴールデンハッシュと一致`, () => {
      expect(digest(id)).toBe(GOLDEN[id]);
      expect(digest(id)).toBe(GOLDEN[id]); // 2回目も同一(プロセス内決定論)
    });
  }
  it("イベント列に done が1回だけ含まれ、最後に来る", () => {
    for (const id of Object.keys(GOLDEN)) {
      const seq = buildDemoSequence(getScenario(id));
      const dones = seq.filter((x) => x.event.type === "done");
      expect(dones).toHaveLength(1);
      expect(seq[seq.length - 1]!.event.type).toBe("done");
    }
  });
});
