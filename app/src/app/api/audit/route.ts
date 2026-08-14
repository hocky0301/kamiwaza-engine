// clarify(逆質問への回答)の監査ログ受け口。
// 回答はクライアント側でspecに適用されるため、サーバーはこの通知でしか観測できない。
// ホワイトリスト検証(audit.ts sanitizeClarify)を通ったものだけを1行追記する。
import { appendAudit, sanitizeClarify } from "@/lib/audit";
import { readJsonLimited } from "@/lib/http";

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(req: Request): Promise<Response> {
  const parsed = await readJsonLimited<unknown>(req, MAX_BODY_BYTES);
  const entry = parsed.ok ? sanitizeClarify(parsed.body) : null;
  if (!entry) {
    return new Response(JSON.stringify({ error: "invalid clarify payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  await appendAudit(entry);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
