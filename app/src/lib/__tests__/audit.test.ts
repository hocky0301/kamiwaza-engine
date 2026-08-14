// 監査ログの規律を固定するテスト:
// ①画像・値を含まない(ホワイトリスト検証) ②AUDIT_LOG=0で完全無効 ③書き込みは追記1行
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAudit, auditEnabled, sanitizeClarify, sha16 } from "../audit";

afterEach(() => {
  delete process.env.AUDIT_LOG;
  delete process.env.AUDIT_DIR;
});

describe("sha16", () => {
  it("決定論・16桁hex", () => {
    expect(sha16("abc")).toBe(sha16("abc"));
    expect(sha16("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(sha16("abc")).not.toBe(sha16("abd"));
  });
});

describe("sanitizeClarify(ホワイトリスト)", () => {
  const ok = { event: "clarify", fieldId: "billing_no", choiceIndex: 0, mode: "live" };
  it("正常系を通す", () => {
    const e = sanitizeClarify(ok);
    expect(e?.event).toBe("clarify");
    expect(e?.human_answer).toEqual({ fieldId: "billing_no", choiceIndex: 0 });
    expect(e?.mode).toBe("live");
  });
  it.each([
    ["event違い", { ...ok, event: "analyze" }],
    ["fieldIdに記号", { ...ok, fieldId: "a; DROP TABLE" }],
    ["fieldId長すぎ", { ...ok, fieldId: "a".repeat(65) }],
    ["choiceIndex小数", { ...ok, choiceIndex: 1.5 }],
    ["choiceIndex負", { ...ok, choiceIndex: -1 }],
    ["choiceIndex過大", { ...ok, choiceIndex: 99 }],
    ["非オブジェクト", "text"],
    ["null", null],
  ])("%s を拒否", (_n, bad) => {
    expect(sanitizeClarify(bad)).toBeNull();
  });
  it("未知のキー(値らしきもの)は出力に持ち込まれない", () => {
    const e = sanitizeClarify({ ...ok, value: "田中", imageBase64: "xxxx" });
    expect(JSON.stringify(e)).not.toContain("田中");
    expect(JSON.stringify(e)).not.toContain("xxxx");
  });
  it("mode不正は落とすが本体は通す", () => {
    const e = sanitizeClarify({ ...ok, mode: "hack" });
    expect(e?.mode).toBeUndefined();
  });
});

describe("appendAudit", () => {
  it("JSONLに1行追記される", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
    process.env.AUDIT_DIR = dir;
    await appendAudit({ ts: "2026-08-14T00:00:00Z", event: "analyze", mode: "demo" });
    await appendAudit({ ts: "2026-08-14T00:00:01Z", event: "clarify" });
    const lines = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("analyze");
  });
  it("AUDIT_LOG=0 で何も書かない", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-off-"));
    process.env.AUDIT_DIR = dir;
    process.env.AUDIT_LOG = "0";
    expect(auditEnabled()).toBe(false);
    await appendAudit({ ts: "2026-08-14T00:00:00Z", event: "analyze" });
    expect(existsSync(path.join(dir, "audit.jsonl"))).toBe(false);
  });
});
