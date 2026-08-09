// ストリーミング部分JSONパーサ(フェンス耐性つき)。
// 直接Anthropic経路では structured outputs が生JSONを保証するが、
// OrcaRouter経路では output_config が握りつぶされ、応答が ```json フェンス付きで
// 返ってくる(2026-08-08実測)。どちらの形でも同じコードパスで扱えるよう、
// パース前にフェンス/散文を除去する。
//
// stripCodeFences はdeltaごとに蓄積バッファ全体へ適用する前提で設計されている
// (buffer蓄積時に除去すると、フェンスがdelta境界で分割された場合に取り逃す)。

/**
 * コードフェンス(```json ... ```)や前置の散文を許容して、JSON本体だけを取り出す。
 * ストリーミング途中の不完全なバッファにも安全:
 * - JSON開始('{' か '[')より前しか受信していなければ "" を返す(呼び出し元は次のdeltaを待つ)
 * - 末尾のバックティック1〜3個は部分的な閉じフェンスとして除去する。ただし
 *   JSON文字列内のバックティックを誤除去しないよう、除去後が '}' か ']' で
 *   終わるときだけ適用する(閉じフェンスは必ず最後の閉じ括弧の後に来る)
 */
export function stripCodeFences(src: string): string {
  const start = src.search(/[{[]/);
  if (start === -1) return "";
  let out = src.slice(start);

  const fence = out.match(/`{1,3}\s*$/);
  if (fence && fence.index !== undefined) {
    const candidate = out.slice(0, fence.index).replace(/\s+$/, "");
    if (/[}\]]$/.test(candidate)) out = candidate;
  }
  return out;
}

/**
 * 未完成のJSON文字列を閉じてパースを試みる。
 * ストリーミング中のプログレッシブレンダリングに使う(失敗したらnullで次のトークンを待つ)。
 * フェンス付き入力(```json ...)にも対応する。
 */
export function tryParsePartial(buf: string): Record<string, unknown> | null {
  const src = stripCodeFences(buf);
  if (!src) return null;

  const candidates = [src];
  const lastComma = src.lastIndexOf(",");
  if (lastComma > 0) candidates.push(src.slice(0, lastComma));

  for (const candidate of candidates) {
    const completed = completeJson(candidate);
    if (!completed) continue;
    try {
      const parsed = JSON.parse(completed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

/**
 * 先頭の完結したJSON値({...} か [...])だけを取り出す(文字列リテラル対応の括弧走査)。
 * stripCodeFences が想定する「フェンスのみ」の形から外れた応答
 * (閉じフェンスの後に散文が続く、フェンスなしでJSONの後に説明文が付く等)の救済用。
 * 完結したJSONが見つからなければ null。
 * 注意: 厳密パースが失敗したときのフォールバックとしてのみ使うこと
 * (先頭の散文に '{' や '[' が含まれるとそちらを拾ってしまうため)。
 */
export function extractBalancedJson(src: string): string | null {
  const start = src.search(/[{[]/);
  if (start === -1) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null; // 壊れたJSON
      if (stack.length === 0) return src.slice(start, i + 1);
    }
  }
  return null; // 未完結
}

export function completeJson(src: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null; // 壊れたJSON
    }
  }
  let out = src;
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/[\s]+$/, "");
  if (out.endsWith(",")) out = out.slice(0, -1);
  if (out.endsWith(":")) out += "null";
  while (stack.length) out += stack.pop();
  return out;
}
