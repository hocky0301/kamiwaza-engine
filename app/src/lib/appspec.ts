// AppSpec DSL — カミワザの心臓部。
// LLMは生コードではなくこの制約されたスペックだけを出力し、
// 決定論的レンダラー(SpecApp)が描画する。

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "checkbox"
  | "phone"
  | "stamp";

export interface SourceBox {
  /** 元帳票画像上の位置(%座標, 0-100)。x,yは左上。 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FieldSpec {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** select用の選択肢 */
  options?: string[];
  /** number用の単位(円, 個, ℃ など) */
  unit?: string;
  /** 読み取り信頼度 0-1。低いと逆質問の対象になる */
  confidence: number;
  /** 元帳票のどこから読み取ったか */
  sourceBox?: SourceBox;
}

export interface ApprovalStep {
  name: string;
  role: string;
}

export interface AggregationSpec {
  id: string;
  label: string;
  fieldId: string;
  op: "sum" | "count" | "avg";
  unit?: string;
}

export type RecordValue = string | number | boolean;
export type AppRecord = Record<string, RecordValue>;

export interface AppSpec {
  appName: string;
  /** 絵文字1文字 */
  icon: string;
  description: string;
  fields: FieldSpec[];
  /** 一覧画面に出すフィールドID(4つ程度) */
  listColumns: string[];
  approvalFlow: ApprovalStep[] | null;
  aggregations: AggregationSpec[];
  /** 撮影した紙から読み取った1件目のレコード */
  firstRecord: AppRecord;
}

/**
 * ライブモードのワイヤ型。structured outputsは additionalProperties: false 必須のため、
 * 動的キーを持つ firstRecord だけ {fieldId, value} のペア配列で受け取り、
 * toAppSpec() でアプリ内部の AppSpec に変換する。
 */
export interface AnalyzeOutput extends Omit<AppSpec, "firstRecord"> {
  firstRecord: { fieldId: string; value: string }[];
}

export function toAppSpec(out: AnalyzeOutput): AppSpec {
  const record: AppRecord = {};
  for (const pair of out.firstRecord) {
    const field = out.fields.find((f) => f.id === pair.fieldId);
    const raw = pair.value.trim();
    if (!field) continue;
    if (field.type === "number") {
      const n = parseFloat(raw.replace(/[¥,円\s]/g, ""));
      record[pair.fieldId] = Number.isFinite(n) ? n : raw;
    } else if (field.type === "checkbox" || field.type === "stamp") {
      record[pair.fieldId] = ["true", "はい", "○", "済", "有", "1"].includes(raw);
    } else {
      record[pair.fieldId] = raw;
    }
  }
  return { ...out, firstRecord: record };
}

/**
 * ライブモードでClaudeのstructured outputsに渡すJSON Schema。
 * additionalProperties: false でスペック外の出力を封じる。
 */
export const ANALYZE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    appName: { type: "string", description: "業務アプリ名(日本語・簡潔に)" },
    icon: { type: "string", description: "アプリを表す絵文字1文字" },
    description: { type: "string", description: "この帳票業務の一行説明" },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "英小文字スネークケースのフィールドID" },
          label: { type: "string", description: "帳票に書かれている項目名" },
          type: {
            type: "string",
            enum: ["text", "textarea", "number", "date", "select", "checkbox", "phone", "stamp"],
          },
          required: { type: "boolean" },
          options: { type: "array", items: { type: "string" } },
          unit: { type: "string" },
          confidence: { type: "number", description: "読み取り信頼度 0-1" },
          sourceBox: {
            type: "object",
            description: "元画像上の位置(%座標)。左上原点、x,y,w,hすべて0-100",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
            required: ["x", "y", "w", "h"],
            additionalProperties: false,
          },
        },
        required: ["id", "label", "type", "required", "confidence"],
        additionalProperties: false,
      },
    },
    listColumns: {
      type: "array",
      items: { type: "string" },
      description: "一覧画面に表示するフィールドID(重要な順に最大4つ)",
    },
    approvalFlow: {
      // structured outputsが明示サポートする anyOf で array | null を表現
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string" },
            },
            required: ["name", "role"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
      description: "承認印欄など承認業務の存在が読み取れる場合のみ。最大2段+起票",
    },
    aggregations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          fieldId: { type: "string" },
          op: { type: "string", enum: ["sum", "count", "avg"] },
          unit: { type: "string" },
        },
        required: ["id", "label", "fieldId", "op"],
        additionalProperties: false,
      },
      description: "この業務でダッシュボードに出すべき集計(最大3つ)",
    },
    firstRecord: {
      type: "array",
      description:
        "帳票に手書きされている実データ。dateはYYYY-MM-DD、numberは数字のみの文字列、checkbox/stampは'true'か'false'",
      items: {
        type: "object",
        properties: {
          fieldId: { type: "string" },
          value: { type: "string" },
        },
        required: ["fieldId", "value"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "appName",
    "icon",
    "description",
    "fields",
    "listColumns",
    "approvalFlow",
    "aggregations",
    "firstRecord",
  ],
  additionalProperties: false,
} as const;
