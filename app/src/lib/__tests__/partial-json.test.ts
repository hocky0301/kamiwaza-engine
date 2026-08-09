import { describe, it, expect } from "vitest";

import {
  completeJson,
  extractBalancedJson,
  stripCodeFences,
  tryParsePartial,
} from "../partial-json";

/* ============================================================================
 * partial-json — ストリーミング部分JSONパーサのフェンス耐性
 *
 * 直接Anthropic経路: structured outputs が生JSONを保証 → フェンスなし
 * OrcaRouter経路:    output_config が握りつぶされ ```json フェンス付き(2026-08-08実測)
 * 両経路が同じコードパスを通るため、フェンスあり/なし/途中分割をすべて凍結する。
 * ==========================================================================*/

describe("stripCodeFences", () => {
  it("フェンスなしの生JSONはそのまま返す(直接Anthropic経路の従来挙動)", () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    expect(stripCodeFences('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it("```json フェンスと閉じフェンスを除去する", () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("言語タグなしのフェンス(``` のみ)も除去する", () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("フェンス前の散文(Here is the JSON: など)も落とす", () => {
    expect(stripCodeFences('Here is the JSON:\n```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("JSON開始前しか受信していないバッファは空文字を返す(次のdeltaを待つ)", () => {
    expect(stripCodeFences("")).toBe("");
    expect(stripCodeFences("``")).toBe("");
    expect(stripCodeFences("```jso")).toBe("");
    expect(stripCodeFences("```json\n")).toBe("");
    expect(stripCodeFences("Here is the")).toBe("");
  });

  it("末尾の部分的な閉じフェンス(バックティック1〜2個)も除去する", () => {
    expect(stripCodeFences('{"a":1}\n`')).toBe('{"a":1}');
    expect(stripCodeFences('{"a":1}\n``')).toBe('{"a":1}');
    expect(stripCodeFences('{"a":1}```')).toBe('{"a":1}');
  });

  it("閉じフェンス後の末尾空白も除去する", () => {
    expect(stripCodeFences('{"a":1}\n```\n')).toBe('{"a":1}');
  });

  it("JSON文字列値の中のバックティックは壊さない", () => {
    const src = '{"description":"use `npm test` here"}';
    expect(stripCodeFences(src)).toBe(src);
    expect(stripCodeFences("```json\n" + src + "\n```")).toBe(src);
  });

  it("未閉鎖の文字列の末尾がバックティックでも削らない(残りが閉じ括弧で終わらないため)", () => {
    const src = '{"description":"use `';
    expect(stripCodeFences(src)).toBe(src);
  });
});

describe("tryParsePartial: フェンスなし(従来挙動の凍結)", () => {
  it("完全なJSONはそのままパースされる", () => {
    expect(tryParsePartial('{"a":1}')).toEqual({ a: 1 });
  });

  it("値の途中で切れたバッファは補完してパースされる", () => {
    expect(tryParsePartial('{"appName":"注文管理","fields":[')).toEqual({
      appName: "注文管理",
      fields: [],
    });
  });

  it("キーの途中で切れたバッファは直前のカンマまでの候補で救済される", () => {
    expect(tryParsePartial('{"a":1,"b"')).toEqual({ a: 1 });
  });

  it("パース不能なバッファは null(呼び出し元は次のトークンを待つ)", () => {
    expect(tryParsePartial("")).toBeNull();
    expect(tryParsePartial("こんにちは")).toBeNull();
  });

  it("括弧の対応が壊れたJSONは null", () => {
    expect(tryParsePartial('{"a":1]')).toBeNull();
  });
});

describe("tryParsePartial: フェンスあり(OrcaRouter経路)", () => {
  it("```json フェンス付きの完全なJSONをパースできる", () => {
    expect(tryParsePartial('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("フェンス付きで途中まで受信したバッファも部分パースできる", () => {
    expect(tryParsePartial('```json\n{"appName":"注文管理","fields":[')).toEqual({
      appName: "注文管理",
      fields: [],
    });
  });

  it("フェンスがdelta境界で分割されても、蓄積バッファごとに正しく振る舞う", () => {
    // 実際のSSEのdelta到着を模したシーケンス。バッファは蓄積され、
    // stripCodeFences は毎回バッファ全体に適用される。
    const deltas = [
      "```",
      "json\n",
      '{"appName":',
      '"注文管理",',
      '"fields":[',
      '{"id":"a"}',
      "]}",
      "\n``",
      "`",
    ];
    let buf = "";
    const snapshots = deltas.map((d) => {
      buf += d;
      return tryParsePartial(buf);
    });

    // フェンスしか来ていない間は null(JSON本体を待つ)
    expect(snapshots[0]).toBeNull();
    expect(snapshots[1]).toBeNull();
    // JSON本体が届き始めたら部分パースが立ち上がる
    expect(snapshots[2]).toEqual({ appName: null });
    expect(snapshots[4]).toEqual({ appName: "注文管理", fields: [] });
    // 本体完結後、閉じフェンスが1文字ずつ届いても結果は完全形のまま安定
    const full = { appName: "注文管理", fields: [{ id: "a" }] };
    expect(snapshots[6]).toEqual(full);
    expect(snapshots[7]).toEqual(full);
    expect(snapshots[8]).toEqual(full);
  });

  it("散文+フェンス+バックティック入り文字列値の複合ケース", () => {
    const src = 'Here is the JSON:\n```json\n{"description":"use `npm` here","fields":[]}\n```';
    expect(tryParsePartial(src)).toEqual({ description: "use `npm` here", fields: [] });
  });
});

describe("extractBalancedJson: 厳密パース失敗時の救済(最終応答専用)", () => {
  it("閉じフェンスの後に散文が続く応答からJSON本体を取り出す", () => {
    // stripCodeFences 単独では救えない形(末尾がバックティックで終わらない)
    const stripped = stripCodeFences('```json\n{"a":1}\n```\n以上が解析結果です。');
    expect(() => JSON.parse(stripped)).toThrow();
    expect(extractBalancedJson(stripped)).toBe('{"a":1}');
  });

  it("フェンスなしでJSONの後に説明文が続く応答も救済する", () => {
    expect(extractBalancedJson('{"a":1} この形式で出力しました')).toBe('{"a":1}');
  });

  it("文字列値の中の括弧・バックティックに惑わされない", () => {
    const json = '{"note":"a } b ] c ``` d","n":[1,2]}';
    expect(extractBalancedJson(json + "\n```\nほか")).toBe(json);
  });

  it("エスケープされた引用符を跨いで正しく文字列を閉じる", () => {
    const json = '{"q":"say \\"hi\\" now"}';
    expect(extractBalancedJson(json + " 済")).toBe(json);
  });

  it("未完結・対応の壊れたJSON・JSONなしは null", () => {
    expect(extractBalancedJson('{"a":1')).toBeNull();
    expect(extractBalancedJson('{"a":1]')).toBeNull();
    expect(extractBalancedJson("散文だけです")).toBeNull();
    expect(extractBalancedJson("")).toBeNull();
  });

  it("完全なJSONはそのまま返る(直接Anthropic経路と等価)", () => {
    expect(extractBalancedJson('{"a":1}')).toBe('{"a":1}');
    expect(extractBalancedJson('[{"a":1}]')).toBe('[{"a":1}]');
  });
});

describe("completeJson: 補完ロジック(移設後の挙動凍結)", () => {
  it("開き括弧を閉じ、末尾のカンマ/コロンを補正する", () => {
    expect(completeJson('{"a":[1,2')).toBe('{"a":[1,2]}');
    expect(completeJson('{"a":')).toBe('{"a":null}');
    expect(completeJson('{"a":1,')).toBe('{"a":1}');
  });

  it("未閉鎖の文字列は閉じる", () => {
    expect(completeJson('{"a":"xy')).toBe('{"a":"xy"}');
  });

  it("対応の壊れた括弧は null を返す", () => {
    expect(completeJson('{"a":1]')).toBeNull();
  });
});
