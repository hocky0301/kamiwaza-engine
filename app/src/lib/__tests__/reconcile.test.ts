import { describe, it, expect } from "vitest";

import type { AppSpec, FieldSpec } from "../appspec";
import {
  buildStateFromSpec,
  diffBuildState,
  initialBuildState,
  type StreamedBuildState,
} from "../reconcile";

/* ============================================================================
 * reconcile — done.spec によるストリーム組み立て状態の照合・復元(三重保険 第2層)
 *
 * 攻撃2で観測された「タイトル文字重複(出荷指示管理理)+フィールド欠落」型の
 * クライアント側破損を、done 受信時に静かに自己修復するためのロジック。
 * 要件:
 * - 正常時(streamed ≡ done.spec)は不一致ゼロ → 再構築しても視覚的差分ゼロ
 * - 破損時(欠落・文字列破損)は不一致を検出し、spec からの再構築で復元できる
 * ==========================================================================*/

function field(id: string, label: string): FieldSpec {
  return { id, label, type: "text", required: true, confidence: 0.9 };
}

function sampleSpec(): AppSpec {
  return {
    appName: "出荷指示管理",
    icon: "📦",
    description: "紙の出荷指示書をアプリ化する",
    fields: [field("customer", "得意先"), field("item", "品名")],
    lineItems: {
      label: "出荷明細",
      columns: [{ id: "name", label: "品名", type: "text" }],
    },
    listColumns: ["customer"],
    approvalFlow: [{ name: "課長承認", role: "課長" }],
    aggregations: [{ id: "cnt", label: "件数", fieldId: "customer", op: "count" }],
    firstRecord: { customer: "田中商店", item: "ボルト" },
    firstRecordLines: [{ name: "ボルト" }],
  };
}

/** 正常にストリームを受け切った状態(= done.spec と恒等)を組み立てる */
function streamedFromSpec(spec: AppSpec): StreamedBuildState {
  return buildStateFromSpec(spec);
}

describe("buildStateFromSpec: done.spec からの表示状態の再構築", () => {
  it("spec の全表示要素をそのまま写像する", () => {
    const spec = sampleSpec();
    const s = buildStateFromSpec(spec);
    expect(s.meta).toEqual({
      appName: spec.appName,
      icon: spec.icon,
      description: spec.description,
    });
    expect(s.fields).toEqual(spec.fields);
    expect(s.lineItems).toEqual({ spec: spec.lineItems, rowCount: 1 });
    expect(s.approval).toEqual(spec.approvalFlow);
    expect(s.aggs).toEqual(spec.aggregations);
    expect(s.record).toEqual(spec.firstRecord);
  });

  it("lineItems: null / approvalFlow: null の帳票も正しく写像する", () => {
    const spec: AppSpec = {
      ...sampleSpec(),
      lineItems: null,
      firstRecordLines: [],
      approvalFlow: null,
    };
    const s = buildStateFromSpec(spec);
    expect(s.lineItems).toBeNull();
    // null は「承認フローなし」の確定値(undefined=未着 と区別される)
    expect(s.approval).toBeNull();
  });

  it("返す配列・レコードはコピー(後続の mutate が spec を汚さない)", () => {
    const spec = sampleSpec();
    const s = buildStateFromSpec(spec);
    s.fields.push(field("evil", "追加"));
    s.aggs.pop();
    s.record!.customer = "改ざん";
    expect(spec.fields).toHaveLength(2);
    expect(spec.aggregations).toHaveLength(1);
    expect(spec.firstRecord.customer).toBe("田中商店");
  });
});

describe("diffBuildState: 正常系は不一致ゼロ(視覚的差分ゼロの前提)", () => {
  it("ストリームを受け切った状態と done.spec は完全一致", () => {
    const spec = sampleSpec();
    expect(diffBuildState(streamedFromSpec(spec), spec)).toEqual([]);
  });

  it("lineItems/approvalFlow が null の帳票でも一致", () => {
    const spec: AppSpec = {
      ...sampleSpec(),
      lineItems: null,
      firstRecordLines: [],
      approvalFlow: null,
    };
    expect(diffBuildState(streamedFromSpec(spec), spec)).toEqual([]);
  });

  it("キー順が違うだけのオブジェクトは一致扱い(JSON.stringify比較の罠を踏まない)", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    // ストリーム側のfieldはJSONパース由来でキー順が揺れうる — 構造的等価なら一致
    const f = spec.fields[0];
    streamed.fields[0] = JSON.parse(
      JSON.stringify({
        confidence: f.confidence,
        required: f.required,
        type: f.type,
        label: f.label,
        id: f.id,
      }),
    ) as FieldSpec;
    expect(diffBuildState(streamed, spec)).toEqual([]);
  });
});

describe("diffBuildState: 破損検出(攻撃2で観測された型)", () => {
  it("タイトルの文字重複(「出荷指示管理理」)を meta 不一致として検出する", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    streamed.meta = { ...streamed.meta!, appName: "出荷指示管理理" };
    const issues = diffBuildState(streamed, spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("meta");
    expect(issues[0]).toContain("出荷指示管理理");
    expect(issues[0]).toContain("出荷指示管理");
  });

  it("SSE行破損によるfieldイベント欠落を件数不一致として検出する", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    streamed.fields = streamed.fields.slice(0, 1); // 1件欠落
    const issues = diffBuildState(streamed, spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("fields");
    expect(issues[0]).toContain("stream=1");
    expect(issues[0]).toContain("spec=2");
  });

  it("同数だが内容が破損したfieldを添字つきで検出する", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    streamed.fields[1] = { ...streamed.fields[1], label: "品名名" };
    const issues = diffBuildState(streamed, spec);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("fields[1]");
    expect(issues[0]).toContain("id=item");
  });

  it("meta未着(metaイベント自体が落ちた)を検出する", () => {
    const spec = sampleSpec();
    const streamed = { ...streamedFromSpec(spec), meta: null };
    expect(diffBuildState(streamed, spec)).toContainEqual(
      expect.stringContaining("meta: ストリームに未着"),
    );
  });

  it("approval未着(undefined)と record未着(null)を検出する", () => {
    const spec = sampleSpec();
    const streamed: StreamedBuildState = {
      ...streamedFromSpec(spec),
      approval: undefined,
      record: null,
    };
    const issues = diffBuildState(streamed, spec);
    expect(issues).toContainEqual(expect.stringContaining("approval"));
    expect(issues).toContainEqual(expect.stringContaining("record"));
  });

  it("lineItems・aggregations の不一致も検出する", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    streamed.lineItems = null; // lineitemsイベント欠落
    streamed.aggs = []; // aggregationイベント全落ち
    const issues = diffBuildState(streamed, spec);
    expect(issues).toContainEqual(expect.stringContaining("lineItems"));
    expect(issues).toContainEqual(expect.stringContaining("aggregations"));
  });

  it("recordの値破損(文字列重複が値に乗った場合)も検出する", () => {
    const spec = sampleSpec();
    const streamed = streamedFromSpec(spec);
    streamed.record = { ...streamed.record!, customer: "田中商店店" };
    expect(diffBuildState(streamed, spec)).toEqual([
      expect.stringContaining("record"),
    ]);
  });
});

describe("復元フロー: 破損状態 → buildStateFromSpec で自己修復", () => {
  it("何をどう壊しても、spec からの再構築後は不一致ゼロになる", () => {
    const spec = sampleSpec();
    const broken: StreamedBuildState = {
      ...initialBuildState(),
      meta: { appName: "出荷指示管理理", icon: "📦", description: "壊" },
      fields: [field("customer", "得意先")], // 欠落
    };
    expect(diffBuildState(broken, spec).length).toBeGreaterThan(0);

    // KamiwazaApp の done ハンドラと同じ復元手順
    const repaired = buildStateFromSpec(spec);
    expect(diffBuildState(repaired, spec)).toEqual([]);
  });

  it("initialBuildState はすべて未着扱い(接続直後にdoneだけ来ても復元が成立する)", () => {
    const spec = sampleSpec();
    const issues = diffBuildState(initialBuildState(), spec);
    // meta/fields/lineItems/approval/aggs/record すべてが不一致として報告される
    expect(issues.length).toBeGreaterThanOrEqual(5);
    expect(diffBuildState(buildStateFromSpec(spec), spec)).toEqual([]);
  });
});
