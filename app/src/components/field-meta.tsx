// フィールド型の表示メタと信頼度バッジ(BuildPanel / SpecApp 共用)

import type { FieldType } from "@/lib/appspec";

export const FIELD_TYPE_META: Record<FieldType, { icon: string; label: string }> = {
  text: { icon: "🔤", label: "テキスト" },
  textarea: { icon: "📝", label: "複数行テキスト" },
  number: { icon: "🔢", label: "数値" },
  date: { icon: "📅", label: "日付" },
  select: { icon: "🔽", label: "選択式" },
  checkbox: { icon: "☑️", label: "チェック" },
  phone: { icon: "📞", label: "電話番号" },
  stamp: { icon: "🔴", label: "印鑑" },
};

export function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.85 ? "var(--ok)" : value >= 0.7 ? "var(--warn)" : "var(--accent)";
  return (
    <div className="w-16 shrink-0" title={`読み取り信頼度 ${pct}%`}>
      <div className="text-[10px] text-dim text-right mb-0.5">{pct}%</div>
      <div className="confidence-bar">
        <div style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
