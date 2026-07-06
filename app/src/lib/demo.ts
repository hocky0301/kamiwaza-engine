// デモモード: シナリオからイベント列を決定論的に生成してリプレイする。
// ネットワーク・APIキーなしで本番と同じ見た目のストリームが流れる(本番ピッチの保険)。

import type { AnalyzeEvent } from "./events";
import type { Scenario } from "./scenarios";

export interface TimedEvent {
  /** 直前のイベントからの待ち時間(ms) */
  delay: number;
  event: AnalyzeEvent;
}

export function buildDemoSequence(scenario: Scenario): TimedEvent[] {
  const seq: TimedEvent[] = [];
  const { spec } = scenario;

  seq.push({ delay: 400, event: { type: "phase", label: "画像を受信しました" } });
  seq.push({ delay: 700, event: { type: "phase", label: "Claude Vision が帳票を読み取っています…" } });
  seq.push({ delay: 1000, event: { type: "phase", label: `帳票の種類を判定: ${scenario.paperKind}` } });
  seq.push({
    delay: 700,
    event: { type: "meta", appName: spec.appName, icon: spec.icon, description: spec.description },
  });

  for (const field of spec.fields) {
    seq.push({ delay: 380, event: { type: "field", field } });
  }

  if (spec.lineItems) {
    seq.push({
      delay: 500,
      event: {
        type: "lineitems",
        spec: spec.lineItems,
        rowCount: spec.firstRecordLines.length,
      },
    });
  }

  if (scenario.question) {
    seq.push({ delay: 550, event: { type: "question", ...scenario.question } });
  }

  seq.push({ delay: 500, event: { type: "approval", flow: spec.approvalFlow } });

  for (const agg of spec.aggregations) {
    seq.push({ delay: 350, event: { type: "aggregation", agg } });
  }

  if (scenario.validationNote) {
    seq.push({ delay: 550, event: { type: "phase", label: scenario.validationNote } });
  }

  seq.push({
    delay: 650,
    event: { type: "record", record: spec.firstRecord, lines: spec.firstRecordLines },
  });
  seq.push({
    delay: 500,
    event: { type: "phase", label: "紙に書かれていた内容を 1件目のデータとして登録しました" },
  });
  seq.push({
    delay: 400,
    event: { type: "done", spec, mode: "demo", scenarioId: scenario.id },
  });

  return seq;
}
