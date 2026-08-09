// 出典ハイライトのタッチ発火・解除規則(highlight.ts)のテスト。
// 規則: 同じ出典の再タップ=解除 / 別の出典のタップ=切り替え / 未点灯からのタップ=点灯

import { describe, it, expect } from "vitest";
import {
  sameBox,
  toggleHighlight,
  INTERACTIVE_TAGS,
  INTERACTIVE_SELECTOR,
} from "../highlight";
import type { SourceBox } from "../appspec";

const box = (x: number, y: number, w: number, h: number): SourceBox => ({ x, y, w, h });

describe("sameBox — 出典矩形の値等価", () => {
  it("同一参照はtrue", () => {
    const a = box(10, 20, 30, 5);
    expect(sameBox(a, a)).toBe(true);
  });

  it("参照が違っても座標が同じならtrue(spec差し替え後の再タップ解除の根拠)", () => {
    expect(sameBox(box(10, 20, 30, 5), box(10, 20, 30, 5))).toBe(true);
  });

  it.each([
    ["x", box(11, 20, 30, 5)],
    ["y", box(10, 21, 30, 5)],
    ["w", box(10, 20, 31, 5)],
    ["h", box(10, 20, 30, 6)],
  ])("%s が1つでも違えばfalse", (_axis, b) => {
    expect(sameBox(box(10, 20, 30, 5), b)).toBe(false);
  });

  it("null/undefinedが混ざればfalse", () => {
    const a = box(0, 0, 1, 1);
    expect(sameBox(null, a)).toBe(false);
    expect(sameBox(a, null)).toBe(false);
    expect(sameBox(undefined, a)).toBe(false);
    expect(sameBox(a, undefined)).toBe(false);
  });

  it("両方null/undefinedでもfalse(「何も光っていない」は出典と一致しない)", () => {
    expect(sameBox(null, null)).toBe(false);
    expect(sameBox(undefined, undefined)).toBe(false);
    expect(sameBox(null, undefined)).toBe(false);
  });

  it("0座標の矩形どうしも正しく比較できる", () => {
    expect(sameBox(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(true);
  });
});

describe("toggleHighlight — タップの点灯/解除規則", () => {
  it("未点灯(null)からのタップは点灯し、渡したboxをそのまま返す", () => {
    const b = box(5, 10, 40, 8);
    expect(toggleHighlight(null, b)).toBe(b);
  });

  it("同じ出典の再タップは解除(null)", () => {
    const b = box(5, 10, 40, 8);
    expect(toggleHighlight(b, b)).toBeNull();
  });

  it("値が同じ別参照の再タップでも解除(spec再構成後も再タップで消せる)", () => {
    expect(toggleHighlight(box(5, 10, 40, 8), box(5, 10, 40, 8))).toBeNull();
  });

  it("別の出典をタップしたら切り替え(新しいboxを返す)", () => {
    const cur = box(5, 10, 40, 8);
    const next = box(50, 60, 20, 4);
    expect(toggleHighlight(cur, next)).toBe(next);
  });

  it("解除→再タップで再点灯できる(トグルの往復)", () => {
    const b = box(1, 2, 3, 4);
    const off = toggleHighlight(b, b);
    expect(off).toBeNull();
    expect(toggleHighlight(off, b)).toBe(b);
  });

  it("引数のboxを変異させない(純粋関数)", () => {
    const cur = box(5, 10, 40, 8);
    const next = box(50, 60, 20, 4);
    toggleHighlight(cur, next);
    expect(cur).toEqual(box(5, 10, 40, 8));
    expect(next).toEqual(box(50, 60, 20, 4));
  });
});

describe("INTERACTIVE_TAGS / INTERACTIVE_SELECTOR — 行タップの除外対象", () => {
  it("フォーカスが担当するフォームコントロールを網羅している", () => {
    for (const tag of ["input", "textarea", "select", "label", "button", "a"]) {
      expect(INTERACTIVE_TAGS).toContain(tag);
    }
  });

  it("セレクタはタグ列と一致する(closest()にそのまま渡せる形)", () => {
    expect(INTERACTIVE_SELECTOR.split(", ")).toEqual([...INTERACTIVE_TAGS]);
  });

  it("全タグが小文字(closestのセレクタ照合はcase-insensitiveだが表記を統一)", () => {
    for (const tag of INTERACTIVE_TAGS) {
      expect(tag).toBe(tag.toLowerCase());
    }
  });
});
