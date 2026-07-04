// /api/analyze が流すSSEイベントのプロトコル。
// デモモード(リプレイ)もライブモード(Claude Vision)も同じイベント列を流すため、
// クライアントは接続先がどちらかを意識しない。

import type {
  AppSpec,
  FieldSpec,
  ApprovalStep,
  AggregationSpec,
  AppRecord,
} from "./appspec";

export type AnalyzeEvent =
  | { type: "phase"; label: string }
  | { type: "meta"; appName: string; icon: string; description: string }
  | { type: "field"; field: FieldSpec }
  | { type: "approval"; flow: ApprovalStep[] | null }
  | { type: "aggregation"; agg: AggregationSpec }
  | { type: "record"; record: AppRecord }
  | { type: "question"; fieldId: string; question: string; choices: string[] }
  | { type: "done"; spec: AppSpec; mode: "demo" | "live"; scenarioId?: string }
  | { type: "error"; message: string };

export function sseLine(event: AnalyzeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
