import { describe, expect, it } from "vitest";
import { parseRotationResponse, resolveRotationVotes } from "../rotation";

describe("parseRotationResponse — 回転判定応答のパース(F07)", () => {
  it("生JSONを読む(直接Anthropic経路の正常形)", () => {
    expect(parseRotationResponse('{"rotation": 180}')).toBe(180);
    expect(parseRotationResponse('{"rotation": 0}')).toBe(0);
  });

  it("フェンス付きJSONを読む(OrcaRouter経路の実測形)", () => {
    expect(parseRotationResponse('```json\n{"rotation": 90}\n```')).toBe(90);
  });

  it("前後に散文が付いたJSONを読む", () => {
    expect(parseRotationResponse('判定結果です。```json\n{"rotation": 270}\n``` 以上です。')).toBe(270);
  });

  it("散文「0度です。…」を読む(2026-08-09実測: 5回中4回この形)", () => {
    expect(
      parseRotationResponse(
        "0度です。この画像は既に本文(タイトル「請求書」、表、記入内容)が正しく読める向きになっているため、回転させる必要はありません。",
      ),
    ).toBe(0);
  });

  it("散文「時計回りに180度…」を読む", () => {
    expect(parseRotationResponse("時計回りに180度回転させる必要があります。")).toBe(180);
  });

  it("「回転させる必要はありません」だけでも0と判定する", () => {
    expect(parseRotationResponse("この画像は正しい向きです。回転させる必要はありません。")).toBe(0);
  });

  it("無効な角度のJSONはnull(散文フォールバックにも角度が無い場合)", () => {
    expect(parseRotationResponse('{"rotation": 45}')).toBeNull();
  });

  it("解釈不能な散文はnull(呼び出し側で0扱い)", () => {
    expect(parseRotationResponse("画像を確認しました。")).toBeNull();
    expect(parseRotationResponse("")).toBeNull();
  });

  it("散文中の最初の有効角度を拾う(「45度」等の無効角度は拾わない)", () => {
    expect(parseRotationResponse("おそらく90度の回転が必要です")).toBe(90);
    expect(parseRotationResponse("45度ほど傾いています")).toBeNull();
  });
});

describe("resolveRotationVotes — 非ゼロ判定の合議規則(誤回転 >> 未補正)", () => {
  it("一致した非ゼロは採用", () => {
    expect(resolveRotationVotes(180, 180)).toBe(180);
    expect(resolveRotationVotes(90, 90)).toBe(90);
  });

  it("不一致は0に倒す(2026-08-09実測: 画像を見ない誤判定への防御)", () => {
    expect(resolveRotationVotes(180, 0)).toBe(0);
    expect(resolveRotationVotes(90, 180)).toBe(0);
  });

  it("どちらかが判定不能(null)なら0に倒す", () => {
    expect(resolveRotationVotes(180, null)).toBe(0);
    expect(resolveRotationVotes(null, null)).toBe(0);
  });

  it("0の一致は0", () => {
    expect(resolveRotationVotes(0, 0)).toBe(0);
  });
});
