"use client";

// 決定論的レンダラー: 妥当なAppSpecなら何でも「業務アプリ」として描画する。
// LLMはスペックしか出力しないため、UI品質はこちら側で常に担保される。

import { useMemo, useState } from "react";
import type {
  AppSpec,
  AppRecord,
  FieldSpec,
  SourceBox,
  RecordValue,
} from "@/lib/appspec";
import { FIELD_TYPE_META, ConfidenceBadge } from "./field-meta";

type Tab = "form" | "list" | "dashboard";

export interface QuestionState {
  fieldId: string;
  question: string;
  choices: string[];
  answer: number | null;
}

interface SpecAppProps {
  spec: AppSpec;
  /** records[0] が今スキャンした1件目 */
  records: AppRecord[];
  alert: string | null;
  mode: "demo" | "live";
  onHighlight: (box: SourceBox | null) => void;
  question: QuestionState | null;
  onAnswer: (choiceIndex: number) => void;
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
}: {
  question: QuestionState;
  onAnswer: (i: number) => void;
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
                  className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
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

/* ---------- フォーム ---------- */

function FormField({
  field,
  value,
  confirmed,
  onHighlight,
}: {
  field: FieldSpec;
  value: RecordValue | undefined;
  confirmed: boolean;
  onHighlight: (box: SourceBox | null) => void;
}) {
  const tm = FIELD_TYPE_META[field.type];

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
          <div className="flex items-center gap-2">
            <input
              type="number"
              defaultValue={typeof value === "number" ? value : undefined}
              className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm focus:border-accent outline-none"
            />
            {field.unit && <span className="text-sm text-dim shrink-0">{field.unit}</span>}
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
  const filtered =
    dimField && first
      ? records.filter((r) => r[dimField.id] === first[dimField.id])
      : records;

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
    ? `${dimField && first ? `${first[dimField.id]} — ` : ""}${numField.label}の推移`
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

/* ---------- CSV ---------- */

function downloadCsv(spec: AppSpec, records: AppRecord[]) {
  const esc = (s: string) => `"${s.replace(/"/g, '""').replace(/\n/g, " ")}"`;
  const header = spec.fields.map((f) => esc(f.label)).join(",");
  const rows = records.map((r) =>
    spec.fields
      .map((f) => {
        const v = r[f.id];
        return esc(typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v ?? ""));
      })
      .join(","),
  );
  // 先頭のBOMでExcelにUTF-8と認識させる(日本語の文字化け防止)
  const csv = "\uFEFF" + [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${spec.appName}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- 本体 ---------- */

export function SpecApp({
  spec,
  records,
  alert,
  mode,
  onHighlight,
  question,
  onAnswer,
}: SpecAppProps) {
  const [tab, setTab] = useState<Tab>("form");
  const first = records[0];

  const tabs: { id: Tab; label: string }[] = [
    { id: "form", label: "📄 フォーム" },
    { id: "list", label: "📚 一覧" },
    { id: "dashboard", label: "📊 ダッシュボード" },
  ];

  return (
    <div className="flex flex-col gap-3 h-full">
      {question && question.answer === null && (
        <QuestionCard question={question} onAnswer={onAnswer} />
      )}

      <div className="card flex-1 overflow-hidden flex flex-col">
        {/* アプリヘッダ */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-line bg-panel">
          <span className="text-2xl">{spec.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold">{spec.appName}</div>
            <div className="text-dim text-[11px] truncate">{spec.description}</div>
          </div>
          <span
            className={`text-[10px] rounded-full px-2.5 py-1 font-bold shrink-0 ${
              mode === "live" ? "bg-ok/15 text-ok" : "bg-accent-soft text-accent"
            }`}
          >
            {mode === "live" ? "● LIVE解析" : "● デモリプレイ"}
          </span>
        </div>

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

        {/* タブ */}
        <div className="flex border-b border-line px-3">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer ${
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
            className="ml-auto my-1.5 rounded-lg border border-line px-3 text-xs text-dim hover:text-fg hover:border-dim transition-colors cursor-pointer"
            title="Excelで開けるCSVを書き出し"
          >
            ⬇ CSV
          </button>
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
                />
              ))}
            </div>
          </div>

          <div hidden={tab !== "list"}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim text-xs border-b border-line">
                  <th className="px-4 py-2.5 w-12"></th>
                  {spec.listColumns.map((cid) => (
                    <th key={cid} className="px-4 py-2.5 font-medium">
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
                      <td key={cid} className="px-4 py-2.5">
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
                  <div key={a.id} className="card p-4">
                    <div className="text-xs text-dim mb-1">{a.label}</div>
                    <div className="text-2xl font-bold tracking-tight">
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
