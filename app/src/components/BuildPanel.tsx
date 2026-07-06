"use client";

// 解析中のプログレッシブビルド画面。
// SSEでフィールドが届くたびに、アプリが目の前で組み上がっていく「見せ場」。

import { useEffect, useRef } from "react";
import type {
  AggregationSpec,
  ApprovalStep,
  FieldSpec,
  LineItemsSpec,
} from "@/lib/appspec";
import { FIELD_TYPE_META, ConfidenceBadge } from "./field-meta";

export interface BuildState {
  phases: string[];
  meta: { appName: string; icon: string; description: string } | null;
  fields: FieldSpec[];
  lineItems: { spec: LineItemsSpec; rowCount: number } | null;
  approval: ApprovalStep[] | null | undefined; // undefined = 未着
  aggs: AggregationSpec[];
  recordArrived: boolean;
  done: boolean;
}

export function BuildPanel({ state }: { state: BuildState }) {
  const { phases, meta, fields, lineItems, approval, aggs, recordArrived, done } = state;
  const listRef = useRef<HTMLDivElement>(null);

  // 新しい部品が届くたびに最新の行へ追従スクロール
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [fields.length, lineItems, aggs.length, approval, recordArrived]);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* 解析ログ */}
      <div className="card p-4 font-mono text-[13px] leading-6 text-dim">
        {phases.map((p, i) => {
          const isLast = i === phases.length - 1;
          return (
            <div key={i} className="flex items-center gap-2">
              {isLast && !done ? (
                <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent spin-slow shrink-0" />
              ) : (
                <span className="text-ok shrink-0">✓</span>
              )}
              <span className={isLast && !done ? "text-fg" : ""}>{p}</span>
            </div>
          );
        })}
      </div>

      {/* 組み上がっていくアプリ */}
      <div className="card flex-1 overflow-hidden flex flex-col">
        {!meta ? (
          <div className="flex-1 flex items-center justify-center text-dim text-sm">
            <span className="blink-cursor">アプリの仕様を待機中</span>
          </div>
        ) : (
          <>
            <div className="field-in flex items-center gap-3 px-5 py-4 border-b border-line bg-panel">
              <span className="text-3xl">{meta.icon}</span>
              <div>
                <div className="font-bold text-lg">{meta.appName}</div>
                <div className="text-dim text-xs">{meta.description}</div>
              </div>
            </div>
            <div ref={listRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
              {fields.map((f) => {
                const tm = FIELD_TYPE_META[f.type];
                return (
                  <div
                    key={f.id}
                    className="field-in flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5"
                  >
                    <span className="w-6 text-center shrink-0" title={tm.label}>
                      {tm.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {f.label}
                        {f.required && <span className="text-accent ml-1">*</span>}
                      </div>
                      <div className="text-[11px] text-dim">
                        {tm.label}
                        {f.unit ? ` (${f.unit})` : ""}
                        {f.options ? ` : ${f.options.join(" / ")}` : ""}
                      </div>
                    </div>
                    <ConfidenceBadge value={f.confidence} />
                  </div>
                );
              })}

              {lineItems && (
                <div className="field-in flex items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft/50 px-3 py-2.5 text-sm">
                  <span className="w-6 text-center shrink-0">🧮</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">
                      明細テーブル「{lineItems.spec.label}」
                      <span className="text-accent ml-2">{lineItems.rowCount}行</span>
                    </div>
                    <div className="text-[11px] text-dim truncate">
                      {lineItems.spec.columns.map((c) => c.label).join(" | ")}
                    </div>
                  </div>
                </div>
              )}

              {approval && approval.length > 0 && (
                <div className="field-in flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm">
                  <span className="w-6 text-center shrink-0">🔏</span>
                  <span className="text-dim text-xs shrink-0">承認フロー</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {approval.map((s, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-dim">→</span>}
                        <span className="rounded-full bg-accent-soft text-accent px-2.5 py-0.5 text-xs font-medium">
                          {s.name}
                          <span className="opacity-70">({s.role})</span>
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {aggs.map((a) => (
                <div
                  key={a.id}
                  className="field-in flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-sm"
                >
                  <span className="w-6 text-center shrink-0">📊</span>
                  <span className="font-medium">{a.label}</span>
                  <span className="text-[11px] text-dim ml-auto">
                    {a.op === "sum" ? "合計" : a.op === "avg" ? "平均" : "件数"}を自動集計
                  </span>
                </div>
              ))}

              {recordArrived && (
                <div className="field-in flex items-center gap-3 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2.5 text-sm">
                  <span className="w-6 text-center shrink-0">✅</span>
                  <span>
                    紙の記入内容を <b>1件目のデータ</b> として登録しました
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
