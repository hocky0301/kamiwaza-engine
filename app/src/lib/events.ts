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
import type { LlmRoute } from "./llm-client";

/**
 * LLM呼び出しのトークン使用量(実測値のみ。デモ経路では付与しない=捏造しない)。
 * 合計プロンプト量は inputTokens + cacheCreationInputTokens + cacheReadInputTokens の和。
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** 原価推定に使った単価の出典: live=/v1/models実測 / fallback=定数($5/$25) */
export type PricingSource = "live" | "fallback";

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
  /**
   * lines は両経路が送出するが現行クライアントは読まない(明細表示は lineitems の
   * rowCount と done.spec.firstRecordLines のみ)。削除はワイヤ形式の変更になるため据え置き
   */
  | { type: "record"; record: AppRecord; lines?: LineRecord[] }
  | { type: "question"; fieldId: string; question: string; choices: string[] }
  /**
   * ライブ解析の最終JSONに対するアプリ側スキーマ検証の結果(誠実性の可視化)。
   * ok: false のときは直後にライブ解析が失敗扱いとなり、デモフォールバックに流れる。
   */
  | { type: "validation"; ok: boolean; violations: number }
  | {
      type: "done";
      spec: AppSpec;
      mode: "demo" | "live";
      scenarioId?: string;
      /** ライブ経路のみ: 回転検出+本解析の合計トークン使用量 */
      usage?: LlmUsage;
      /** ライブ経路のみ: どのLLM経路を通ったか(UI表示・ログ用) */
      llmRoute?: LlmRoute;
      /** ライブ経路のみ: usage×公表単価による推定原価(USD)。課金の正はダッシュボード */
      costUsd?: number;
      /** 単価の出典: live=/v1/models実測 / fallback=定数($5/$25) */
      pricingSource?: PricingSource;
      /**
       * ライブ解析が失敗してデモへフォールバックしたときのみ。
       * 失敗までに消費したトークンの推定原価(USD)。
       * これが入っている done は mode:"demo" だが原価は $0 ではない。
       */
      abortedLiveCostUsd?: number;
      /** 同上: 失敗までに消費したトークン使用量 */
      abortedLiveUsage?: LlmUsage;
    }
  | { type: "error"; message: string };

export function sseLine(event: AnalyzeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * ライブ解析が途中で失敗し、デモリプレイへフォールバックしたときに、
 * done イベントへ「失敗までに実際に消費した分」を載せる。
 *
 * なぜ必要か: デモの done は mode:"demo" で usage を持たないため、画面は
 * 「デモ再生: LLM呼び出しなし(原価 $0)」と表示する。しかしライブが
 * finalMessage 取得後(refusal / max_tokens / JSON抽出失敗 / スキーマ違反)に
 * 落ちた場合、トークンは既に課金されている。$0 と表示すると無料だと誤認させる。
 *
 * 消費が0のとき(キー未設定・接続前に失敗)は何も足さない=本当に $0。
 */
export function withAbortedLiveCost(
  event: AnalyzeEvent,
  consumed: { usage: LlmUsage; costUsd: number | null },
): AnalyzeEvent {
  if (event.type !== "done") return event;
  const total =
    consumed.usage.inputTokens +
    consumed.usage.outputTokens +
    consumed.usage.cacheCreationInputTokens +
    consumed.usage.cacheReadInputTokens;
  if (total <= 0) return event;
  return {
    ...event,
    abortedLiveUsage: consumed.usage,
    abortedLiveCostUsd: consumed.costUsd ?? undefined,
  };
}
