// /api/analyze が流すSSEイベントのプロトコル。
// デモモード(リプレイ)もライブモード(Claude Vision)も同じイベント列を流すため、
// クライアントは接続先がどちらかを意識しない。

import type {
  AppSpec,
  FieldSpec,
  ApprovalStep,
  AggregationSpec,
  AppRecord,
  LineItemsSpec,
  LineRecord,
} from "./appspec";

export type AnalyzeEvent =
  | { type: "phase"; label: string }
  /** 回転補正後の画像。クライアントは表示中の紙をこれに差し替える */
  | { type: "image"; dataUrl: string }
  | { type: "meta"; appName: string; icon: string; description: string }
  | { type: "field"; field: FieldSpec }
  /** 明細テーブルの定義(DSL v2) */
  | { type: "lineitems"; spec: LineItemsSpec; rowCount: number }
  | { type: "approval"; flow: ApprovalStep[] | null }
  | { type: "aggregation"; agg: AggregationSpec }
  | { type: "record"; record: AppRecord; lines?: LineRecord[] }
  | { type: "question"; fieldId: string; question: string; choices: string[] }
  | { type: "done"; spec: AppSpec; mode: "demo" | "live"; scenarioId?: string }
  | { type: "error"; message: string };

export function sseLine(event: AnalyzeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
