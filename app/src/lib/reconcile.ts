// done.spec によるストリーム組み立て状態の照合・復元 — 三重保険 第2層。
//
// 攻撃2(審査員シミュレーション)で観測された実害への対策:
// クライアントは解析ストリーム中に meta/field/lineitems/... イベントから画面状態を
// 組み立てるが、従来は done 受信時に ev.spec で照合・復元していなかった。そのため
// デルタ重複による文字列破損(「出荷指示管理理」)や SSE行破損によるfieldイベント欠落が
// 起きると、BuildPanel が壊れた状態を表示し続けた。
//
// done.spec はサーバーの最終検証(validate-spec)を通過した唯一の正であり、
// ライブ実測ではストリーム組み立て状態の厳密なスーパーセット、デモ経路では構成上
// 同一(demo.ts は spec からイベントを生成する)。よって done 受信時に
//   1. diffBuildState() で照合し、結果をコンソールに残す(ブースでの静かな自己修復ログ)
//   2. buildStateFromSpec() で done.spec から表示状態を無条件に再構築する
// ことで、正常時は視覚的差分ゼロ・破損時のみ自己修復という純利得が得られる。
//
// 重複デルタが文字列値の内側に収まる破損はパイプライン内に検出点がない
// (partial-json.ts の冒頭コメント参照)。クライアント側組み立ての破損については
// この照合が最終防衛線。done.spec 自体が破損している場合(転送層の共通モード故障・
// モデル出力の誤字)はここでも救えないが、その場合も画面とspecの整合は保たれる。
//
// 純粋関数のみで構成(テスト可能・サーバー/クライアント両用)。

import type {
  AggregationSpec,
  AppRecord,
  AppSpec,
  ApprovalStep,
  FieldSpec,
  LineItemsSpec,
} from "./appspec";

/**
 * ストリームから組み立てた画面状態。
 * KamiwazaApp の state 群(meta/fields/lineItems/approval/aggs/record)と同形で、
 * BuildPanel の BuildState の表示部分に対応する。
 */
export interface StreamedBuildState {
  meta: { appName: string; icon: string; description: string } | null;
  fields: FieldSpec[];
  lineItems: { spec: LineItemsSpec; rowCount: number } | null;
  /** undefined = approvalイベント未着(null は「承認フローなし」の確定値) */
  approval: ApprovalStep[] | null | undefined;
  aggs: AggregationSpec[];
  record: AppRecord | null;
}

export function initialBuildState(): StreamedBuildState {
  return {
    meta: null,
    fields: [],
    lineItems: null,
    approval: undefined,
    aggs: [],
    record: null,
  };
}

/**
 * done.spec から表示状態を再構築する(specが唯一の正)。
 * 配列・レコードは浅いコピーにして、呼び出し側の後続 mutate が spec を汚さないようにする。
 */
export function buildStateFromSpec(spec: AppSpec): StreamedBuildState {
  return {
    meta: { appName: spec.appName, icon: spec.icon, description: spec.description },
    fields: [...spec.fields],
    lineItems: spec.lineItems
      ? { spec: spec.lineItems, rowCount: spec.firstRecordLines.length }
      : null,
    approval: spec.approvalFlow,
    aggs: [...spec.aggregations],
    record: { ...spec.firstRecord },
  };
}

/** JSON値の構造的等価判定(キー順非依存)。spec/イベントはJSON由来なので関数・循環は想定しない */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * ストリーム組み立て状態と done.spec を照合し、不一致の説明(人間可読)を返す。
 * 空配列 = 完全一致(正常系)。返り値はコンソール/開発ログ用で、UIには出さない。
 */
export function diffBuildState(streamed: StreamedBuildState, spec: AppSpec): string[] {
  const expected = buildStateFromSpec(spec);
  const issues: string[] = [];

  if (streamed.meta === null) {
    issues.push("meta: ストリームに未着");
  } else if (!deepEqual(streamed.meta, expected.meta)) {
    issues.push(
      `meta: 不一致 (stream="${streamed.meta.appName}" / spec="${spec.appName}")`,
    );
  }

  if (streamed.fields.length !== expected.fields.length) {
    issues.push(
      `fields: 件数不一致 (stream=${streamed.fields.length} / spec=${expected.fields.length})`,
    );
  } else {
    expected.fields.forEach((f, i) => {
      if (!deepEqual(streamed.fields[i], f)) {
        issues.push(`fields[${i}] (id=${f.id}): 内容不一致`);
      }
    });
  }

  if (!deepEqual(streamed.lineItems, expected.lineItems)) {
    issues.push("lineItems: 不一致");
  }

  if (streamed.approval === undefined) {
    issues.push("approval: ストリームに未着");
  } else if (!deepEqual(streamed.approval, expected.approval)) {
    issues.push("approval: 不一致");
  }

  if (!deepEqual(streamed.aggs, expected.aggs)) {
    issues.push(
      `aggregations: 不一致 (stream=${streamed.aggs.length}件 / spec=${expected.aggs.length}件)`,
    );
  }

  if (streamed.record === null) {
    issues.push("record: ストリームに未着");
  } else if (!deepEqual(streamed.record, expected.record)) {
    issues.push("record: 不一致");
  }

  return issues;
}
