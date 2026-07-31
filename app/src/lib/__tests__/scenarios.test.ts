// scenarios.ts の回帰網。
//
// このファイルはバグ探索ではなく「デモが壊れたことに気づくため」のテスト。
// scenarios.ts の数値の多くは alert / validationNote / 逆質問の文面に
// 手打ちのリテラルとして二重に書かれており、seedRecords を1件足すだけで
// 「今月の発注7件」「¥2,175,800」といった読み上げ文が静かに嘘になる。
// したがって期待値は「汎用ルール」ではなく「仕様として正しい実測値」を
// テーブルに直書きし、シナリオを増やしたらテーブル追加を強制する形にしてある。

import { describe, it, expect } from "vitest";
import { SCENARIOS, getScenario, type Scenario } from "../scenarios";
import type { AppRecord, AppSpec, RecordValue } from "../appspec";
import { chipsForScenario, applyDiffs, checkLimit } from "../specdiff";
import { buildDemoSequence } from "../demo";

/* ============================================================
 * 共通ヘルパ
 * ============================================================ */

/** 画面に出るレコードは常に [firstRecord, ...seedRecords](KamiwazaApp が両者を連結する) */
const allRecords = (s: Scenario): AppRecord[] => [s.spec.firstRecord, ...s.seedRecords];

const fieldIds = (spec: AppSpec) => spec.fields.map((f) => f.id);

const asNumber = (v: RecordValue | undefined): number => {
  expect(typeof v).toBe("number");
  return v as number;
};

const asString = (v: RecordValue | undefined): string => {
  expect(typeof v).toBe("string");
  return v as string;
};

/** 金額比較。単価 4.20 / 1.80 / 1.4 のような小数が混ざるため厳密比較は使わない */
const expectMoney = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 2);

/** alert 文中の円表記(¥1,234,567)を組み立てる */
const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

/**
 * 期待値テーブルが SCENARIOS を過不足なく覆っていることを保証する。
 * シナリオを1件足してテーブルを更新し忘れると、ここで落ちる。
 */
function expectTableCoversAllScenarios(table: Record<string, unknown>) {
  expect(Object.keys(table).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
}

/* ============================================================
 * 1. シナリオの同一性と順序
 * ============================================================ */

describe("SCENARIOS の同一性と順序", () => {
  it("id は仕様どおりの順序で並ぶ(先頭が既定シナリオ・選択UIの並び順)", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      "seikyu",
      "chumonsho",
      "nippo",
      "tenken",
      "hacchusho",
    ]);
  });

  it("label は選択UIの表示名として一意", () => {
    expect(SCENARIOS.map((s) => s.label)).toEqual([
      "月締め請求明細書",
      "FAX注文書",
      "作業日報",
      "設備点検表",
      "発注書",
    ]);
    expect(new Set(SCENARIOS.map((s) => s.label)).size).toBe(SCENARIOS.length);
  });

  it("id は重複しない", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("getScenario は既知IDをそのまま引ける", () => {
    for (const s of SCENARIOS) {
      expect(getScenario(s.id)).toBe(s);
    }
  });

  it("getScenario は未知IDで throw せず先頭シナリオにフォールバックする", () => {
    // 配列順序が仕様の一部である根拠。並べ替えると既定デモが変わる。
    expect(getScenario("no-such-scenario")).toBe(SCENARIOS[0]);
    expect(getScenario("").id).toBe("seikyu");
  });
});

/* ============================================================
 * 2. Scenario の必須フィールド
 * ============================================================ */

const SHAPE: Record<string, { paper: number; fields: number; seeds: number; hasValidationNote: boolean }> = {
  seikyu: { paper: 89, fields: 12, seeds: 4, hasValidationNote: true },
  chumonsho: { paper: 50, fields: 7, seeds: 6, hasValidationNote: false },
  nippo: { paper: 33, fields: 10, seeds: 5, hasValidationNote: false },
  tenken: { paper: 41, fields: 11, seeds: 5, hasValidationNote: false },
  hacchusho: { paper: 81, fields: 11, seeds: 5, hasValidationNote: true },
};

describe("Scenario の必須フィールド", () => {
  it("形状テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(SHAPE));

  it.each(SCENARIOS)("$id — 文字列フィールドが空でない", (s) => {
    for (const [key, value] of [
      ["id", s.id],
      ["label", s.label],
      ["paperKind", s.paperKind],
      ["alert", s.alert],
    ] as const) {
      expect(typeof value, key).toBe("string");
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });

  it.each(SCENARIOS)("$id — 紙・フィールド・シードの件数が凍結値と一致する", (s) => {
    const want = SHAPE[s.id];
    expect(s.paper).toHaveLength(want.paper);
    expect(s.spec.fields).toHaveLength(want.fields);
    expect(s.seedRecords).toHaveLength(want.seeds);
  });

  it.each(SCENARIOS)("$id — alert はダッシュボードで読ませる長さがある", (s) => {
    // 実測 83〜170字。短い一言に劣化していないことの下限ガード。
    expect(s.alert.length).toBeGreaterThanOrEqual(80);
  });

  it.each(SCENARIOS)("$id — question は null か {fieldId, question, choices}", (s) => {
    if (s.question === null) return;
    expect(typeof s.question.fieldId).toBe("string");
    expect(s.question.question.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(s.question.choices)).toBe(true);
  });

  it.each(SCENARIOS)("$id — validationNote の有無が凍結値と一致する", (s) => {
    expect(s.validationNote !== undefined).toBe(SHAPE[s.id].hasValidationNote);
  });
});

/* ============================================================
 * 3. ID の一意性
 * ============================================================ */

describe("ID の一意性", () => {
  it.each(SCENARIOS)("$id — fields[].id が重複しない", (s) => {
    const ids = fieldIds(s.spec);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SCENARIOS)("$id — lineItems.columns[].id が重複しない", (s) => {
    const ids = s.spec.lineItems?.columns.map((c) => c.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SCENARIOS)("$id — aggregations[].id が重複しない", (s) => {
    const ids = s.spec.aggregations.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("明細列の構成が凍結値と一致する", () => {
    const columns = Object.fromEntries(
      SCENARIOS.map((s) => [s.id, s.spec.lineItems?.columns.map((c) => c.id) ?? null]),
    );
    expect(columns).toEqual({
      seikyu: ["date_slip", "item", "qty", "unit", "unit_price", "amount"],
      chumonsho: ["item_name", "qty", "unit_price", "amount"],
      nippo: null,
      tenken: null,
      hacchusho: ["item", "qty", "unit", "unit_price", "amount", "ref_no"],
    });
  });
});

/* ============================================================
 * 4. listColumns
 * ============================================================ */

const LIST_COLUMNS: Record<string, string[]> = {
  seikyu: ["closing_date", "issuer", "billed", "status"],
  chumonsho: ["order_date", "supplier", "total", "delivery_date"],
  nippo: ["work_date", "worker", "site", "safety_check"],
  tenken: ["inspect_date", "equipment", "gauge_status", "pressure"],
  hacchusho: ["issue_date", "supplier", "project", "total"],
};

describe("listColumns", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(LIST_COLUMNS));

  it.each(SCENARIOS)("$id — 一覧列が凍結値と一致する", (s) => {
    expect(s.spec.listColumns).toEqual(LIST_COLUMNS[s.id]);
  });

  it.each(SCENARIOS)("$id — 一覧列は全て実在フィールドを指す", (s) => {
    const ids = fieldIds(s.spec);
    for (const c of s.spec.listColumns) expect(ids, c).toContain(c);
  });

  it.each(SCENARIOS)("$id — 一覧列はチップ1枚分の追加余地を残している", (s) => {
    // applyDiff の addFilterColumn は listColumns.length >= 6 を拒否する。
    // 4列なら「一覧に◯◯を表示」チップが必ず通る。
    expect(s.spec.listColumns.length).toBe(4);
    expect(s.spec.listColumns.length).toBeLessThan(6);
  });
});

/* ============================================================
 * 5. select の options とレコード値
 * ============================================================ */

const SELECTS: Record<string, Record<string, { options: string[]; first: string }>> = {
  seikyu: {
    status: { options: ["未処理", "入力済", "支払済"], first: "入力済" },
  },
  // FAX注文書には選択式の項目がない(全て自由入力・数値・押印)
  chumonsho: {},
  nippo: {
    weather: { options: ["晴れ", "曇り", "雨"], first: "晴れ" },
  },
  tenken: {
    equipment: {
      options: ["コンプレッサー 1号機", "コンプレッサー 2号機", "コンプレッサー 3号機"],
      first: "コンプレッサー 3号機",
    },
    gauge_status: { options: ["○ 正常", "△ 要観察", "× 異常"], first: "△ 要観察" },
  },
  hacchusho: {
    // "SNS" はどのレコードでも未使用(将来の分類先として残してある空オプション)
    category: {
      options: ["ポスティング", "OOH", "SNS", "サンプリング", "イベント", "その他"],
      first: "ポスティング",
    },
    // "北日本" / "西日本" も未使用
    area: { options: ["北日本", "東日本", "中日本", "関西", "西日本"], first: "東日本" },
    payment_terms: {
      options: ["検収完了月の当月末日払い", "検収完了月の翌月25日払い"],
      first: "検収完了月の翌月25日払い",
    },
  },
};

describe("select フィールド", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(SELECTS));

  it.each(SCENARIOS)("$id — select フィールドの顔ぶれが凍結値と一致する", (s) => {
    const actual = s.spec.fields.filter((f) => f.type === "select").map((f) => f.id);
    expect(actual.sort()).toEqual(Object.keys(SELECTS[s.id]).sort());
  });

  it.each(SCENARIOS)("$id — options と1件目の値が凍結値と一致する", (s) => {
    for (const [id, want] of Object.entries(SELECTS[s.id])) {
      const field = s.spec.fields.find((f) => f.id === id);
      expect(field?.options, id).toEqual(want.options);
      expect(s.spec.firstRecord[id], id).toBe(want.first);
    }
  });

  it.each(SCENARIOS)("$id — 全レコードの値が options に含まれる", (s) => {
    // 逆(全 options が使われている)は成立しない。hacchusho の SNS / 北日本 / 西日本 は未使用。
    for (const field of s.spec.fields) {
      if (field.type !== "select") continue;
      expect(field.options, field.id).toBeDefined();
      for (const rec of allRecords(s)) {
        expect(field.options, `${field.id}=${String(rec[field.id])}`).toContain(rec[field.id]);
      }
    }
  });
});

/* ============================================================
 * 6. 明細行の算術と合計の突合
 * ============================================================ */

/**
 * Σ明細金額と「合計欄フィールド」の関係はシナリオごとに違う。
 * 一律の「Σ === total」を書くと hacchusho(Σ=小計、total=税込)が必ず落ちる。
 */
type Reconcile =
  /** Σ(全明細行) === 指定フィールド */
  | { check: "sumAll=field"; field: string }
  /** Σ(全明細行) × rate === 指定フィールド(Σが「小計」で合計欄が税込のとき) */
  | { check: "sumAll*rate=field"; rate: number; field: string }
  /** Σ(数量・単価を持つ行) === 指定フィールド(税行が明細に混在するとき) */
  | { check: "sumPricedRows=field"; field: string }
  /** Σ(数量・単価を持たない行) === 指定フィールド(消費税行の突合) */
  | { check: "sumUnpricedRows=field"; field: string };

const LINES: Record<
  string,
  {
    rows: number;
    sumAll: number;
    /** qty × unit_price === amount を検算できる行の凍結値 */
    arithmetic: [qty: number, unitPrice: number, amount: number][];
    reconcile: Reconcile[];
  }
> = {
  // 明細に消費税行(数量・単価なし)が混ざる様式
  seikyu: {
    rows: 4,
    sumAll: 167200, // 60,000 + 50,000 + 42,000 + 15,200(税行)
    arithmetic: [
      [500, 120, 60000],
      [200, 250, 50000],
      [30000, 1.4, 42000],
    ],
    reconcile: [
      { check: "sumAll=field", field: "billed" },
      { check: "sumPricedRows=field", field: "purchase" },
      { check: "sumUnpricedRows=field", field: "tax" },
    ],
  },
  // 合計欄が税抜。Σがそのまま合計欄と一致する
  chumonsho: {
    rows: 3,
    sumAll: 85800, // 36,000 + 40,800 + 9,000
    arithmetic: [
      [30, 1200, 36000],
      [12, 3400, 40800],
      [200, 45, 9000],
    ],
    reconcile: [{ check: "sumAll=field", field: "total" }],
  },
  nippo: { rows: 0, sumAll: 0, arithmetic: [], reconcile: [] },
  tenken: { rows: 0, sumAll: 0, arithmetic: [], reconcile: [] },
  // Σは紙の「小計」。合計欄フィールドは消費税10%込みの「総合計」
  hacchusho: {
    rows: 2,
    sumAll: 300000, // 210,000 + 90,000
    arithmetic: [
      [50000, 4.2, 210000],
      [50000, 1.8, 90000],
    ],
    reconcile: [{ check: "sumAll*rate=field", rate: 1.1, field: "total" }],
  },
};

describe("明細行", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(LINES));

  it.each(SCENARIOS)("$id — lineItems の有無と firstRecordLines の有無が一致する", (s) => {
    // SpecApp は `!lineItems || firstRecordLines.length === 0` で明細UIを丸ごと落とす。
    // 片方だけ設定すると明細が無言で消える。
    expect(s.spec.lineItems === null).toBe(s.spec.firstRecordLines.length === 0);
    expect(s.spec.firstRecordLines).toHaveLength(LINES[s.id].rows);
  });

  it.each(SCENARIOS)("$id — 明細行のキーは lineItems.columns の部分集合", (s) => {
    // 全列必須ではない。seikyu の消費税行は {item, amount} だけの疎な行。
    const cols = new Set(s.spec.lineItems?.columns.map((c) => c.id) ?? []);
    for (const line of s.spec.firstRecordLines) {
      for (const key of Object.keys(line)) expect(cols, key).toContain(key);
    }
  });

  it.each(SCENARIOS)("$id — 数量×単価 = 金額(両方を持つ行のみ)", (s) => {
    const priced = s.spec.firstRecordLines.filter(
      (l) => typeof l.qty === "number" && typeof l.unit_price === "number",
    );
    expect(priced.map((l) => [l.qty, l.unit_price, l.amount])).toEqual(LINES[s.id].arithmetic);
    for (const l of priced) {
      expectMoney((l.qty as number) * (l.unit_price as number), l.amount as number);
    }
  });

  it.each(SCENARIOS)("$id — Σ明細金額と合計欄フィールドの関係が凍結値どおり", (s) => {
    const lines = s.spec.firstRecordLines;
    const amount = (l: (typeof lines)[number]) => (typeof l.amount === "number" ? l.amount : 0);
    const isPriced = (l: (typeof lines)[number]) =>
      typeof l.qty === "number" && typeof l.unit_price === "number";
    const sum = (rows: typeof lines) => rows.reduce((a, l) => a + amount(l), 0);

    const want = LINES[s.id];
    expectMoney(sum(lines), want.sumAll);

    for (const r of want.reconcile) {
      const target = asNumber(s.spec.firstRecord[r.field]);
      switch (r.check) {
        case "sumAll=field":
          expectMoney(sum(lines), target);
          break;
        case "sumAll*rate=field":
          expectMoney(sum(lines) * r.rate, target);
          break;
        case "sumPricedRows=field":
          expectMoney(sum(lines.filter(isPriced)), target);
          break;
        case "sumUnpricedRows=field":
          expectMoney(sum(lines.filter((l) => !isPriced(l))), target);
          break;
      }
    }
  });
});

/* ============================================================
 * 7. 請求明細書の繰越サマリー帯(この様式の看板)
 * ============================================================ */

describe("seikyu — 繰越サマリー帯の恒等式", () => {
  const seikyu = getScenario("seikyu");

  it("全レコードで 前回請求 − 入金 = 繰越", () => {
    for (const r of allRecords(seikyu)) {
      expectMoney(asNumber(r.prev_amount) - asNumber(r.payment), asNumber(r.carryover));
    }
  });

  it("全レコードで 繰越 + 今回買上 + 消費税 = 今回請求額", () => {
    for (const r of allRecords(seikyu)) {
      expectMoney(
        asNumber(r.carryover) + asNumber(r.purchase) + asNumber(r.tax),
        asNumber(r.billed),
      );
    }
  });

  it("全レコードで 消費税 = 今回買上 × 10%", () => {
    for (const r of allRecords(seikyu)) {
      expectMoney(asNumber(r.purchase) * 0.1, asNumber(r.tax));
    }
  });

  it("全レコードが繰越0(前月分は全額入金済みという設定)", () => {
    expect(allRecords(seikyu).map((r) => r.carryover)).toEqual([0, 0, 0, 0, 0]);
  });
});

/* ============================================================
 * 8. 座標系(紙 ↔ sourceBox)
 * ============================================================ */

/** 紙とAppSpecが同じ%座標系を共有する前提での浮動小数許容 */
const COORD_EPS = 0.001;

/** 紙の明細テーブル全体を指す予約 fieldId */
const ITEMS_MARKER = "items";

/** spec 側に居るが対応する紙要素を持たないフィールド(意図的な例外のみ) */
const FIELDS_WITHOUT_PAPER: Record<string, string[]> = {
  seikyu: [],
  chumonsho: [],
  nippo: [],
  tenken: [],
  // category は project と同じ「給付内容」セルから AI が分類するデモ。
  // 紙にカテゴリ欄そのものは存在せず、sourceBox は project のセルにネストしている。
  hacchusho: ["category"],
};

describe("座標系(紙とAppSpecの共有%座標)", () => {
  it("例外テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(FIELDS_WITHOUT_PAPER));

  it.each(SCENARIOS)("$id — 全フィールドが sourceBox を持ち紙の内側に収まる", (s) => {
    for (const f of s.spec.fields) {
      const b = f.sourceBox;
      expect(b, f.id).toBeDefined();
      if (!b) continue;
      expect(b.x, f.id).toBeGreaterThanOrEqual(0);
      expect(b.y, f.id).toBeGreaterThanOrEqual(0);
      expect(b.w, f.id).toBeGreaterThan(0);
      expect(b.h, f.id).toBeGreaterThan(0);
      expect(b.x + b.w, f.id).toBeLessThanOrEqual(100 + COORD_EPS);
      expect(b.y + b.h, f.id).toBeLessThanOrEqual(100 + COORD_EPS);
    }
  });

  it.each(SCENARIOS)("$id — lineItems.sourceBox も紙の内側に収まる", (s) => {
    const b = s.spec.lineItems?.sourceBox;
    if (!b) return;
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
    expect(b.x + b.w).toBeLessThanOrEqual(100 + COORD_EPS);
    expect(b.y + b.h).toBeLessThanOrEqual(100 + COORD_EPS);
  });

  it.each(SCENARIOS)("$id — PaperElement が紙からはみ出さない", (s) => {
    for (const el of s.paper) {
      const tag = `${el.kind}:${el.text ?? ""}`;
      expect(el.x, tag).toBeGreaterThanOrEqual(0);
      expect(el.y, tag).toBeGreaterThanOrEqual(0);
      expect(el.x + el.w, tag).toBeLessThanOrEqual(100 + COORD_EPS);
      expect(el.y + el.h, tag).toBeLessThanOrEqual(100 + COORD_EPS);
    }
  });

  it.each(SCENARIOS)("$id — PaperElement.fieldId は実在フィールドか明細マーカー", (s) => {
    // タイポすると出典ハイライトが無反応になるだけでエラーは出ない。
    const known = new Set([...fieldIds(s.spec), ITEMS_MARKER]);
    for (const el of s.paper) {
      if (!el.fieldId) continue;
      expect(known, el.fieldId).toContain(el.fieldId);
    }
  });

  it.each(SCENARIOS)("$id — 紙要素を持たないフィールドは意図的な例外のみ", (s) => {
    const withPaper = new Set(s.paper.map((el) => el.fieldId).filter(Boolean));
    const orphans = fieldIds(s.spec).filter((id) => !withPaper.has(id));
    expect(orphans).toEqual(FIELDS_WITHOUT_PAPER[s.id]);
  });

  it.each(SCENARIOS)("$id — fieldId 付き紙要素は対応する sourceBox に完全に内包される", (s) => {
    // 出典ハイライトが構造的にズレないという設計主張(scenarios.ts 冒頭)の実体。
    // 内包(はみ出しゼロ)だけを見る。余白の大きさは検証しない
    // (tenken のチェック行は行全体を光らせる設計で左右に大きな余白がある)。
    for (const el of s.paper) {
      if (!el.fieldId) continue;
      const box =
        el.fieldId === ITEMS_MARKER
          ? s.spec.lineItems?.sourceBox
          : s.spec.fields.find((f) => f.id === el.fieldId)?.sourceBox;
      expect(box, el.fieldId).toBeDefined();
      if (!box) continue;
      const tag = `${el.fieldId} "${el.text ?? el.kind}"`;
      expect(el.x, tag).toBeGreaterThanOrEqual(box.x - COORD_EPS);
      expect(el.y, tag).toBeGreaterThanOrEqual(box.y - COORD_EPS);
      expect(el.x + el.w, tag).toBeLessThanOrEqual(box.x + box.w + COORD_EPS);
      expect(el.y + el.h, tag).toBeLessThanOrEqual(box.y + box.h + COORD_EPS);
    }
  });

  it("hacchusho — category の sourceBox は project のセルに内包される", () => {
    const spec = getScenario("hacchusho").spec;
    const project = spec.fields.find((f) => f.id === "project")?.sourceBox;
    const category = spec.fields.find((f) => f.id === "category")?.sourceBox;
    expect(project).toBeDefined();
    expect(category).toBeDefined();
    if (!project || !category) return;
    expect(category.x).toBeGreaterThanOrEqual(project.x);
    expect(category.y).toBeGreaterThanOrEqual(project.y);
    expect(category.x + category.w).toBeLessThanOrEqual(project.x + project.w + COORD_EPS);
    expect(category.y + category.h).toBeLessThanOrEqual(project.y + project.h + COORD_EPS);
  });
});

/* ============================================================
 * 9. 集計(aggregations)
 * ============================================================ */

/** ダッシュボードに出る集計値。sum/avg は金額・実測値、count は表示件数 */
const AGG_VALUES: Record<string, Record<string, number>> = {
  seikyu: { billed_sum: 409200, invoice_count: 5 },
  chumonsho: { total_sum: 498900, order_count: 7 },
  nippo: { report_count: 6, break_avg: 1 },
  // 3.55 / 6 = 0.59166… を小数2桁に丸めて 0.59 と表示される
  tenken: { inspect_count: 6, pressure_avg: 0.59 },
  hacchusho: { po_sum: 2175800, po_count: 6 },
};

describe("aggregations", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(AGG_VALUES));

  it.each(SCENARIOS)("$id — 集計の顔ぶれが凍結値と一致する", (s) => {
    expect(s.spec.aggregations.map((a) => a.id)).toEqual(Object.keys(AGG_VALUES[s.id]));
  });

  it.each(SCENARIOS)("$id — fieldId が実在し、件数はチップ追加の余地を残す", (s) => {
    const ids = fieldIds(s.spec);
    for (const a of s.spec.aggregations) expect(ids, a.id).toContain(a.fieldId);
    expect(s.spec.aggregations.length).toBeGreaterThanOrEqual(1);
    // applyDiff の addAggregation は 6枚以上で拒否する。
    expect(s.spec.aggregations.length).toBeLessThan(6);
  });

  it.each(SCENARIOS)("$id — sum / avg の対象は number 型フィールド", (s) => {
    // count は SpecApp が records.length を返すだけで fieldId を読まないため、
    // nippo/tenken のように date 型を指していてよい。
    for (const a of s.spec.aggregations) {
      if (a.op === "count") continue;
      const f = s.spec.fields.find((x) => x.id === a.fieldId);
      expect(f?.type, `${a.id} → ${a.fieldId}`).toBe("number");
    }
  });

  it.each(SCENARIOS)("$id — 実データからの集計値が凍結値と一致する", (s) => {
    const records = allRecords(s);
    for (const [aggId, expected] of Object.entries(AGG_VALUES[s.id])) {
      const agg = s.spec.aggregations.find((a) => a.id === aggId);
      expect(agg, aggId).toBeDefined();
      if (!agg) continue;
      if (agg.op === "count") {
        expect(records.length, aggId).toBe(expected);
        continue;
      }
      const nums = records
        .map((r) => r[agg.fieldId])
        .filter((v): v is number => typeof v === "number");
      const sum = nums.reduce((a, b) => a + b, 0);
      if (agg.op === "sum") {
        expectMoney(sum, expected);
      } else {
        expect(Math.round((sum / nums.length) * 100) / 100, aggId).toBe(expected);
      }
    }
  });
});

/* ============================================================
 * 10. 承認フロー
 * ============================================================ */

const APPROVAL_FLOWS: Record<string, { name: string; role: string }[]> = {
  seikyu: [
    { name: "入力", role: "経理" },
    { name: "支払承認", role: "社長" },
  ],
  chumonsho: [
    { name: "起票", role: "担当" },
    { name: "承認", role: "工場長" },
  ],
  nippo: [
    { name: "提出", role: "作業員" },
    { name: "確認", role: "現場監督" },
  ],
  tenken: [
    { name: "点検", role: "点検担当" },
    { name: "確認", role: "係長" },
  ],
  hacchusho: [
    { name: "起票", role: "施策担当" },
    { name: "押印決裁", role: "部長" },
  ],
};

describe("approvalFlow", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(APPROVAL_FLOWS));

  it.each(SCENARIOS)("$id — 承認フローが凍結値と一致する", (s) => {
    expect(s.spec.approvalFlow).toEqual(APPROVAL_FLOWS[s.id]);
  });

  it.each(SCENARIOS)("$id — 段数はスキーマ上限内で、チップ1段分の余地がある", (s) => {
    const flow = s.spec.approvalFlow ?? [];
    // JSON Schema は「最大2段+起票」。applyDiff の絶対上限は5段。
    expect(flow.length).toBeGreaterThanOrEqual(1);
    expect(flow.length).toBeLessThanOrEqual(3);
    expect(flow.length).toBeLessThan(5);
  });

  it.each(SCENARIOS)("$id — ステップ名が重複しない(同名は applyDiff に拒否される)", (s) => {
    const names = (s.spec.approvalFlow ?? []).map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/* ============================================================
 * 11. 逆質問(question)
 * ============================================================ */

const QUESTIONS: Record<string, { fieldId: string; confidence: number } | null> = {
  seikyu: { fieldId: "status", confidence: 0.66 },
  chumonsho: { fieldId: "approval_stamp", confidence: 0.58 },
  nippo: { fieldId: "supervisor_stamp", confidence: 0.62 },
  // 最小 confidence は approver_stamp の 0.60 だが、意図的に逆質問を出さない。
  // 「低信頼度なら必ず question がある」という逆向きの主張は成立しない。
  tenken: null,
  hacchusho: { fieldId: "company_seal", confidence: 0.6 },
};

describe("逆質問", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(QUESTIONS));

  it.each(SCENARIOS)("$id — 全フィールドの confidence が 0 < c <= 1", (s) => {
    for (const f of s.spec.fields) {
      expect(f.confidence, f.id).toBeGreaterThan(0);
      expect(f.confidence, f.id).toBeLessThanOrEqual(1);
    }
  });

  it.each(SCENARIOS)("$id — 逆質問の有無と対象フィールドが凍結値と一致する", (s) => {
    const want = QUESTIONS[s.id];
    if (want === null) {
      expect(s.question).toBeNull();
      return;
    }
    expect(s.question?.fieldId).toBe(want.fieldId);
  });

  it.each(SCENARIOS)("$id — 逆質問の対象は confidence 最小のフィールド", (s) => {
    if (!s.question) return;
    const min = Math.min(...s.spec.fields.map((f) => f.confidence));
    const target = s.spec.fields.find((f) => f.id === s.question?.fieldId);
    expect(target, s.question.fieldId).toBeDefined();
    expect(target?.confidence).toBe(min);
    expect(target?.confidence).toBe(QUESTIONS[s.id]?.confidence);
  });

  it.each(SCENARIOS)("$id — 質問文の「信頼度 NN%」が confidence と一致する", (s) => {
    if (!s.question) return;
    // 文面には数値が手打ちされており confidence を編集しても追随しない。
    // この二重管理こそが回帰テストの主対象。
    const conf = s.spec.fields.find((f) => f.id === s.question?.fieldId)?.confidence ?? 0;
    expect(s.question.question).toContain(`信頼度 ${Math.round(conf * 100)}%`);
  });

  it.each(SCENARIOS)("$id — 選択肢は「はい/いいえ」の2択", (s) => {
    if (!s.question) return;
    expect(s.question.choices).toHaveLength(2);
    expect(s.question.choices[0].startsWith("はい")).toBe(true);
    expect(s.question.choices[1]).toBe("いいえ、記録だけでよい");
  });
});

/* ============================================================
 * 12. レコードの型とキー
 * ============================================================ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("レコード", () => {
  it.each(SCENARIOS)("$id — 値の JS 型が FieldSpec.type と整合する", (s) => {
    for (const [i, rec] of allRecords(s).entries()) {
      for (const f of s.spec.fields) {
        const v = rec[f.id];
        const tag = `#${i} ${f.id}(${f.type})`;
        if (f.type === "number") {
          expect(typeof v, tag).toBe("number");
        } else if (f.type === "checkbox" || f.type === "stamp") {
          expect(typeof v, tag).toBe("boolean");
        } else {
          expect(typeof v, tag).toBe("string");
        }
        if (f.type === "date") expect(String(v), tag).toMatch(ISO_DATE);
      }
    }
  });

  it.each(SCENARIOS)("$id — 全レコードのキー集合が fields と完全一致する", (s) => {
    // 任意項目(note / break_hours / reg_no など)も空文字などで明示的に埋める流儀。
    const want = fieldIds(s.spec).sort();
    for (const [i, rec] of allRecords(s).entries()) {
      expect(Object.keys(rec).sort(), `#${i}`).toEqual(want);
    }
  });
});

/* ============================================================
 * 13. alert の数値が実データから再計算できる
 * ============================================================ */

/** 作業時間文字列の区切りは波ダッシュ U+301C(全角チルダ U+FF5E ではない) */
const WAVE_DASH = "〜";

/** "8:00〜19:00" と休憩時間から実働時間を導出する(実働時間はどこにも保存されていない) */
function actualWorkHours(rec: AppRecord): number {
  const parts = asString(rec.work_hours).split(WAVE_DASH);
  expect(parts, String(rec.work_hours)).toHaveLength(2);
  const toHours = (t: string) => {
    const [h, m] = t.trim().split(":").map(Number);
    return h + m / 60;
  };
  return toHours(parts[1]) - toHours(parts[0]) - asNumber(rec.break_hours);
}

/** 検収完了日 + 支払条件 から支払予定日を導出する */
function paymentDate(rec: AppRecord): string {
  const [y, m] = asString(rec.acceptance_date).split("-").map(Number);
  const terms = asString(rec.payment_terms);
  if (terms === "検収完了月の翌月25日払い") {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-25`;
  }
  expect(terms).toBe("検収完了月の当月末日払い");
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

const sumOf = (records: AppRecord[], key: string) =>
  records.reduce((a, r) => a + asNumber(r[key]), 0);

/** 各シナリオの alert 文に埋まっている数値の検算 */
const ALERT_FACTS: Record<string, (s: Scenario, records: AppRecord[]) => void> = {
  seikyu: (s, records) => {
    expect(records).toHaveLength(5);
    expect(s.alert).toContain("仕入請求5件");

    const unprocessed = records.filter((r) => r.status === "未処理");
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].issuer).toBe("ラッコ包装株式会社");
    expect(s.alert).toContain("ラッコ包装株式会社");
    expect(s.alert).toContain(yen(asNumber(unprocessed[0].billed)));
    expect(asNumber(unprocessed[0].billed)).toBe(74800);

    // 「他4件は繰越0円・検算一致」
    expect(records.filter((r) => r !== unprocessed[0])).toHaveLength(4);
  },

  chumonsho: (s, records) => {
    expect(records).toHaveLength(7);
    expect(s.alert).toContain("発注7件");

    // 今週 = 7/27 以降
    const thisWeek = records.filter((r) => asString(r.order_date) >= "2026-07-27");
    const lastWeek = records.filter(
      (r) => asString(r.order_date) >= "2026-07-20" && asString(r.order_date) <= "2026-07-26",
    );
    const thisSum = sumOf(thisWeek, "total");
    const lastSum = sumOf(lastWeek, "total");
    expect(thisSum).toBe(296200);
    expect(lastSum).toBe(202700);
    expect(s.alert).toContain(yen(thisSum));
    // 296,200 / 202,700 = 1.46 →「約1.5倍」
    expect(thisSum / lastSum).toBeGreaterThan(1.4);
    expect(thisSum / lastSum).toBeLessThan(1.55);
    expect(s.alert).toContain("約1.5倍");

    const yamada = records.filter((r) => r.supplier === "株式会社 イルカ製作所");
    expect(yamada).toHaveLength(4);
    expect(s.alert).toContain("株式会社 イルカ製作所");
    expect(s.alert).toContain(`${yamada.length}件`);
  },

  nippo: (s, records) => {
    expect(records).toHaveLength(6);
    // 7/27 にはオルカ駅前ビルの別レコードもあるため、現場での絞り込みが必須
    const site = "クジラ第二倉庫 新築工事";
    const at = (date: string) => {
      const hit = records.filter((r) => r.site === site && r.work_date === date);
      expect(hit, date).toHaveLength(1);
      return hit[0];
    };
    expect(actualWorkHours(at("2026-07-26"))).toBeCloseTo(10.0, 2);
    expect(actualWorkHours(at("2026-07-27"))).toBeCloseTo(9.5, 2);
    expect(s.alert).toContain(site);
    expect(s.alert).toContain("7/26: 実働10.0時間");
    expect(s.alert).toContain("7/27: 実働9.5時間");
  },

  tenken: (s, records) => {
    expect(records).toHaveLength(6);
    const target = "コンプレッサー 3号機";
    const series = records
      .filter((r) => r.equipment === target)
      .sort((a, b) => asString(a.inspect_date).localeCompare(asString(b.inspect_date)))
      .map((r) => asNumber(r.pressure));
    expect(series).toEqual([0.58, 0.62, 0.63, 0.65]);

    const LIMIT = 0.6; // 紙に印字された基準値
    const recent = series.slice(-3);
    expect(recent.every((p) => p > LIMIT)).toBe(true); // 「3回連続で基準値超過」
    expect(series[series.length - 4]).toBeLessThanOrEqual(LIMIT); // その前は基準内
    expect(recent[0] < recent[1] && recent[1] < recent[2]).toBe(true); // 「上昇傾向」
    expect(s.alert).toContain("0.62 → 0.63 → 0.65");
    expect(s.alert).toContain("3回連続");
  },

  hacchusho: (s, records) => {
    expect(records).toHaveLength(6);
    expect(s.alert).toContain("6件");

    const total = sumOf(records, "total");
    expect(total).toBe(2175800);
    expect(s.alert).toContain(yen(total));

    const top = [...records].sort((a, b) => asNumber(b.total) - asNumber(a.total))[0];
    expect(top.supplier).toBe("株式会社 マンボウ商事");
    expect(asNumber(top.total)).toBe(880000);
    expect(s.alert).toContain(yen(880000));
    expect(Math.round((asNumber(top.total) / total) * 100)).toBe(40);
    expect(s.alert).toContain("40%");

    const unsealed = records.filter((r) => r.company_seal === false);
    expect(unsealed).toHaveLength(1);
    expect(unsealed[0].project).toBe("店頭POP 増刷(中日本 8月分)");
    expect(s.alert).toContain(yen(asNumber(unsealed[0].total)));

    // 支払月バケット。当月末払いの 8月分 ¥572,000 は alert では意図的に省略されている。
    const buckets = new Map<string, number>();
    for (const r of records) {
      const d = paymentDate(r);
      buckets.set(d, (buckets.get(d) ?? 0) + asNumber(r.total));
    }
    expect(Object.fromEntries(buckets)).toEqual({
      "2026-09-25": 976800,
      "2026-10-25": 627000,
      "2026-08-31": 572000,
    });
    expect(s.alert).toContain(`9月25日に ${yen(976800)}`);
    expect(s.alert).toContain(`10月25日に ${yen(627000)}`);
  },
};

describe("alert の数値", () => {
  it("検算テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(ALERT_FACTS));

  it.each(SCENARIOS)("$id — alert の数値が実データから再計算できる", (s) => {
    const check = ALERT_FACTS[s.id];
    expect(check, `${s.id} の alert 検算が未定義`).toBeDefined();
    check(s, allRecords(s));
  });
});

/* ============================================================
 * 14. validationNote の数値
 * ============================================================ */

describe("validationNote の数値", () => {
  it("seikyu — 繰越サマリーの読み上げ文が firstRecord と一致する", () => {
    const s = getScenario("seikyu");
    const r = s.spec.firstRecord;
    expect(s.validationNote).toBeDefined();
    const note = s.validationNote ?? "";

    expect(asNumber(r.carryover)).toBe(0);
    expect(asNumber(r.purchase)).toBe(152000);
    expect(asNumber(r.tax)).toBe(15200);
    expect(asNumber(r.billed)).toBe(167200);
    expectMoney(asNumber(r.carryover) + asNumber(r.purchase) + asNumber(r.tax), asNumber(r.billed));
    expect(asNumber(r.prev_amount)).toBe(asNumber(r.payment)); // 「前回請求は全額入金済み」

    expect(note).toContain("繰越 0");
    expect(note).toContain("今回買上 152,000");
    expect(note).toContain("消費税 15,200");
    expect(note).toContain("今回請求額 167,200");
    expect(note).toContain("前回請求 214,500");
  });

  it("hacchusho — 明細の読み上げ文が firstRecordLines と一致する", () => {
    const s = getScenario("hacchusho");
    const [flyer, posting] = s.spec.firstRecordLines;
    const note = s.validationNote ?? "";
    expect(s.validationNote).toBeDefined();

    expect(flyer.qty).toBe(50000);
    expectMoney(flyer.unit_price as number, 4.2);
    expectMoney(flyer.amount as number, 210000);
    expect(posting.qty).toBe(50000);
    expectMoney(posting.unit_price as number, 1.8);
    expectMoney(posting.amount as number, 90000);

    const subtotal = (flyer.amount as number) + (posting.amount as number);
    expectMoney(subtotal, 300000);
    expectMoney(subtotal * 1.1, asNumber(s.spec.firstRecord.total));
    expectMoney(asNumber(s.spec.firstRecord.total), 330000);

    expect(note).toContain("50,000枚×@4.20 = 210,000");
    expect(note).toContain("50,000部×@1.80 = 90,000");
    expect(note).toContain("小計 300,000 + 消費税 30,000 = 総合計 ¥330,000");
  });
});

/* ============================================================
 * 15. コマンドチップ(クロスモジュール: specdiff.ts)
 * ============================================================ */

/** 各シナリオのチップ枚数 */
const CHIP_COUNTS: Record<string, number> = {
  seikyu: 4,
  chumonsho: 4,
  nippo: 3,
  tenken: 4,
  hacchusho: 4,
};

/**
 * setNumberLimit チップが実データで「発火する」件数。
 * 0件になるとデモで上限アラートの絵が出ない(= チップを押しても何も起きない)。
 * 明細列(unit_price)への上限はレコードでは判定できないためここには現れない。
 */
const LIMIT_FIRINGS: Record<string, Record<string, number>> = {
  seikyu: { billed: 1 }, // 167,200 のみが上限 100,000 を超過(5件中)
  chumonsho: { total: 2 }, // 85,800 / 148,000 が上限 80,000 を超過(7件中)
  nippo: {},
  tenken: { pressure: 3, temperature: 3 }, // 6件中3件ずつ
  hacchusho: { total: 3 }, // 330,000 / 880,000 / 440,000 が上限 300,000 を超過(6件中)
};

describe("コマンドチップ(日本語で書いて直す)", () => {
  it("期待値テーブルは全シナリオを覆う", () => {
    expectTableCoversAllScenarios(CHIP_COUNTS);
    expectTableCoversAllScenarios(LIMIT_FIRINGS);
  });

  it("未知シナリオIDではチップが空になる", () => {
    expect(chipsForScenario("no-such-scenario")).toEqual([]);
  });

  it.each(SCENARIOS)("$id — チップ枚数が凍結値と一致する", (s) => {
    expect(chipsForScenario(s.id)).toHaveLength(CHIP_COUNTS[s.id]);
  });

  it.each(SCENARIOS)("$id — 全チップの全 op が spec 上で解決する", (s) => {
    // applyDiff は失敗しても throw せず ok:false と元の spec を返すだけ。
    // scenarios.ts 側で fieldId をリネームすると、デモ中にチップを押しても
    // 何も起きないという最悪の壊れ方をする。ここがクロスモジュールの最重要ガード。
    for (const chip of chipsForScenario(s.id)) {
      const { results } = applyDiffs(s.spec, chip.ops);
      const failures = results.filter((r) => !r.ok).map((r) => `${r.summary}: ${r.reason}`);
      expect(failures, `${s.id} / ${chip.id}`).toEqual([]);
    }
  });

  it.each(SCENARIOS)("$id — 上限チップが実データで発火する", (s) => {
    const records = allRecords(s);
    const fired: Record<string, number> = {};
    for (const chip of chipsForScenario(s.id)) {
      for (const op of chip.ops) {
        if (op.op !== "setNumberLimit") continue;
        // 明細列への上限はレコード単位では評価できないので対象外
        if (!s.spec.fields.some((f) => f.id === op.fieldId)) continue;
        fired[op.fieldId] = records.filter(
          (r) => checkLimit({ min: op.min, max: op.max }, r[op.fieldId]) !== null,
        ).length;
      }
    }
    expect(fired).toEqual(LIMIT_FIRINGS[s.id]);
    for (const [fieldId, count] of Object.entries(fired)) {
      expect(count, `${fieldId} が1件も発火しない`).toBeGreaterThan(0);
    }
  });
});

/* ============================================================
 * 16. 逆質問に「いいえ」と答えた後も spec が整合する
 * ============================================================ */

describe("逆質問を「いいえ」で除去した後の整合性", () => {
  it.each(SCENARIOS)("$id — 除去後も listColumns / aggregations が解決する", (s) => {
    if (!s.question) return;
    // KamiwazaApp は answer===1 のとき fields と listColumns から対象を取り除く。
    const removed = s.question.fieldId;
    const remaining = s.spec.fields.filter((f) => f.id !== removed).map((f) => f.id);
    expect(remaining).not.toContain(removed);

    for (const c of s.spec.listColumns.filter((c) => c !== removed)) {
      expect(remaining, c).toContain(c);
    }
    for (const a of s.spec.aggregations) {
      expect(remaining, `${a.id} → ${a.fieldId}`).toContain(a.fieldId);
    }
  });

  it("seikyu — status は一覧列なので除去すると4列→3列になる(それでも破綻しない)", () => {
    const s = getScenario("seikyu");
    expect(s.spec.listColumns).toContain("status");
    expect(s.spec.listColumns.filter((c) => c !== "status")).toHaveLength(3);
  });
});

/* ============================================================
 * 17. グラフの軸選択(fields の宣言順が仕様の一部)
 * ============================================================ */

const CHART_AXES: Record<
  string,
  { dimFieldId: string | null; useDim: boolean; numAggId: string }
> = {
  // status は select かつ一覧列だが、同値レコードが2件しかないので全件表示にフォールバック
  seikyu: { dimFieldId: "status", useDim: false, numAggId: "billed_sum" },
  chumonsho: { dimFieldId: null, useDim: false, numAggId: "total_sum" },
  // weather は select だが listColumns 外なので軸にならない
  nippo: { dimFieldId: null, useDim: false, numAggId: "break_avg" },
  // equipment と gauge_status の両方が条件を満たすが、宣言順で equipment が先に来る。
  // 3号機が4件あるので「コンプレッサー 3号機 — 吐出圧力の推移」に絞り込まれる。
  tenken: { dimFieldId: "equipment", useDim: true, numAggId: "pressure_avg" },
  hacchusho: { dimFieldId: null, useDim: false, numAggId: "po_sum" },
};

describe("グラフの軸選択", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(CHART_AXES));

  it.each(SCENARIOS)("$id — 軸に選ばれる select フィールドが凍結値と一致する", (s) => {
    // SpecApp.Chart は fields.find(select かつ listColumns に含まれる) で軸を決める。
    // fields を並べ替えると無言でグラフが変わる。
    const dim = s.spec.fields.find(
      (f) => f.type === "select" && s.spec.listColumns.includes(f.id),
    );
    expect(dim?.id ?? null).toBe(CHART_AXES[s.id].dimFieldId);
  });

  it.each(SCENARIOS)("$id — 絞り込みが起きるかどうかが凍結値と一致する", (s) => {
    const dim = s.spec.fields.find(
      (f) => f.type === "select" && s.spec.listColumns.includes(f.id),
    );
    const records = allRecords(s);
    const same = dim ? records.filter((r) => r[dim.id] === records[0][dim.id]) : records;
    // 同一エンティティの推移として意味を持つ件数(3件以上)が残るときだけ絞り込む
    expect(Boolean(dim) && same.length >= 3).toBe(CHART_AXES[s.id].useDim);
  });

  it.each(SCENARIOS)("$id — 縦軸に使う集計が凍結値と一致する", (s) => {
    const numAgg = s.spec.aggregations.find((a) => {
      const f = s.spec.fields.find((x) => x.id === a.fieldId);
      return f?.type === "number" && (a.op === "sum" || a.op === "avg");
    });
    expect(numAgg?.id).toBe(CHART_AXES[s.id].numAggId);
  });
});

/* ============================================================
 * 18. icon は書記素1文字
 * ============================================================ */

describe("spec.icon", () => {
  it.each(SCENARIOS)("$id — 絵文字1文字(書記素単位で数える)", (s) => {
    // 🏗️ / 🗂️ は VS16 付きでコードポイント2個・UTF-16長3。
    // [...icon].length === 1 や icon.length <= 2 で書くと誤って落ちる。
    const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
    expect([...segmenter.segment(s.spec.icon)], s.spec.icon).toHaveLength(1);
  });

  it("icon の顔ぶれが凍結値と一致する", () => {
    expect(SCENARIOS.map((s) => s.spec.icon)).toEqual(["🧾", "📋", "🏗️", "🔧", "🗂️"]);
  });
});

/* ============================================================
 * 19. stamp 型フィールドと押印要素
 * ============================================================ */

const STAMP_FIELDS: Record<string, string[]> = {
  // seikyu に stamp 型フィールドはない(status は select で、
  // 紙側は赤ゴム印「入 力 済」+ 手書き日付「7/3」の2要素にまたがる)
  seikyu: [],
  chumonsho: ["approval_stamp"],
  nippo: ["supervisor_stamp"],
  tenken: ["approver_stamp"],
  hacchusho: ["company_seal"],
};

describe("stamp 型フィールド", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(STAMP_FIELDS));

  it.each(SCENARIOS)("$id — stamp 型フィールドの顔ぶれが凍結値と一致する", (s) => {
    expect(s.spec.fields.filter((f) => f.type === "stamp").map((f) => f.id)).toEqual(
      STAMP_FIELDS[s.id],
    );
  });

  it.each(SCENARIOS)("$id — stamp 型フィールドには押印の絵が対応する", (s) => {
    // 装飾のみの stamp(seikyu の角印「北関東」・検印「山口」)は fieldId を持たないので対象外。
    for (const f of s.spec.fields.filter((x) => x.type === "stamp")) {
      const hit = s.paper.some((el) => el.fieldId === f.id && el.kind === "stamp");
      expect(hit, `${f.id} に対応する stamp 要素がない`).toBe(true);
    }
  });

  it("seikyu — status は紙の2要素(赤ゴム印+手書き日付)にまたがる", () => {
    const s = getScenario("seikyu");
    const els = s.paper.filter((el) => el.fieldId === "status");
    expect(els.map((el) => el.kind)).toEqual(["stamp", "hand"]);
  });
});

/* ============================================================
 * 20. デモイベント列(クロスモジュール: demo.ts)
 * ============================================================ */

const DEMO_SEQUENCE: Record<string, { events: number; totalDelayMs: number }> = {
  seikyu: { events: 25, totalDelayMs: 11710 },
  chumonsho: { events: 19, totalDelayMs: 9260 },
  nippo: { events: 21, totalDelayMs: 9900 },
  tenken: { events: 21, totalDelayMs: 9730 },
  hacchusho: { events: 24, totalDelayMs: 11330 },
};

describe("デモイベント列", () => {
  it("期待値テーブルは全シナリオを覆う", () => expectTableCoversAllScenarios(DEMO_SEQUENCE));

  it.each(SCENARIOS)("$id — イベント数と総尺が凍結値と一致する", (s) => {
    const seq = buildDemoSequence(s);
    expect(seq).toHaveLength(DEMO_SEQUENCE[s.id].events);
    const total = seq.reduce((a, e) => a + e.delay, 0);
    expect(total).toBe(DEMO_SEQUENCE[s.id].totalDelayMs);
    // ピッチの尺。1シナリオ15秒を超えると本番で間が持たない。
    expect(total).toBeLessThanOrEqual(15000);
  });

  it.each(SCENARIOS)("$id — field イベントが全フィールド分流れる", (s) => {
    const seq = buildDemoSequence(s);
    expect(seq.filter((e) => e.event.type === "field")).toHaveLength(s.spec.fields.length);
  });

  it.each(SCENARIOS)("$id — lineitems / question イベントの有無が spec と一致する", (s) => {
    const seq = buildDemoSequence(s);
    const has = (t: string) => seq.some((e) => e.event.type === t);
    expect(has("lineitems")).toBe(s.spec.lineItems !== null);
    expect(has("question")).toBe(s.question !== null);
  });

  it.each(SCENARIOS)("$id — 最後は必ず done イベント", (s) => {
    const seq = buildDemoSequence(s);
    const last = seq[seq.length - 1].event;
    expect(last.type).toBe("done");
    if (last.type !== "done") return;
    expect(last.mode).toBe("demo");
    expect(last.scenarioId).toBe(s.id);
    expect(last.spec).toBe(s.spec);
  });
});
