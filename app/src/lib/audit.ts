// 監査ログ(JSONL)— 「モデルの出力を人間がどう直したか」を構造化して残す。
//
// 自動運転のデータ収集基盤が一番欲しがるのは disengagement(人間の介入)の記録で、
// このアプリにおける同型物は ①逆質問への回答 ②「日本語で書いて直す」の差分適用。
// どのフィールドが低信頼で聞き返し、人が何と答え、specがどう変わったか——を1行1イベントで残す。
//
// プライバシーの規律(このファイルが唯一の定義):
// - 画像・記入値・ラベル文字列は**書かない**。書くのはハッシュ(sha256先頭16桁)と
//   メタデータ(fieldId・confidence・トークン数・所要ms・検証結果)のみ
// - AUDIT_LOG=0 で完全無効化。書き込み失敗は本処理を殺さない(ログは主機能に劣後)
// - 出力先は var/audit.jsonl(gitignore済み)。AUDIT_DIR で差し替え可(テスト用)

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AuditEventType = "analyze" | "clarify" | "reconfigure";

export interface AuditTokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface AuditEntry {
  ts: string;
  event: AuditEventType;
  mode?: "demo" | "live";
  /** 入力画像のsha256先頭16桁(画像そのものは残さない) */
  input_hash?: string;
  spec_hash?: string;
  spec_hash_before?: string;
  spec_hash_after?: string;
  /** 低信頼で逆質問対象になったフィールド(IDと信頼度のみ・値は残さない) */
  low_confidence_fields?: { fieldId: string; confidence: number }[];
  /** 人間の回答(選択肢のインデックスのみ・自由記述は存在しない設計) */
  human_answer?: { fieldId: string; choiceIndex: number };
  /** 適用された差分(操作種別とフィールドIDのみ) */
  diff_applied?: { op: string; fieldId?: string; ok: boolean }[];
  model?: string;
  route?: string;
  tokens?: AuditTokens;
  cost_usd?: number;
  duration_ms?: number;
  validation?: { ok: boolean; violations: number };
  rotation_applied?: number;
  fallback_reason?: string;
  aborted_live_cost_usd?: number;
}

export function auditEnabled(): boolean {
  return process.env.AUDIT_LOG !== "0";
}

export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function auditDir(): string {
  return process.env.AUDIT_DIR ?? path.join(process.cwd(), "var");
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  if (!auditEnabled()) return;
  try {
    const dir = auditDir();
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // ログの失敗で解析を止めない(主機能に劣後)
  }
}

/** clarify受け口(/api/audit)の入力検証。ホワイトリスト方式で、余計なキーは全部落とす */
export function sanitizeClarify(body: unknown): AuditEntry | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (o.event !== "clarify") return null;
  const fieldId = o.fieldId;
  const choiceIndex = o.choiceIndex;
  const confidence = o.confidence;
  const mode = o.mode;
  if (typeof fieldId !== "string" || fieldId.length === 0 || fieldId.length > 64) return null;
  if (!/^[a-z0-9_]+$/.test(fieldId)) return null;
  if (typeof choiceIndex !== "number" || !Number.isInteger(choiceIndex)) return null;
  if (choiceIndex < 0 || choiceIndex > 8) return null;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    event: "clarify",
    human_answer: { fieldId, choiceIndex },
  };
  if (typeof confidence === "number" && confidence >= 0 && confidence <= 1) {
    entry.low_confidence_fields = [{ fieldId, confidence }];
  }
  if (mode === "demo" || mode === "live") entry.mode = mode;
  return entry;
}
