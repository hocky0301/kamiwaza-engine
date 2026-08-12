import { describe, it, expect } from "vitest";

import {
  ANALYZE_OUTPUT_JSON_SCHEMA,
  toAppSpec,
  type AnalyzeOutput,
} from "../appspec";
import { extractBalancedJson, tryParsePartial } from "../partial-json";
import {
  MIN_FIELDS,
  validate,
  validateAnalyzeOutput,
  validateSpecMinimums,
} from "../validate-spec";

/* ============================================================================
 * 攻撃2(審査員シミュレーション)で観測された実害の再現テストと、三重保険による修正の凍結
 *
 * F1: fields 0件の spec が validate-spec を通過し、空フォームが描画される
 *     → 修正: validateSpecMinimums(意味検査)が失格させ、
 *       既存の「validation違反→throw→デモフォールバック」連鎖に乗る(第1層)
 * F2: ストリーミングのデルタ重複(同一チャンク二重適用)で
 *     「出荷指示管理理」型の文字重複が発生し、JSONとしては有効なため
 *     パーサ・バリデータのどちらも検出できない
 *     → 部分対策: tryParsePartial の extractBalancedJson 救済(第3層)。
 *       文字列内重複はテキストレベルで検出不能のため、クライアント側の破損は
 *       done.spec 照合復元(reconcile.ts, 第2層)が最終防衛(reconcile.test.ts参照)
 * ==========================================================================*/

/** スキーマ上まったく問題のないライブモード出力(validate-spec.test.ts と同形) */
function validOutput(): Record<string, unknown> {
  return {
    appName: "注文管理",
    icon: "📦",
    description: "紙の注文書をアプリ化する",
    fields: [
      {
        id: "total",
        label: "合計",
        type: "number",
        required: true,
        confidence: 0.9,
        sourceBox: { x: 1, y: 2, w: 3, h: 4 },
      },
    ],
    lineItems: null,
    lineRows: [],
    listColumns: ["total"],
    approvalFlow: null,
    aggregations: [],
    firstRecord: [{ fieldId: "total", value: "1200" }],
  };
}

describe("F1: fields 0件の空殻specは意味検査で失格する(三重保険 第1層)", () => {
  it("fields: [] は minItems 違反として検出され、デモフォールバック連鎖に乗る", () => {
    const out = { ...validOutput(), fields: [], listColumns: [] };
    // 修正前はここが [] で、空フォームがそのまま描画されていた(観測された実害)。
    // 違反1件以上 → claude-live.ts が throw → 既存の「ライブ失敗→デモ続行」保険が発火する
    expect(validateAnalyzeOutput(out)).toContainEqual({
      path: "$.fields",
      keyword: "minItems",
    });
  });

  it("fields: [] でも toAppSpec 自体は正常終了する(検証層が唯一の網であることの記録)", () => {
    const out = {
      ...validOutput(),
      fields: [],
      listColumns: [],
    } as unknown as AnalyzeOutput;
    const spec = toAppSpec(out);
    expect(spec.fields).toHaveLength(0);
    // 紙から読めた値(total=1200)は field 定義がないため無言で捨てられる。
    // → ライブ経路では validateAnalyzeOutput が throw するため、この空殻が
    //   toAppSpec / SpecApp に到達することはもうない
    expect(spec.firstRecord).toEqual({});
  });

  it("極端な空殻(全配列が空・文字列が空)は fields と appName の両方で失格する", () => {
    const hollow = {
      appName: "",
      icon: "",
      description: "",
      fields: [],
      lineItems: null,
      lineRows: [],
      listColumns: [],
      approvalFlow: null,
      aggregations: [],
      firstRecord: [],
    };
    const reported = validateAnalyzeOutput(hollow).map((e) => `${e.keyword}@${e.path}`);
    expect(reported).toContain("minItems@$.fields");
    expect(reported).toContain("minLength@$.appName");
  });

  it("設計判断: ワイヤスキーマの fields には今後も minItems を宣言しない", () => {
    // ANALYZE_OUTPUT_JSON_SCHEMA は structured outputs としてAPIへそのまま送信され、
    // structured outputs は配列制約(minItems)・文字列制約(minLength)を非サポート。
    // 宣言すると直接Anthropic経路のリクエストを壊しうるため、最小件数検査は
    // validateSpecMinimums(アプリ側の意味検査層)が担う。
    const fieldsSchema = ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields as Record<
      string,
      unknown
    >;
    expect(fieldsSchema.minItems).toBeUndefined();
  });

  it("設計判断: ミニバリデータも minItems 非対応のまま(ワイヤスキーマと1:1を維持)", () => {
    // 「未対応キーワードは黙って通さず throw」の設計は据え置き。
    // 意味検査を構造検査に混ぜず別層にしたのは、バリデータがワイヤスキーマの
    // 忠実な検証器であり続けるため(スキーマに書けない検査を紛れ込ませない)
    expect(() =>
      validate({ type: "array", minItems: 1 } as never, []),
    ).toThrow(/未対応のキーワード: minItems/);
  });
});

describe("F1境界: validateSpecMinimums の閾値設計(50枚検証を踏まえた保守的設定)", () => {
  it("MIN_FIELDS は 1(実在帳票50枚はすべて複数フィールド。1項目の紙も誤失格させない)", () => {
    expect(MIN_FIELDS).toBe(1);
  });

  it("fields 0件: 失格", () => {
    expect(validateSpecMinimums({ ...validOutput(), fields: [] })).toContainEqual({
      path: "$.fields",
      keyword: "minItems",
    });
  });

  it("fields 1件(境界): 合格", () => {
    // validOutput() は fields 1件 — これが誤失格すると正常なライブ解析まで潰れる
    expect(validateSpecMinimums(validOutput())).toEqual([]);
    expect(validateAnalyzeOutput(validOutput())).toEqual([]);
  });

  it("appName が空文字・空白のみ: 失格(画面ヘッダが成立しない)", () => {
    expect(validateSpecMinimums({ ...validOutput(), appName: "" })).toContainEqual({
      path: "$.appName",
      keyword: "minLength",
    });
    expect(validateSpecMinimums({ ...validOutput(), appName: "  " })).toContainEqual({
      path: "$.appName",
      keyword: "minLength",
    });
  });

  it("型違い(fieldsが配列でない・appNameが文字列でない)は意味検査では報告しない", () => {
    // 型違反は構造検査 validate() の責務。二重報告で違反件数を水増ししない
    expect(validateSpecMinimums({ ...validOutput(), fields: "broken" })).toEqual([]);
    expect(validateSpecMinimums({ ...validOutput(), appName: 42 })).toEqual([]);
    // 欠落も同様(required 違反は構造検査が報告する)
    const noAppName: Record<string, unknown> = { ...validOutput() };
    delete noAppName.appName;
    expect(validateSpecMinimums(noAppName)).toEqual([]);
  });

  it("非オブジェクト入力の挙動は従来どおり type 違反1件のみ(挙動凍結)", () => {
    expect(validateAnalyzeOutput("just prose, not json")).toEqual([
      { path: "$", keyword: "type" },
    ]);
    expect(validateAnalyzeOutput(null)).toEqual([{ path: "$", keyword: "type" }]);
  });
});

describe("F2: 同一デルタ二重適用による文字重複(「管理理」型)の構成", () => {
  it("対照実験: 正常なデルタ列では appName は正しい", () => {
    const deltas = ['{"appName":"出荷指示管', "理", '","icon":"📦","fields":[]}'];
    const buffer = deltas.join("");
    expect(tryParsePartial(buffer)?.appName).toBe("出荷指示管理");
  });

  it("文字列リテラル内のデルタが二重適用されると「出荷指示管理理」になり、JSONとして有効", () => {
    // claude-live.ts:264 の `buffer += delta` は重複検出を持たない。
    // 同一チャンク「理」が2回届く(プロキシ再送・SSE再emit等)と:
    const deltas = [
      '{"appName":"出荷指示管',
      "理",
      "理", // ← 同一デルタの二重適用
      '","icon":"📦","fields":[]}',
    ];
    const buffer = deltas.join("");
    const parsed = tryParsePartial(buffer);
    // 重複が文字列値の内側に収まる限り、JSONは壊れない=検出不能
    expect(parsed?.appName).toBe("出荷指示管理理");
  });

  it("重複入りでもスキーマ検証を素通りする(文字列値の内容は検査対象外)", () => {
    const out = { ...validOutput(), appName: "出荷指示管理理" };
    expect(validateAnalyzeOutput(out)).toEqual([]);
    // → done.spec.appName = 「出荷指示管理理」のまま画面に出る(観測された実害と一致)
  });

  it("メンバー境界をまたぐデルタの二重適用は重複キーになり、JSON.parse が黙って吸収する", () => {
    // 二重適用が「値の閉じ + 次のキー」を含む場合: 重複キーは last-wins で有効なJSON
    const deltas = [
      '{"appName":"出荷指示管理',
      '","icon":"📦',
      '","icon":"📦', // ← 二重適用
      '"}',
    ];
    const parsed = tryParsePartial(deltas.join(""));
    expect(parsed).toEqual({ appName: "出荷指示管理", icon: "📦" });
    // この形も検出不能(エラーにならず、静かに通る)
  });

  it("末尾の構造文字デルタ二重適用: extractBalancedJson 救済で完全なオブジェクトが返る(第3層)", () => {
    // 修正前は last-comma 救済が fields ごと切り詰めた {appName} だけを「成功」として
    // 返していた(再現調査の発見事項)。現在は先頭の完結JSONを第2候補として試すため、
    // 末尾の構造ゴミを無視して完全な形が返る
    const deltas = ['{"appName":"出荷指示管理","fields":[{"id":"a"}]}', "}"];
    expect(tryParsePartial(deltas.join(""))).toEqual({
      appName: "出荷指示管理",
      fields: [{ id: "a" }],
    });
  });

  it("文字列リテラル内に収まらない中間位置の構造重複だけが、最終パースで検出→fallback に落ちる", () => {
    // 例: "fields":[] の閉じ配列デルタ "]," が二重適用 → JSONとして不正
    const broken = '{"appName":"出荷指示管理","fields":[],],"listColumns":[]}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(extractBalancedJson(broken)).toBeNull();
    // claude-live.ts:309-321 の最終パース(+extractBalancedJson救済も不可)で throw
    // → デモフォールバック発火。検出できるのはこの形だけで、
    //   文字列内重複・メンバー単位重複・末尾重複はすべて素通りする
  });

  it("チャンク境界での部分重複(オフセット巻き戻し再送)も同型の重複文字列を生む", () => {
    // 「…管理シ」まで送信済みの状態から「理システム」で再送が始まるケース
    const deltas = [
      '{"appName":"出荷指示管理シ',
      "理システム", // ← 巻き戻し再送: 先頭の「理」以降が重複区間
      '","icon":"📦","fields":[]}',
    ];
    const parsed = tryParsePartial(deltas.join(""));
    expect(parsed?.appName).toBe("出荷指示管理シ理システム");
  });
});

describe("第3層(tryParsePartial 救済)の境界: 重複入力列と従来挙動の凍結", () => {
  it("末尾重複が複数個('}}' など)でも完全なオブジェクトに復元される", () => {
    const buf = '{"appName":"出荷指示管理","fields":[{"id":"a"}]}' + "}}";
    expect(tryParsePartial(buf)).toEqual({
      appName: "出荷指示管理",
      fields: [{ id: "a" }],
    });
  });

  it("末尾の配列閉じ重複(']')も同様に救済される", () => {
    const buf = '{"fields":[{"id":"a"}],"listColumns":["a"]}' + "]";
    expect(tryParsePartial(buf)).toEqual({
      fields: [{ id: "a" }],
      listColumns: ["a"],
    });
  });

  it("中間位置の構造重複は救済されず null(最終パースでも失敗→フォールバック発火が正)", () => {
    // "]," の二重適用: 先頭からの括弧対応が壊れるため extractBalancedJson も救えない。
    // これはバグではなく仕様 — 検出可能な破損は握りつぶさずフォールバックへ流す
    const broken = '{"appName":"出荷指示管理","fields":[],],"listColumns":[]}';
    expect(tryParsePartial(broken)).toBeNull();
    expect(extractBalancedJson(broken)).toBeNull();
  });

  it("正常なストリーミング途中のバッファの挙動は不変(救済候補が誤発動しない)", () => {
    // 未完結バッファでは extractBalancedJson が null を返すため従来挙動そのまま
    expect(tryParsePartial('{"appName":"注文管理","fields":[')).toEqual({
      appName: "注文管理",
      fields: [],
    });
    expect(tryParsePartial('{"a":1,"b"')).toEqual({ a: 1 });
    expect(tryParsePartial('{"a":1]')).toBeNull();
  });

  it("文字列リテラル内の重複はJSONとして正常なため第3層では素通り(第2層が最終防衛)", () => {
    // 「管理理」型はここでは検出できない、という限界の凍結。
    // クライアント組み立て状態の破損は done.spec 照合(reconcile.ts)が復元し、
    // done.spec 自体に乗った破損はパイプライン内に検出点が存在しない(partial-json.ts冒頭)
    const deltas = ['{"appName":"出荷指示管', "理", "理", '","fields":[{"id":"a"}]}'];
    expect(tryParsePartial(deltas.join(""))?.appName).toBe("出荷指示管理理");
  });
});
