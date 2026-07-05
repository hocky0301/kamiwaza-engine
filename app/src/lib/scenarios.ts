// デモシナリオ定義。
// 紙(PaperElement)とAppSpecのsourceBoxは同じ%座標系を共有しているため、
// 「クリックすると紙のどこから読んだかが光る」出典ハイライトが構造的にズレない。

import type { AppSpec, AppRecord } from "./appspec";

export interface PaperElement {
  /** AppSpecのフィールドIDと紐づける(出典ハイライト用) */
  fieldId?: string;
  kind: "printed" | "hand" | "line" | "box" | "stamp" | "circle";
  /** 紙に対する%座標(左上原点)。紙のアスペクト比はA4固定 */
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  /** フォントサイズ(cqw単位 = 紙の幅の%) */
  size?: number;
  align?: "left" | "center" | "right";
  rotate?: number;
  bold?: boolean;
  /** stamp用: 角印・ゴム印(true)か丸印(false/省略)か */
  square?: boolean;
}

export interface Scenario {
  id: string;
  /** 選択画面での表示名 */
  label: string;
  /** 紙の種類の説明 */
  paperKind: string;
  paper: PaperElement[];
  spec: AppSpec;
  /** 一覧・ダッシュボード用の追加レコード(過去分) */
  seedRecords: AppRecord[];
  /** ダッシュボードに出すAI異常検知アラート */
  alert: string;
  /** 信頼度が低い項目への逆質問(なければnull) */
  question: { fieldId: string; question: string; choices: string[] } | null;
  /** レコード登録前に流す検算結果メッセージ(なければ省略) */
  validationNote?: string;
}

/* ============================================================
 * シナリオ1: FAX注文書
 * ============================================================ */

const chumonshoPaper: PaperElement[] = [
  // FAXヘッダ
  { kind: "printed", x: 3, y: 1.5, w: 40, h: 2.5, text: "FAX送信票  030-5550-0123", size: 1.9, align: "left" },
  // 承認印・担当印ボックス(右上)
  { kind: "box", x: 74, y: 2, w: 10.5, h: 10 },
  { kind: "box", x: 85, y: 2, w: 10.5, h: 10 },
  { kind: "printed", x: 74, y: 2.6, w: 10.5, h: 2, text: "承認", size: 1.8, align: "center" },
  { kind: "printed", x: 85, y: 2.6, w: 10.5, h: 2, text: "担当", size: 1.8, align: "center" },
  { fieldId: "approval_stamp", kind: "stamp", x: 86.8, y: 5.2, w: 7, h: 5.4, text: "佐藤" },
  // タイトル
  { kind: "printed", x: 25, y: 7.5, w: 50, h: 5, text: "注  文  書", size: 5, align: "center", bold: true },
  { kind: "line", x: 32, y: 13.5, w: 36, h: 0.18 },
  // 注文日
  { kind: "printed", x: 56, y: 16.5, w: 12, h: 3, text: "注文日:", size: 2.2 },
  { fieldId: "order_date", kind: "hand", x: 68, y: 16, w: 28, h: 3.5, text: "2026年 7月28日", size: 2.5, rotate: -0.6 },
  // 宛先
  { fieldId: "supplier", kind: "hand", x: 4, y: 20.5, w: 44, h: 4, text: "株式会社 イルカ製作所", size: 3.1, rotate: 0.4 },
  { kind: "printed", x: 49, y: 21.3, w: 9, h: 3, text: "御中", size: 2.6 },
  { kind: "line", x: 4, y: 25.2, w: 54, h: 0.18 },
  // 発注元ブロック(右)
  { kind: "printed", x: 58, y: 22, w: 38, h: 2.5, text: "オルカ精密工業株式会社", size: 2.1 },
  { kind: "printed", x: 58, y: 24.8, w: 38, h: 2, text: "TEL: 030-5550-0199", size: 1.8 },
  { fieldId: "orderer", kind: "hand", x: 58, y: 27.2, w: 24, h: 3.2, text: "担当: 佐藤", size: 2.4, rotate: -0.8 },
  // 明細テーブル(外枠+罫線)
  { kind: "box", x: 4, y: 33, w: 92, h: 34 },
  { kind: "line", x: 4, y: 38, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 45.25, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 52.5, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 59.75, w: 92, h: 0.15 },
  { kind: "line", x: 50, y: 33, w: 0.15, h: 34 },
  { kind: "line", x: 62, y: 33, w: 0.15, h: 34 },
  { kind: "line", x: 77, y: 33, w: 0.15, h: 34 },
  // テーブルヘッダ
  { kind: "printed", x: 4, y: 34.3, w: 46, h: 2.5, text: "品  名", size: 2.1, align: "center" },
  { kind: "printed", x: 50, y: 34.3, w: 12, h: 2.5, text: "数量", size: 2.1, align: "center" },
  { kind: "printed", x: 62, y: 34.3, w: 15, h: 2.5, text: "単価", size: 2.1, align: "center" },
  { kind: "printed", x: 77, y: 34.3, w: 19, h: 2.5, text: "金額", size: 2.1, align: "center" },
  // 明細行1
  { fieldId: "items", kind: "hand", x: 5.5, y: 39.8, w: 44, h: 3.2, text: "SUS304 丸棒 φ20", size: 2.3, rotate: -0.5 },
  { fieldId: "items", kind: "hand", x: 50, y: 39.8, w: 12, h: 3.2, text: "30", size: 2.4, align: "center" },
  { fieldId: "items", kind: "hand", x: 62, y: 39.8, w: 15, h: 3.2, text: "1,200", size: 2.3, align: "center", rotate: 0.5 },
  { fieldId: "items", kind: "hand", x: 77, y: 39.8, w: 18, h: 3.2, text: "36,000", size: 2.3, align: "right" },
  // 明細行2
  { fieldId: "items", kind: "hand", x: 5.5, y: 47, w: 44, h: 3.2, text: "アルミ板 A5052 t5", size: 2.3, rotate: 0.4 },
  { fieldId: "items", kind: "hand", x: 50, y: 47, w: 12, h: 3.2, text: "12", size: 2.4, align: "center" },
  { fieldId: "items", kind: "hand", x: 62, y: 47, w: 15, h: 3.2, text: "3,400", size: 2.3, align: "center", rotate: -0.4 },
  { fieldId: "items", kind: "hand", x: 77, y: 47, w: 18, h: 3.2, text: "40,800", size: 2.3, align: "right" },
  // 明細行3
  { fieldId: "items", kind: "hand", x: 5.5, y: 54.2, w: 44, h: 3.2, text: "六角ボルト M10×30", size: 2.3, rotate: -0.3 },
  { fieldId: "items", kind: "hand", x: 50, y: 54.2, w: 12, h: 3.2, text: "200", size: 2.4, align: "center", rotate: 0.6 },
  { fieldId: "items", kind: "hand", x: 62, y: 54.2, w: 15, h: 3.2, text: "45", size: 2.3, align: "center" },
  { fieldId: "items", kind: "hand", x: 77, y: 54.2, w: 18, h: 3.2, text: "9,000", size: 2.3, align: "right" },
  // 合計金額
  { kind: "box", x: 62, y: 69, w: 34, h: 6.5 },
  { kind: "printed", x: 63, y: 70.8, w: 13, h: 3, text: "合計金額", size: 2.2 },
  { fieldId: "total", kind: "hand", x: 76, y: 69.9, w: 19, h: 4.5, text: "¥85,800", size: 3.2, align: "right", rotate: -0.7 },
  // 納期
  { kind: "printed", x: 4, y: 78.5, w: 9, h: 3, text: "納期:", size: 2.2 },
  { fieldId: "delivery_date", kind: "hand", x: 14, y: 78, w: 32, h: 3.5, text: "8月8日 午前中", size: 2.6, rotate: 0.5 },
  { kind: "line", x: 4, y: 82, w: 52, h: 0.15 },
  // 備考
  { kind: "printed", x: 4, y: 85.5, w: 9, h: 3, text: "備考:", size: 2.2 },
  { fieldId: "note", kind: "hand", x: 14, y: 85, w: 64, h: 3.5, text: "前回と同じ仕様でお願いします。", size: 2.3, rotate: -0.4 },
  { kind: "line", x: 4, y: 89, w: 82, h: 0.15 },
  { kind: "line", x: 4, y: 94, w: 82, h: 0.15 },
];

const chumonshoSpec: AppSpec = {
  appName: "注文書管理",
  icon: "📋",
  description: "FAX・手書きの注文書を受け付けて発注を管理する業務",
  fields: [
    { id: "order_date", label: "注文日", type: "date", required: true, confidence: 0.98, sourceBox: { x: 55, y: 15.2, w: 42, h: 5 } },
    { id: "supplier", label: "宛先(発注先)", type: "text", required: true, confidence: 0.97, sourceBox: { x: 3, y: 19.5, w: 56, h: 6.5 } },
    { id: "orderer", label: "発注元 担当者", type: "text", required: true, confidence: 0.94, sourceBox: { x: 57, y: 21, w: 40, h: 10 } },
    { id: "items", label: "注文品目", type: "textarea", required: true, confidence: 0.92, sourceBox: { x: 3.5, y: 32.5, w: 93, h: 35.5 } },
    { id: "total", label: "合計金額", type: "number", required: true, unit: "円", confidence: 0.96, sourceBox: { x: 61, y: 68.2, w: 36, h: 8 } },
    { id: "delivery_date", label: "納期", type: "date", required: true, confidence: 0.87, sourceBox: { x: 3, y: 77, w: 45, h: 6 } },
    { id: "note", label: "備考", type: "textarea", required: false, confidence: 0.93, sourceBox: { x: 3, y: 84, w: 77, h: 6.5 } },
    { id: "approval_stamp", label: "承認印", type: "stamp", required: false, confidence: 0.58, sourceBox: { x: 73, y: 1.2, w: 24, h: 11.5 } },
  ],
  listColumns: ["order_date", "supplier", "total", "delivery_date"],
  approvalFlow: [
    { name: "起票", role: "担当" },
    { name: "承認", role: "工場長" },
  ],
  aggregations: [
    { id: "total_sum", label: "今月の発注金額", fieldId: "total", op: "sum", unit: "円" },
    { id: "order_count", label: "今月の注文件数", fieldId: "total", op: "count", unit: "件" },
  ],
  firstRecord: {
    order_date: "2026-07-28",
    supplier: "株式会社 イルカ製作所",
    orderer: "佐藤",
    items: "SUS304 丸棒 φ20 ×30 / アルミ板 A5052 t5 ×12 / 六角ボルト M10×30 ×200",
    total: 85800,
    delivery_date: "2026-08-08",
    note: "前回と同じ仕様でお願いします。納期は午前中指定。",
    approval_stamp: true,
  },
};

const chumonshoSeeds: AppRecord[] = [
  { order_date: "2026-07-27", supplier: "株式会社 イルカ製作所", orderer: "佐藤", items: "SS400 平鋼 t9 ×20", total: 62400, delivery_date: "2026-08-05", note: "", approval_stamp: true },
  { order_date: "2026-07-27", supplier: "シャチホコ鋼材株式会社", orderer: "高橋", items: "H形鋼 200×100 ×6", total: 148000, delivery_date: "2026-08-12", note: "現場直送", approval_stamp: true },
  { order_date: "2026-07-25", supplier: "株式会社 イルカ製作所", orderer: "佐藤", items: "SUS304 丸棒 φ25 ×15", total: 43500, delivery_date: "2026-08-01", note: "", approval_stamp: true },
  { order_date: "2026-07-24", supplier: "ミナト商事株式会社", orderer: "鈴木", items: "切削油 20L ×4", total: 30400, delivery_date: "2026-07-30", note: "", approval_stamp: false },
  { order_date: "2026-07-23", supplier: "株式会社 イルカ製作所", orderer: "佐藤", items: "アルミ角パイプ 30×30 ×24", total: 57600, delivery_date: "2026-07-31", note: "", approval_stamp: true },
  { order_date: "2026-07-22", supplier: "シャチホコ鋼材株式会社", orderer: "高橋", items: "縞鋼板 t4.5 ×8", total: 71200, delivery_date: "2026-07-29", note: "", approval_stamp: true },
];

/* ============================================================
 * シナリオ2: 作業日報
 * ============================================================ */

const nippoPaper: PaperElement[] = [
  { kind: "printed", x: 25, y: 4.5, w: 50, h: 5, text: "作 業 日 報", size: 4.6, align: "center", bold: true },
  { kind: "line", x: 31, y: 10.5, w: 38, h: 0.18 },
  // 日付・氏名
  { kind: "printed", x: 4, y: 14.5, w: 9, h: 3, text: "氏名:", size: 2.2 },
  { fieldId: "worker", kind: "hand", x: 14, y: 14, w: 26, h: 3.5, text: "鈴木 一郎", size: 2.8, rotate: -0.5 },
  { kind: "line", x: 4, y: 18, w: 38, h: 0.15 },
  { kind: "printed", x: 56, y: 14.5, w: 9, h: 3, text: "日付:", size: 2.2 },
  { fieldId: "work_date", kind: "hand", x: 66, y: 14, w: 30, h: 3.5, text: "7月28日", size: 2.7, rotate: 0.6 },
  { kind: "line", x: 56, y: 18, w: 40, h: 0.15 },
  // 現場・天候
  { kind: "printed", x: 4, y: 21.5, w: 9, h: 3, text: "現場:", size: 2.2 },
  { fieldId: "site", kind: "hand", x: 14, y: 21, w: 46, h: 3.5, text: "クジラ第二倉庫 新築工事", size: 2.5, rotate: 0.3 },
  { kind: "line", x: 4, y: 25, w: 58, h: 0.15 },
  { kind: "printed", x: 65, y: 21.5, w: 9, h: 3, text: "天候:", size: 2.2 },
  { kind: "printed", x: 74, y: 21.5, w: 22, h: 3, text: "晴 ・ 曇 ・ 雨", size: 2.4 },
  { fieldId: "weather", kind: "circle", x: 73.2, y: 20.6, w: 6.5, h: 4.6 },
  // 作業時間
  { kind: "printed", x: 4, y: 28.5, w: 15, h: 3, text: "作業時間:", size: 2.2 },
  { fieldId: "work_hours", kind: "hand", x: 20, y: 28, w: 28, h: 3.5, text: "8:00 〜 17:00", size: 2.6, rotate: -0.4 },
  { kind: "printed", x: 49, y: 28.5, w: 10, h: 3, text: "(休憩", size: 2.2 },
  { fieldId: "break_hours", kind: "hand", x: 59, y: 28, w: 7, h: 3.5, text: "1.0", size: 2.6, align: "center", rotate: 0.8 },
  { kind: "printed", x: 66, y: 28.5, w: 12, h: 3, text: "時間)", size: 2.2 },
  // 作業内容
  { kind: "printed", x: 4, y: 34, w: 32, h: 3, text: "◼ 本日の作業内容", size: 2.3, bold: true },
  { kind: "box", x: 4, y: 37.5, w: 92, h: 22 },
  { fieldId: "work_detail", kind: "hand", x: 6.5, y: 40, w: 88, h: 3.5, text: "・2F 天井下地組み(南側 完了)", size: 2.5, rotate: -0.3 },
  { fieldId: "work_detail", kind: "hand", x: 6.5, y: 45.5, w: 88, h: 3.5, text: "・軽天ボード搬入 40枚", size: 2.5, rotate: 0.4 },
  { fieldId: "work_detail", kind: "hand", x: 6.5, y: 51, w: 88, h: 3.5, text: "・照明配線ルートの墨出し", size: 2.5, rotate: -0.5 },
  // 安全確認
  { kind: "printed", x: 4, y: 62.5, w: 30, h: 3, text: "安全確認(KY活動):", size: 2.2 },
  { kind: "printed", x: 35, y: 62.5, w: 14, h: 3, text: "済 ・ 未", size: 2.4 },
  { fieldId: "safety_check", kind: "circle", x: 34.4, y: 61.6, w: 6.2, h: 4.6 },
  // 明日の予定
  { kind: "printed", x: 4, y: 68.5, w: 24, h: 3, text: "◼ 明日の予定", size: 2.3, bold: true },
  { kind: "box", x: 4, y: 72, w: 92, h: 11 },
  { fieldId: "tomorrow_plan", kind: "hand", x: 6.5, y: 74.5, w: 88, h: 3.5, text: "2F 天井ボード貼り(北側から)", size: 2.5, rotate: 0.3 },
  // 確認印
  { kind: "box", x: 78, y: 86, w: 18, h: 11 },
  { kind: "printed", x: 78, y: 86.8, w: 18, h: 2.2, text: "監督確認印", size: 1.8, align: "center" },
  { fieldId: "supervisor_stamp", kind: "stamp", x: 83, y: 89.8, w: 8, h: 6.2, text: "高橋" },
];

const nippoSpec: AppSpec = {
  appName: "作業日報",
  icon: "🏗️",
  description: "現場ごとの作業日報を提出・確認する業務",
  fields: [
    { id: "work_date", label: "日付", type: "date", required: true, confidence: 0.97, sourceBox: { x: 55, y: 13, w: 42, h: 6 } },
    { id: "worker", label: "氏名", type: "text", required: true, confidence: 0.96, sourceBox: { x: 3, y: 13, w: 40, h: 6 } },
    { id: "site", label: "現場名", type: "text", required: true, confidence: 0.95, sourceBox: { x: 3, y: 20, w: 60, h: 6 } },
    { id: "weather", label: "天候", type: "select", required: true, options: ["晴れ", "曇り", "雨"], confidence: 0.91, sourceBox: { x: 64, y: 19.5, w: 33, h: 6.5 } },
    { id: "work_hours", label: "作業時間", type: "text", required: true, confidence: 0.93, sourceBox: { x: 3, y: 27, w: 46, h: 6 } },
    { id: "break_hours", label: "休憩時間", type: "number", required: false, unit: "時間", confidence: 0.89, sourceBox: { x: 48, y: 27, w: 32, h: 6 } },
    { id: "work_detail", label: "本日の作業内容", type: "textarea", required: true, confidence: 0.94, sourceBox: { x: 3.5, y: 33.5, w: 93, h: 27 } },
    { id: "safety_check", label: "安全確認(KY活動)", type: "checkbox", required: true, confidence: 0.88, sourceBox: { x: 3, y: 61, w: 48, h: 6.5 } },
    { id: "tomorrow_plan", label: "明日の予定", type: "textarea", required: false, confidence: 0.92, sourceBox: { x: 3.5, y: 68, w: 93, h: 16 } },
    { id: "supervisor_stamp", label: "監督確認印", type: "stamp", required: false, confidence: 0.62, sourceBox: { x: 77, y: 85, w: 20, h: 13 } },
  ],
  listColumns: ["work_date", "worker", "site", "safety_check"],
  approvalFlow: [
    { name: "提出", role: "作業員" },
    { name: "確認", role: "現場監督" },
  ],
  aggregations: [
    { id: "report_count", label: "今週の日報件数", fieldId: "work_date", op: "count", unit: "件" },
    { id: "break_avg", label: "平均休憩時間", fieldId: "break_hours", op: "avg", unit: "時間" },
  ],
  firstRecord: {
    work_date: "2026-07-28",
    worker: "鈴木 一郎",
    site: "クジラ第二倉庫 新築工事",
    weather: "晴れ",
    work_hours: "8:00〜17:00",
    break_hours: 1.0,
    work_detail: "・2F 天井下地組み(南側 完了)\n・軽天ボード搬入 40枚\n・照明配線ルートの墨出し",
    safety_check: true,
    tomorrow_plan: "2F 天井ボード貼り(北側から)",
    supervisor_stamp: true,
  },
};

const nippoSeeds: AppRecord[] = [
  { work_date: "2026-07-27", worker: "鈴木 一郎", site: "クジラ第二倉庫 新築工事", weather: "曇り", work_hours: "8:00〜18:30", break_hours: 1.0, work_detail: "・2F 天井下地組み(中央部)", safety_check: true, tomorrow_plan: "南側下地の続き", supervisor_stamp: true },
  { work_date: "2026-07-27", worker: "田村 健", site: "オルカ駅前ビル 改修", weather: "曇り", work_hours: "8:30〜17:30", break_hours: 1.0, work_detail: "・外壁シーリング打ち替え(東面)", safety_check: true, tomorrow_plan: "北面シーリング", supervisor_stamp: true },
  { work_date: "2026-07-26", worker: "鈴木 一郎", site: "クジラ第二倉庫 新築工事", weather: "晴れ", work_hours: "8:00〜19:00", break_hours: 1.0, work_detail: "・1F 間仕切り建て込み", safety_check: true, tomorrow_plan: "2F 天井下地", supervisor_stamp: true },
  { work_date: "2026-07-25", worker: "田村 健", site: "オルカ駅前ビル 改修", weather: "雨", work_hours: "9:00〜16:00", break_hours: 1.0, work_detail: "・資材整理、雨天のため外部作業中止", safety_check: true, tomorrow_plan: "天候回復次第シーリング再開", supervisor_stamp: false },
  { work_date: "2026-07-25", worker: "鈴木 一郎", site: "クジラ第二倉庫 新築工事", weather: "雨", work_hours: "8:00〜17:00", break_hours: 1.0, work_detail: "・内部造作(1F 巾木取付)", safety_check: true, tomorrow_plan: "間仕切り建て込み", supervisor_stamp: true },
];

/* ============================================================
 * シナリオ3: 設備点検表
 * ============================================================ */

const tenkenPaper: PaperElement[] = [
  { kind: "printed", x: 22, y: 4.5, w: 56, h: 5, text: "設 備 日 常 点 検 表", size: 4.2, align: "center", bold: true },
  { kind: "line", x: 26, y: 10.5, w: 48, h: 0.18 },
  // 点検日・設備・点検者
  { kind: "printed", x: 4, y: 14.5, w: 12, h: 3, text: "点検日:", size: 2.2 },
  { fieldId: "inspect_date", kind: "hand", x: 16, y: 14, w: 30, h: 3.5, text: "7月28日 9:15", size: 2.6, rotate: -0.5 },
  { kind: "printed", x: 55, y: 14.5, w: 12, h: 3, text: "点検者:", size: 2.2 },
  { fieldId: "inspector", kind: "hand", x: 67, y: 14, w: 18, h: 3.5, text: "伊藤", size: 2.7, rotate: 0.5 },
  { kind: "printed", x: 4, y: 20, w: 12, h: 3, text: "設備名:", size: 2.2 },
  { fieldId: "equipment", kind: "hand", x: 16, y: 19.5, w: 46, h: 3.5, text: "コンプレッサー 3号機", size: 2.7, rotate: 0.3 },
  { kind: "line", x: 4, y: 23.5, w: 92, h: 0.15 },
  // 点検チェックテーブル
  { kind: "box", x: 4, y: 27, w: 92, h: 28 },
  { kind: "line", x: 4, y: 32, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 37.75, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 43.5, w: 92, h: 0.15 },
  { kind: "line", x: 4, y: 49.25, w: 92, h: 0.15 },
  { kind: "line", x: 42, y: 27, w: 0.15, h: 28 },
  { kind: "line", x: 58, y: 27, w: 0.15, h: 28 },
  { kind: "printed", x: 4, y: 28.3, w: 38, h: 2.5, text: "点検項目", size: 2.1, align: "center" },
  { kind: "printed", x: 42, y: 28.3, w: 16, h: 2.5, text: "判定", size: 2.1, align: "center" },
  { kind: "printed", x: 58, y: 28.3, w: 38, h: 2.5, text: "メモ", size: 2.1, align: "center" },
  { kind: "printed", x: 5.5, y: 33.6, w: 36, h: 2.6, text: "異音・振動なし", size: 2.1 },
  { fieldId: "noise_ok", kind: "hand", x: 46, y: 32.9, w: 8, h: 3.6, text: "○", size: 3, align: "center" },
  { kind: "printed", x: 5.5, y: 39.3, w: 36, h: 2.6, text: "油量(オイルゲージ)", size: 2.1 },
  { fieldId: "oil_ok", kind: "hand", x: 46, y: 38.7, w: 8, h: 3.6, text: "○", size: 3, align: "center", rotate: 4 },
  { kind: "printed", x: 5.5, y: 45.1, w: 36, h: 2.6, text: "圧力ゲージ", size: 2.1 },
  { fieldId: "gauge_status", kind: "hand", x: 46, y: 44.4, w: 8, h: 3.6, text: "△", size: 3, align: "center", rotate: -3 },
  { fieldId: "gauge_status", kind: "hand", x: 59.5, y: 44.8, w: 36, h: 3.2, text: "針が振れ気味", size: 2.2, rotate: -0.6 },
  { kind: "printed", x: 5.5, y: 50.8, w: 36, h: 2.6, text: "Vベルトの張り・損傷", size: 2.1 },
  { fieldId: "belt_ok", kind: "hand", x: 46, y: 50.2, w: 8, h: 3.6, text: "○", size: 3, align: "center", rotate: 2 },
  // 計測値
  { kind: "printed", x: 4, y: 59.5, w: 15, h: 3, text: "吐出圧力:", size: 2.2 },
  { fieldId: "pressure", kind: "hand", x: 19.5, y: 59, w: 10, h: 3.5, text: "0.65", size: 2.8, rotate: -0.8 },
  { kind: "printed", x: 30, y: 59.5, w: 26, h: 3, text: "MPa (基準: 0.60 以下)", size: 1.9 },
  { kind: "printed", x: 58, y: 59.5, w: 15, h: 3, text: "本体温度:", size: 2.2 },
  { fieldId: "temperature", kind: "hand", x: 73.5, y: 59, w: 8, h: 3.5, text: "42", size: 2.8, rotate: 0.7 },
  { kind: "printed", x: 82, y: 59.5, w: 6, h: 3, text: "℃", size: 2.2 },
  // 特記事項
  { kind: "printed", x: 4, y: 66, w: 24, h: 3, text: "◼ 特記事項", size: 2.3, bold: true },
  { kind: "box", x: 4, y: 69.5, w: 92, h: 14 },
  { fieldId: "notes", kind: "hand", x: 6.5, y: 72, w: 88, h: 3.5, text: "圧力ゲージの針が振れ気味。", size: 2.5, rotate: -0.3 },
  { fieldId: "notes", kind: "hand", x: 6.5, y: 77, w: 88, h: 3.5, text: "次回定期点検で交換を検討したい。", size: 2.5, rotate: 0.4 },
  // 確認印
  { kind: "box", x: 78, y: 86.5, w: 18, h: 11 },
  { kind: "printed", x: 78, y: 87.3, w: 18, h: 2.2, text: "係長確認印", size: 1.8, align: "center" },
  { fieldId: "approver_stamp", kind: "stamp", x: 83, y: 90.3, w: 8, h: 6.2, text: "渡辺" },
];

const tenkenSpec: AppSpec = {
  appName: "設備点検記録",
  icon: "🔧",
  description: "コンプレッサー等の設備を日常点検し記録する業務",
  fields: [
    { id: "inspect_date", label: "点検日時", type: "date", required: true, confidence: 0.96, sourceBox: { x: 3, y: 13, w: 45, h: 6 } },
    { id: "inspector", label: "点検者", type: "text", required: true, confidence: 0.95, sourceBox: { x: 54, y: 13, w: 33, h: 6 } },
    { id: "equipment", label: "設備名", type: "select", required: true, options: ["コンプレッサー 1号機", "コンプレッサー 2号機", "コンプレッサー 3号機"], confidence: 0.82, sourceBox: { x: 3, y: 18.5, w: 62, h: 6 } },
    { id: "noise_ok", label: "異音・振動なし", type: "checkbox", required: true, confidence: 0.93, sourceBox: { x: 3.5, y: 32.2, w: 93, h: 6 } },
    { id: "oil_ok", label: "油量 正常", type: "checkbox", required: true, confidence: 0.92, sourceBox: { x: 3.5, y: 38, w: 93, h: 6 } },
    { id: "gauge_status", label: "圧力ゲージ判定", type: "select", required: true, options: ["○ 正常", "△ 要観察", "× 異常"], confidence: 0.9, sourceBox: { x: 3.5, y: 43.7, w: 93, h: 6 } },
    { id: "belt_ok", label: "Vベルト 正常", type: "checkbox", required: true, confidence: 0.92, sourceBox: { x: 3.5, y: 49.5, w: 93, h: 6 } },
    { id: "pressure", label: "吐出圧力", type: "number", required: true, unit: "MPa", confidence: 0.97, sourceBox: { x: 3, y: 58, w: 54, h: 6 } },
    { id: "temperature", label: "本体温度", type: "number", required: true, unit: "℃", confidence: 0.96, sourceBox: { x: 57, y: 58, w: 32, h: 6 } },
    { id: "notes", label: "特記事項", type: "textarea", required: false, confidence: 0.94, sourceBox: { x: 3.5, y: 65.5, w: 93, h: 19 } },
    { id: "approver_stamp", label: "係長確認印", type: "stamp", required: false, confidence: 0.6, sourceBox: { x: 77, y: 85.5, w: 20, h: 13 } },
  ],
  listColumns: ["inspect_date", "equipment", "gauge_status", "pressure"],
  approvalFlow: [
    { name: "点検", role: "点検担当" },
    { name: "確認", role: "係長" },
  ],
  aggregations: [
    { id: "inspect_count", label: "今月の点検回数", fieldId: "inspect_date", op: "count", unit: "回" },
    { id: "pressure_avg", label: "平均吐出圧力", fieldId: "pressure", op: "avg", unit: "MPa" },
  ],
  firstRecord: {
    inspect_date: "2026-07-28",
    inspector: "伊藤",
    equipment: "コンプレッサー 3号機",
    noise_ok: true,
    oil_ok: true,
    gauge_status: "△ 要観察",
    belt_ok: true,
    pressure: 0.65,
    temperature: 42,
    notes: "圧力ゲージの針が振れ気味。次回定期点検で交換を検討したい。",
    approver_stamp: true,
  },
};

const tenkenSeeds: AppRecord[] = [
  { inspect_date: "2026-07-27", inspector: "伊藤", equipment: "コンプレッサー 3号機", noise_ok: true, oil_ok: true, gauge_status: "△ 要観察", belt_ok: true, pressure: 0.63, temperature: 41, notes: "圧力やや高め", approver_stamp: true },
  { inspect_date: "2026-07-27", inspector: "小林", equipment: "コンプレッサー 1号機", noise_ok: true, oil_ok: true, gauge_status: "○ 正常", belt_ok: true, pressure: 0.52, temperature: 38, notes: "", approver_stamp: true },
  { inspect_date: "2026-07-26", inspector: "伊藤", equipment: "コンプレッサー 3号機", noise_ok: true, oil_ok: false, gauge_status: "△ 要観察", belt_ok: true, pressure: 0.62, temperature: 43, notes: "オイル補充実施", approver_stamp: true },
  { inspect_date: "2026-07-26", inspector: "小林", equipment: "コンプレッサー 2号機", noise_ok: true, oil_ok: true, gauge_status: "○ 正常", belt_ok: true, pressure: 0.55, temperature: 39, notes: "", approver_stamp: true },
  { inspect_date: "2026-07-25", inspector: "伊藤", equipment: "コンプレッサー 3号機", noise_ok: true, oil_ok: true, gauge_status: "○ 正常", belt_ok: true, pressure: 0.58, temperature: 40, notes: "", approver_stamp: false },
];

/* ============================================================
 * シナリオ4: 月締め請求明細書
 * 実在の化学品商社26年分・14,608件の書類アーカイブ分析から抽出した
 * 「国産販売管理ソフト典型様式(繰越サマリー帯つき)」に準拠。
 * 手書きゼロの印字帳票+赤ゴム印という、実際に最も多いパターン。
 * ============================================================ */

const seikyuPaper: PaperElement[] = [
  // タイトル(枠囲み)
  { kind: "box", x: 30, y: 2.5, w: 32, h: 5.5 },
  { kind: "printed", x: 30, y: 3.8, w: 32, h: 3.2, text: "請 求 明 細 書", size: 2.9, align: "center", bold: true },
  // 右上: PAGE / 請求No / 締切分
  { kind: "printed", x: 82, y: 2.2, w: 14, h: 2.2, text: "PAGE  1", size: 1.6, align: "right" },
  { fieldId: "billing_no", kind: "printed", x: 70, y: 4.6, w: 26, h: 2.4, text: "請求No. 00000743", size: 1.8, align: "right" },
  { fieldId: "closing_date", kind: "printed", x: 66, y: 7.2, w: 30, h: 2.4, text: "2026年 7月31日 締切分", size: 1.9, align: "right" },
  // 宛先ブロック(左)
  { kind: "printed", x: 5, y: 12, w: 30, h: 2.2, text: "〒000-0004", size: 1.8 },
  { kind: "printed", x: 5, y: 14.4, w: 42, h: 2.2, text: "埼玉県架空市機屋3-9-2", size: 1.8 },
  { fieldId: "customer", kind: "printed", x: 5, y: 17.4, w: 44, h: 3.2, text: "オルカ精密工業株式会社  御中", size: 2.5, bold: true },
  { kind: "printed", x: 5, y: 20.8, w: 20, h: 2.2, text: "(0105)", size: 1.8 },
  { kind: "line", x: 5, y: 20.4, w: 44, h: 0.15 },
  // 発行元ブロック(右)+ 赤角印
  { fieldId: "issuer", kind: "printed", x: 60, y: 11.5, w: 30, h: 2.8, text: "シャチホコ鋼材株式会社", size: 2.2, bold: true },
  { kind: "stamp", x: 86, y: 10.6, w: 6, h: 4.5, text: "北関東", size: 1.5, square: true },
  { kind: "printed", x: 60, y: 14.6, w: 36, h: 2, text: "〒000-0001 東京都架空区海風1-2-3", size: 1.5 },
  { kind: "printed", x: 60, y: 16.6, w: 36, h: 2, text: "TEL: 030-5550-0177  FAX: 030-5550-0178", size: 1.5 },
  { kind: "printed", x: 60, y: 18.6, w: 36, h: 2, text: "取引銀行: カモメ銀行 みなと支店 当座 0098765", size: 1.5 },
  { fieldId: "reg_no", kind: "printed", x: 60, y: 20.6, w: 36, h: 2, text: "登録番号: T1234567890123", size: 1.6 },
  // 検印枠 + 担当者丸印
  { kind: "box", x: 84, y: 23.5, w: 12, h: 8 },
  { kind: "printed", x: 84, y: 24, w: 12, h: 1.8, text: "検印", size: 1.4, align: "center" },
  { kind: "stamp", x: 87.2, y: 26.2, w: 5.6, h: 4.4, text: "山口", size: 1.6 },
  // 経理の赤ゴム印「入力済」+ 手書き日付(消込の実務)
  { fieldId: "status", kind: "stamp", x: 7, y: 23.8, w: 13, h: 4.8, text: "入 力 済", size: 1.9, square: true, rotate: -2 },
  { fieldId: "status", kind: "hand", x: 21.5, y: 24.6, w: 8, h: 3, text: "7/3", size: 2.1, rotate: -1 },
  // 繰越サマリー帯(この様式の看板)
  { kind: "box", x: 4, y: 31, w: 92, h: 6.5 },
  { kind: "line", x: 19.33, y: 31, w: 0.15, h: 6.5 },
  { kind: "line", x: 34.67, y: 31, w: 0.15, h: 6.5 },
  { kind: "line", x: 50, y: 31, w: 0.15, h: 6.5 },
  { kind: "line", x: 65.33, y: 31, w: 0.15, h: 6.5 },
  { kind: "line", x: 80.67, y: 31, w: 0.15, h: 6.5 },
  { kind: "printed", x: 4, y: 31.7, w: 15.3, h: 1.8, text: "前回御請求額", size: 1.4, align: "center" },
  { kind: "printed", x: 19.33, y: 31.7, w: 15.3, h: 1.8, text: "御入金額", size: 1.4, align: "center" },
  { kind: "printed", x: 34.67, y: 31.7, w: 15.3, h: 1.8, text: "繰越金額", size: 1.4, align: "center" },
  { kind: "printed", x: 50, y: 31.7, w: 15.3, h: 1.8, text: "今回御買上額", size: 1.4, align: "center" },
  { kind: "printed", x: 65.33, y: 31.7, w: 15.3, h: 1.8, text: "消費税", size: 1.4, align: "center" },
  { kind: "printed", x: 80.67, y: 31.7, w: 15.3, h: 1.8, text: "今回御請求額", size: 1.4, align: "center" },
  { fieldId: "prev_amount", kind: "printed", x: 5, y: 34.2, w: 13.3, h: 2.4, text: "214,500", size: 1.9, align: "right" },
  { fieldId: "payment", kind: "printed", x: 20.33, y: 34.2, w: 13.3, h: 2.4, text: "214,500", size: 1.9, align: "right" },
  { fieldId: "carryover", kind: "printed", x: 35.67, y: 34.2, w: 13.3, h: 2.4, text: "0", size: 1.9, align: "right" },
  { fieldId: "purchase", kind: "printed", x: 51, y: 34.2, w: 13.3, h: 2.4, text: "152,000", size: 1.9, align: "right" },
  { fieldId: "tax", kind: "printed", x: 66.33, y: 34.2, w: 13.3, h: 2.4, text: "15,200", size: 1.9, align: "right" },
  { fieldId: "billed", kind: "printed", x: 81.67, y: 34.2, w: 13.3, h: 2.4, text: "167,200", size: 1.9, align: "right", bold: true },
  // 明細テーブル(空行にも罫線=固定行数様式)
  { kind: "box", x: 4, y: 40, w: 92, h: 43 },
  { kind: "line", x: 17, y: 40, w: 0.15, h: 43 },
  { kind: "line", x: 57, y: 40, w: 0.15, h: 43 },
  { kind: "line", x: 68, y: 40, w: 0.15, h: 43 },
  { kind: "line", x: 75, y: 40, w: 0.15, h: 43 },
  { kind: "line", x: 84, y: 40, w: 0.15, h: 43 },
  { kind: "line", x: 4, y: 43.5, w: 92, h: 0.15 },
  { kind: "printed", x: 4, y: 40.8, w: 13, h: 1.8, text: "日付 / 伝票No", size: 1.3, align: "center" },
  { kind: "printed", x: 17, y: 40.8, w: 40, h: 1.8, text: "商品コード ・ 商 品 名", size: 1.4, align: "center" },
  { kind: "printed", x: 57, y: 40.8, w: 11, h: 1.8, text: "数量", size: 1.4, align: "center" },
  { kind: "printed", x: 68, y: 40.8, w: 7, h: 1.8, text: "単位", size: 1.4, align: "center" },
  { kind: "printed", x: 75, y: 40.8, w: 9, h: 1.8, text: "単価", size: 1.4, align: "center" },
  { kind: "printed", x: 84, y: 40.8, w: 12, h: 1.8, text: "金額", size: 1.4, align: "center" },
  // 行罫線(空行にも印字される固定様式)
  { kind: "line", x: 4, y: 47.9, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 52.3, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 56.7, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 61.1, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 65.5, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 69.9, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 74.3, w: 92, h: 0.12 },
  { kind: "line", x: 4, y: 78.7, w: 92, h: 0.12 },
  // 明細行1: OPPフィルム
  { fieldId: "items", kind: "printed", x: 4.5, y: 44.6, w: 12.5, h: 2, text: "7/08  4211", size: 1.4 },
  { fieldId: "items", kind: "printed", x: 18, y: 44.6, w: 38, h: 2, text: "[1023] OPPフィルム #40", size: 1.6 },
  { fieldId: "items", kind: "printed", x: 57, y: 44.6, w: 10, h: 2, text: "500", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 68.5, y: 44.6, w: 6, h: 2, text: "kg", size: 1.5, align: "center" },
  { fieldId: "items", kind: "printed", x: 75, y: 44.6, w: 8.5, h: 2, text: "120", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 84, y: 44.6, w: 11, h: 2, text: "60,000", size: 1.6, align: "right" },
  //   規格サブ行(2行使い様式)
  { fieldId: "items", kind: "printed", x: 18, y: 49, w: 38, h: 2, text: "  規格: 2軸延伸PP 40μ-720幅", size: 1.4 },
  { fieldId: "items", kind: "printed", x: 84, y: 49, w: 11, h: 2, text: "0", size: 1.5, align: "right" },
  // 明細行2: PETフィルム
  { fieldId: "items", kind: "printed", x: 4.5, y: 53.4, w: 12.5, h: 2, text: "7/15  4258", size: 1.4 },
  { fieldId: "items", kind: "printed", x: 18, y: 53.4, w: 38, h: 2, text: "[1041] PETフィルム #75", size: 1.6 },
  { fieldId: "items", kind: "printed", x: 57, y: 53.4, w: 10, h: 2, text: "200", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 68.5, y: 53.4, w: 6, h: 2, text: "kg", size: 1.5, align: "center" },
  { fieldId: "items", kind: "printed", x: 75, y: 53.4, w: 8.5, h: 2, text: "250", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 84, y: 53.4, w: 11, h: 2, text: "50,000", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 18, y: 57.8, w: 38, h: 2, text: "  規格: 2軸延伸PET 75μ-1060幅", size: 1.4 },
  { fieldId: "items", kind: "printed", x: 84, y: 57.8, w: 11, h: 2, text: "0", size: 1.5, align: "right" },
  // 明細行3: PP袋
  { fieldId: "items", kind: "printed", x: 4.5, y: 62.2, w: 12.5, h: 2, text: "7/22  4290", size: 1.4 },
  { fieldId: "items", kind: "printed", x: 18, y: 62.2, w: 38, h: 2, text: "[2005] PP袋 300×450", size: 1.6 },
  { fieldId: "items", kind: "printed", x: 57, y: 62.2, w: 10, h: 2, text: "30,000", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 68.5, y: 62.2, w: 6, h: 2, text: "枚", size: 1.5, align: "center" },
  { fieldId: "items", kind: "printed", x: 75, y: 62.2, w: 8.5, h: 2, text: "1.4", size: 1.6, align: "right" },
  { fieldId: "items", kind: "printed", x: 84, y: 62.2, w: 11, h: 2, text: "42,000", size: 1.6, align: "right" },
  // 消費税行(明細に混在する様式)
  { fieldId: "items", kind: "printed", x: 18, y: 66.6, w: 38, h: 2, text: "請求時消費税 〈10.0%〉", size: 1.5 },
  { fieldId: "items", kind: "printed", x: 84, y: 66.6, w: 11, h: 2, text: "15,200", size: 1.6, align: "right" },
  // 表内下部の合計3行(中央寄せ)
  { kind: "printed", x: 30, y: 75.2, w: 25, h: 2, text: "【 売 上 額 】", size: 1.5 },
  { kind: "printed", x: 60, y: 75.2, w: 18, h: 2, text: "152,000", size: 1.6, align: "right" },
  { kind: "printed", x: 30, y: 79.6, w: 25, h: 2, text: "【 外 税 額 】", size: 1.5 },
  { kind: "printed", x: 60, y: 79.6, w: 18, h: 2, text: "15,200", size: 1.6, align: "right" },
  // 下部注記
  { kind: "printed", x: 4, y: 85, w: 60, h: 2, text: "※お支払いは翌月末日までに上記口座へお願いいたします。", size: 1.5 },
];

const seikyuSpec: AppSpec = {
  appName: "仕入請求管理",
  icon: "🧾",
  description: "仕入先からの月締め請求書を検算・消込・支払管理する業務",
  fields: [
    { id: "billing_no", label: "請求No", type: "text", required: true, confidence: 0.97, sourceBox: { x: 68, y: 4, w: 29, h: 3.5 } },
    { id: "closing_date", label: "締切日", type: "date", required: true, confidence: 0.98, sourceBox: { x: 64, y: 6.6, w: 33, h: 3.4 } },
    { id: "customer", label: "請求先", type: "text", required: true, confidence: 0.96, sourceBox: { x: 4, y: 16.6, w: 46, h: 5 } },
    { id: "issuer", label: "仕入先(発行元)", type: "text", required: true, confidence: 0.95, sourceBox: { x: 59, y: 10.5, w: 38, h: 5 } },
    { id: "reg_no", label: "インボイス登録番号", type: "text", required: false, confidence: 0.9, sourceBox: { x: 59, y: 20, w: 38, h: 3.2 } },
    { id: "prev_amount", label: "前回御請求額", type: "number", required: true, unit: "円", confidence: 0.94, sourceBox: { x: 3.5, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "payment", label: "御入金額", type: "number", required: true, unit: "円", confidence: 0.94, sourceBox: { x: 18.8, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "carryover", label: "繰越金額", type: "number", required: true, unit: "円", confidence: 0.92, sourceBox: { x: 34.2, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "purchase", label: "今回御買上額", type: "number", required: true, unit: "円", confidence: 0.96, sourceBox: { x: 49.5, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "tax", label: "消費税", type: "number", required: true, unit: "円", confidence: 0.95, sourceBox: { x: 64.8, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "billed", label: "今回御請求額", type: "number", required: true, unit: "円", confidence: 0.97, sourceBox: { x: 80.2, y: 30.5, w: 16.3, h: 7.5 } },
    { id: "items", label: "明細", type: "textarea", required: true, confidence: 0.91, sourceBox: { x: 3.5, y: 39.5, w: 93, h: 44 } },
    { id: "status", label: "消込ステータス", type: "select", required: false, options: ["未処理", "入力済", "支払済"], confidence: 0.66, sourceBox: { x: 5.5, y: 22.8, w: 25, h: 7 } },
  ],
  listColumns: ["closing_date", "issuer", "billed", "status"],
  approvalFlow: [
    { name: "入力", role: "経理" },
    { name: "支払承認", role: "社長" },
  ],
  aggregations: [
    { id: "billed_sum", label: "今月の仕入請求合計", fieldId: "billed", op: "sum", unit: "円" },
    { id: "invoice_count", label: "今月の請求書件数", fieldId: "billed", op: "count", unit: "件" },
  ],
  firstRecord: {
    billing_no: "00000743",
    closing_date: "2026-07-31",
    customer: "オルカ精密工業株式会社",
    issuer: "シャチホコ鋼材株式会社",
    reg_no: "T1234567890123",
    prev_amount: 214500,
    payment: 214500,
    carryover: 0,
    purchase: 152000,
    tax: 15200,
    billed: 167200,
    items:
      "7/08 [1023] OPPフィルム #40 (2軸延伸PP 40μ-720幅) 500kg ×120 = 60,000\n7/15 [1041] PETフィルム #75 (2軸延伸PET 75μ-1060幅) 200kg ×250 = 50,000\n7/22 [2005] PP袋 300×450 30,000枚 ×1.4 = 42,000\n請求時消費税〈10.0%〉 15,200",
    status: "入力済",
  },
};

const seikyuSeeds: AppRecord[] = [
  { billing_no: "00000728", closing_date: "2026-07-31", customer: "オルカ精密工業株式会社", issuer: "ラッコ包装株式会社", reg_no: "T2345678901234", prev_amount: 81400, payment: 81400, carryover: 0, purchase: 68000, tax: 6800, billed: 74800, items: "緩衝材・段ボール一式", status: "未処理" },
  { billing_no: "00000712", closing_date: "2026-07-25", customer: "オルカ精密工業株式会社", issuer: "株式会社 イルカ製作所", reg_no: "T3456789012345", prev_amount: 102300, payment: 102300, carryover: 0, purchase: 88000, tax: 8800, billed: 96800, items: "SUS304 丸棒・アルミ板ほか", status: "支払済" },
  { billing_no: "00000705", closing_date: "2026-07-25", customer: "オルカ精密工業株式会社", issuer: "ミナト商事株式会社", reg_no: "T4567890123456", prev_amount: 45100, payment: 45100, carryover: 0, purchase: 38000, tax: 3800, billed: 41800, items: "切削油・工具消耗品", status: "入力済" },
  { billing_no: "00000691", closing_date: "2026-07-20", customer: "オルカ精密工業株式会社", issuer: "東都運輸株式会社", reg_no: "T5678901234567", prev_amount: 30800, payment: 30800, carryover: 0, purchase: 26000, tax: 2600, billed: 28600, items: "7月分 運送費", status: "支払済" },
];

/* ============================================================
 * エクスポート
 * ============================================================ */

export const SCENARIOS: Scenario[] = [
  {
    id: "seikyu",
    label: "月締め請求明細書",
    paperKind: "販売管理ソフト印字の請求明細書(実在様式準拠)",
    paper: seikyuPaper,
    spec: seikyuSpec,
    seedRecords: seikyuSeeds,
    alert:
      "今月の仕入請求5件のうち「ラッコ包装株式会社」(¥74,800)が未処理のままです。支払期日(翌月末)から逆算すると今週中の入力・承認が必要です。他4件は繰越0円・検算一致を確認済みです。",
    question: {
      fieldId: "status",
      question:
        "左上に経理のゴム印「入力済」と手書き日付(7/3)を検出しました(信頼度 66%)。この赤印を消込ステータス(未処理→入力済→支払済)としてデジタル管理しますか?",
      choices: ["はい、ステータス管理する", "いいえ、記録だけでよい"],
    },
    validationNote:
      "検算OK: 繰越 0 + 今回買上 152,000 + 消費税 15,200 = 今回請求額 167,200 ✓(前回請求 214,500 は全額入金済み)",
  },
  {
    id: "chumonsho",
    label: "FAX注文書",
    paperKind: "手書きのFAX注文書(製造業)",
    paper: chumonshoPaper,
    spec: chumonshoSpec,
    seedRecords: chumonshoSeeds,
    alert:
      "今週(7/27〜)の発注金額は ¥296,200 で先週比 約1.5倍 に増加しています。今月の発注7件のうち「株式会社 イルカ製作所」向けが4件を占めており、単価交渉・まとめ発注の余地があります。",
    question: {
      fieldId: "approval_stamp",
      question:
        "右上の枠は「承認印」欄と読み取りました(信頼度 58%)。この会社では発注前に工場長の承認が必要ですか?",
      choices: ["はい、承認フローに含める", "いいえ、記録だけでよい"],
    },
  },
  {
    id: "nippo",
    label: "作業日報",
    paperKind: "手書きの作業日報(建設業)",
    paper: nippoPaper,
    spec: nippoSpec,
    seedRecords: nippoSeeds,
    alert:
      "「クジラ第二倉庫 新築工事」で残業が続いています(7/26: 実働10.0時間、7/27: 実働9.5時間)。工程の遅れ、または人員配置の見直しのサインかもしれません。",
    question: {
      fieldId: "supervisor_stamp",
      question:
        "右下の枠は「監督確認印」欄と読み取りました(信頼度 62%)。日報の提出後に現場監督の確認ステップを設けますか?",
      choices: ["はい、確認フローに含める", "いいえ、記録だけでよい"],
    },
  },
  {
    id: "tenken",
    label: "設備点検表",
    paperKind: "手書きの設備日常点検表(工場)",
    paper: tenkenPaper,
    spec: tenkenSpec,
    seedRecords: tenkenSeeds,
    alert:
      "コンプレッサー3号機の吐出圧力が3回連続で基準値(0.60 MPa)を超えています(0.62 → 0.63 → 0.65 と上昇傾向)。点検メモの「針が振れ気味」という記載と併せて、早期の部品交換を推奨します。",
    question: null,
  },
];

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}
