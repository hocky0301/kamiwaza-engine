import { describe, it, expect } from "vitest";
import sharp from "sharp";

import { streamLiveAnalysis } from "../claude-live";
import type { AnalyzeEvent } from "../events";
import type { FieldSpec } from "../appspec";

/* ============================================================================
 * 攻撃2の観測(4): ライブ経路1回(合成画像・小さめ)で、
 * ストリーム中に emit された組み立てイベント列(meta / field)と
 * done.spec の関係を実測する。
 *
 * APIを実費で1回呼ぶため、通常の `npm test` では skip される。
 * 実行: RUN_LIVE_PROBE=1 + ORCAROUTER_API_KEY(または ANTHROPIC_API_KEY)
 * ==========================================================================*/

const LIVE = process.env.RUN_LIVE_PROBE === "1";

/** 小さめの合成帳票(備品購入申請書)。フィールド5個程度に抑えて出力を短くする */
async function syntheticFormPng(): Promise<string> {
  const svg = `
  <svg width="600" height="780" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="780" fill="#fdfdf8"/>
    <text x="300" y="70" font-size="34" text-anchor="middle" font-family="Hiragino Sans, sans-serif" fill="#222">備品購入申請書</text>
    <line x1="150" y1="85" x2="450" y2="85" stroke="#222" stroke-width="2"/>

    <text x="60" y="160" font-size="20" font-family="Hiragino Sans, sans-serif" fill="#222">申請日:</text>
    <text x="220" y="160" font-size="22" font-family="Hiragino Sans, sans-serif" fill="#1a3">2026年8月1日</text>
    <line x1="200" y1="168" x2="520" y2="168" stroke="#888"/>

    <text x="60" y="220" font-size="20" font-family="Hiragino Sans, sans-serif" fill="#222">申請者:</text>
    <text x="220" y="220" font-size="22" font-family="Hiragino Sans, sans-serif" fill="#1a3">山田 太郎</text>
    <line x1="200" y1="228" x2="520" y2="228" stroke="#888"/>

    <text x="60" y="280" font-size="20" font-family="Hiragino Sans, sans-serif" fill="#222">品名:</text>
    <text x="220" y="280" font-size="22" font-family="Hiragino Sans, sans-serif" fill="#1a3">ボールペン(黒)</text>
    <line x1="200" y1="288" x2="520" y2="288" stroke="#888"/>

    <text x="60" y="340" font-size="20" font-family="Hiragino Sans, sans-serif" fill="#222">数量:</text>
    <text x="220" y="340" font-size="22" font-family="Hiragino Sans, sans-serif" fill="#1a3">10 個</text>
    <line x1="200" y1="348" x2="520" y2="348" stroke="#888"/>

    <text x="60" y="400" font-size="20" font-family="Hiragino Sans, sans-serif" fill="#222">金額:</text>
    <text x="220" y="400" font-size="22" font-family="Hiragino Sans, sans-serif" fill="#1a3">1,200 円</text>
    <line x1="200" y1="408" x2="520" y2="408" stroke="#888"/>

    <rect x="440" y="560" width="110" height="110" fill="none" stroke="#a33" stroke-width="2"/>
    <text x="495" y="590" font-size="16" text-anchor="middle" font-family="Hiragino Sans, sans-serif" fill="#a33">承認印</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}

describe.runIf(LIVE)("攻撃2観測(4): ライブ経路の done.spec とストリーム構築状態", () => {
  it(
    "正常時に streamed meta/field 列が done.spec と一致するかを実測する",
    { timeout: 240_000 },
    async () => {
      const data = await syntheticFormPng();
      const events: AnalyzeEvent[] = [];
      const t0 = Date.now();
      await streamLiveAnalysis({ data, mediaType: "image/png" }, (e) => {
        // emit後にオブジェクトが再利用されても観測が汚れないよう複製して保存
        events.push(JSON.parse(JSON.stringify(e)) as AnalyzeEvent);
        const at = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[+${at}s] ${e.type}` +
            (e.type === "phase" ? ` ${e.label}` : "") +
            (e.type === "field" ? ` id=${e.field.id}` : "") +
            (e.type === "validation" ? ` ok=${e.ok}` : ""),
        );
      });

      const done = events.find((e) => e.type === "done");
      expect(done, "doneイベントが来ること").toBeDefined();
      if (done?.type !== "done") return;

      const validationIdx = events.findIndex((e) => e.type === "validation");
      const fieldEvents = events
        .map((e, i) => ({ e, i }))
        .filter((x): x is { e: Extract<AnalyzeEvent, { type: "field" }>; i: number } =>
          x.e.type === "field",
        );
      const streamedDuringGen = fieldEvents.filter((x) => x.i < validationIdx);
      const flushedAfterFinal = fieldEvents.filter((x) => x.i > validationIdx);
      const meta = events.find((e) => e.type === "meta");

      const streamedFields: FieldSpec[] = fieldEvents.map((x) => x.e.field);
      const summary = {
        durationSec: Math.round((Date.now() - t0) / 10) / 100,
        route: done.llmRoute,
        usage: done.usage,
        costUsd: done.costUsd,
        specAppName: done.spec.appName,
        metaEventAppName: meta?.type === "meta" ? meta.appName : null,
        specFieldIds: done.spec.fields.map((f) => f.id),
        streamedFieldIds: streamedFields.map((f) => f.id),
        fieldsStreamedDuringGeneration: streamedDuringGen.length,
        fieldsFlushedFromFinalSpec: flushedAfterFinal.length,
        metaMatchesSpec:
          meta?.type === "meta" &&
          meta.appName === done.spec.appName &&
          meta.icon === done.spec.icon &&
          meta.description === done.spec.description,
        streamedFieldsDeepEqualSpecFields:
          JSON.stringify(streamedFields) === JSON.stringify(done.spec.fields),
        validationEvent: events[validationIdx],
        firstRecord: done.spec.firstRecord,
      };
      console.log("=== LIVE PROBE SUMMARY ===");
      console.log(JSON.stringify(summary, null, 2));

      // vitest のコンソール抑制に依存しない観測ログ(env指定があればファイルにも残す)
      if (process.env.LIVE_PROBE_OUT) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          process.env.LIVE_PROBE_OUT,
          JSON.stringify({ summary, events }, null, 2),
        );
      }

      // 正常時の基本関係(壊れていたらここで分かる)
      expect(done.spec.fields.length).toBeGreaterThan(0);
      expect(streamedFields.length).toBe(done.spec.fields.length);
    },
  );
});
