// 回転判定応答のパース(サーバー専用・純関数)。
//
// OrcaRouter経由では output_config(structured outputs)が透過されないため、
// 回転判定の応答が JSON ではなく散文(「0度です。この画像は…」)で返ることがある。
// 旧実装は JSON パースのみ → 散文は常に rotation 0 へフォールバックしており、
// 「本当に回転した紙が補正されない」形で回転補正が実質無効化されていた(F07)。
// さらに画像を見ずに妥当なJSONを返すケース(誤回転)も観測されたため、
// 非ゼロ判定は呼び出し側で二重確認(合議)してから適用する。
import { stripCodeFences, extractBalancedJson } from "./partial-json";

export type Rotation = 0 | 90 | 180 | 270;

const VALID: readonly number[] = [0, 90, 180, 270];

/**
 * 回転判定コールの応答テキストから回転角を抽出する。
 * 優先順: (1) JSON {"rotation": N} (2) フェンス除去+完結JSON抽出
 * (3) 散文パターン(「N度」「時計回りにN度」「回転させる必要はありません」)
 * どれにも該当しなければ null(判定不能。呼び出し側は 0 として扱う)。
 */
export function parseRotationResponse(text: string): Rotation | null {
  const stripped = stripCodeFences(text);
  for (const candidate of [stripped, extractBalancedJson(stripped)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as { rotation?: unknown };
      if (typeof parsed.rotation === "number" && VALID.includes(parsed.rotation)) {
        return parsed.rotation as Rotation;
      }
    } catch {
      // 散文パースへ続行
    }
  }
  // 散文: 明示的な「不要」表現は 0
  if (/回転させる必要はありません|回転(は)?不要|already.*correct/i.test(text)) {
    return 0;
  }
  // 「時計回りに90度」「答えは180度」「0度です」等の最初の角度表現を拾う。
  // 「90度回転している」(状態の記述)と「90度回転させる」(指示)の区別は
  // 文脈で曖昧になりうるため、非ゼロは呼び出し側の二重確認を前提とする。
  const m = text.match(/(?:時計回りに\s*)?(0|90|180|270)\s*度/);
  if (m) {
    const v = Number(m[1]);
    if (VALID.includes(v)) return v as Rotation;
  }
  return null;
}

/**
 * 2回の判定結果から適用回転を決める合議規則。
 * - 一致 → その値
 * - 不一致 or どちらか判定不能 → 0(誤回転の実害 >> 未補正の実害。
 *   誤回転は読み取り崩壊・捏造様の誤抽出を誘発する(2026-08-09実測)ため保守側に倒す)
 */
export function resolveRotationVotes(first: Rotation | null, second: Rotation | null): Rotation {
  if (first !== null && first === second) return first;
  return 0;
}
