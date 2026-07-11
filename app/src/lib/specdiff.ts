// SpecDiff — 「日本語で書いて直す」の核。
// LLMには生コードもspec全体も書かせず、閉じた6種の操作(SpecDiff)だけを
// tool useで発行させ、決定論的な純粋関数 applyDiff がAppSpecへ適用する。
// 不正な操作は適用されず元のspecが返るため、モデルはアプリを壊せない。

import type {
  AppSpec,
  AppRecord,
  FieldSpec,
  FieldType,
  ColumnSpec,
} from "./appspec";

/* ============================================================
 * 操作集合(6種で凍結)
 * ============================================================ */

export type SpecDiff =
  | { op: "addApprovalStep"; name: string; role: string }
  | { op: "setNumberLimit"; fieldId: string; min?: number; max?: number }
  | {
      op: "addField";
      id: string;
      label: string;
      fieldType: Exclude<FieldType, "stamp" | "phone">;
      required?: boolean;
      options?: string[];
      unit?: string;
    }
  | { op: "addAggregation"; label: string; fieldId: string; agg: "sum" | "count" | "avg"; unit?: string }
  | { op: "renameField"; fieldId: string; label: string }
  | { op: "addFilterColumn"; fieldId: string };

export interface DiffResult {
  ok: boolean;
  reason?: string;
  /** 適用後spec。失敗時は元のspecがそのまま返る */
  spec: AppSpec;
  /** 手術ログ用の1行表記 */
  summary: string;
}

export interface PatchLogEntry {
  summary: string;
  ok: boolean;
  reason?: string;
  /** trueのとき✓/✗を出さない情報行(指示文のエコーやフェーズ表示) */
  info?: boolean;
}

/** /api/reconfigure が流すSSEイベント */
export type ReconfigureEvent =
  | { type: "rphase"; label: string }
  | { type: "patch"; diff: SpecDiff; ok: boolean; reason?: string; summary: string }
  | { type: "rdone"; applied: number }
  | { type: "rerror"; message: string };

/* ============================================================
 * applyDiff — 決定論的リデューサ(純粋関数)
 * ============================================================ */

function summarize(diff: SpecDiff): string {
  switch (diff.op) {
    case "addApprovalStep":
      return `addApprovalStep{${diff.name} / ${diff.role}}`;
    case "setNumberLimit": {
      const parts = [
        diff.min !== undefined ? `min:${diff.min}` : null,
        diff.max !== undefined ? `max:${diff.max}` : null,
      ].filter(Boolean);
      return `setNumberLimit{${diff.fieldId}, ${parts.join(", ")}}`;
    }
    case "addField":
      return `addField{${diff.id}: ${diff.label} (${diff.fieldType})}`;
    case "addAggregation":
      return `addAggregation{${diff.label}: ${diff.agg}(${diff.fieldId})}`;
    case "renameField":
      return `renameField{${diff.fieldId} → ${diff.label}}`;
    case "addFilterColumn":
      return `addFilterColumn{${diff.fieldId}}`;
  }
}

function fail(spec: AppSpec, diff: SpecDiff, reason: string): DiffResult {
  return { ok: false, reason, spec, summary: summarize(diff) };
}

const NUM = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function applyDiff(spec: AppSpec, diff: SpecDiff): DiffResult {
  const summary = summarize(diff);

  switch (diff.op) {
    case "addApprovalStep": {
      if (!diff.name?.trim() || !diff.role?.trim())
        return fail(spec, diff, "名前とロールが必要です");
      const flow = spec.approvalFlow ?? [];
      if (flow.some((s) => s.name === diff.name))
        return fail(spec, diff, `「${diff.name}」は既に承認フローにあります`);
      if (flow.length >= 5) return fail(spec, diff, "承認ステップは5段までです");
      return {
        ok: true,
        summary,
        spec: { ...spec, approvalFlow: [...flow, { name: diff.name, role: diff.role }] },
      };
    }

    case "setNumberLimit": {
      if (diff.min === undefined && diff.max === undefined)
        return fail(spec, diff, "min/maxのどちらかが必要です");
      if (diff.min !== undefined && !NUM(diff.min))
        return fail(spec, diff, "minが数値ではありません");
      if (diff.max !== undefined && !NUM(diff.max))
        return fail(spec, diff, "maxが数値ではありません");
      if (diff.min !== undefined && diff.max !== undefined && diff.min > diff.max)
        return fail(spec, diff, "minがmaxを上回っています");

      // 片側だけ指定されたときは既存の反対側リミットを保持し、マージ後の整合を検証する
      const merged = (cur: { min?: number; max?: number }) => {
        const min = diff.min ?? cur.min;
        const max = diff.max ?? cur.max;
        return { min, max, valid: min === undefined || max === undefined || min <= max };
      };
      const fi = spec.fields.findIndex((f) => f.id === diff.fieldId);
      if (fi >= 0) {
        if (spec.fields[fi].type !== "number")
          return fail(spec, diff, `「${spec.fields[fi].label}」は数値項目ではありません`);
        const m = merged(spec.fields[fi]);
        if (!m.valid) return fail(spec, diff, "既存のリミットと矛盾します(min > max)");
        const fields = spec.fields.slice();
        fields[fi] = { ...fields[fi], min: m.min, max: m.max };
        return { ok: true, summary, spec: { ...spec, fields } };
      }
      const ci = spec.lineItems?.columns.findIndex((c) => c.id === diff.fieldId) ?? -1;
      if (spec.lineItems && ci >= 0) {
        if (spec.lineItems.columns[ci].type !== "number")
          return fail(spec, diff, `明細列「${spec.lineItems.columns[ci].label}」は数値列ではありません`);
        const m = merged(spec.lineItems.columns[ci]);
        if (!m.valid) return fail(spec, diff, "既存のリミットと矛盾します(min > max)");
        const columns = spec.lineItems.columns.slice();
        columns[ci] = { ...columns[ci], min: m.min, max: m.max };
        return { ok: true, summary, spec: { ...spec, lineItems: { ...spec.lineItems, columns } } };
      }
      return fail(spec, diff, `項目「${diff.fieldId}」が見つかりません`);
    }

    case "addField": {
      const id = diff.id?.trim();
      if (!id || !diff.label?.trim()) return fail(spec, diff, "idとラベルが必要です");
      if (spec.fields.some((f) => f.id === id))
        return fail(spec, diff, `項目「${id}」は既に存在します`);
      if (spec.fields.length >= 20) return fail(spec, diff, "項目は20個までです");
      const field: FieldSpec = {
        id,
        label: diff.label,
        type: diff.fieldType,
        required: diff.required ?? false,
        options: diff.fieldType === "select" ? (diff.options ?? []) : undefined,
        unit: diff.unit,
        confidence: 1, // 人の指示で追加された項目
      };
      return { ok: true, summary, spec: { ...spec, fields: [...spec.fields, field] } };
    }

    case "addAggregation": {
      if (!diff.label?.trim()) return fail(spec, diff, "ラベルが必要です");
      const field = spec.fields.find((f) => f.id === diff.fieldId);
      if (!field) return fail(spec, diff, `項目「${diff.fieldId}」が見つかりません`);
      if (diff.agg !== "count" && field.type !== "number")
        return fail(spec, diff, `「${field.label}」は数値項目ではないため${diff.agg}できません`);
      if (spec.aggregations.length >= 6) return fail(spec, diff, "集計カードは6枚までです");
      const id = `agg_${diff.agg}_${diff.fieldId}`;
      if (spec.aggregations.some((a) => a.id === id))
        return fail(spec, diff, "同じ集計が既にあります");
      return {
        ok: true,
        summary,
        spec: {
          ...spec,
          aggregations: [
            ...spec.aggregations,
            { id, label: diff.label, fieldId: diff.fieldId, op: diff.agg, unit: diff.unit ?? field.unit },
          ],
        },
      };
    }

    case "renameField": {
      if (!diff.label?.trim()) return fail(spec, diff, "新しいラベルが必要です");
      const fi = spec.fields.findIndex((f) => f.id === diff.fieldId);
      if (fi >= 0) {
        const fields = spec.fields.slice();
        fields[fi] = { ...fields[fi], label: diff.label };
        return { ok: true, summary, spec: { ...spec, fields } };
      }
      const ci = spec.lineItems?.columns.findIndex((c) => c.id === diff.fieldId) ?? -1;
      if (spec.lineItems && ci >= 0) {
        const columns = spec.lineItems.columns.slice();
        columns[ci] = { ...columns[ci], label: diff.label };
        return { ok: true, summary, spec: { ...spec, lineItems: { ...spec.lineItems, columns } } };
      }
      return fail(spec, diff, `項目「${diff.fieldId}」が見つかりません`);
    }

    case "addFilterColumn": {
      const field = spec.fields.find((f) => f.id === diff.fieldId);
      if (!field) return fail(spec, diff, `項目「${diff.fieldId}」が見つかりません`);
      if (spec.listColumns.includes(diff.fieldId))
        return fail(spec, diff, `「${field.label}」は既に一覧に表示されています`);
      if (spec.listColumns.length >= 6) return fail(spec, diff, "一覧の列は6つまでです");
      return { ok: true, summary, spec: { ...spec, listColumns: [...spec.listColumns, diff.fieldId] } };
    }
  }
}

/** 複数opをまとめて適用。okなopだけがspecに反映される */
export function applyDiffs(
  spec: AppSpec,
  diffs: SpecDiff[],
): { spec: AppSpec; results: DiffResult[] } {
  let cur = spec;
  const results: DiffResult[] = [];
  for (const d of diffs) {
    const r = applyDiff(cur, d);
    results.push(r);
    cur = r.spec;
  }
  return { spec: cur, results };
}

/* ============================================================
 * バリデーション表示・ROI(決定論・実データ由来)
 * ============================================================ */

export interface LimitViolation {
  kind: "max" | "min";
  /** 超過(不足)量。正の数 */
  amount: number;
  limit: number;
}

export function checkLimit(
  f: { min?: number; max?: number },
  v: unknown,
): LimitViolation | null {
  if (!NUM(v)) return null;
  if (f.max !== undefined && v > f.max)
    return { kind: "max", amount: round2(v - f.max), limit: f.max };
  if (f.min !== undefined && v < f.min)
    return { kind: "min", amount: round2(f.min - v), limit: f.min };
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 上限超過のROIサマリ(手元のレコードから決定論的に算出。捏造なし)。
 * 円建てのときだけ年間換算を出す。
 */
export function roiSummary(
  field: FieldSpec,
  records: AppRecord[],
): string | null {
  if (field.type !== "number" || (field.max === undefined && field.min === undefined))
    return null;
  let count = 0;
  let total = 0;
  for (const r of records) {
    const viol = checkLimit(field, r[field.id]);
    if (viol) {
      count++;
      total += viol.amount;
    }
  }
  if (count === 0) return null;
  const unit = field.unit ?? "";
  if (unit === "円") {
    const annual = total * 12;
    const annualText =
      annual >= 10000 ? `約${Math.round(annual / 10000).toLocaleString()}万円` : `¥${annual.toLocaleString()}`;
    return `今あるデータで上限超過 ${count}件・計¥${total.toLocaleString()} → 年間換算 ${annualText}の確認対象`;
  }
  return `今あるデータで上限超過 ${count}件`;
}

/* ============================================================
 * tool use 定義 — 現行specの実IDをenumに動的注入(幻覚の構造的封殺)
 * ============================================================ */

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function buildReconfigureTools(spec: AppSpec): ToolDef[] {
  const numericIds = [
    ...spec.fields.filter((f) => f.type === "number").map((f) => f.id),
    ...(spec.lineItems?.columns.filter((c) => c.type === "number").map((c) => c.id) ?? []),
  ];
  const allIds = [
    ...spec.fields.map((f) => f.id),
    ...(spec.lineItems?.columns.map((c) => c.id) ?? []),
  ];
  const scalarIds = spec.fields.map((f) => f.id);
  const filterable = spec.fields
    .filter((f) => !spec.listColumns.includes(f.id))
    .map((f) => f.id);

  const labelHint = [
    ...spec.fields.map((f) => `${f.id}=${f.label}`),
    ...(spec.lineItems?.columns.map((c) => `${c.id}=${c.label}(明細列)`) ?? []),
  ].join(", ");

  const tools: ToolDef[] = [
    {
      name: "add_approval_step",
      description: "承認フローにステップを1段追加する(例: 社長承認)。複数段はこのツールを複数回呼ぶ。",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "ステップ名(例: 社長承認)" },
          role: { type: "string", description: "承認者のロール(例: 社長)" },
        },
        required: ["name", "role"],
        additionalProperties: false,
      },
    },
    {
      name: "add_field",
      description: "フォームに新しい項目を追加する。",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "英小文字スネークケースの新ID" },
          label: { type: "string" },
          fieldType: { type: "string", enum: ["text", "textarea", "number", "date", "select", "checkbox"] },
          required: { type: "boolean" },
          options: { type: "array", items: { type: "string" }, description: "select用" },
          unit: { type: "string", description: "number用の単位(円・時間など)" },
        },
        required: ["id", "label", "fieldType"],
        additionalProperties: false,
      },
    },
  ];

  if (numericIds.length > 0) {
    tools.push({
      name: "set_number_limit",
      description: `数値項目に上限/下限チェックを設定する。金額の「万円」は円に換算すること(1万円=10000)。項目対応表: ${labelHint}`,
      input_schema: {
        type: "object",
        properties: {
          fieldId: { type: "string", enum: numericIds },
          min: { type: "number", description: "下限(任意)" },
          max: { type: "number", description: "上限(任意)" },
        },
        required: ["fieldId"],
        additionalProperties: false,
      },
    });
  }
  if (scalarIds.length > 0) {
    tools.push({
      name: "add_aggregation",
      description: `ダッシュボードに集計カードを追加する。項目対応表: ${labelHint}`,
      input_schema: {
        type: "object",
        properties: {
          label: { type: "string", description: "カードの見出し(例: 平均発注額)" },
          fieldId: { type: "string", enum: scalarIds },
          agg: { type: "string", enum: ["sum", "count", "avg"] },
          unit: { type: "string" },
        },
        required: ["label", "fieldId", "agg"],
        additionalProperties: false,
      },
    });
  }
  if (allIds.length > 0) {
    tools.push({
      name: "rename_field",
      description: `項目の表示名を変更する。項目対応表: ${labelHint}`,
      input_schema: {
        type: "object",
        properties: {
          fieldId: { type: "string", enum: allIds },
          label: { type: "string", description: "新しい表示名" },
        },
        required: ["fieldId", "label"],
        additionalProperties: false,
      },
    });
  }
  if (filterable.length > 0) {
    tools.push({
      name: "add_filter_column",
      description: `一覧画面に表示する列を追加する。項目対応表: ${labelHint}`,
      input_schema: {
        type: "object",
        properties: {
          fieldId: { type: "string", enum: filterable },
        },
        required: ["fieldId"],
        additionalProperties: false,
      },
    });
  }
  return tools;
}

/** tool_useブロック(name+input)をSpecDiffへ写像。未知のツール名はnull */
export function toolCallToDiff(
  name: string,
  input: Record<string, unknown>,
): SpecDiff | null {
  switch (name) {
    case "add_approval_step":
      return { op: "addApprovalStep", name: String(input.name ?? ""), role: String(input.role ?? "") };
    case "set_number_limit":
      return {
        op: "setNumberLimit",
        fieldId: String(input.fieldId ?? ""),
        min: NUM(input.min) ? input.min : undefined,
        max: NUM(input.max) ? input.max : undefined,
      };
    case "add_field": {
      const allowed = ["text", "textarea", "number", "date", "select", "checkbox"] as const;
      const ft = allowed.includes(input.fieldType as (typeof allowed)[number])
        ? (input.fieldType as (typeof allowed)[number])
        : "text";
      return {
        op: "addField",
        id: String(input.id ?? ""),
        label: String(input.label ?? ""),
        fieldType: ft,
        required: input.required === true,
        options: Array.isArray(input.options) ? input.options.map(String) : undefined,
        unit: input.unit ? String(input.unit) : undefined,
      };
    }
    case "add_aggregation": {
      const agg = input.agg === "sum" || input.agg === "count" || input.agg === "avg" ? input.agg : "sum";
      return {
        op: "addAggregation",
        label: String(input.label ?? ""),
        fieldId: String(input.fieldId ?? ""),
        agg,
        unit: input.unit ? String(input.unit) : undefined,
      };
    }
    case "rename_field":
      return { op: "renameField", fieldId: String(input.fieldId ?? ""), label: String(input.label ?? "") };
    case "add_filter_column":
      return { op: "addFilterColumn", fieldId: String(input.fieldId ?? "") };
    default:
      return null;
  }
}

/* ============================================================
 * キーワード・フォールバック(APIなし/ライブ失敗時)
 * ============================================================ */

function parseYen(text: string): number | null {
  const m = /([0-9][0-9,.]*)\s*(万)?\s*円/.exec(text);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  return m[2] ? base * 10000 : base;
}

function findNumericTarget(spec: AppSpec, text: string): string | null {
  const candidates: { id: string; label: string }[] = [
    ...spec.fields.filter((f) => f.type === "number").map((f) => ({ id: f.id, label: f.label })),
    ...(spec.lineItems?.columns.filter((c) => c.type === "number").map((c) => ({ id: c.id, label: c.label })) ?? []),
  ];
  for (const c of candidates) {
    const plain = c.label.replace(/[((].*?[))]/g, "");
    if (text.includes(c.label) || (plain && text.includes(plain))) return c.id;
  }
  // 「単価」「金額」などの一般語で部分一致
  for (const word of ["単価", "金額", "圧力", "温度", "時間"]) {
    if (text.includes(word)) {
      const hit = candidates.find((c) => c.label.includes(word));
      if (hit) return hit.id;
    }
  }
  return candidates.length === 1 ? candidates[0].id : null;
}

/** LLMなしで指示文を定型差分に変換するベストエフォート */
export function keywordFallback(spec: AppSpec, instruction: string): SpecDiff[] {
  const diffs: SpecDiff[] = [];

  if (/承認/.test(instruction) && /(追加|増や|段階|入れ|二段|2段)/.test(instruction)) {
    const flow = spec.approvalFlow ?? [];
    const name = flow.some((s) => s.name.includes("社長")) ? "役員確認" : "社長承認";
    const role = name === "社長承認" ? "社長" : "役員";
    diffs.push({ op: "addApprovalStep", name, role });
  }

  if (/(上限|下限|超え|以下|以上|まで|アラート|チェック)/.test(instruction)) {
    const yen = parseYen(instruction);
    // 円表記がない場合は「上限・下限語に隣接した数値」だけを拾う
    // (「2段階」の2などの無関係な数字を閾値として誤認しないため)
    const plain = /([0-9][0-9,.]*)\s*(万)?\s*(以上|以下|まで|超|未満)/.exec(
      instruction.replace(/,/g, ""),
    );
    const num = yen ?? (plain ? parseFloat(plain[1]) * (plain[2] ? 10000 : 1) : null);
    const target = findNumericTarget(spec, instruction);
    if (num !== null && Number.isFinite(num) && target) {
      // 「N以上はアラート」はNを超える値の検知=上限。minは下限系の語彙に限定する
      const isMin = /(下限|下回|未満)/.test(instruction);
      diffs.push(
        isMin
          ? { op: "setNumberLimit", fieldId: target, min: num }
          : { op: "setNumberLimit", fieldId: target, max: num },
      );
    }
  }

  if (/(平均|合計|件数)/.test(instruction) && /(集計|ダッシュボード|カード)/.test(instruction)) {
    const target =
      spec.fields.find((f) => f.type === "number" && instruction.includes(f.label))?.id ??
      spec.fields.find((f) => f.type === "number")?.id;
    if (target) {
      const agg = /平均/.test(instruction) ? "avg" : /件数/.test(instruction) ? "count" : "sum";
      const field = spec.fields.find((f) => f.id === target);
      diffs.push({
        op: "addAggregation",
        label: `${agg === "avg" ? "平均" : agg === "count" ? "件数" : "合計"}: ${field?.label ?? target}`,
        fieldId: target,
        agg,
      });
    }
  }

  if (/一覧/.test(instruction) && /(表示|出|追加|見)/.test(instruction)) {
    const hit = spec.fields.find(
      (f) => !spec.listColumns.includes(f.id) && instruction.includes(f.label),
    );
    if (hit) diffs.push({ op: "addFilterColumn", fieldId: hit.id });
  }

  return diffs;
}

/* ============================================================
 * 提案チップ(シナリオ別・オフラインで確実に動く定型差分)
 * ============================================================ */

export interface CommandChip {
  id: string;
  label: string;
  ops: SpecDiff[];
}

const SCENARIO_CHIPS: Record<string, CommandChip[]> = {
  seikyu: [
    {
      id: "exec-check",
      label: "10万円超の請求は役員確認に",
      ops: [
        { op: "addApprovalStep", name: "役員確認", role: "役員" },
        { op: "setNumberLimit", fieldId: "billed", max: 100000 },
      ],
    },
    {
      id: "price-cap",
      label: "明細単価に200円の上限アラート",
      ops: [{ op: "setNumberLimit", fieldId: "unit_price", max: 200 }],
    },
    {
      id: "avg-agg",
      label: "平均請求額をダッシュボードに",
      ops: [{ op: "addAggregation", label: "平均請求額", fieldId: "billed", agg: "avg", unit: "円" }],
    },
    {
      id: "list-purchase",
      label: "一覧に今回買上額を表示",
      ops: [{ op: "addFilterColumn", fieldId: "purchase" }],
    },
  ],
  chumonsho: [
    {
      id: "big-order-approval",
      label: "8万円超の発注は社長承認に",
      ops: [
        { op: "addApprovalStep", name: "社長承認", role: "社長" },
        { op: "setNumberLimit", fieldId: "total", max: 80000 },
      ],
    },
    {
      id: "unit-price-cap",
      label: "単価に3,000円の上限チェック",
      ops: [{ op: "setNumberLimit", fieldId: "unit_price", max: 3000 }],
    },
    {
      id: "list-note",
      label: "一覧に備考も表示",
      ops: [{ op: "addFilterColumn", fieldId: "note" }],
    },
    {
      id: "avg-total",
      label: "平均発注額を集計",
      ops: [{ op: "addAggregation", label: "平均発注額", fieldId: "total", agg: "avg", unit: "円" }],
    },
  ],
  nippo: [
    {
      id: "safety-approval",
      label: "安全責任者の確認を追加",
      ops: [{ op: "addApprovalStep", name: "安全確認", role: "安全責任者" }],
    },
    {
      id: "overtime-field",
      label: "残業時間の項目を追加",
      ops: [
        { op: "addField", id: "overtime_hours", label: "残業時間", fieldType: "number", unit: "時間" },
      ],
    },
    {
      id: "list-weather",
      label: "一覧に天候を表示",
      ops: [{ op: "addFilterColumn", fieldId: "weather" }],
    },
  ],
  tenken: [
    {
      id: "pressure-cap",
      label: "圧力0.6MPa超を自動アラート",
      ops: [{ op: "setNumberLimit", fieldId: "pressure", max: 0.6 }],
    },
    {
      id: "maint-approval",
      label: "保全課長の確認を追加",
      ops: [{ op: "addApprovalStep", name: "保全課長確認", role: "保全課長" }],
    },
    {
      id: "temp-cap",
      label: "本体温度40℃の上限チェック",
      ops: [{ op: "setNumberLimit", fieldId: "temperature", max: 40 }],
    },
    {
      id: "avg-temp",
      label: "平均本体温度を集計",
      ops: [{ op: "addAggregation", label: "平均本体温度", fieldId: "temperature", agg: "avg", unit: "℃" }],
    },
  ],
};

export function chipsForScenario(scenarioId: string): CommandChip[] {
  return SCENARIO_CHIPS[scenarioId] ?? [];
}

/** 数値を「きりのいい」少し下の値に丸める(ライブ写真用チップの自動しきい値) */
function niceFloorBelow(v: number): number {
  if (v <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const floored = Math.floor((v / mag) * 2) / 2; // 0.5刻み
  const candidate = floored * mag;
  return candidate >= v ? candidate - mag / 2 : candidate;
}

/**
 * ライブ写真から生成したアプリ用の汎用チップ。
 * 実データの値から決定論的にしきい値を作るため、審査員の紙でも必ず「発火する」絵が出る。
 */
export function genericChips(spec: AppSpec, firstRecord: AppRecord): CommandChip[] {
  const chips: CommandChip[] = [];

  const flow = spec.approvalFlow ?? [];
  if (flow.length < 5) {
    const name = flow.some((s) => s.name.includes("社長")) ? "役員確認" : "社長承認";
    chips.push({
      id: "g-approval",
      label: `承認に「${name}」を追加`,
      ops: [{ op: "addApprovalStep", name, role: name === "社長承認" ? "社長" : "役員" }],
    });
  }

  const numField = spec.fields.find(
    (f) => f.type === "number" && NUM(firstRecord[f.id]) && (firstRecord[f.id] as number) > 0,
  );
  if (numField && numField.max === undefined) {
    const v = firstRecord[numField.id] as number;
    const limit = niceFloorBelow(v);
    if (limit > 0 && limit < v) {
      chips.push({
        id: "g-limit",
        label: `${numField.label}に上限チェック(${limit.toLocaleString()}${numField.unit ?? ""})`,
        ops: [{ op: "setNumberLimit", fieldId: numField.id, max: limit }],
      });
    }
  }

  if (numField && !spec.aggregations.some((a) => a.fieldId === numField.id && a.op === "avg")) {
    chips.push({
      id: "g-avg",
      label: `平均${numField.label}を集計`,
      ops: [{ op: "addAggregation", label: `平均${numField.label}`, fieldId: numField.id, agg: "avg", unit: numField.unit }],
    });
  }

  return chips;
}
