// LLMクライアントファクトリ — OrcaRouter / 直接Anthropic / デモのみ、の経路解決を一元化する。
//
// 経路解決の優先順位:
//   1. LLM_FORCE_DIRECT=1 … OrcaRouterを無視して直接Anthropicに強制(障害時の保険。運用方針ブース設計が参照)
//   2. ORCAROUTER_API_KEY … OrcaRouter経由(Anthropicプロトコル互換 /v1/messages・Bearer認証)
//   3. ANTHROPIC_API_KEY  … 従来どおり直接Anthropic
//   4. どれも無ければ null … 呼び出し元はデモモードで動く
//
// OrcaRouter実測(2026-08-08):
//   - モデルIDはドット表記 anthropic/claude-opus-4.8(ハイフン表記 claude-opus-4-8 は model_not_found)
//   - SSEストリーミング / tool use は透過
//   - structured outputs(output_config)は握りつぶされる: エラーにはならないが応答が
//     ```json フェンス付きになる=サーバー側スキーマ強制なし。受信側は
//     フェンス耐性パーサ(partial-json.ts)とアプリ側スキーマ検証(validate-spec.ts)で防御する

import Anthropic from "@anthropic-ai/sdk";

/** 全LLM呼び出しで使う既定モデル(Anthropic表記)。OrcaRouter向けの変換は getLlmClient が行う */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";

export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai";

/** UI表示・ログ用の経路情報 */
export type LlmRoute = "orcarouter" | "anthropic";

export interface LlmClient {
  client: Anthropic;
  /** 経路に応じて変換済みのモデルID(このままリクエストに渡す) */
  model: string;
  route: LlmRoute;
}

/**
 * AnthropicのモデルID(ハイフン表記)をOrcaRouterのID(anthropic/プレフィクス+ドット表記)へ変換する。
 * 例: claude-opus-4-8 → anthropic/claude-opus-4.8、claude-opus-5 → anthropic/claude-opus-5
 * 末尾に連続する数値セグメントをバージョンとみなして "." で連結する。
 * すでに "/" を含むID(プロバイダ表記)はそのまま返す。
 */
export function toOrcaRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  const segments = model.split("-");
  let firstNumeric = segments.length;
  while (firstNumeric > 0 && /^\d+$/.test(segments[firstNumeric - 1])) firstNumeric--;
  if (firstNumeric === segments.length) return `anthropic/${model}`; // 数値バージョンなし
  const name = segments.slice(0, firstNumeric).join("-");
  const version = segments.slice(firstNumeric).join(".");
  return `anthropic/${name}-${version}`;
}

/**
 * 環境変数からLLM経路を決定する(クライアント生成なしの純粋な判定)。
 * null = キーなし(デモモードのみ)。
 */
export function resolveLlmRoute(): LlmRoute | null {
  const forceDirect = process.env.LLM_FORCE_DIRECT === "1";
  if (!forceDirect && process.env.ORCAROUTER_API_KEY) return "orcarouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

/** ライブ経路が使えるか(analyze/reconfigure のライブ/デモ分岐用) */
export function hasLlmClient(): boolean {
  return resolveLlmRoute() !== null;
}

/**
 * 経路に応じたクライアントと変換済みモデルIDを返す。キーが無ければ null(=デモモード)。
 */
export function getLlmClient(model: string = DEFAULT_CLAUDE_MODEL): LlmClient | null {
  const route = resolveLlmRoute();
  if (route === null) return null;
  if (route === "orcarouter") {
    return {
      route,
      model: toOrcaRouterModelId(model),
      client: new Anthropic({
        baseURL: ORCAROUTER_BASE_URL,
        // OrcaRouterは Authorization: Bearer 認証。apiKey: null で
        // ANTHROPIC_API_KEY 環境変数からの x-api-key 送出を明示的に無効化する
        // (両ヘッダ同時送出は拒否されうる)
        authToken: process.env.ORCAROUTER_API_KEY,
        apiKey: null,
      }),
    };
  }
  return { route, model, client: new Anthropic() };
}
