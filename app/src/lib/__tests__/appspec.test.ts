import { describe, it, expect } from "vitest";

import {
  ANALYZE_OUTPUT_JSON_SCHEMA,
  toAppSpec,
  type AggregationSpec,
  type AnalyzeOutput,
  type ColumnSpec,
  type FieldSpec,
  type FieldType,
  type LineItemsSpec,
} from "../appspec";
import { applyDiff, buildReconfigureTools, toolCallToDiff } from "../specdiff";
import {
  ANALYZE_OUTPUT_SCHEMA,
  SUPPORTED_KEYWORDS,
  isObjectNode,
  validate,
  validateAnalyzeOutput,
  walkSchema,
  type SchemaNode,
} from "../validate-spec";

/* ============================================================================
 * テスト基盤: スキーマ走査ヘルパーと最小 JSON Schema バリデータは
 * 本番モジュール ../validate-spec に移動した(ライブ解析の最終JSONに適用される)。
 * このファイルの「テスト基盤の自己検証」describe は、そのまま本番モジュールの
 * ユニットテストとして機能する。
 *
 * 個別プロパティの assert では元の `as const` 型のまま ANALYZE_OUTPUT_JSON_SCHEMA を
 * 参照する（キーが消えたらランタイムではなく `tsc --noEmit` の時点で落ちてほしいため）。
 * ==========================================================================*/

/** 汎用走査・バリデーション用の緩いビュー（読み取り専用で使うこと） */
const SCHEMA = ANALYZE_OUTPUT_SCHEMA;

/** 意図的に不完全な判定（走査ロジックのメタテスト専用。本番の判定には使わない） */
function isObjectNodeNaive(node: SchemaNode): boolean {
  return node.type === "object";
}

const validateOutput = validateAnalyzeOutput;

/* ============================================================================
 * テスト基盤 3: サンプルデータ
 * ==========================================================================*/

/** スキーマ上まったく問題のないライブモード出力（全プロパティを埋めた最小形） */
function validSample(): Record<string, unknown> {
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
    lineItems: {
      label: "明細",
      columns: [{ id: "name", label: "品名", type: "text" }],
    },
    lineRows: [["ボルト"]],
    listColumns: ["total"],
    approvalFlow: [{ name: "課長承認", role: "課長" }],
    aggregations: [{ id: "a", label: "合計", fieldId: "total", op: "sum" }],
    firstRecord: [{ fieldId: "total", value: "1200" }],
  };
}

function analyzeOutput(patch: Partial<AnalyzeOutput> = {}): AnalyzeOutput {
  return {
    appName: "注文管理",
    icon: "📦",
    description: "紙の注文書をアプリ化する",
    fields: [],
    lineItems: null,
    lineRows: [],
    listColumns: [],
    approvalFlow: null,
    aggregations: [],
    firstRecord: [],
    ...patch,
  };
}

const field = (id: string, type: FieldType): FieldSpec => ({
  id,
  label: id,
  type,
  required: false,
  confidence: 1,
});

/* ============================================================================
 * テスト基盤の自己検証
 * ==========================================================================*/

describe("テスト基盤の自己検証", () => {
  describe("走査ロジック(walkSchema)は type配列ノードを取りこぼさない", () => {
    // これが無いと、後続の additionalProperties 全走査テストが
    // 「何も拾っていないので必ず緑」というザルになりうる。
    it("素朴な判定(type === 'object')は lineItems を見逃す", () => {
      const naive = walkSchema(SCHEMA, isObjectNodeNaive).map((h) => h.path);
      // lineItems は type: ["object","null"] なので単純比較では一致しない
      expect(naive).not.toContain("$.properties.lineItems");
      expect(naive).toHaveLength(8);
    });

    it("正規化した判定は lineItems を含めて1件多く拾う", () => {
      const normalized = walkSchema(SCHEMA, isObjectNode).map((h) => h.path);
      const naive = walkSchema(SCHEMA, isObjectNodeNaive).map((h) => h.path);
      expect(normalized).toContain("$.properties.lineItems");
      expect(normalized).toHaveLength(naive.length + 1);
      expect(normalized.filter((p) => !naive.includes(p))).toEqual(["$.properties.lineItems"]);
    });

    it("approvalFlow は type キー自体を持たない anyOf ラッパーなので、type前提の走査では素通りする", () => {
      // 「type を見れば済む」という前提が二重に崩れていることの固定化。
      // anyOf の中身(配列要素のオブジェクト)は走査対象に入る必要がある。
      expect(Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties.approvalFlow)).not.toContain("type");
      const normalized = walkSchema(SCHEMA, isObjectNode).map((h) => h.path);
      expect(normalized).toContain("$.properties.approvalFlow.anyOf[0].items");
    });
  });

  describe("ミニJSON Schemaバリデータ", () => {
    it("スキーマが使うキーワードはすべてバリデータの実装範囲に収まっている", () => {
      const used = new Set<string>();
      for (const hit of walkSchema(SCHEMA, () => true)) {
        for (const kw of Object.keys(hit.node)) used.add(kw);
      }
      expect([...used].sort()).toEqual([
        "additionalProperties",
        "anyOf",
        "description",
        "enum",
        "items",
        "properties",
        "required",
        "type",
      ]);
      expect([...used].filter((kw) => !SUPPORTED_KEYWORDS.has(kw))).toEqual([]);
    });

    it("未対応キーワードに出会ったら黙って通さず throw する", () => {
      expect(() => validate({ minimum: 3 } as unknown as SchemaNode, 1)).toThrow(
        /未対応のキーワード: minimum/,
      );
    });

    it("type / required / enum / additionalProperties をそれぞれ検出できる", () => {
      const s: SchemaNode = {
        type: "object",
        properties: { a: { type: "string", enum: ["x"] } },
        required: ["a"],
        additionalProperties: false,
      };
      expect(validate(s, { a: "x" })).toEqual([]);
      expect(validate(s, { a: 1 })).toEqual([{ path: "$.a", keyword: "type" }]);
      expect(validate(s, {})).toEqual([{ path: "$.a", keyword: "required" }]);
      expect(validate(s, { a: "y" })).toEqual([{ path: "$.a", keyword: "enum" }]);
      expect(validate(s, { a: "x", b: 1 })).toEqual([
        { path: "$.b", keyword: "additionalProperties" },
      ]);
    });

    it("anyOf はいずれかの枝が通れば valid、全滅なら anyOf エラー", () => {
      const s: SchemaNode = { anyOf: [{ type: "array" }, { type: "null" }] };
      expect(validate(s, [])).toEqual([]);
      expect(validate(s, null)).toEqual([]);
      expect(validate(s, "x")).toEqual([{ path: "$", keyword: "anyOf" }]);
    });

    it("type: ['object','null'] で null が来たとき required/additionalProperties は適用されない", () => {
      const s: SchemaNode = {
        type: ["object", "null"],
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      };
      expect(validate(s, null)).toEqual([]);
      expect(validate(s, {})).toEqual([{ path: "$.a", keyword: "required" }]);
    });

    it("正常サンプルはエラーゼロ(以降のネガティブテストの土台)", () => {
      expect(validateOutput(validSample())).toEqual([]);
    });
  });
});

/* ============================================================================
 * ANALYZE_OUTPUT_JSON_SCHEMA — 構造の不変条件
 * ==========================================================================*/

describe("ANALYZE_OUTPUT_JSON_SCHEMA: additionalProperties の全階層封鎖", () => {
  it("オブジェクト型ノードは9個あり、その全パスが既知の集合と一致する", () => {
    // 「LLMに生コードを書かせない」の根幹。ノードが増減したらここで気づく。
    const paths = walkSchema(SCHEMA, isObjectNode).map((h) => h.path);
    expect(paths).toEqual([
      "$",
      "$.properties.fields.items",
      "$.properties.fields.items.properties.sourceBox",
      "$.properties.lineItems",
      "$.properties.lineItems.properties.columns.items",
      "$.properties.lineItems.properties.sourceBox",
      "$.properties.approvalFlow.anyOf[0].items",
      "$.properties.aggregations.items",
      "$.properties.firstRecord.items",
    ]);
  });

  it("そのすべてが additionalProperties: false を持つ(違反ノードはゼロ)", () => {
    const violations = walkSchema(SCHEMA, isObjectNode)
      .filter((h) => h.node.additionalProperties !== false)
      .map((h) => h.path);
    // 1ノードでも漏れると未定義キー(=任意のペイロード)が構造化出力に混入しうる
    expect(violations).toEqual([]);
  });
});

describe("ANALYZE_OUTPUT_JSON_SCHEMA: 未知キーは全階層で実際に reject される", () => {
  // 静的走査の取りこぼしを挙動側から二重に塞ぐ。
  const mutations: { name: string; path: string; mutate: (s: Record<string, never>) => void }[] = [
    {
      name: "トップレベル",
      path: "$.hacked",
      mutate: (s) => {
        (s as Record<string, unknown>).hacked = "x";
      },
    },
    {
      name: "fields[0]",
      path: "$.fields[0].evilCode",
      mutate: (s) => {
        ((s as Record<string, unknown>).fields as Record<string, unknown>[])[0].evilCode = "x";
      },
    },
    {
      name: "fields[0].sourceBox",
      path: "$.fields[0].sourceBox.z",
      mutate: (s) => {
        (
          ((s as Record<string, unknown>).fields as Record<string, unknown>[])[0]
            .sourceBox as Record<string, unknown>
        ).z = 1;
      },
    },
    {
      name: "lineItems",
      path: "$.lineItems.script",
      mutate: (s) => {
        ((s as Record<string, unknown>).lineItems as Record<string, unknown>).script = "x";
      },
    },
    {
      name: "lineItems.columns[0]",
      path: "$.lineItems.columns[0].bad",
      mutate: (s) => {
        (
          ((s as Record<string, unknown>).lineItems as Record<string, unknown>)
            .columns as Record<string, unknown>[]
        )[0].bad = "x";
      },
    },
    {
      name: "approvalFlow[0]",
      path: "$.approvalFlow[0].exec",
      mutate: (s) => {
        ((s as Record<string, unknown>).approvalFlow as Record<string, unknown>[])[0].exec = "x";
      },
    },
    {
      name: "aggregations[0]",
      path: "$.aggregations[0].bad",
      mutate: (s) => {
        ((s as Record<string, unknown>).aggregations as Record<string, unknown>[])[0].bad = "x";
      },
    },
    {
      name: "firstRecord[0]",
      path: "$.firstRecord[0].bad",
      mutate: (s) => {
        ((s as Record<string, unknown>).firstRecord as Record<string, unknown>[])[0].bad = "x";
      },
    },
  ];

  it.each(mutations)("$name に余分なキーを足すと additionalProperties で弾かれる", ({ path, mutate }) => {
    const sample = validSample();
    mutate(sample as unknown as Record<string, never>);
    // approvalFlow は anyOf 配下なので、枝が全滅した結果として anyOf エラーで報告される
    const errors = validateOutput(sample);
    expect(errors.length).toBeGreaterThan(0);
    const reported = errors.map((e) => `${e.keyword}@${e.path}`);
    const isApprovalFlow = path.startsWith("$.approvalFlow");
    expect(reported).toContain(
      isApprovalFlow ? "anyOf@$.approvalFlow" : `additionalProperties@${path}`,
    );
  });
});

describe("ANALYZE_OUTPUT_JSON_SCHEMA: required が型定義と同期している", () => {
  it("トップレベルは全10プロパティが required(AnalyzeOutput の全キーと過不足なく一致)", () => {
    const S = ANALYZE_OUTPUT_JSON_SCHEMA;
    const props = Object.keys(S.properties);
    expect(props).toHaveLength(10); // AppSpec の8キー(firstRecord/firstRecordLines除く) + firstRecord + lineRows
    expect([...S.required].sort()).toEqual([...props].sort());
  });

  it("firstRecordLines はワイヤ型に存在しない(toAppSpec が生成する派生値)", () => {
    expect(Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties)).not.toContain("firstRecordLines");
  });

  it("FieldSpec の必須5件が fields.items.required と一致", () => {
    // options / unit / sourceBox / min / max は TS 側で optional
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields.items.required).toEqual([
      "id",
      "label",
      "type",
      "required",
      "confidence",
    ]);
  });

  it("SourceBox の4件は fields配下・lineItems配下のどちらでも全て required", () => {
    const expected = ["x", "y", "w", "h"]; // SourceBox に optional は無い
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields.items.properties.sourceBox.required).toEqual(
      expected,
    );
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.properties.sourceBox.required).toEqual(
      expected,
    );
  });

  it("LineItemsSpec の必須2件(sourceBox は optional)", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.required).toEqual(["label", "columns"]);
  });

  it("ColumnSpec の必須3件(unit は optional)", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.properties.columns.items.required).toEqual(
      ["id", "label", "type"],
    );
  });

  it("ApprovalStep は2件とも required", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.approvalFlow.anyOf[0].items.required).toEqual([
      "name",
      "role",
    ]);
  });

  it("AggregationSpec の必須4件(unit は optional)", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.aggregations.items.required).toEqual([
      "id",
      "label",
      "fieldId",
      "op",
    ]);
  });

  it("firstRecord の {fieldId, value} は2件とも required", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.firstRecord.items.required).toEqual([
      "fieldId",
      "value",
    ]);
  });

  it("optional プロパティは required に昇格していない(ネストで全キーrequiredを要求しないこと)", () => {
    // Anthropic の structured outputs が必須にするのは additionalProperties: false であって、
    // OpenAI strict mode のような「全プロパティを required に列挙せよ」ではない。
    // ここを「揃える」修正は TS 型との乖離を生むので誤り。
    const S = ANALYZE_OUTPUT_JSON_SCHEMA;
    for (const optional of ["options", "unit", "sourceBox"]) {
      expect(S.properties.fields.items.required).not.toContain(optional);
    }
    expect(S.properties.lineItems.properties.columns.items.required).not.toContain("unit");
    expect(S.properties.aggregations.items.required).not.toContain("unit");
    expect(S.properties.lineItems.required).not.toContain("sourceBox");
  });
});

describe("ANALYZE_OUTPUT_JSON_SCHEMA: min/max は意図的に非搭載", () => {
  // FieldSpec.min/max と ColumnSpec.min/max は「日本語で書いて直す」で後付けされる値で、
  // 解析経路(LLM出力)では使わない。乖離ではなく設計判断なので凍結する。
  // 補足: structured outputs は minimum/maximum 等の数値制約キーワード自体を非サポート。
  it("fields.items の properties は8件で、min/max を含まない", () => {
    expect(Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields.items.properties)).toEqual([
      "id",
      "label",
      "type",
      "required",
      "options",
      "unit",
      "confidence",
      "sourceBox",
    ]);
  });

  it("lineItems.columns.items の properties は4件で、min/max を含まない", () => {
    expect(
      Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.properties.columns.items.properties),
    ).toEqual(["id", "label", "type", "unit"]);
  });

  it("スキーマ全体に minimum/maximum などの数値制約キーワードが混入していない", () => {
    const used = new Set<string>();
    for (const hit of walkSchema(SCHEMA, () => true)) {
      for (const kw of Object.keys(hit.node)) used.add(kw);
    }
    for (const numeric of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      expect([...used]).not.toContain(numeric);
    }
  });
});

/* ============================================================================
 * enum と TS union の同期
 *
 * Record<Union, true> は tsc が網羅性を強制するので、
 *   union → このオブジェクト  … `tsc --noEmit` が保証（メンバ追加/削除で型エラー）
 *   このオブジェクト → enum   … 下のランタイムテストが保証
 * の2段で union ⇄ enum が繋がる。
 * ==========================================================================*/

const FIELD_TYPE_MEMBERS: Record<FieldType, true> = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  select: true,
  checkbox: true,
  phone: true,
  stamp: true,
};

const COLUMN_TYPE_MEMBERS: Record<ColumnSpec["type"], true> = {
  text: true,
  number: true,
  date: true,
};

const AGG_OP_MEMBERS: Record<AggregationSpec["op"], true> = {
  sum: true,
  count: true,
  avg: true,
};

describe("ANALYZE_OUTPUT_JSON_SCHEMA: enum が TS union と完全一致", () => {
  it("fields.items.type.enum は FieldType の8メンバと宣言順まで一致", () => {
    const enumValues = ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields.items.properties.type.enum;
    expect(enumValues).toEqual([
      "text",
      "textarea",
      "number",
      "date",
      "select",
      "checkbox",
      "phone",
      "stamp",
    ]);
    expect([...enumValues].sort()).toEqual(Object.keys(FIELD_TYPE_MEMBERS).sort());
  });

  it("enum 外の fieldType(email)はバリデータで弾かれる", () => {
    const sample = validSample();
    (sample.fields as Record<string, unknown>[])[0].type = "email";
    expect(validateOutput(sample)).toContainEqual({ path: "$.fields[0].type", keyword: "enum" });
  });

  it("columns.items.type.enum は ColumnSpec['type'] の3値と一致(select/stamp等は許さない)", () => {
    const enumValues =
      ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.properties.columns.items.properties.type.enum;
    expect(enumValues).toEqual(["text", "number", "date"]);
    expect([...enumValues].sort()).toEqual(Object.keys(COLUMN_TYPE_MEMBERS).sort());
  });

  it("明細列の3値は FieldType の真部分集合(差分は textarea/select/checkbox/phone/stamp)", () => {
    const colTypes = Object.keys(COLUMN_TYPE_MEMBERS);
    const fieldTypes = Object.keys(FIELD_TYPE_MEMBERS);
    expect(colTypes.every((t) => fieldTypes.includes(t))).toBe(true);
    expect(fieldTypes.filter((t) => !colTypes.includes(t)).sort()).toEqual(
      ["checkbox", "phone", "select", "stamp", "textarea"].sort(),
    );
  });

  it("enum 外の列タイプ(select)はバリデータで弾かれる", () => {
    const sample = validSample();
    ((sample.lineItems as Record<string, unknown>).columns as Record<string, unknown>[])[0].type =
      "select";
    expect(validateOutput(sample)).toContainEqual({
      path: "$.lineItems.columns[0].type",
      keyword: "enum",
    });
  });

  it("aggregations.items.op.enum は AggregationSpec['op'] の3値と一致", () => {
    const enumValues = ANALYZE_OUTPUT_JSON_SCHEMA.properties.aggregations.items.properties.op.enum;
    expect(enumValues).toEqual(["sum", "count", "avg"]);
    expect([...enumValues].sort()).toEqual(Object.keys(AGG_OP_MEMBERS).sort());
  });

  it("enum 外の集計演算(median)はバリデータで弾かれる", () => {
    const sample = validSample();
    (sample.aggregations as Record<string, unknown>[])[0].op = "median";
    expect(validateOutput(sample)).toContainEqual({
      path: "$.aggregations[0].op",
      keyword: "enum",
    });
  });
});

/* ============================================================================
 * null 許容の表現
 * ==========================================================================*/

describe("ANALYZE_OUTPUT_JSON_SCHEMA: null 許容のイディオムが2種類混在している", () => {
  // approvalFlow は anyOf[array, null]（コメントで「structured outputs が明示サポート」と明記）、
  // lineItems は type: ["object","null"]。プラットフォームの文書でサポートが明示されているのは
  // anyOf の方なので、統一するなら anyOf 側へ寄せる判断になる。
  // ここでは現状値を凍結し、意図しない書き換えを検知することに徹する。
  it("lineItems は type: ['object','null'] で null を表現している", () => {
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.properties.lineItems.type).toEqual(["object", "null"]);
  });

  it("approvalFlow は anyOf[array, null] で null を表現している", () => {
    const anyOf = ANALYZE_OUTPUT_JSON_SCHEMA.properties.approvalFlow.anyOf;
    expect(anyOf).toHaveLength(2);
    expect(anyOf[0].type).toBe("array");
    expect(anyOf[1]).toEqual({ type: "null" });
  });

  it("どちらの書き方でも null は実際に受理される", () => {
    const noLineItems = { ...validSample(), lineItems: null, lineRows: [] };
    expect(validateOutput(noLineItems)).toEqual([]);
    const noApproval = { ...validSample(), approvalFlow: null };
    expect(validateOutput(noApproval)).toEqual([]);
  });

  it("approvalFlow の空配列もスキーマ上は valid(minItems が無いため)", () => {
    // 注意: アプリ側の意味論は「承認業務なし = null」。空配列と null で意味が二重化している。
    // スキーマは両方通すので、プロンプト側で null に寄せる責務がある。
    expect(validateOutput({ ...validSample(), approvalFlow: [] })).toEqual([]);
  });
});

describe("ANALYZE_OUTPUT_JSON_SCHEMA: プロパティ宣言順は claude-live のストリーミング前提", () => {
  it("properties の宣言順が凍結されている(fields は description の直後)", () => {
    // claude-live.ts:263-296 のプログレッシブ描画は「スキーマ順で fields は description の直後」
    // に依存し、"fields":[ が現れた時点で description の文字列が閉じたと判断している。
    // 並べ替えると型チェックもテストも通るのに描画だけ壊れるサイレント回帰になる。
    expect(Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties)).toEqual([
      "appName",
      "icon",
      "description",
      "fields",
      "lineItems",
      "lineRows",
      "listColumns",
      "approvalFlow",
      "aggregations",
      "firstRecord",
    ]);
  });
});

describe("ANALYZE_OUTPUT_JSON_SCHEMA: 共有ミュータブル定数の保護", () => {
  it("`as const` はランタイムの凍結を与えないので、テストは絶対にこの定数を変異させない", () => {
    // Object.isFrozen === false = 誰かが書き換えたら同一モジュールを共有する全テストに漏れる。
    // ネガティブケースは常にサンプルデータ側を変異させること。
    expect(Object.isFrozen(ANALYZE_OUTPUT_JSON_SCHEMA)).toBe(false);
    // 上の全 describe を通過した時点でも構造が無傷であることを確認する
    expect(Object.keys(ANALYZE_OUTPUT_JSON_SCHEMA.properties.fields.items.properties)).toHaveLength(
      8,
    );
    expect(ANALYZE_OUTPUT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

/* ============================================================================
 * モジュール横断の enum 整合（specdiff）
 * ==========================================================================*/

describe("モジュール横断: specdiff の enum が appspec の型と同期している", () => {
  const specForTools = {
    appName: "注文管理",
    icon: "📦",
    description: "d",
    fields: [field("total", "number"), field("memo", "text")],
    lineItems: null,
    listColumns: [],
    approvalFlow: null,
    aggregations: [],
    firstRecord: {},
    firstRecordLines: [],
  };

  const addFieldTool = () => {
    const tool = buildReconfigureTools(specForTools).find((t) => t.name === "add_field");
    if (!tool) throw new Error("add_field ツールが見つからない");
    return tool.input_schema as unknown as SchemaNode;
  };

  it("add_field の fieldType enum は FieldType から stamp/phone をちょうど除いた6値", () => {
    // SpecDiff の addField は Exclude<FieldType, "stamp" | "phone">。
    // 「日本語で書いて直す」で判子欄・電話欄を新規追加させない設計。
    const schema = addFieldTool();
    const enumValues = schema.properties?.fieldType.enum as string[];
    expect(enumValues).toEqual(["text", "textarea", "number", "date", "select", "checkbox"]);

    const fieldTypes = Object.keys(FIELD_TYPE_MEMBERS);
    expect(enumValues.every((t) => fieldTypes.includes(t))).toBe(true);
    expect(fieldTypes.filter((t) => !enumValues.includes(t)).sort()).toEqual(["phone", "stamp"]);
  });

  it("tool定義の enum 6値はフォールバック実装でも素通りする(text に潰されない)", () => {
    // tool の enum と toolCallToDiff 内の allowed 配列がズレると、
    // LLM が発行した値が黙って "text" に潰される。
    const enumValues = addFieldTool().properties?.fieldType.enum as string[];
    for (const ft of enumValues) {
      const diff = toolCallToDiff("add_field", { id: "x", label: "X", fieldType: ft });
      expect(diff).toMatchObject({ op: "addField", fieldType: ft });
    }
  });

  it("enum 外の fieldType(stamp/phone/未知)は text にフォールバックする", () => {
    for (const ft of ["stamp", "phone", "email"]) {
      const diff = toolCallToDiff("add_field", { id: "x", label: "X", fieldType: ft });
      expect(diff).toMatchObject({ op: "addField", fieldType: "text" });
    }
  });

  it("add_aggregation の agg enum は AggregationSpec['op'] の3値と一致し、全て素通りする", () => {
    const tool = buildReconfigureTools(specForTools).find((t) => t.name === "add_aggregation");
    if (!tool) throw new Error("add_aggregation ツールが見つからない");
    const enumValues = (tool.input_schema as unknown as SchemaNode).properties?.agg.enum as string[];
    expect([...enumValues].sort()).toEqual(Object.keys(AGG_OP_MEMBERS).sort());
    for (const op of enumValues) {
      expect(toolCallToDiff("add_aggregation", { label: "L", fieldId: "total", agg: op })).toMatchObject(
        { op: "addAggregation", agg: op },
      );
    }
    // 範囲外は sum にフォールバック
    expect(
      toolCallToDiff("add_aggregation", { label: "L", fieldId: "total", agg: "median" }),
    ).toMatchObject({ agg: "sum" });
  });
});

/* ============================================================================
 * toAppSpec — ワイヤ型 → 内部型の変換
 * ==========================================================================*/

describe("toAppSpec: number フィールドの数値化", () => {
  const numeric = (value: string) =>
    toAppSpec(
      analyzeOutput({
        fields: [field("amount", "number")],
        firstRecord: [{ fieldId: "amount", value }],
      }),
    ).firstRecord.amount;

  it.each([
    // [入力, 期待値, 意図]
    ["1,096.100", 1096.1, "桁区切りカンマを除去して小数として解釈"],
    // 注意: 後置の「円」は parseFloat が勝手に読み飛ばすので、この行だけでは
    // 正規表現の「円」除去が効いているかを判定できない。前置ケースを下に置いて補う。
    [" ¥1,200円 ", 1200, "通貨記号・カンマ・前後空白を除去"],
    ["円1200", 1200, "前置の『円』は正規表現でしか落とせない(parseFloat は先頭で止まる)"],
    ["-5", -5, "負数はそのまま"],
    ["3 000", 3000, "全角でない空白区切りも除去して連結"],
    ["0", 0, "ゼロは falsy だが number として保持される"],
  ])("'%s' → %s (%s)", (input, expected) => {
    expect(numeric(input as string)).toBe(expected);
  });

  it.each([
    ["", "空文字は 0 ではなく空文字のまま(未入力と 0 を区別する)"],
    ["abc", "数値化できない文字列は原文を保持"],
    ["１２３", "全角数字は parseFloat が解釈しないので文字列のまま(OCR由来で現実に起きる)"],
    ["Infinity", "Number.isFinite が false なので数値化しない"],
  ])("'%s' は文字列のまま残る (%s)", (input) => {
    const result = numeric(input);
    expect(result).toBe(input);
    expect(typeof result).toBe("string");
  });

  describe("parseFloat の部分パース(既知の緩さ。仕様として凍結する)", () => {
    it.each([
      ["12abc", 12, "先頭の数値だけを拾って残りを捨てる"],
      ["1.2.3", 1.2, "2つ目の小数点以降を捨てる"],
      ["0x10", 0, "parseFloat は16進数を解さず先頭の 0 だけを読む"],
      ["1,2,3", 123, "カンマ除去後に 123 という1つの数として読まれる"],
      ["12%", 12, "パーセント記号は除去対象外だが parseFloat が無視する"],
    ])("'%s' → %s (%s)", (input, expected) => {
      expect(numeric(input as string)).toBe(expected);
    });
  });
});

describe("toAppSpec: checkbox/stamp の真偽値化はホワイトリスト完全一致", () => {
  const truthy = (value: string) => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("ok", "checkbox"), field("hanko", "stamp")],
        firstRecord: [
          { fieldId: "ok", value },
          { fieldId: "hanko", value },
        ],
      }),
    );
    expect(out.firstRecord.ok).toBe(out.firstRecord.hanko); // checkbox と stamp は同一ロジック
    return out.firstRecord.ok;
  };

  it.each([
    ["true", "英字リテラル"],
    [" true ", "trim 後に一致すればよい"],
    ["はい", "日本語の肯定"],
    ["○", "○ = U+25CB WHITE CIRCLE。ホワイトリストに載っている方の丸"],
    ["済", "押印済みの略記"],
    ["有", "有無記入欄"],
    ["1", "数字の1"],
  ])("'%s' は true (%s)", (input) => {
    expect(truthy(input)).toBe(true);
  });

  it.each([
    ["false", "明示的な否定"],
    ["いいえ", "日本語の否定"],
    ["0", "数字のゼロ"],
    ["TRUE", "大文字は吸収しない(完全一致のため)"],
    ["有り", "接尾辞が付くと一致しない"],
    ["×", "× = U+00D7。否定記号"],
    ["レ", "チェックマーク代わりのカタカナは未対応"],
    ["◯", "◯ = U+25EF LARGE CIRCLE。○(U+25CB)と見た目が近いが別コードポイントなので false"],
    ["", "空文字"],
  ])("'%s' は false (%s)", (input) => {
    expect(truthy(input)).toBe(false);
  });
});

describe("toAppSpec: firstRecord の fieldId 解決", () => {
  it("fields に存在しない fieldId は record に入らない(LLMの幻覚の混入防止)", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("memo", "text")],
        firstRecord: [{ fieldId: "nope", value: "x" }],
      }),
    );
    expect(out.firstRecord).toEqual({});
  });

  it("同一 fieldId が複数回来たら後勝ちで上書きされる", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("memo", "text")],
        firstRecord: [
          { fieldId: "memo", value: "first" },
          { fieldId: "memo", value: "second" },
        ],
      }),
    );
    expect(out.firstRecord).toEqual({ memo: "second" });
  });

  it("number/checkbox/stamp 以外は trim 済みの文字列がそのまま入る", () => {
    const types: FieldType[] = ["text", "textarea", "date", "select", "phone"];
    const out = toAppSpec(
      analyzeOutput({
        fields: types.map((t) => field(t, t)),
        firstRecord: types.map((t) => ({ fieldId: t, value: `  ${t}の値  ` })),
      }),
    );
    expect(out.firstRecord).toEqual({
      text: "textの値",
      textarea: "textareaの値",
      date: "dateの値",
      select: "selectの値",
      phone: "phoneの値",
    });
  });
});

describe("toAppSpec: 戻り値の形", () => {
  const out = toAppSpec(
    analyzeOutput({
      fields: [field("memo", "text")],
      firstRecord: [{ fieldId: "memo", value: "m" }],
    }),
  );

  it("AppSpec の10キーを持ち、ワイヤ専用の lineRows は消えている", () => {
    expect(Object.keys(out)).toEqual([
      "appName",
      "icon",
      "description",
      "fields",
      "lineItems",
      "listColumns",
      "approvalFlow",
      "aggregations",
      "firstRecord",
      "firstRecordLines",
    ]);
    expect("lineRows" in out).toBe(false);
  });

  it("firstRecord は配列ではなく Record に置き換わっている", () => {
    // `{ ...rest, firstRecord: record }` のプロパティ順が load-bearing。
    // 順序を入れ替えると rest 側のワイヤ型(ペア配列)が漏れる回帰になる。
    expect(Array.isArray(out.firstRecord)).toBe(false);
    expect(out.firstRecord).toEqual({ memo: "m" });
    expect(Array.isArray(out.firstRecordLines)).toBe(true);
  });

  it("浅いコピーなので fields/lineItems は入力と同一参照(戻り値を破壊的変更しないこと)", () => {
    const input = analyzeOutput({
      fields: [field("memo", "text")],
      lineItems: { label: "明細", columns: [{ id: "name", label: "品名", type: "text" }] },
    });
    const result = toAppSpec(input);
    expect(result.fields).toBe(input.fields);
    expect(result.lineItems).toBe(input.lineItems);
  });
});

describe("toAppSpec: 明細行(lineRows → firstRecordLines)", () => {
  const lineItems: LineItemsSpec = {
    label: "注文明細",
    columns: [
      { id: "name", label: "品名", type: "text" },
      { id: "qty", label: "数量", type: "number" },
      { id: "price", label: "単価", type: "number" },
    ],
  };
  const lines = (lineRows: string[][]) =>
    toAppSpec(analyzeOutput({ lineItems, lineRows })).firstRecordLines;

  it("各セルは columns と同順で対応付けられ、number 列だけ数値化される", () => {
    expect(lines([["ボルト", "3", "150"]])).toEqual([{ name: "ボルト", qty: 3, price: 150 }]);
  });

  it("値の前後空白と単位は列単位で除去される", () => {
    expect(lines([["  ボルト  ", " 3 ", " 1,500円 "]])).toEqual([
      { name: "ボルト", qty: 3, price: 1500 },
    ]);
  });

  it("空欄の列はキーごと省略される(疎な LineRecord)", () => {
    const [row] = lines([["ボルト", "", "150"]]);
    expect(row).toEqual({ name: "ボルト", price: 150 });
    expect("qty" in row).toBe(false); // 空文字や 0 ではなくキーが存在しない
  });

  it("列数が足りない行は不足分を空として扱う", () => {
    expect(lines([["ボルト"]])).toEqual([{ name: "ボルト" }]);
  });

  it("columns 数を超えた値は無視される", () => {
    expect(lines([["ボルト", "3", "150", "EXTRA"]])).toEqual([
      { name: "ボルト", qty: 3, price: 150 },
    ]);
  });

  it("全列が空の行は行ごと捨てられる", () => {
    expect(lines([["", "", ""]])).toEqual([]);
  });

  it("空行が落ちるため firstRecordLines の添字は lineRows の添字と一致しない", () => {
    // 元帳票の行番号との対応付けを期待値に埋め込むと壊れる、という注意の固定化。
    const result = lines([
      ["a", "1", "1"],
      ["", "", ""],
      ["b", "2", "2"],
    ]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ name: "b", qty: 2, price: 2 }); // 元は3行目
  });

  it("lineItems が null なら lineRows に値があっても firstRecordLines は空", () => {
    expect(toAppSpec(analyzeOutput({ lineItems: null, lineRows: [["a", "b"]] })).firstRecordLines).toEqual(
      [],
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
  ])("lineRows が %s でも throw せず空配列を返す", (_label, value) => {
    const out = analyzeOutput({ lineItems });
    (out as { lineRows: unknown }).lineRows = value;
    expect(toAppSpec(out).firstRecordLines).toEqual([]);
  });
});

describe("toAppSpec: 壊れた入力は検証されず throw する(現状仕様の固定)", () => {
  // claude-live.ts は `JSON.parse(text) as AnalyzeOutput` と cast しているだけで、
  // toAppSpec 側にも入力検証は無い。防御を入れるかは設計判断だが、
  // 「静かに壊れたデータを通す」のではなく「落ちる」ことは現状の重要な性質。
  it("firstRecord の value が欠けていると、未知 fieldId であっても trim で落ちる", () => {
    // value.trim() が `if (!field) continue` より前に実行されるため、
    // fields に無い fieldId でも早期 continue に到達しない。
    const out = analyzeOutput({
      fields: [],
      firstRecord: [{ fieldId: "nope" } as unknown as { fieldId: string; value: string }],
    });
    expect(() => toAppSpec(out)).toThrow(TypeError);
  });

  it("firstRecord が配列でないと iterate できず落ちる", () => {
    const out = analyzeOutput();
    (out as { firstRecord: unknown }).firstRecord = null;
    expect(() => toAppSpec(out)).toThrow(/not iterable/);
  });

  it("明細セルが文字列でない(数値など)と trim できず落ちる", () => {
    const out = analyzeOutput({
      lineItems: { label: "明細", columns: [{ id: "a", label: "A", type: "text" }] },
    });
    (out as { lineRows: unknown }).lineRows = [[1]];
    expect(() => toAppSpec(out)).toThrow(TypeError);
  });
});

describe("toAppSpec: fields と明細列の id 衝突は列側の決定論的リネームで解消する(F03 解析経路)", () => {
  // モデルが最初の解析で fields と lineItems.columns に同じ id を吐くと、
  // 以後 renameField / setNumberLimit が fields 側を先に拾い明細列に届かなくなる。
  // 解析結果は拒否できない(ライブ本番で「エラーで空」が最悪)ため、
  // 衝突した列 id に連番接尾辞を付けて逃がす。fields 側の id は
  // firstRecord / listColumns / aggregations.fieldId から参照されるため動かさない。

  it("衝突がなければ lineItems は入力と同一参照のまま(リネーム経路を通らない)", () => {
    const input = analyzeOutput({
      fields: [field("total", "number")],
      lineItems: { label: "明細", columns: [{ id: "name", label: "品名", type: "text" }] },
    });
    const out = toAppSpec(input);
    expect(out.lineItems).toBe(input.lineItems);
  });

  it("衝突した列 id には _2 が付き、id 以外(label/type/unit)と lineItems.label/sourceBox は保たれる", () => {
    const input = analyzeOutput({
      fields: [field("unit_price", "number")],
      lineItems: {
        label: "注文明細",
        columns: [{ id: "unit_price", label: "単価", type: "number", unit: "円" }],
        sourceBox: { x: 1, y: 2, w: 3, h: 4 },
      },
    });
    const out = toAppSpec(input);
    expect(out.lineItems?.columns).toEqual([
      { id: "unit_price_2", label: "単価", type: "number", unit: "円" },
    ]);
    expect(out.lineItems?.label).toBe("注文明細");
    expect(out.lineItems?.sourceBox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("fields 側の id と firstRecord のキーは変わらない(sourceBox・集計・一覧の参照を壊さない)", () => {
    const input = analyzeOutput({
      fields: [field("unit_price", "number")],
      lineItems: {
        label: "明細",
        columns: [{ id: "unit_price", label: "単価", type: "number" }],
      },
      firstRecord: [{ fieldId: "unit_price", value: "500" }],
    });
    const out = toAppSpec(input);
    expect(out.fields).toBe(input.fields);
    expect(out.firstRecord).toEqual({ unit_price: 500 });
  });

  it("firstRecordLines のキーはリネーム後の列 id になる(lineRows は位置対応なので値は落ちない)", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("qty", "number")],
        lineItems: {
          label: "明細",
          columns: [
            { id: "name", label: "品名", type: "text" },
            { id: "qty", label: "数量", type: "number" },
          ],
        },
        lineRows: [["ボルト", "3"]],
      }),
    );
    expect(out.firstRecordLines).toEqual([{ name: "ボルト", qty_2: 3 }]);
  });

  it("複数の列が衝突すればそれぞれ独立にリネームされる", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("qty", "number"), field("price", "number")],
        lineItems: {
          label: "明細",
          columns: [
            { id: "name", label: "品名", type: "text" },
            { id: "qty", label: "数量", type: "number" },
            { id: "price", label: "単価", type: "number" },
          ],
        },
      }),
    );
    expect(out.lineItems?.columns.map((c) => c.id)).toEqual(["name", "qty_2", "price_2"]);
  });

  it("接尾辞 _2 が fields 側の既存 id と再衝突する場合は空くまで連番を進める", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("qty", "number"), field("qty_2", "number")],
        lineItems: {
          label: "明細",
          columns: [{ id: "qty", label: "数量", type: "number" }],
        },
      }),
    );
    expect(out.lineItems?.columns.map((c) => c.id)).toEqual(["qty_3"]);
  });

  it("接尾辞 _2 が別の明細列と再衝突する場合も空くまで連番を進める(列同士の新規衝突を作らない)", () => {
    const out = toAppSpec(
      analyzeOutput({
        fields: [field("qty", "number")],
        lineItems: {
          label: "明細",
          columns: [
            { id: "qty", label: "数量", type: "number" },
            { id: "qty_2", label: "予備", type: "number" },
          ],
        },
      }),
    );
    expect(out.lineItems?.columns.map((c) => c.id)).toEqual(["qty_3", "qty_2"]);
  });

  it("決定論: 同じ入力を2回変換すると完全に同じ結果になる", () => {
    const make = () =>
      analyzeOutput({
        fields: [field("qty", "number"), field("qty_2", "number")],
        lineItems: {
          label: "明細",
          columns: [
            { id: "qty", label: "数量", type: "number" },
            { id: "qty", label: "重複数量", type: "number" },
          ],
        },
        lineRows: [["3", "4"]],
      });
    const a = toAppSpec(make());
    const b = toAppSpec(make());
    expect(a).toEqual(b);
    // 同一 id の列が両方衝突しても、先勝ちの連番で互いに区別される
    expect(a.lineItems?.columns.map((c) => c.id)).toEqual(["qty_3", "qty_4"]);
  });

  it("横断: リネーム後は setNumberLimit / renameField が fields と明細列の両方に届く(F03 の実害の解消)", () => {
    const spec = toAppSpec(
      analyzeOutput({
        fields: [field("unit_price", "number")],
        lineItems: {
          label: "明細",
          columns: [{ id: "unit_price", label: "単価", type: "number" }],
        },
      }),
    );
    // fields 側: 元の id で届く
    const r1 = applyDiff(spec, { op: "setNumberLimit", fieldId: "unit_price", max: 100 });
    expect(r1.ok).toBe(true);
    expect(r1.spec.fields[0].max).toBe(100);
    expect(r1.spec.lineItems?.columns[0].max).toBeUndefined();
    // 明細列側: リネーム後の id で届く(修正前は到達不能だった)
    const r2 = applyDiff(spec, { op: "setNumberLimit", fieldId: "unit_price_2", max: 200 });
    expect(r2.ok).toBe(true);
    expect(r2.spec.lineItems?.columns[0].max).toBe(200);
    expect(r2.spec.fields[0].max).toBeUndefined();
    const r3 = applyDiff(spec, { op: "renameField", fieldId: "unit_price_2", label: "仕入単価" });
    expect(r3.ok).toBe(true);
    expect(r3.spec.lineItems?.columns[0].label).toBe("仕入単価");
    expect(r3.spec.fields[0].label).toBe("unit_price");
  });
});
