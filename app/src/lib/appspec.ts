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

/* ---------- DSL v2: 明細行(lineItems) ---------- */

export interface ColumnSpec {
  id: string;
  label: string;
  type: "text" | "number" | "date";
  unit?: string;
}

export interface LineItemsSpec {
  /** 明細テーブルの名前(例: 注文明細) */
  label: string;
  columns: ColumnSpec[];
  /** 元帳票の明細テーブル全体の位置 */
  sourceBox?: SourceBox;
}

/** 明細1行。キーはColumnSpec.id */
export type LineRecord = Record<string, string | number>;

export interface AppSpec {
  appName: string;
  /** 絵文字1文字 */
  icon: string;
  description: string;
  fields: FieldSpec[];
  /** 明細テーブル定義(帳票に明細行がなければnull)— DSL v2 */
  lineItems: LineItemsSpec | null;
  /** 一覧画面に出すフィールドID(4つ程度) */
  listColumns: string[];
  approvalFlow: ApprovalStep[] | null;
  aggregations: AggregationSpec[];
  /** 撮影した紙から読み取った1件目のレコード */
  firstRecord: AppRecord;
  /** 1件目の明細行 — DSL v2 */
  firstRecordLines: LineRecord[];
}

/**
 * ライブモードのワイヤ型。structured outputsは additionalProperties: false 必須のため、
 * 動的キーを持つ firstRecord は {fieldId, value} のペア配列、
 * 明細行(lineRows)は columns と同順の文字列配列で受け取り、
 * toAppSpec() でアプリ内部の AppSpec に変換する。
 */
export interface AnalyzeOutput
  extends Omit<AppSpec, "firstRecord" | "firstRecordLines"> {
  firstRecord: { fieldId: string; value: string }[];
  /** 明細行。各行は lineItems.columns と同じ順の値(空欄は "") */
  lineRows: string[][];
}

function parseNumeric(raw: string): number | string {
  const n = parseFloat(raw.replace(/[¥,円\s]/g, ""));
  return Number.isFinite(n) ? n : raw;
}

export function toAppSpec(out: AnalyzeOutput): AppSpec {
  const record: AppRecord = {};
  for (const pair of out.firstRecord) {
    const field = out.fields.find((f) => f.id === pair.fieldId);
    const raw = pair.value.trim();
    if (!field) continue;
    if (field.type === "number") {
      record[pair.fieldId] = parseNumeric(raw);
    } else if (field.type === "checkbox" || field.type === "stamp") {
      record[pair.fieldId] = ["true", "はい", "○", "済", "有", "1"].includes(raw);
    } else {
      record[pair.fieldId] = raw;
    }
  }

  const lines: LineRecord[] = [];
  if (out.lineItems) {
    for (const row of out.lineRows ?? []) {
      const line: LineRecord = {};
      out.lineItems.columns.forEach((col, i) => {
        const raw = (row[i] ?? "").trim();
        if (raw === "") return;
        line[col.id] = col.type === "number" ? parseNumeric(raw) : raw;
      });
      if (Object.keys(line).length > 0) lines.push(line);
    }
  }

  const { lineRows: _lineRows, ...rest } = out;
  void _lineRows;
  return { ...rest, firstRecord: record, firstRecordLines: lines };
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
    lineItems: {
      type: ["object", "null"],
      description:
        "帳票に品目・行単位の明細テーブルがある場合のみ定義。なければnull。明細の値はfieldsに重複させない(合計金額などのサマリはfieldsへ)",
      properties: {
        label: { type: "string", description: "明細テーブルの名前(例: 注文明細)" },
        columns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "英小文字スネークケースの列ID" },
              label: { type: "string" },
              type: { type: "string", enum: ["text", "number", "date"] },
              unit: { type: "string" },
            },
            required: ["id", "label", "type"],
            additionalProperties: false,
          },
        },
        sourceBox: {
          type: "object",
          description: "明細テーブル全体の位置(%座標)",
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
      required: ["label", "columns"],
      additionalProperties: false,
    },
    lineRows: {
      type: "array",
      description:
        "明細の全行。各行はlineItems.columnsと同じ順の値の配列(空欄は空文字列)。lineItemsがnullなら空配列。行が20行を超える場合は主要20行+最終行に「ほか◯行」",
      items: { type: "array", items: { type: "string" } },
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
    "lineItems",
    "lineRows",
    "listColumns",
    "approvalFlow",
    "aggregations",
    "firstRecord",
  ],
  additionalProperties: false,
} as const;
