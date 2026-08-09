// 出典ハイライトの発火・解除ロジック(タッチ/フォーカス対応)。
//
// デスクトップはホバーで光るが、iPad(指操作)ではhoverが存在しないため
// 「フォーム項目=フォーカス」「一覧・非input要素=タップ」で発火させる。
// タップの解除規則はここで一元定義し、純粋関数としてテストする:
//   - 同じ出典を再タップ → 解除
//   - 別の出典をタップ → 切り替え
//   - (フォーカス発火分はblurで解除。これはコンポーネント側の配線)

import type { SourceBox } from "./appspec";

/**
 * 出典矩形の値等価。
 * 「日本語で書いて直す」でspecが差し替わるとsourceBoxの参照が変わるため、
 * 参照比較ではなく座標の値比較で「同じ出典か」を判定する。
 */
export function sameBox(
  a: SourceBox | null | undefined,
  b: SourceBox | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * タップのトグル規則: 現在光っている出典と同じならnull(解除)、
 * 違えばその出典(切り替え/点灯)を返す。
 * setState(cur => toggleHighlight(cur, box)) の形でそのまま使える。
 */
export function toggleHighlight(
  current: SourceBox | null,
  box: SourceBox,
): SourceBox | null {
  return sameBox(current, box) ? null : box;
}

/**
 * 行タップのトグル対象外にするインタラクティブ要素。
 * これらはタップでフォーカス/クリックの本来動作が走る(inputはfocusCaptureが
 * ハイライトを担当する)ため、行トグルと二重発火させない。
 */
export const INTERACTIVE_TAGS = [
  "input",
  "textarea",
  "select",
  "label",
  "button",
  "a",
] as const;

/** Element.closest() 用セレクタ(行タップハンドラが除外判定に使う) */
export const INTERACTIVE_SELECTOR = INTERACTIVE_TAGS.join(", ");
