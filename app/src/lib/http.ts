// リクエストボディの上限つき読み取り(サーバー専用)。
//
// App Router の Route Handler には既定のボディ上限が無く(Pages Router の
// bodyParser.sizeLimit は適用されない)、`req.json()` は届いた分を全部
// メモリに載せる。実測でも 80MB の JSON がそのまま受理された。
// 未認証のPOSTでプロセスのメモリを焼けるので、ここで明示的に閉じる。
//
// Content-Length は chunked では付かないことがあるため、ヘッダの事前判定と
// ストリームのバイトカウントの両方で見る。

export type LimitedBody<T> =
  | { ok: true; body: T }
  /** ボディが上限超過。呼び出し側は 413 を返す */
  | { ok: false; reason: "too-large" }
  /** ボディ無し・不正JSON。呼び出し側は従来どおりのフォールバックへ */
  | { ok: false; reason: "invalid" };

/**
 * JSONボディを最大 maxBytes まで読む。上限を超えた時点でストリームを切る
 * (全量を受け取ってから測るのでは意味がないため)。
 */
export async function readJsonLimited<T>(
  req: Request,
  maxBytes: number,
): Promise<LimitedBody<T>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too-large" };
  }
  if (!req.body) return { ok: false, reason: "invalid" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(buf)) as T };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function payloadTooLarge(): Response {
  return new Response(JSON.stringify({ error: "payload too large" }), {
    status: 413,
    headers: { "Content-Type": "application/json" },
  });
}
