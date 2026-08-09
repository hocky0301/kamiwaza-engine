"use client";

// 決定論的レンダラー: 妥当なAppSpecなら何でも「業務アプリ」として描画する。
// LLMはスペックしか出力しないため、UI品質はこちら側で常に担保される。

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSpec,
  AppRecord,
  FieldSpec,
  SourceBox,
  RecordValue,
} from "@/lib/appspec";
import type { LlmUsage, PricingSource } from "@/lib/events";
import type { LlmRoute } from "@/lib/llm-client";
import {
  checkLimit,
  roiSummary,
  type CommandChip,
  type PatchLogEntry,
} from "@/lib/specdiff";
import { FIELD_TYPE_META, ConfidenceBadge } from "./field-meta";

type Tab = "form" | "list" | "dashboard";

/**
 * 推定原価の累計(解析+ライブ再構成)。
 * トークン実測×公表単価の保守的上限であり、課金の正はプロバイダのダッシュボード。
 */
export interface CostState {
  /** 累計の推定原価(USD) */
  usd: number;
  /** 累計のトークン内訳(実測) */
  usage: LlmUsage;
  /** 1回でもfallback単価を含めば "fallback"(保守側に倒す) */
  source: PricingSource;
  /** ライブ再構成の回数 */
  reconfCalls: number;
  route: LlmRoute | null;
}

export interface QuestionState {
  fieldId: string;
  question: string;
  choices: string[];
  answer: number | null;
}

/** 提案チップ+適用可否(すべて適用済みならdisabled) */
export type ChipState = CommandChip & { disabled: boolean };

interface SpecAppProps {
  spec: AppSpec;
  /** records[0] が今スキャンした1件目 */
  records: AppRecord[];
  alert: string | null;
  mode: "demo" | "live";
  /** ライブ経路の推定原価チップ。デモ・usage欠落時はnull(実額を捏造しない) */
  cost: CostState | null;
  onHighlight: (box: SourceBox | null) => void;
  question: QuestionState | null;
  onAnswer: (choiceIndex: number) => void;
  /* --- 日本語で書いて直す --- */
  chips: ChipState[];
  onChip: (chip: ChipState) => void;
  onInstruction: (text: string) => void;
  onUndo: () => void;
  canUndo: boolean;
  patchLog: PatchLogEntry[];
  busy: boolean;
}

/* ---------- 値フォーマット ---------- */

function fmtDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

function fmtValue(field: FieldSpec | undefined, v: RecordValue | undefined): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "✓" : "—";
  if (field?.type === "number" && typeof v === "number")
    return `${v.toLocaleString()}${field.unit ?? ""}`;
  if (field?.type === "date" && typeof v === "string") return fmtDate(v);
  return String(v);
}

/* ---------- 逆質問カード ---------- */

export function QuestionCard({
  question,
  onAnswer,
  disabled = false,
}: {
  question: QuestionState;
  onAnswer: (i: number) => void;
  /** 再構成の適用中は回答を受け付けない(specスナップショットの整合を守る) */
  disabled?: boolean;
}) {
  return (
    <div className="field-in card border-warn/50 bg-warn/5 p-4">
      <div className="flex items-start gap-3">
        <span className="text-xl shrink-0">🤔</span>
        <div className="flex-1">
          <div className="text-[11px] font-bold text-warn mb-1">
            カミワザからの確認
          </div>
          <p className="text-sm leading-relaxed">{question.question}</p>
          {question.answer === null ? (
            <div className="flex gap-2 mt-3 flex-wrap">
              {question.choices.map((c, i) => (
                <button
                  key={i}
                  onClick={() => onAnswer(i)}
                  disabled={disabled}
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                    i === 0
                      ? "bg-accent text-white hover:opacity-85"
                      : "border border-line text-dim hover:text-fg hover:border-dim"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-ok">
              ✓ 回答: {question.choices[question.answer]} — スペックに反映しました
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 日本語で書いて直す(コマンドバー+手術ログ) ---------- */

function CommandBar({
  chips,
  onChip,
  onInstruction,
  onUndo,
  canUndo,
  patchLog,
  busy,
}: Pick<
  SpecAppProps,
  "chips" | "onChip" | "onInstruction" | "onUndo" | "canUndo" | "patchLog" | "busy"
>) {
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // 新しいログ行が来たら追従スクロール
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [patchLog.length]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onInstruction(text);
    setText("");
  };

  return (
    <div className="card p-3.5">
      {/* モバイルでは入力欄が1行を占め、ボタンは次の行へ折り返す(sm以上は従来どおり1行) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 w-full sm:w-auto sm:flex-1 min-w-0">
          <span className="text-base shrink-0">🗣️</span>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // SafariはIME確定EnterでisComposing=falseのままkeyCode=229を報告する
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) submit();
            }}
            disabled={busy}
            placeholder="このアプリに日本語で指示…(例: 承認を2段階にして、単価に上限チェックを)"
            className="flex-1 min-w-0 rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-accent outline-none disabled:opacity-50"
          />
        </div>
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="rounded-lg bg-accent text-white px-3.5 py-2 text-sm font-medium hover:opacity-85 disabled:opacity-40 transition-opacity cursor-pointer shrink-0"
        >
          {busy ? (
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent spin-slow align-middle" />
          ) : (
            "作り替える"
          )}
        </button>
        {canUndo && (
          <button
            onClick={onUndo}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-2 text-sm text-dim hover:text-fg hover:border-dim disabled:opacity-40 transition-colors cursor-pointer shrink-0"
            title="直前の変更を元に戻す"
          >
            ↩ 戻す
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {chips.map((chip) => (
            <button
              key={chip.id}
              onClick={() => onChip(chip)}
              disabled={busy || chip.disabled}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors cursor-pointer ${
                chip.disabled
                  ? "border-line text-dim/50 line-through cursor-default"
                  : "border-accent/50 text-accent hover:bg-accent-soft"
              } disabled:cursor-default`}
              title={chip.disabled ? "適用済み" : "タップでその場で作り替え(オフラインでも動作)"}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {patchLog.length > 0 && (
        <div
          ref={logRef}
          className="mt-2.5 rounded-lg bg-panel border border-line px-3 py-2 font-mono text-[11px] leading-5 max-h-24 overflow-y-auto"
        >
          {patchLog.map((e, i) => (
            <div key={i} className="field-in">
              {e.info ? (
                <span className="text-dim">{e.summary}</span>
              ) : e.ok ? (
                <>
                  <span className="text-ok">✓ </span>
                  <span className="text-fg">{e.summary}</span>
                </>
              ) : (
                <>
                  <span className="text-accent">✗ </span>
                  <span className="text-dim">
                    {e.summary}
                    {e.reason ? ` — ${e.reason}` : ""}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- フォーム ---------- */

function FormField({
  field,
  value,
  confirmed,
  onHighlight,
  roiNote,
}: {
  field: FieldSpec;
  value: RecordValue | undefined;
  confirmed: boolean;
  onHighlight: (box: SourceBox | null) => void;
  roiNote?: string | null;
}) {
  const tm = FIELD_TYPE_META[field.type];
  // 数値フィールドは編集にバリデーションが追従するよう制御化する
  // (審査員が値を書き換えたとき赤発火/解除がその場で反応する)
  const [draft, setDraft] = useState<number | undefined>(
    typeof value === "number" ? value : undefined,
  );
  useEffect(() => {
    setDraft(typeof value === "number" ? value : undefined);
  }, [value]);
  const violation = field.type === "number" ? checkLimit(field, draft) : null;

  const input = (() => {
    switch (field.type) {
      case "textarea":
        return (
          <textarea
            defaultValue={String(value ?? "")}
            rows={2}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm resize-y focus:border-accent outline-none"
          />
        );
      case "select":
        return (
          <select
            defaultValue={String(value ?? "")}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-accent outline-none"
          >
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      case "checkbox":
        return (
          <label className="flex items-center gap-2 text-sm py-1.5 cursor-pointer">
            <input type="checkbox" defaultChecked={value === true} className="accent-[var(--accent)] w-4 h-4" />
            <span className="text-dim">実施済み</span>
          </label>
        );
      case "stamp":
        return (
          <div className="flex items-center gap-2 py-1">
            <span
              className={`inline-flex items-center justify-center w-9 h-9 rounded-full border-2 text-[11px] font-serif ${
                value === true
                  ? "border-accent text-accent"
                  : "border-line text-dim border-dashed"
              }`}
              style={{ transform: "rotate(-6deg)" }}
            >
              {value === true ? "印" : "未"}
            </span>
            <span className="text-xs text-dim">{value === true ? "押印あり" : "未押印"}</span>
          </div>
        );
      case "number":
        return (
          <div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={draft ?? ""}
                onChange={(e) => {
                  const n = e.target.valueAsNumber;
                  setDraft(Number.isFinite(n) ? n : undefined);
                }}
                className={`w-full rounded-lg border bg-panel px-3 py-2 text-sm outline-none ${
                  violation
                    ? "border-accent text-accent font-bold"
                    : "border-line focus:border-accent"
                }`}
              />
              {field.unit && <span className="text-sm text-dim shrink-0">{field.unit}</span>}
            </div>
            {violation && (
              <div className="field-in mt-1.5 text-xs text-accent font-medium">
                ⚠ {violation.kind === "max" ? "上限" : "下限"}{" "}
                {violation.limit.toLocaleString()}
                {field.unit ?? ""} を {violation.amount.toLocaleString()}
                {field.unit ?? ""} {violation.kind === "max" ? "超過" : "下回り"} —{" "}
                {field.min !== undefined && violation.kind === "min"
                  ? "確認が必要です"
                  : "承認前に確認が必要です"}
              </div>
            )}
            {roiNote && (
              <div className="field-in mt-1 text-[11px] text-warn">💰 {roiNote}</div>
            )}
          </div>
        );
      case "date":
        return (
          <input
            type="date"
            defaultValue={typeof value === "string" ? value : undefined}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-accent outline-none"
          />
        );
      default:
        return (
          <input
            type="text"
            defaultValue={String(value ?? "")}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-accent outline-none"
          />
        );
    }
  })();

  return (
    <div
      className="group rounded-xl border border-transparent hover:border-accent/40 hover:bg-accent-soft/40 px-3 py-2 -mx-3 transition-colors"
      onMouseEnter={() => field.sourceBox && onHighlight(field.sourceBox)}
      onMouseLeave={() => onHighlight(null)}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs">{tm.icon}</span>
        <label className="text-sm font-medium">
          {field.label}
          {field.required && <span className="text-accent ml-0.5">*</span>}
        </label>
        {confirmed ? (
          <span className="text-[10px] rounded-full bg-ok/15 text-ok px-2 py-0.5 ml-auto">
            確認済み
          </span>
        ) : (
          <span className="ml-auto">
            <ConfidenceBadge value={field.confidence} />
          </span>
        )}
        {field.sourceBox && (
          <span
            className="text-[10px] text-dim opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            title="元の紙のどこから読み取ったか"
          >
            ← 紙の出典
          </span>
        )}
      </div>
      {input}
    </div>
  );
}

/* ---------- ダッシュボード ---------- */

function computeAgg(spec: AppSpec, records: AppRecord[], aggId: string): string {
  const agg = spec.aggregations.find((a) => a.id === aggId);
  if (!agg) return "—";
  if (agg.op === "count") return `${records.length}${agg.unit ?? "件"}`;
  const nums = records
    .map((r) => r[agg.fieldId])
    .filter((v): v is number => typeof v === "number");
  if (nums.length === 0) return "—";
  const sum = nums.reduce((a, b) => a + b, 0);
  const field = spec.fields.find((f) => f.id === agg.fieldId);
  const unit = agg.unit ?? field?.unit ?? "";
  if (agg.op === "sum")
    return unit === "円" ? `¥${sum.toLocaleString()}` : `${sum.toLocaleString()}${unit}`;
  const avg = sum / nums.length;
  const rounded = Math.round(avg * 100) / 100;
  return `${rounded.toLocaleString()}${unit}`;
}

function Chart({ spec, records }: { spec: AppSpec; records: AppRecord[] }) {
  const dateField = spec.fields.find((f) => f.type === "date");
  const numAgg = spec.aggregations.find((a) => {
    const f = spec.fields.find((x) => x.id === a.fieldId);
    return f?.type === "number" && (a.op === "sum" || a.op === "avg");
  });
  const numField = numAgg ? spec.fields.find((f) => f.id === numAgg.fieldId) : undefined;

  // 一覧のキー項目になっている選択式フィールドがあれば、1件目と同じ値に絞る
  // (例: 設備点検表 → 同じ設備の推移を見る)
  const dimField = spec.fields.find(
    (f) => f.type === "select" && spec.listColumns.includes(f.id),
  );
  const first = records[0];
  // 同一エンティティ(例: 同じ設備)の推移として意味を持つだけの件数が残る場合のみ絞り込む。
  // ステータス系のselect(絞ると1〜2件になる)では全件表示にフォールバックする
  const sameDim =
    dimField && first
      ? records.filter((r) => r[dimField.id] === first[dimField.id])
      : records;
  const useDim = dimField && first && sameDim.length >= 3;
  const filtered = useDim ? sameDim : records;

  const sorted = useMemo(() => {
    if (!dateField) return [...filtered].reverse();
    return [...filtered].sort((a, b) =>
      String(a[dateField.id] ?? "").localeCompare(String(b[dateField.id] ?? "")),
    );
  }, [filtered, dateField]);

  if (sorted.length === 0) return null;

  const values = sorted.map((r) =>
    numField && typeof r[numField.id] === "number" ? (r[numField.id] as number) : 1,
  );
  const max = Math.max(...values, 1);
  const title = numField
    ? `${useDim ? `${String(first[dimField.id])} — ` : ""}${numField.label}の推移`
    : "登録件数の推移";

  const W = 420;
  const H = 150;
  const pad = 6;
  const bw = Math.min(48, (W - pad * 2) / sorted.length - 8);

  return (
    <div className="card p-4">
      <div className="text-xs text-dim mb-2 font-medium">{title}</div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full">
        {sorted.map((r, i) => {
          const v = values[i];
          const h = Math.max(6, (v / max) * H * 0.88);
          const x = pad + (i + 0.5) * ((W - pad * 2) / sorted.length) - bw / 2;
          const isNewest = r === records[0];
          const label = dateField ? fmtDate(String(r[dateField.id] ?? "")) : `${i + 1}`;
          return (
            <g key={i}>
              <rect
                x={x}
                y={H - h}
                width={bw}
                height={h}
                rx={4}
                fill={isNewest ? "var(--accent)" : "var(--line)"}
              />
              {numField && (
                <text
                  x={x + bw / 2}
                  y={H - h - 5}
                  textAnchor="middle"
                  fontSize={10}
                  fill={isNewest ? "var(--accent)" : "var(--fg-dim)"}
                >
                  {v.toLocaleString()}
                </text>
              )}
              <text
                x={x + bw / 2}
                y={H + 14}
                textAnchor="middle"
                fontSize={10}
                fill="var(--fg-dim)"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ---------- 明細テーブル(DSL v2) ---------- */

function LineItemsTable({
  spec,
  onHighlight,
}: {
  spec: AppSpec;
  onHighlight: (box: SourceBox | null) => void;
}) {
  const li = spec.lineItems;
  if (!li || spec.firstRecordLines.length === 0) return null;
  return (
    <div
      className="group rounded-xl border border-transparent hover:border-accent/40 hover:bg-accent-soft/40 px-3 py-2 -mx-3 transition-colors"
      onMouseEnter={() => li.sourceBox && onHighlight(li.sourceBox)}
      onMouseLeave={() => onHighlight(null)}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs">🧮</span>
        <label className="text-sm font-medium">{li.label}</label>
        <span className="text-[10px] rounded-full bg-accent-soft text-accent px-2 py-0.5">
          {spec.firstRecordLines.length}行
        </span>
        {li.sourceBox && (
          <span
            className="text-[10px] text-dim opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0"
            title="元の紙のどこから読み取ったか"
          >
            ← 紙の出典
          </span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-panel text-dim text-xs">
              {li.columns.map((c) => (
                <th
                  key={c.id}
                  className={`px-3 py-2 font-medium whitespace-nowrap ${c.type === "number" ? "text-right" : "text-left"}`}
                >
                  {c.label}
                  {c.unit ? `(${c.unit})` : ""}
                  {c.max !== undefined && (
                    <span className="ml-1 text-accent font-bold">
                      ≦{c.max.toLocaleString()}
                    </span>
                  )}
                  {c.min !== undefined && (
                    <span className="ml-1 text-accent font-bold">
                      ≧{c.min.toLocaleString()}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.firstRecordLines.map((line, i) => (
              <tr key={i} className="border-t border-line/50">
                {li.columns.map((c) => {
                  const v = line[c.id];
                  const viol = c.type === "number" ? checkLimit(c, v) : null;
                  return (
                    <td
                      key={c.id}
                      className={`px-3 py-1.5 ${c.type === "number" ? "text-right tabular-nums" : ""} ${
                        viol ? "text-accent font-bold bg-accent-soft/50" : ""
                      }`}
                      title={
                        viol
                          ? `${viol.kind === "max" ? "上限" : "下限"} ${viol.limit.toLocaleString()}${c.unit ?? ""} を ${viol.amount.toLocaleString()}${c.unit ?? ""} ${viol.kind === "max" ? "超過" : "下回り"}`
                          : undefined
                      }
                    >
                      {v === undefined || v === ""
                        ? "—"
                        : typeof v === "number"
                          ? v.toLocaleString()
                          : String(v)}
                      {viol && <span className="ml-1">⚠</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- CSV ---------- */

/**
 * CSVインジェクション(数式インジェクション)対策。
 * ラベルも値も紙の写真をLLMが読んだ結果なので、紙に `=HYPERLINK(...)` と
 * 書いておくだけで、書き出したCSVをExcelで開いた瞬間に数式として評価されうる。
 * ダブルクォートで囲っても Excel は数式解釈するため、先頭に `'` を付けて無害化する。
 * ただし数値リテラル(負数・小数を含む)はそのまま通す — 書き出したCSVで
 * 金額や温度が文字列化してしまうと業務側の集計が壊れるため。
 * 全5シナリオの書き出し結果がこの変更前後でバイト単位一致することを確認済み。
 */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

const csvEsc = (s: string) => {
  const safe = /^[=+\-@\t\r]/.test(s) && !NUMERIC_LITERAL.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""').replace(/\n/g, " ")}"`;
};

function downloadBlob(csv: string, filename: string) {
  // 先頭のBOMでExcelにUTF-8と認識させる(日本語の文字化け防止)
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadLinesCsv(spec: AppSpec) {
  const li = spec.lineItems;
  if (!li) return;
  const header = li.columns.map((c) => csvEsc(c.label)).join(",");
  const rows = spec.firstRecordLines.map((line) =>
    li.columns.map((c) => csvEsc(String(line[c.id] ?? ""))).join(","),
  );
  downloadBlob([header, ...rows].join("\n"), `${spec.appName}_明細.csv`);
}

function downloadCsv(spec: AppSpec, records: AppRecord[]) {
  const header = spec.fields.map((f) => csvEsc(f.label)).join(",");
  const rows = records.map((r) =>
    spec.fields
      .map((f) => {
        const v = r[f.id];
        return csvEsc(typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v ?? ""));
      })
      .join(","),
  );
  downloadBlob([header, ...rows].join("\n"), `${spec.appName}.csv`);
}

/* ---------- 原価チップ(誠実表示) ---------- */

/** 参考換算のみ。課金はUSD(プロバイダのダッシュボードが正) */
const USD_JPY_REFERENCE_RATE = 150;

function fmtYen(usd: number): string {
  const yen = usd * USD_JPY_REFERENCE_RATE;
  return yen < 10 ? yen.toFixed(1) : String(Math.round(yen));
}

/**
 * 推定原価の詳細行(ヘッダ下トグル+hoverのtitle兼用)。
 * 「トークン実測×公表単価の保守的上限」であることを隠さず示す。
 */
function costDetailLines(cost: CostState): string[] {
  const u = cost.usage;
  const breakdown = [
    `入力 ${u.inputTokens.toLocaleString()}`,
    `キャッシュ読取 ${u.cacheReadInputTokens.toLocaleString()}`,
    ...(u.cacheCreationInputTokens > 0
      ? [`キャッシュ作成 ${u.cacheCreationInputTokens.toLocaleString()}`]
      : []),
    `出力 ${u.outputTokens.toLocaleString()}`,
  ].join(" + ");
  const rateSource =
    cost.source === "live"
      ? "OrcaRouter /v1/models 実測単価"
      : "公表値の定数単価(実測取得失敗時のフォールバック)";
  const billingRef = cost.route === "anthropic" ? "Anthropicコンソール" : "OrcaRouterダッシュボード";
  return [
    `${breakdown} tok × $5/$25 per 1Mtok(${rateSource})`,
    "キャッシュ割引前の上限推定(cache_read/cache_creation とも入力単価で満額計上。割引後の正値はダッシュボード)",
    `課金の正: ${billingRef}(この推定と突合可)・$1=¥${USD_JPY_REFERENCE_RATE} 参考換算`,
    ...(cost.reconfCalls > 0 ? [`再構成${cost.reconfCalls}回を含む累計`] : []),
  ];
}

/* ---------- 本体 ---------- */

export function SpecApp({
  spec,
  records,
  alert,
  mode,
  cost,
  onHighlight,
  question,
  onAnswer,
  chips,
  onChip,
  onInstruction,
  onUndo,
  canUndo,
  patchLog,
  busy,
}: SpecAppProps) {
  const [tab, setTab] = useState<Tab>("form");
  const [costOpen, setCostOpen] = useState(false);
  const first = records[0];

  const tabs: { id: Tab; label: string }[] = [
    { id: "form", label: "📄 フォーム" },
    { id: "list", label: "📚 一覧" },
    { id: "dashboard", label: "📊 ダッシュボード" },
  ];

  return (
    <div className="flex flex-col gap-3 h-full">
      {question && question.answer === null && (
        <QuestionCard question={question} onAnswer={onAnswer} disabled={busy} />
      )}

      <CommandBar
        chips={chips}
        onChip={onChip}
        onInstruction={onInstruction}
        onUndo={onUndo}
        canUndo={canUndo}
        patchLog={patchLog}
        busy={busy}
      />

      <div className="card flex-1 overflow-hidden flex flex-col">
        {/* アプリヘッダ */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line bg-panel">
          <span className="text-2xl">{spec.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold">{spec.appName}</div>
            <div className="text-dim text-[11px] truncate">{spec.description}</div>
          </div>
          {/* 原価チップ: ライブ=トークン実測×公表単価の推定累計 / デモ=$0の誠実表示。
              朱(--accent)は警告・赤発火の色なので原価には使わない(墨系ピル) */}
          {mode === "live" && cost && (
            <button
              onClick={() => setCostOpen((o) => !o)}
              className="text-[10px] rounded-full px-2.5 py-1 shrink-0 bg-panel border border-line hover:border-dim transition-colors cursor-pointer whitespace-nowrap"
              title={costDetailLines(cost).join("\n")}
            >
              <span className="text-dim">原価 </span>
              <span className="text-fg font-bold">${cost.usd.toFixed(3)}</span>
              <span className="hidden sm:inline text-dim">
                (約¥{fmtYen(cost.usd)}・参考換算)
                {cost.source === "fallback" && " ※定数単価"}
              </span>
            </button>
          )}
          {mode === "demo" && (
            <span
              className="text-[10px] rounded-full px-2.5 py-1 shrink-0 bg-panel border border-line text-dim whitespace-nowrap"
              title="サンプルカードは決定論リプレイでAPIを呼びません。実額はライブ解析時のみ表示"
            >
              <span className="sm:hidden">原価 $0</span>
              <span className="hidden sm:inline">デモ再生: LLM呼び出しなし(原価 $0)</span>
            </span>
          )}
          <span
            className={`text-[10px] rounded-full px-2.5 py-1 font-bold shrink-0 ${
              mode === "live" ? "bg-ok/15 text-ok" : "bg-accent-soft text-accent"
            }`}
          >
            {mode === "live" ? "● LIVE解析" : "● デモリプレイ"}
          </span>
        </div>

        {/* 原価の内訳(チップをクリックでトグル)— 推定の方法と限界を隠さない */}
        {mode === "live" && cost && costOpen && (
          <div className="px-5 py-2 border-b border-line text-[11px] leading-5 text-dim">
            {costDetailLines(cost).map((line, i) => (
              <div key={i} className={i === 0 ? "text-fg" : undefined}>
                {line}
              </div>
            ))}
          </div>
        )}

        {/* 承認フロー */}
        {spec.approvalFlow && spec.approvalFlow.length > 0 && (
          <div className="flex items-center gap-1.5 px-5 py-2 border-b border-line text-xs flex-wrap">
            <span className="text-dim mr-1">承認フロー:</span>
            {spec.approvalFlow.map((s, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-dim">→</span>}
                <span className="rounded-full bg-accent-soft text-accent px-2.5 py-0.5 font-medium">
                  {s.name}({s.role})
                </span>
              </span>
            ))}
            <span className="ml-auto rounded-full bg-warn/15 text-warn px-2.5 py-0.5">
              1件目: {spec.approvalFlow[spec.approvalFlow.length - 1].name}待ち
            </span>
          </div>
        )}

        {/* タブ — モバイルでは全部を1行に置けないので横スクロール(縦には絶対に折り返さない) */}
        <div className="flex border-b border-line px-3 overflow-x-auto overflow-y-hidden">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                tab === t.id
                  ? "border-accent text-fg"
                  : "border-transparent text-dim hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => downloadCsv(spec, records)}
            className="ml-auto my-1.5 rounded-lg border border-line px-3 text-xs text-dim hover:text-fg hover:border-dim transition-colors cursor-pointer whitespace-nowrap shrink-0"
            title="Excelで開けるCSVを書き出し"
          >
            ⬇ CSV
          </button>
          {spec.lineItems && spec.firstRecordLines.length > 0 && (
            <button
              onClick={() => downloadLinesCsv(spec)}
              className="ml-2 my-1.5 rounded-lg border border-line px-3 text-xs text-dim hover:text-fg hover:border-dim transition-colors cursor-pointer whitespace-nowrap shrink-0"
              title="明細行をCSVで書き出し"
            >
              ⬇ 明細CSV
            </button>
          )}
        </div>

        {/* コンテンツ — hidden切替で常時マウント(フォームの編集内容をタブ往復で保持) */}
        <div className="flex-1 overflow-y-auto">
          <div hidden={tab !== "form"}>
            <div className="p-5 flex flex-col gap-1.5">
              <div className="text-[11px] text-dim mb-2">
                項目にカーソルを合わせると、<span className="text-accent">元の紙のどこから読み取ったか</span>が光ります
              </div>
              {spec.fields.map((f) => (
                <FormField
                  key={f.id}
                  field={f}
                  value={first?.[f.id]}
                  confirmed={question?.fieldId === f.id && question.answer === 0}
                  onHighlight={onHighlight}
                  roiNote={
                    f.type === "number" && checkLimit(f, first?.[f.id])
                      ? roiSummary(f, records)
                      : null
                  }
                />
              ))}
              <LineItemsTable spec={spec} onHighlight={onHighlight} />
            </div>
          </div>

          {/* 一覧 — 列が増えるとモバイル幅を必ず超えるので、テーブルだけ横スクロールさせる。
              whitespace-nowrap がないと1文字ずつ縦積みになって読めなくなる */}
          <div hidden={tab !== "list"} className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim text-xs border-b border-line">
                  <th className="px-4 py-2.5 w-12"></th>
                  {spec.listColumns.map((cid) => (
                    <th key={cid} className="px-4 py-2.5 font-medium whitespace-nowrap">
                      {spec.fields.find((f) => f.id === cid)?.label ?? cid}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-b border-line/50 ${i === 0 ? "bg-accent-soft/60" : "hover:bg-panel"}`}
                  >
                    <td className="px-4 py-2.5">
                      {i === 0 && (
                        <span className="text-[10px] rounded bg-accent text-white px-1.5 py-0.5 font-bold">
                          NEW
                        </span>
                      )}
                    </td>
                    {spec.listColumns.map((cid) => (
                      <td key={cid} className="px-4 py-2.5 whitespace-nowrap">
                        {fmtValue(
                          spec.fields.find((f) => f.id === cid),
                          r[cid],
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div hidden={tab !== "dashboard"}>
            <div className="p-5 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                {spec.aggregations.map((a) => (
                  <div key={a.id} className="card p-3 sm:p-4">
                    <div className="text-xs text-dim mb-1">{a.label}</div>
                    {/* 桁数の多い金額がモバイルの半幅タイルからはみ出さないよう1段落とす */}
                    <div className="text-xl sm:text-2xl font-bold tracking-tight break-words">
                      {computeAgg(spec, records, a.id)}
                    </div>
                  </div>
                ))}
              </div>
              <Chart spec={spec} records={records} />
              {alert && (
                <div className="card border-warn/50 bg-warn/5 p-4 flex items-start gap-3">
                  <span className="text-xl shrink-0">⚠️</span>
                  <div>
                    <div className="text-[11px] font-bold text-warn mb-1">
                      AIからの気づき
                    </div>
                    <p className="text-sm leading-relaxed">{alert}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
