#!/usr/bin/env node
// 原価バッチハーネス: 画像ディレクトリの jpeg/png を dev サーバーの /api/analyze へ
// 直列POST(SSE)し、done イベントの usage / costUsd / llmRoute / pricingSource を
// 集計して out/run-<連番>.json に保存する。
// 制約: app/ のコードは import しない(素の node + fetch のみ)。実行ごとにLLM課金が発生する。
// llmRoute の無い結果(=デモフォールバック)は FAIL として明示する。

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.COST_BATCH_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.join(HERE, "out");
/** ブース運用(数分に1回)の模擬。同時実行はしない */
const WAIT_BETWEEN_MS = 2000;
/** 1画像あたりのSSE全体の上限。超えたら FAIL(ハングを成功に見せない) */
const REQUEST_TIMEOUT_MS = 180_000;
/** サーバー側 MAX_IMAGE_BASE64 と同値(超過は送らずに FAIL) */
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

const MEDIA_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SSE を読み切り、受信イベントを配列で返す(形式は app/src/lib/events.ts に準拠) */
async function postAnalyze(base64, mediaType, signal) {
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: { data: base64, mediaType } }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const events = [];
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // 壊れた行はスキップ(クライアント実装と同じ扱い)
      }
    }
  }
  return events;
}

async function analyzeOne(filePath) {
  const file = path.basename(filePath);
  const mediaType = MEDIA_TYPES[path.extname(filePath).toLowerCase()];
  const b64 = (await readFile(filePath)).toString("base64");
  const started = Date.now();
  const result = { file, ok: false, seconds: 0 };

  if (b64.length > MAX_IMAGE_BASE64) {
    result.failReason = `画像が大きすぎる (base64 ${b64.length} bytes > ${MAX_IMAGE_BASE64})`;
    return result;
  }

  let events;
  try {
    events = await postAnalyze(b64, mediaType, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (err) {
    result.seconds = (Date.now() - started) / 1000;
    result.failReason =
      err?.name === "TimeoutError"
        ? `タイムアウト (${REQUEST_TIMEOUT_MS / 1000}s)`
        : `接続/HTTP失敗: ${err?.message ?? err} (dev サーバー起動を確認: cd app && npm run dev)`;
    return result;
  }
  result.seconds = (Date.now() - started) / 1000;

  const done = events.findLast((e) => e.type === "done");
  const errorEv = events.findLast((e) => e.type === "error");
  const validation = events.findLast((e) => e.type === "validation");
  const lastPhase = events.findLast((e) => e.type === "phase")?.label;
  if (lastPhase) result.lastPhase = lastPhase;
  if (validation) result.validation = { ok: validation.ok, violations: validation.violations };

  if (errorEv) {
    result.failReason = `error イベント: ${errorEv.message}`;
    return result;
  }
  if (!done) {
    result.failReason = "done イベント未受信";
    return result;
  }
  result.mode = done.mode;
  if (done.scenarioId) result.scenarioId = done.scenarioId;
  if (done.mode !== "live" || !done.llmRoute) {
    result.failReason = "デモフォールバック (llmRoute 無し = ライブ解析失敗)";
    return result;
  }

  result.ok = true;
  result.usage = done.usage ?? null;
  result.costUsd = done.costUsd ?? null;
  result.llmRoute = done.llmRoute;
  result.pricingSource = done.pricingSource ?? null;
  return result;
}

/** 全角(概ね U+0100 以上)を2桁として数える表示幅 */
const dw = (s) => [...String(s)].reduce((n, c) => n + (c.codePointAt(0) > 0xff ? 2 : 1), 0);
const pad = (s, w) => String(s) + " ".repeat(Math.max(0, w - dw(s)));
const padL = (s, w) => " ".repeat(Math.max(0, w - dw(s))) + String(s);

function printTable(results, totals) {
  const cols = [
    { h: "ファイル名", v: (r) => r.file, right: false },
    { h: "所要秒", v: (r) => r.seconds.toFixed(1), right: true },
    { h: "prompt", v: (r) => r.usage?.inputTokens ?? "-", right: true },
    { h: "output", v: (r) => r.usage?.outputTokens ?? "-", right: true },
    { h: "cacheRead", v: (r) => r.usage?.cacheReadInputTokens ?? "-", right: true },
    { h: "cacheCreation", v: (r) => r.usage?.cacheCreationInputTokens ?? "-", right: true },
    { h: "costUsd", v: (r) => (r.costUsd != null ? r.costUsd.toFixed(6) : "-"), right: true },
    { h: "llmRoute", v: (r) => (r.ok ? r.llmRoute : "FAIL"), right: false },
  ];
  const totalRow = {
    file: `合計 (${totals.ok}/${totals.files} OK)`,
    seconds: totals.seconds,
    usage: totals.ok > 0 ? totals.usage : null,
    costUsd: totals.ok > 0 ? totals.costUsd : null,
    ok: true,
    llmRoute: "-",
  };
  const rows = [...results, totalRow];
  const widths = cols.map((c) => Math.max(dw(c.h), ...rows.map((r) => dw(c.v(r)))));
  const line = (cells) =>
    console.log(cells.map((s, i) => (cols[i].right ? padL(s, widths[i]) : pad(s, widths[i]))).join("  "));
  const rule = () => console.log(widths.map((w) => "-".repeat(w)).join("--"));

  console.log("");
  line(cols.map((c) => c.h));
  rule();
  for (const r of results) {
    line(cols.map((c) => c.v(r)));
    if (!r.ok) console.log(`  ! FAIL: ${r.failReason}${r.lastPhase ? ` / 最終phase: ${r.lastPhase}` : ""}`);
  }
  rule();
  line(cols.map((c) => c.v(totalRow)));
  console.log("");
  console.log("ダッシュボード突合用: この合計 costUsd を OrcaRouter コンソールの同時間帯の使用額と比べる");
  if (totals.fail > 0) {
    console.log(`注意: FAIL ${totals.fail} 件。FAIL を含む実行は凍結値に使わないこと`);
  }
}

async function nextRunPath() {
  await mkdir(OUT_DIR, { recursive: true });
  const nums = (await readdir(OUT_DIR))
    .map((f) => /^run-(\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return path.join(OUT_DIR, `run-${String(n).padStart(3, "0")}.json`);
}

async function main() {
  const imageDir = path.resolve(process.argv[2] ?? path.join(HERE, "samples"));
  const files = (await readdir(imageDir))
    .filter((f) => MEDIA_TYPES[path.extname(f).toLowerCase()])
    .sort()
    .map((f) => path.join(imageDir, f));
  if (files.length === 0) {
    console.error(`画像 (jpg/jpeg/png) が見つからない: ${imageDir}`);
    console.error("サンプルを使う場合は先に gen-samples.mjs で samples/ を生成する");
    process.exit(2);
  }

  console.log(`対象: ${files.length} 枚 (${imageDir})`);
  console.log(`送信先: ${BASE_URL}/api/analyze (直列・${WAIT_BETWEEN_MS / 1000}s 間隔)`);

  const results = [];
  for (const [i, f] of files.entries()) {
    if (i > 0) await sleep(WAIT_BETWEEN_MS);
    process.stdout.write(`[${i + 1}/${files.length}] ${path.basename(f)} ... `);
    const r = await analyzeOne(f);
    results.push(r);
    console.log(r.ok ? `OK ${r.seconds.toFixed(1)}s $${r.costUsd?.toFixed(6)} (${r.llmRoute})` : "FAIL");
  }

  const okResults = results.filter((r) => r.ok);
  const totals = {
    files: results.length,
    ok: okResults.length,
    fail: results.length - okResults.length,
    seconds: Number(results.reduce((s, r) => s + r.seconds, 0).toFixed(1)),
    usage: {
      inputTokens: okResults.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0),
      outputTokens: okResults.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0),
      cacheReadInputTokens: okResults.reduce((s, r) => s + (r.usage?.cacheReadInputTokens ?? 0), 0),
      cacheCreationInputTokens: okResults.reduce((s, r) => s + (r.usage?.cacheCreationInputTokens ?? 0), 0),
    },
    costUsd: okResults.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  };

  printTable(results, totals);

  const outPath = await nextRunPath();
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        imageDir,
        note: "合計 costUsd を OrcaRouter コンソールの同時間帯の使用額と突合する。FAIL を含む実行は凍結値に使わない",
        totals,
        files: results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`保存: ${outPath}`);
  process.exit(totals.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
