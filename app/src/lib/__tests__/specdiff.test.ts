// specdiff の単体テスト。
//
// このモジュールが守るべき契約は「LLMにアプリを壊させない」こと。
// したがってテストの重心は (1) ガードが確実に効くこと (2) applyDiff が純粋であること
// (3) ツール定義の enum と reducer の受理集合が一致していること の3点に置く。
//
// 期待値は原則「仕様としてこうあるべき」を書く。文言や丸め値など実装が唯一の真実に
// なるものはコメントで根拠を添えて固定する(回帰検知が目的)。

import { describe, it, expect } from "vitest";
import type { AppSpec, AppRecord, FieldSpec } from "../appspec";
import {
  applyDiff,
  applyDiffs,
  checkLimit,
  roiSummary,
  buildReconfigureTools,
  toolCallToDiff,
  keywordFallback,
  chipsForScenario,
  genericChips,
  type SpecDiff,
  type DiffResult,
  type CommandChip,
} from "../specdiff";
import { SCENARIOS, getScenario } from "../scenarios";

/* ============================================================
 * フィクスチャ
 * ============================================================ */

/**
 * テスト用の最小完全 AppSpec。
 * - fields: number / textarea / text を1つずつ(型ガードの分岐を全部踏める最小構成)
 * - lineItems: number 列と text 列(2段探索の分岐用)
 * - listColumns は1本だけ埋まっている(6列上限まで余裕がある)
 */
function makeSpec(): AppSpec {
  return {
    appName: "テスト帳票",
    icon: "📄",
    description: "specdiff のテスト用スペック",
    fields: [
      { id: "total", label: "合計金額", type: "number", required: true, unit: "円", confidence: 0.9 },
      { id: "note", label: "備考", type: "textarea", required: false, confidence: 0.9 },
      { id: "cust", label: "顧客", type: "text", required: true, confidence: 0.9 },
    ],
    lineItems: {
      label: "明細",
      columns: [
        { id: "unit_price", label: "単価", type: "number", unit: "円" },
        { id: "item", label: "品名", type: "text" },
      ],
    },
    listColumns: ["total"],
    approvalFlow: [{ name: "課長承認", role: "課長" }],
    aggregations: [],
    firstRecord: { total: 1234, note: "", cust: "A社" },
    firstRecordLines: [],
  };
}

/** fields/lineItems が空の骨だけスペック(ツール定義の条件分岐用) */
function emptySpec(): AppSpec {
  return {
    ...makeSpec(),
    fields: [],
    lineItems: null,
    listColumns: [],
    aggregations: [],
    approvalFlow: null,
    firstRecord: {},
  };
}

const numField = (id: string, over: Partial<FieldSpec> = {}): FieldSpec => ({
  id,
  label: id,
  type: "number",
  required: false,
  confidence: 1,
  ...over,
});

/** n段の承認フローを持つスペック */
const withFlow = (n: number): AppSpec => ({
  ...makeSpec(),
  approvalFlow: Array.from({ length: n }, (_, i) => ({ name: `承認${i + 1}`, role: `役職${i + 1}` })),
});

/** n個のfieldを持つスペック(listColumns は空にして列上限と干渉させない) */
const withFields = (n: number): AppSpec => ({
  ...makeSpec(),
  fields: Array.from({ length: n }, (_, i) => numField(`f${i}`)),
  listColumns: [],
});

/** 数値候補が amount ひとつだけのスペック(keywordFallback の単一候補フォールバック用) */
const singleNumSpec = (): AppSpec => ({
  ...makeSpec(),
  fields: [numField("amount", { label: "金額A" })],
  lineItems: null,
  listColumns: [],
});

const findField = (spec: AppSpec, id: string) => spec.fields.find((f) => f.id === id);
const findCol = (spec: AppSpec, id: string) => spec.lineItems?.columns.find((c) => c.id === id);

/** ToolDef は非export のため構造的に扱う */
type ToolLike = { name: string; description: string; input_schema: Record<string, unknown> };
const propEnum = (tool: ToolLike, prop: string): unknown =>
  (tool.input_schema as { properties: Record<string, { enum?: unknown }> }).properties[prop]?.enum;
const toolNamed = (tools: ToolLike[], name: string): ToolLike => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

/* ============================================================
 * applyDiff — 各opの正常系
 * ============================================================ */

describe("applyDiff / addApprovalStep", () => {
  it("既存フローの末尾に1段追加する", () => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "addApprovalStep", name: "社長承認", role: "社長" });

    expect(r.ok).toBe(true);
    expect(r.spec.approvalFlow).toEqual([
      { name: "課長承認", role: "課長" },
      { name: "社長承認", role: "社長" }, // 末尾に積まれる(承認は順序が意味を持つ)
    ]);
    expect(r.summary).toBe("addApprovalStep{社長承認 / 社長}");
  });

  it("approvalFlow が null のスペックでも空配列として扱い、新規にフローを作る", () => {
    const spec: AppSpec = { ...makeSpec(), approvalFlow: null };
    const r = applyDiff(spec, { op: "addApprovalStep", name: "A", role: "B" });

    expect(r.ok).toBe(true);
    expect(r.spec.approvalFlow).toEqual([{ name: "A", role: "B" }]);
  });
});

describe("applyDiff / setNumberLimit", () => {
  it("fields の number項目に max を書き込む", () => {
    const r = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 });

    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")).toMatchObject({ max: 100 });
    expect(findField(r.spec, "total")?.min).toBeUndefined();
  });

  it("片側だけ指定したとき、既存の反対側リミットは保持される", () => {
    const withMax = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec;
    const r = applyDiff(withMax, { op: "setNumberLimit", fieldId: "total", min: 50 });

    expect(r.ok).toBe(true);
    // min だけ渡しても max:100 が消えない = 「上限だけ後から足す」会話が成立する
    expect(findField(r.spec, "total")).toMatchObject({ min: 50, max: 100 });
  });

  it("fields に無ければ lineItems.columns を探索して書き込む", () => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "setNumberLimit", fieldId: "unit_price", max: 200 });

    expect(r.ok).toBe(true);
    expect(findCol(r.spec, "unit_price")).toMatchObject({ max: 200 });
    // 明細列パスでは fields 配列を作り直さない(構造共有)
    expect(r.spec.fields).toBe(spec.fields);
  });

  it("min === max は有効な指定として受け入れる(1点に固定する運用がありうる)", () => {
    const r = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", min: 10, max: 10 });
    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")).toMatchObject({ min: 10, max: 10 });
  });

  it("0 と負値は正当なリミットとして受け入れる", () => {
    const zero = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 0 });
    expect(zero.ok).toBe(true);
    expect(findField(zero.spec, "total")?.max).toBe(0);

    const neg = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", min: -100 });
    expect(neg.ok).toBe(true);
    expect(findField(neg.spec, "total")?.min).toBe(-100);
  });

  /* --- 同値の再適用 = 変化なし = 失敗(チップのグレーアウトはこの上に乗っている) --- */

  it("同じリミットの再設定は拒否され、元の spec が同一参照で返る(fields経路)", () => {
    const once = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100000 }).spec;
    const r = applyDiff(once, { op: "setNumberLimit", fieldId: "total", max: 100000 });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("「合計金額」には既に同じリミットが設定されています");
    // 「既に〜」は重複拒否4種と同じ体裁。読み手が1秒で意味を取れる文言に揃えてある
    expect(Object.is(r.spec, once)).toBe(true);
    expect(findField(r.spec, "total")?.max).toBe(100000); // 既存値は壊れない
  });

  it("同じリミットの再設定は拒否される(明細列経路・プレフィックス付き)", () => {
    const once = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "unit_price", max: 200 }).spec;
    const r = applyDiff(once, { op: "setNumberLimit", fieldId: "unit_price", max: 200 });

    expect(r.ok).toBe(false);
    // 明細列であることが分かる文言(fields 側と同じ文だと、どこを見ればいいか分からない)
    expect(r.reason).toBe("明細列「単価」には既に同じリミットが設定されています");
    expect(Object.is(r.spec, once)).toBe(true);
  });

  it("片側が同値でも、もう片側が新規なら成功する", () => {
    // 「上限はそのまま、下限だけ足して」が拒否されると会話が詰まる
    const once = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec;
    const r = applyDiff(once, { op: "setNumberLimit", fieldId: "total", min: 10, max: 100 });

    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")).toMatchObject({ min: 10, max: 100 });
  });

  it("片側だけ渡してもマージ後が既存と同じなら拒否する", () => {
    // 判定はマージ後の (min,max) で行う。diff に載っていない側を「変化」と数えない。
    const both = applyDiff(
      applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec,
      { op: "setNumberLimit", fieldId: "total", min: 10 },
    ).spec;
    const r = applyDiff(both, { op: "setNumberLimit", fieldId: "total", max: 100 });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("「合計金額」には既に同じリミットが設定されています");
  });

  it("値が動くなら上書きは成功する(冪等性の誤適用を防ぐ)", () => {
    // 「やっぱり20万にして」を「既に設定済み」で断ってはいけない
    const once = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec;
    const r = applyDiff(once, { op: "setNumberLimit", fieldId: "total", max: 200 });

    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")?.max).toBe(200);
  });

  it("判定順は 型不一致 → min>max矛盾 → 同値 の順(文言の固定)", () => {
    const withMax = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec;
    // 同値判定より先に矛盾判定が来る。両方に当たる入力は存在しないが、順序が入れ替わると
    // 「min > max」の文言が「既に同じリミット」に化けるケースが出る
    expect(applyDiff(withMax, { op: "setNumberLimit", fieldId: "total", min: 200 }).reason).toBe(
      "既存のリミットと矛盾します(min > max)",
    );
    expect(applyDiff(withMax, { op: "setNumberLimit", fieldId: "note", max: 1 }).reason).toBe(
      "「備考」は数値項目ではありません",
    );
  });
});

describe("applyDiff / addField", () => {
  it("id は trim され、confidence:1(人の指示由来)が必ず付く", () => {
    const r = applyDiff(makeSpec(), {
      op: "addField",
      id: "  overtime_hours  ",
      label: "残業時間",
      fieldType: "number",
      unit: "時間",
    });

    expect(r.ok).toBe(true);
    expect(r.spec.fields.at(-1)).toEqual({
      id: "overtime_hours", // 前後空白は除去される
      label: "残業時間",
      type: "number",
      required: false, // 未指定なら任意項目
      options: undefined, // select 以外では持たない
      unit: "時間",
      confidence: 1, // AI推定ではなく人が明示した項目なので逆質問の対象外
    });
  });

  it("required: true は必須項目としてそのまま保存される", () => {
    // 「必須の項目を追加して」という指示が黙って任意項目になると、
    // 入力漏れを止めるという追加の動機ごと失われる。
    const r = applyDiff(makeSpec(), {
      op: "addField",
      id: "approver",
      label: "承認者",
      fieldType: "text",
      required: true,
    });

    expect(r.ok).toBe(true);
    expect(r.spec.fields.at(-1)?.required).toBe(true);
  });

  it("summary は実際に保存される id(trim 後)を出す", () => {
    // 手術ログは「何が起きたか」の唯一の証跡なので、表記と保存された項目IDは一致させる。
    // trim して保存するのは addField.id だけなので、summarize で trim するのもここだけ
    // (label や fieldId を trim すると、今度はログと reason の文言がずれる)。
    const r = applyDiff(makeSpec(), { op: "addField", id: "  x  ", label: "L", fieldType: "text" });
    expect(r.spec.fields.at(-1)?.id).toBe("x");
    expect(r.summary).toBe("addField{x: L (text)}");
  });

  it("select は options 未指定でも空配列になる(undefined にはならない)", () => {
    const r = applyDiff(makeSpec(), { op: "addField", id: "kind", label: "種別", fieldType: "select" });
    expect(r.spec.fields.at(-1)?.options).toEqual([]);
  });

  it("select の options はそのまま保持される", () => {
    const r = applyDiff(makeSpec(), {
      op: "addField",
      id: "kind",
      label: "種別",
      fieldType: "select",
      options: ["a", "b"],
    });
    expect(r.spec.fields.at(-1)?.options).toEqual(["a", "b"]);
  });

  it("【既知の非対称】label は trim されない — バリデーションは trim 後、保存は生の値", () => {
    const r = applyDiff(makeSpec(), { op: "addField", id: "x", label: "  L  ", fieldType: "text" });
    expect(r.ok).toBe(true);
    // id と揃えるなら "L" が望ましいが、現状は生値が保存される
    // (specdiff.ts は id を trim して検証・保存する一方、label は trim 後に検証して生値を保存する)
    expect(r.spec.fields.at(-1)?.label).toBe("  L  ");
  });
});

describe("applyDiff / addAggregation", () => {
  it("id は agg と fieldId から決定論的に決まり、unit は field から継承する", () => {
    const r = applyDiff(makeSpec(), {
      op: "addAggregation",
      label: "平均発注額",
      fieldId: "total",
      agg: "avg",
    });

    expect(r.ok).toBe(true);
    expect(r.spec.aggregations.at(-1)).toEqual({
      id: "agg_avg_total", // 決定論的ID = 同じ集計の二重追加を id 衝突で弾ける
      label: "平均発注額",
      fieldId: "total",
      op: "avg",
      unit: "円", // total.unit を継承
    });
    expect(r.summary).toBe("addAggregation{平均発注額: avg(total)}");
  });

  it("明示 unit は field.unit より優先される", () => {
    const r = applyDiff(makeSpec(), {
      op: "addAggregation",
      label: "件数",
      fieldId: "total",
      agg: "count",
      unit: "件",
    });
    // count は「円」ではなく「件」で数えたい、というのが明示指定の動機
    expect(r.spec.aggregations.at(-1)?.unit).toBe("件");
  });

  it("同じ field でも agg が違えば別カードとして追加できる", () => {
    const s1 = applyDiff(makeSpec(), { op: "addAggregation", label: "合計", fieldId: "total", agg: "sum" });
    const s2 = applyDiff(s1.spec, { op: "addAggregation", label: "平均", fieldId: "total", agg: "avg" });

    expect(s2.ok).toBe(true);
    expect(s2.spec.aggregations.map((a) => a.id)).toEqual(["agg_sum_total", "agg_avg_total"]);
  });

  it("count は型を問わない — 数値でない項目でも件数集計はできる", () => {
    const r = applyDiff(makeSpec(), { op: "addAggregation", label: "件数", fieldId: "note", agg: "count" });
    expect(r.ok).toBe(true);
    expect(r.spec.aggregations.at(-1)?.id).toBe("agg_count_note");
  });
});

describe("applyDiff / renameField", () => {
  it("fields の label だけを差し替え、他の属性は保持する", () => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "renameField", fieldId: "total", label: "注文合計" });

    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")).toEqual({ ...spec.fields[0], label: "注文合計" });
    expect(r.summary).toBe("renameField{total → 注文合計}");
  });

  it("lineItems の列名も変更できる", () => {
    const r = applyDiff(makeSpec(), { op: "renameField", fieldId: "unit_price", label: "新単価" });

    expect(r.ok).toBe(true);
    expect(findCol(r.spec, "unit_price")).toEqual({
      id: "unit_price",
      label: "新単価",
      type: "number",
      unit: "円",
    });
  });

  it("同じラベルへの rename も成功扱いにする(no-op を失敗として報告しない)", () => {
    const r = applyDiff(makeSpec(), { op: "renameField", fieldId: "total", label: "合計金額" });
    expect(r.ok).toBe(true);
  });
});

describe("applyDiff / addFilterColumn", () => {
  it("未表示の項目を一覧の末尾に足す(fields は変更しない)", () => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "addFilterColumn", fieldId: "note" });

    expect(r.ok).toBe(true);
    expect(r.spec.listColumns).toEqual(["total", "note"]);
    expect(r.spec.fields).toBe(spec.fields);
    expect(r.summary).toBe("addFilterColumn{note}");
  });
});

/* ============================================================
 * ガード(上限)— 「壊せない」ことの本体
 * ============================================================ */

describe("上限ガード", () => {
  it.each([
    { n: 4, ok: true },
    { n: 5, ok: false },
  ])("承認ステップ: $n 段のとき追加は ok=$ok", ({ n, ok }) => {
    const spec = withFlow(n);
    const r = applyDiff(spec, { op: "addApprovalStep", name: "追加分", role: "誰か" });

    expect(r.ok).toBe(ok);
    if (!ok) {
      expect(r.reason).toBe("承認ステップは5段までです");
      expect(r.spec).toBe(spec); // 拒否時は元のスペックがそのまま返る
      expect(spec.approvalFlow).toHaveLength(5);
    }
  });

  it.each([
    { n: 19, ok: true },
    { n: 20, ok: false },
  ])("項目: $n 個のとき addField は ok=$ok", ({ n, ok }) => {
    const spec = withFields(n);
    const r = applyDiff(spec, { op: "addField", id: "extra", label: "追加", fieldType: "text" });

    expect(r.ok).toBe(ok);
    if (!ok) {
      expect(r.reason).toBe("項目は20個までです");
      expect(r.spec).toBe(spec);
    }
  });

  it("項目20個の上限に lineItems の列は加算されない(フォーム項目だけを数える)", () => {
    const spec: AppSpec = {
      ...withFields(19),
      lineItems: {
        label: "明細",
        columns: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `c${i}`, type: "text" as const })),
      },
    };
    // fields=19 + columns=6 = 25 だが、fields が20未満なので通る
    expect(applyDiff(spec, { op: "addField", id: "extra", label: "追加", fieldType: "text" }).ok).toBe(true);
  });

  it.each([
    { n: 5, ok: true },
    { n: 6, ok: false },
  ])("集計カード: $n 枚のとき追加は ok=$ok", ({ n, ok }) => {
    const spec: AppSpec = {
      ...makeSpec(),
      aggregations: Array.from({ length: n }, (_, i) => ({
        id: `a${i}`,
        label: `a${i}`,
        fieldId: "total",
        op: "sum" as const,
      })),
    };
    const r = applyDiff(spec, { op: "addAggregation", label: "新規", fieldId: "total", agg: "avg" });

    expect(r.ok).toBe(ok);
    if (!ok) {
      expect(r.reason).toBe("集計カードは6枚までです");
      expect(r.spec).toBe(spec);
    }
  });

  it("集計カードが満杯のとき、重複する集計でも reason は枚数上限になる(判定順の固定)", () => {
    const spec: AppSpec = {
      ...makeSpec(),
      aggregations: Array.from({ length: 6 }, (_, i) => ({
        id: i === 0 ? "agg_avg_total" : `a${i}`,
        label: `a${i}`,
        fieldId: "total",
        op: "avg" as const,
      })),
    };
    // 実装は 枚数(6) → id重複 の順に見る。どちらでも拒否されるが文言は枚数側。
    expect(applyDiff(spec, { op: "addAggregation", label: "X", fieldId: "total", agg: "avg" }).reason).toBe(
      "集計カードは6枚までです",
    );
  });

  it.each([
    { n: 5, ok: true },
    { n: 6, ok: false },
  ])("一覧の列: $n 本のとき追加は ok=$ok", ({ n, ok }) => {
    const fields = Array.from({ length: 8 }, (_, i) => numField(`f${i}`));
    const spec: AppSpec = { ...makeSpec(), fields, listColumns: fields.slice(0, n).map((f) => f.id) };
    const r = applyDiff(spec, { op: "addFilterColumn", fieldId: "f7" });

    expect(r.ok).toBe(ok);
    if (!ok) {
      expect(r.reason).toBe("一覧の列は6つまでです");
      expect(r.spec).toBe(spec);
    }
  });

  it("一覧が満杯のとき、既に表示中の項目なら reason は重複側になる(判定順の固定)", () => {
    const fields = Array.from({ length: 8 }, (_, i) => numField(`f${i}`, { label: `列${i}` }));
    const spec: AppSpec = { ...makeSpec(), fields, listColumns: fields.slice(0, 6).map((f) => f.id) };
    // 実装は 重複 → 枚数(6) の順に見るため、addAggregation とは逆になる
    expect(applyDiff(spec, { op: "addFilterColumn", fieldId: "f0" }).reason).toBe(
      "「列0」は既に一覧に表示されています",
    );
  });
});

/* ============================================================
 * 不正入力
 * ============================================================ */

describe("不正入力 / 存在しない項目", () => {
  const ghostOps: SpecDiff[] = [
    { op: "setNumberLimit", fieldId: "ghost", max: 1 },
    { op: "renameField", fieldId: "ghost", label: "X" },
    { op: "addAggregation", label: "L", fieldId: "ghost", agg: "count" },
    { op: "addFilterColumn", fieldId: "ghost" },
  ];

  it.each(ghostOps)("$op は存在しない fieldId を拒否し、元のスペックを返す", (op) => {
    const spec = makeSpec();
    const r = applyDiff(spec, op);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("項目「ghost」が見つかりません");
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it("addAggregation / addFilterColumn は明細列を扱えない(fields しか見ない)", () => {
    const spec = makeSpec(); // unit_price は lineItems 側にのみ存在する
    expect(applyDiff(spec, { op: "addAggregation", label: "L", fieldId: "unit_price", agg: "sum" }).reason).toBe(
      "項目「unit_price」が見つかりません",
    );
    expect(applyDiff(spec, { op: "addFilterColumn", fieldId: "unit_price" }).reason).toBe(
      "項目「unit_price」が見つかりません",
    );
  });

  it("lineItems が null のスペックに明細列 id を渡しても安全に失敗する", () => {
    const spec: AppSpec = { ...makeSpec(), lineItems: null };
    const r = applyDiff(spec, { op: "setNumberLimit", fieldId: "unit_price", max: 1 });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("項目「unit_price」が見つかりません");
  });
});

describe("不正入力 / setNumberLimit の数値検証", () => {
  it.each([
    { diff: { max: "100" as unknown as number }, reason: "maxが数値ではありません" },
    { diff: { max: NaN }, reason: "maxが数値ではありません" },
    { diff: { max: Infinity }, reason: "maxが数値ではありません" },
    { diff: { min: NaN }, reason: "minが数値ではありません" },
    { diff: {}, reason: "min/maxのどちらかが必要です" },
    { diff: { min: 10, max: 5 }, reason: "minがmaxを上回っています" },
  ])("$reason", ({ diff, reason }) => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "setNumberLimit", fieldId: "total", ...diff });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it("片側指定でも、既存リミットとマージすると矛盾する場合は拒否する(fields)", () => {
    const withMax = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 100 }).spec;
    const r = applyDiff(withMax, { op: "setNumberLimit", fieldId: "total", min: 200 });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("既存のリミットと矛盾します(min > max)");
    expect(Object.is(r.spec, withMax)).toBe(true);
    expect(findField(withMax, "total")?.max).toBe(100); // 既存値は壊れない
  });

  it("片側指定でも、既存リミットとマージすると矛盾する場合は拒否する(明細列)", () => {
    const withMax = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "unit_price", max: 100 }).spec;
    const r = applyDiff(withMax, { op: "setNumberLimit", fieldId: "unit_price", min: 200 });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("既存のリミットと矛盾します(min > max)");
  });
});

describe("不正入力 / 型不一致", () => {
  it("数値でない項目に上限は設定できない", () => {
    expect(applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "note", max: 1 }).reason).toBe(
      "「備考」は数値項目ではありません",
    );
  });

  it("数値でない明細列に上限は設定できない(文言が明細列であることを示す)", () => {
    expect(applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "item", max: 1 }).reason).toBe(
      "明細列「品名」は数値列ではありません",
    );
  });

  it.each(["sum", "avg"] as const)("%s 集計は数値項目にしか付けられない", (agg) => {
    expect(applyDiff(makeSpec(), { op: "addAggregation", label: "L", fieldId: "note", agg }).reason).toBe(
      `「備考」は数値項目ではないため${agg}できません`,
    );
  });
});

describe("不正入力 / 空文字・空白のみ", () => {
  const blanks: { diff: SpecDiff; reason: string }[] = [
    { diff: { op: "addApprovalStep", name: "", role: "r" }, reason: "名前とロールが必要です" },
    { diff: { op: "addApprovalStep", name: "n", role: "   " }, reason: "名前とロールが必要です" },
    { diff: { op: "addField", id: "x", label: "  ", fieldType: "text" }, reason: "idとラベルが必要です" },
    { diff: { op: "addField", id: "  ", label: "L", fieldType: "text" }, reason: "idとラベルが必要です" },
    { diff: { op: "addAggregation", label: " ", fieldId: "total", agg: "sum" }, reason: "ラベルが必要です" },
    { diff: { op: "renameField", fieldId: "total", label: "" }, reason: "新しいラベルが必要です" },
  ];

  it.each(blanks)("$reason ($diff.op)", ({ diff, reason }) => {
    const spec = makeSpec();
    const r = applyDiff(spec, diff);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
    expect(Object.is(r.spec, spec)).toBe(true);
  });
});

/* ============================================================
 * 重複拒否と冪等性
 * ============================================================ */

describe("重複拒否", () => {
  it.each([
    { diff: { op: "addApprovalStep", name: "課長承認", role: "課長" } as SpecDiff, reason: "「課長承認」は既に承認フローにあります" },
    { diff: { op: "addField", id: "total", label: "別名", fieldType: "number" } as SpecDiff, reason: "項目「total」は既に存在します" },
    { diff: { op: "addFilterColumn", fieldId: "total" } as SpecDiff, reason: "「合計金額」は既に一覧に表示されています" },
  ])("$reason", ({ diff, reason }) => {
    expect(applyDiff(makeSpec(), diff).reason).toBe(reason);
  });

  it("同じ集計は id 衝突で拒否される", () => {
    const s1 = applyDiff(makeSpec(), { op: "addAggregation", label: "合計", fieldId: "total", agg: "sum" }).spec;
    const r = applyDiff(s1, { op: "addAggregation", label: "別ラベル", fieldId: "total", agg: "sum" });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("同じ集計が既にあります"); // ラベルが違っても同一集計とみなす
  });

  it("再適用の可否: renameField 以外は2回目が失敗する", () => {
    // 「変化を生まない再適用は ok:false」が6opのうち5opの法則。
    // UIのグレーアウト(disabled = !ops.some(ok))はこの法則の上に乗っている。
    const ops: SpecDiff[] = [
      { op: "addApprovalStep", name: "社長承認", role: "社長" },
      { op: "setNumberLimit", fieldId: "total", max: 1000 },
      { op: "addField", id: "memo", label: "メモ", fieldType: "text" },
      { op: "addAggregation", label: "合計", fieldId: "total", agg: "sum" },
      { op: "renameField", fieldId: "total", label: "注文合計" },
      { op: "addFilterColumn", fieldId: "note" },
    ];

    for (const op of ops) {
      const first = applyDiff(makeSpec(), op);
      expect(first.ok).toBe(true);
      const second = applyDiff(first.spec, op);
      // renameField だけは唯一の明示的な例外(同じラベルへの改名を失敗と報告しない。
      // 上の「同じラベルへの rename も成功扱いにする」がその根拠)
      const idempotentOk = op.op === "renameField";
      expect(second.ok, `op=${op.op}`).toBe(idempotentOk);
    }
  });
});

/* ============================================================
 * 純粋関数性 — reducer の生命線
 * ============================================================ */

describe("純粋関数性", () => {
  /** 成功・失敗を両方含む代表的な操作セット */
  const allOps: SpecDiff[] = [
    { op: "addApprovalStep", name: "社長承認", role: "社長" },
    { op: "addApprovalStep", name: "課長承認", role: "課長" }, // 重複 → 失敗
    { op: "setNumberLimit", fieldId: "total", max: 100 },
    { op: "setNumberLimit", fieldId: "unit_price", min: 1 },
    { op: "setNumberLimit", fieldId: "note", max: 1 }, // 型違い → 失敗
    { op: "addField", id: "memo", label: "メモ", fieldType: "text" },
    { op: "addField", id: "total", label: "重複", fieldType: "text" }, // 重複 → 失敗
    { op: "addAggregation", label: "合計", fieldId: "total", agg: "sum" },
    { op: "addAggregation", label: "L", fieldId: "ghost", agg: "sum" }, // 不明 → 失敗
    { op: "renameField", fieldId: "total", label: "注文合計" },
    { op: "renameField", fieldId: "item", label: "新品名" },
    { op: "renameField", fieldId: "ghost", label: "X" }, // 不明 → 失敗
    { op: "addFilterColumn", fieldId: "note" },
    { op: "addFilterColumn", fieldId: "total" }, // 重複 → 失敗
  ];

  it("成功・失敗いずれの操作でも入力スペックを一切変更しない", () => {
    const spec = makeSpec();
    const before = JSON.stringify(spec);

    for (const op of allOps) applyDiff(spec, op);

    expect(JSON.stringify(spec)).toBe(before);
  });

  it("凍結したスペックにも適用できる(破壊的代入を一切していない証明)", () => {
    const spec = makeSpec();
    Object.freeze(spec);
    Object.freeze(spec.fields);
    Object.freeze(spec.fields[0]);
    Object.freeze(spec.listColumns);
    Object.freeze(spec.aggregations);

    const r = applyDiff(spec, { op: "renameField", fieldId: "total", label: "凍結後の新名" });

    expect(r.ok).toBe(true);
    expect(findField(r.spec, "total")?.label).toBe("凍結後の新名");
    expect(spec.fields[0].label).toBe("合計金額"); // 元は無傷
  });

  it("失敗時は入力スペックと同一参照を返す", () => {
    const spec = makeSpec();
    expect(Object.is(applyDiff(spec, { op: "setNumberLimit", fieldId: "ghost", max: 1 }).spec, spec)).toBe(true);
  });

  it("成功時は新しい参照を返しつつ、触っていない部分は共有する(構造共有)", () => {
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "setNumberLimit", fieldId: "total", max: 100 });

    expect(r.spec).not.toBe(spec);
    expect(r.spec.fields).not.toBe(spec.fields);
    expect(r.spec.fields[1]).toBe(spec.fields[1]); // 触っていない field は使い回す
    expect(r.spec.lineItems).toBe(spec.lineItems); // 触っていない明細も使い回す
  });
});

/* ============================================================
 * applyDiffs と畳み込み
 * ============================================================ */

describe("applyDiffs", () => {
  it("失敗した op は反映されないが、後続の op は実行される", () => {
    const spec = makeSpec();
    const { spec: out, results } = applyDiffs(spec, [
      { op: "addApprovalStep", name: "社長承認", role: "社長" },
      { op: "setNumberLimit", fieldId: "ghost", max: 1 },
      { op: "addFilterColumn", fieldId: "note" },
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.approvalFlow).toHaveLength(2);
    expect(out.listColumns).toEqual(["total", "note"]);
  });

  it("results の長さは常に diffs の長さと一致する", () => {
    const diffs: SpecDiff[] = [
      { op: "addFilterColumn", fieldId: "ghost" },
      { op: "addFilterColumn", fieldId: "note" },
      { op: "addFilterColumn", fieldId: "note" },
    ];
    expect(applyDiffs(makeSpec(), diffs).results).toHaveLength(3);
  });

  it("全 op が失敗すれば結果は入力スペックと同一参照", () => {
    const spec = makeSpec();
    const { spec: out } = applyDiffs(spec, [
      { op: "setNumberLimit", fieldId: "ghost", max: 1 },
      { op: "renameField", fieldId: "ghost", label: "X" },
    ]);
    expect(Object.is(out, spec)).toBe(true);
  });

  it("空配列は何もしない", () => {
    const spec = makeSpec();
    const { spec: out, results } = applyDiffs(spec, []);
    expect(Object.is(out, spec)).toBe(true);
    expect(results).toEqual([]);
  });

  it("逐次適用: 直前の op が作った項目に、後続の op が作用できる", () => {
    const { spec: out, results } = applyDiffs(makeSpec(), [
      { op: "addField", id: "extra", label: "追加金額", fieldType: "number", unit: "円" },
      { op: "setNumberLimit", fieldId: "extra", max: 10 },
      { op: "addAggregation", label: "追加合計", fieldId: "extra", agg: "sum" },
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(findField(out, "extra")).toMatchObject({ max: 10 });
    // addField で付けた単位が集計カードまで伝播する
    expect(out.aggregations.at(-1)).toMatchObject({ id: "agg_sum_extra", unit: "円" });
  });
});

describe("畳み込み等価性(グループUndoの土台)", () => {
  const g1: SpecDiff[] = [
    { op: "addApprovalStep", name: "社長承認", role: "社長" },
    { op: "setNumberLimit", fieldId: "total", max: 100000 },
  ];
  const g2: SpecDiff[] = [
    { op: "addFilterColumn", fieldId: "note" },
    { op: "addAggregation", label: "平均", fieldId: "total", agg: "avg" },
    { op: "setNumberLimit", fieldId: "ghost", max: 1 }, // 失敗が混ざっていても畳み込みは壊れない
  ];

  it("reduce による畳み込みと applyDiffs は同じ結果になる", () => {
    const spec = makeSpec();
    const ds = [...g1, ...g2];
    // KamiwazaApp が reconfiguredSpec を作る式と同型
    const folded = ds.reduce((s, d) => applyDiff(s, d).spec, spec);

    expect(JSON.stringify(folded)).toBe(JSON.stringify(applyDiffs(spec, ds).spec));
  });

  it("末尾グループを捨てて再計算した結果は、そのグループを一度も適用しなかった結果と一致する", () => {
    const spec = makeSpec();

    applyDiffs(spec, [...g1, ...g2]); // 一度は g2 まで適用してみる(Undo 前の状態)
    const afterUndo = applyDiffs(spec, g1).spec; // 末尾グループを捨てて再fold
    const never = applyDiffs(makeSpec(), g1).spec; // g2 を一度も見ていない世界

    expect(JSON.stringify(afterUndo)).toBe(JSON.stringify(never));
  });
});

/* ============================================================
 * buildReconfigureTools — 幻覚の構造的封殺
 * ============================================================ */

describe("buildReconfigureTools", () => {
  it("項目が何も無いスペックでも add_approval_step と add_field は必ず出る", () => {
    expect(buildReconfigureTools(emptySpec()).map((t) => t.name)).toEqual([
      "add_approval_step",
      "add_field",
    ]);
  });

  it("該当項目があるスペックでは6本すべてが決まった順序で出る", () => {
    expect(buildReconfigureTools(makeSpec()).map((t) => t.name)).toEqual([
      "add_approval_step",
      "add_field",
      "set_number_limit",
      "add_aggregation",
      "rename_field",
      "add_filter_column",
    ]);
  });

  it("数値項目が1つも無ければ set_number_limit を出さない", () => {
    const spec: AppSpec = {
      ...makeSpec(),
      fields: [{ id: "cust", label: "顧客", type: "text", required: true, confidence: 1 }],
      lineItems: { label: "明細", columns: [{ id: "item", label: "品名", type: "text" }] },
    };
    expect(buildReconfigureTools(spec).map((t) => t.name)).not.toContain("set_number_limit");
  });

  it("全項目が一覧に出ていれば add_filter_column を出さない", () => {
    const spec: AppSpec = { ...makeSpec(), listColumns: ["total", "note", "cust"] };
    expect(buildReconfigureTools(spec).map((t) => t.name)).not.toContain("add_filter_column");
  });

  it("fields が空で lineItems だけあるとき、fields 由来の2本が落ちる", () => {
    const spec: AppSpec = { ...makeSpec(), fields: [], listColumns: [] };
    // add_aggregation は fields のみ、add_filter_column も fields のみを対象にするので消える
    expect(buildReconfigureTools(spec).map((t) => t.name)).toEqual([
      "add_approval_step",
      "add_field",
      "set_number_limit",
      "rename_field",
    ]);
  });

  it("各ツールの enum に注入される id 集合が正確である", () => {
    const tools = buildReconfigureTools(makeSpec());

    // 上限設定は number の field と number の明細列
    expect(propEnum(toolNamed(tools, "set_number_limit"), "fieldId")).toEqual(["total", "unit_price"]);
    // 集計は fields のみ(明細列は集計できない)
    expect(propEnum(toolNamed(tools, "add_aggregation"), "fieldId")).toEqual(["total", "note", "cust"]);
    // 改名は fields + 明細列すべて
    expect(propEnum(toolNamed(tools, "rename_field"), "fieldId")).toEqual([
      "total",
      "note",
      "cust",
      "unit_price",
      "item",
    ]);
    // 一覧追加はまだ表示されていない fields のみ
    expect(propEnum(toolNamed(tools, "add_filter_column"), "fieldId")).toEqual(["note", "cust"]);
  });

  it("add_field の fieldType はスペックに依らず固定で、stamp / phone を含まない", () => {
    for (const spec of [makeSpec(), emptySpec()]) {
      // stamp / phone は紙由来の型で、後から人が追加する対象ではない
      expect(propEnum(toolNamed(buildReconfigureTools(spec), "add_field"), "fieldType")).toEqual([
        "text",
        "textarea",
        "number",
        "date",
        "select",
        "checkbox",
      ]);
    }
  });

  it("id を取るツールの description には項目対応表が付き、明細列には注記が入る", () => {
    const tools = buildReconfigureTools(makeSpec());
    const table = "項目対応表: total=合計金額, note=備考, cust=顧客, unit_price=単価(明細列), item=品名(明細列)";

    for (const name of ["set_number_limit", "add_aggregation", "rename_field", "add_filter_column"]) {
      expect(toolNamed(tools, name).description.endsWith(table)).toBe(true);
    }
    // id を取らないツールに対応表は不要
    for (const name of ["add_approval_step", "add_field"]) {
      expect(toolNamed(tools, name).description).not.toContain("項目対応表");
    }
  });

  it("全シナリオで、enum に載った id は必ず reducer に受理される(定義と実装の一致)", () => {
    // enum に載った id が applyDiff に拒否されるなら、ツール定義がモデルに嘘を教えている。
    // 拒否理由の種類は問わず ok:true を要求する(「既に一覧にある」等の重複拒否も、
    // その id を enum に載せるべきではなかったという同じ欠陥の別の顔でしかない)。
    let probed = 0;
    const probe = (spec: AppSpec, ids: unknown, make: (id: string) => SpecDiff) => {
      for (const id of (ids as string[] | undefined) ?? []) {
        probed++;
        const r = applyDiff(spec, make(id));
        expect(r.ok, `${r.summary}: ${r.reason}`).toBe(true);
      }
    };

    for (const sc of SCENARIOS) {
      const tools = buildReconfigureTools(sc.spec);
      const enumFor = (name: string): string[] => {
        if (!tools.find((t) => t.name === name)) return [];
        const ids = propEnum(toolNamed(tools, name), "fieldId");
        // enum キーごと消えても probe が空回りして緑になる、という抜けを塞ぐ
        expect(Array.isArray(ids), `${sc.id}/${name} の fieldId に enum が無い`).toBe(true);
        expect((ids as string[]).length, `${sc.id}/${name} の enum が空`).toBeGreaterThan(0);
        return ids as string[];
      };

      probe(sc.spec, enumFor("set_number_limit"), (id) => ({ op: "setNumberLimit", fieldId: id, max: 1e9 }));
      probe(sc.spec, enumFor("rename_field"), (id) => ({ op: "renameField", fieldId: id, label: "X" }));
      probe(sc.spec, enumFor("add_filter_column"), (id) => ({ op: "addFilterColumn", fieldId: id }));
      probe(sc.spec, enumFor("add_aggregation"), (id) => ({
        op: "addAggregation",
        label: "L",
        fieldId: id,
        agg: "count", // count なら型を問わないので、型不一致ではなく「存在」を検証できる
      }));
    }

    // 1件も probe していなければ上の expect は一度も走っていない
    expect(probed).toBeGreaterThan(0);
  });
});

/* ============================================================
 * toolCallToDiff — モデル出力の正規化
 * ============================================================ */

describe("toolCallToDiff", () => {
  it("未知のツール名は null", () => {
    expect(toolCallToDiff("nope", {})).toBeNull();
    expect(toolCallToDiff("", {})).toBeNull();
  });

  it("既知のツールは入力が壊れていても null を返さない(検証は applyDiff の責務)", () => {
    expect(toolCallToDiff("add_approval_step", {})).toEqual({ op: "addApprovalStep", name: "", role: "" });
    expect(toolCallToDiff("rename_field", { fieldId: null, label: undefined })).toEqual({
      op: "renameField",
      fieldId: "",
      label: "",
    });
    expect(toolCallToDiff("add_filter_column", {})).toEqual({ op: "addFilterColumn", fieldId: "" });
  });

  it("空文字に丸められた diff は applyDiff 側で必ず弾かれる(2段防御)", () => {
    const names = [
      "add_approval_step",
      "set_number_limit",
      "add_field",
      "add_aggregation",
      "rename_field",
      "add_filter_column",
    ];
    for (const name of names) {
      const diff = toolCallToDiff(name, {});
      expect(diff).not.toBeNull();
      expect(applyDiff(makeSpec(), diff as SpecDiff).ok).toBe(false);
    }
  });

  it("数値でない min/max は undefined に落ちる", () => {
    expect(toolCallToDiff("set_number_limit", { fieldId: "total", max: "100" })).toEqual({
      op: "setNumberLimit",
      fieldId: "total",
      min: undefined,
      max: undefined,
    });
    expect(toolCallToDiff("set_number_limit", { fieldId: "total", max: NaN, min: 5 })).toEqual({
      op: "setNumberLimit",
      fieldId: "total",
      min: 5,
      max: undefined,
    });
  });

  it.each(["stamp", "phone", "bogus", undefined])("未知の fieldType %s は text に丸める", (ft) => {
    // stamp/phone は AppSpec 上は存在するが、SpecDiff では意図的に禁止されている型
    expect(toolCallToDiff("add_field", { id: "x", label: "L", fieldType: ft })).toMatchObject({
      fieldType: "text",
    });
  });

  it("options は要素を文字列化する", () => {
    expect(toolCallToDiff("add_field", { id: "x", label: "L", fieldType: "select", options: [1, "x", null] })).toMatchObject({
      options: ["1", "x", "null"], // String(null) は "null" になる。選択肢に混入したら見た目で気づける
    });
  });

  it("required は厳密に true のときだけ true", () => {
    expect(toolCallToDiff("add_field", { id: "x", label: "L", fieldType: "text", required: "yes" })).toMatchObject({
      required: false,
    });
    expect(toolCallToDiff("add_field", { id: "x", label: "L", fieldType: "text", required: true })).toMatchObject({
      required: true,
    });
  });

  it("空文字の unit は undefined 扱い", () => {
    expect(toolCallToDiff("add_field", { id: "x", label: "L", fieldType: "number", unit: "" })).toMatchObject({
      unit: undefined,
    });
  });

  it("未知の agg は sum に丸める", () => {
    expect(toolCallToDiff("add_aggregation", { label: "L", fieldId: "total", agg: "median" })).toMatchObject({
      agg: "sum",
    });
  });
});

/* ============================================================
 * checkLimit
 * ============================================================ */

describe("checkLimit", () => {
  it.each([
    { f: {}, v: 5, why: "リミット未設定" },
    { f: { max: 5 }, v: "10", why: "数値でない文字列" },
    { f: { max: 5 }, v: true, why: "真偽値" },
    { f: { max: 5 }, v: undefined, why: "未入力" },
    { f: { max: 5 }, v: null, why: "null" },
    { f: { max: 5 }, v: NaN, why: "NaN" },
    { f: { max: 5 }, v: 5, why: "上限ちょうどは違反ではない" },
    { f: { min: 5 }, v: 5, why: "下限ちょうどは違反ではない" },
  ])("null を返す: $why", ({ f, v }) => {
    expect(checkLimit(f, v)).toBeNull();
  });

  it("上限超過は超過量を小数第2位まで丸めて返す", () => {
    // 7.555 - 5 = 2.5549999... を 2.55 に丸める(表示に浮動小数の尻尾を出さない)
    expect(checkLimit({ max: 5 }, 7.555)).toEqual({ kind: "max", amount: 2.55, limit: 5 });
  });

  it("下限割れは不足量を返す", () => {
    expect(checkLimit({ min: 5 }, 2.113)).toEqual({ kind: "min", amount: 2.89, limit: 5 });
  });

  it("上下どちらにも違反する構成では上限側を優先して返す", () => {
    expect(checkLimit({ min: 10, max: 5 }, 20)).toEqual({ kind: "max", amount: 15, limit: 5 });
  });

  it("浮動小数の誤差は丸めで消える", () => {
    expect(checkLimit({ max: 0.1 }, 0.30000000000004)).toEqual({ kind: "max", amount: 0.2, limit: 0.1 });
  });
});

/* ============================================================
 * roiSummary
 * ============================================================ */

describe("roiSummary", () => {
  const yen: FieldSpec = numField("total", { label: "合計金額", unit: "円", max: 100000 });

  it("円建てなら件数・超過額合計・年間換算(×12)を出す", () => {
    // 超過 50,000 + 100,000 = 150,000 / 年換算 1,800,000 → 万円表記
    expect(roiSummary(yen, [{ total: 150000 }, { total: 200000 }, { total: 10 }])).toBe(
      "今あるデータで上限超過 2件・計¥150,000 → 年間換算 約180万円の確認対象",
    );
  });

  it("年換算が1万円未満なら万円表記にせず円で出す", () => {
    expect(roiSummary(yen, [{ total: 100500 }])).toBe(
      "今あるデータで上限超過 1件・計¥500 → 年間換算 ¥6,000の確認対象",
    );
  });

  it("単位が円以外なら金額換算はせず件数だけ出す", () => {
    const temp = numField("temp", { label: "温度", unit: "℃", max: 40 });
    expect(roiSummary(temp, [{ temp: 45 }, { temp: 50 }])).toBe("今あるデータで上限超過 2件");
  });

  it("単位未設定は非円扱い", () => {
    const bare = numField("v", { max: 10 });
    expect(roiSummary(bare, [{ v: 20 }])).toBe("今あるデータで上限超過 1件");
  });

  it.each([
    { field: yen, records: [], why: "レコードが無い" },
    { field: yen, records: [{ total: 100 }], why: "全件が範囲内" },
    { field: yen, records: [{ other: 999999 }], why: "対象キーを持たないレコードだけ" },
    { field: numField("total", { type: "text" as const, max: 1 }), records: [{ total: 5 }], why: "数値項目でない" },
    { field: numField("total"), records: [{ total: 5 }], why: "min も max も未設定" },
  ])("null を返す: $why", ({ field, records }) => {
    expect(roiSummary(field, records as AppRecord[])).toBeNull();
  });

  it("下限だけを設定した項目は「下限割れ」と表示される", () => {
    const f = numField("v", { unit: "円", min: 100 });
    // 違反の中身は「100 に 90 足りない」なので、上限超過と呼んではいけない。
    // 件数・金額・年換算の計算方法は上限側と同じ(不足量を積む)。
    expect(roiSummary(f, [{ v: 10 }])).toBe(
      "今あるデータで下限割れ 1件・計¥90 → 年間換算 ¥1,080の確認対象",
    );
  });

  it("上限違反と下限違反が混在したら「リミット逸脱」に丸める", () => {
    // checkLimit は max/min 両設定時に max を優先するため、1項目でも両種の違反が混ざりうる。
    // どちらか片方の語で代表させると必ず嘘になるので、中立の語に落とす。
    // 超過 500(1500-1000)+ 不足 90(100-10)= 590 を1本の合計に積む
    const f = numField("v", { unit: "円", min: 100, max: 1000 });
    expect(roiSummary(f, [{ v: 1500 }, { v: 10 }])).toBe(
      "今あるデータでリミット逸脱 2件・計¥590 → 年間換算 ¥7,080の確認対象",
    );
  });

  it("非円でも違反種別で文言が変わる(件数だけの表示でも語は正しい)", () => {
    const press = numField("press", { label: "吐出圧力", unit: "MPa", min: 0.3 });
    expect(roiSummary(press, [{ press: 0.1 }, { press: 0.9 }])).toBe("今あるデータで下限割れ 1件");

    const both = numField("press", { label: "吐出圧力", unit: "MPa", min: 0.3, max: 0.6 });
    expect(roiSummary(both, [{ press: 0.1 }, { press: 0.9 }])).toBe("今あるデータでリミット逸脱 2件");
  });

  it("実シナリオ回帰: 請求書に10万円上限をかけると1件だけ該当する", () => {
    const sc = getScenario("seikyu");
    const billed = { ...(findField(sc.spec, "billed") as FieldSpec), max: 100000 };
    expect(roiSummary(billed, [sc.spec.firstRecord, ...sc.seedRecords])).toBe(
      "今あるデータで上限超過 1件・計¥67,200 → 年間換算 約81万円の確認対象",
    );
  });

  it("実シナリオ回帰: 点検表の吐出圧力 0.6MPa 上限は3件該当する", () => {
    const sc = getScenario("tenken");
    const pressure = { ...(findField(sc.spec, "pressure") as FieldSpec), max: 0.6 };
    // 0.65 / 0.63 / 0.62 の3件(アラート文が語る「3回連続超過」と一致する)
    expect(roiSummary(pressure, [sc.spec.firstRecord, ...sc.seedRecords])).toBe(
      "今あるデータで上限超過 3件",
    );
  });
});

/* ============================================================
 * keywordFallback
 * ============================================================ */

describe("keywordFallback / 数値ターゲットの決定", () => {
  it("数値候補が1つなら手がかりが無くてもその項目を採用する", () => {
    expect(keywordFallback(singleNumSpec(), "10万円を超えたらアラート")).toEqual([
      { op: "setNumberLimit", fieldId: "amount", max: 100000 },
    ]);
  });

  it("数値候補が複数あり、どのラベルにも一般語にも当たらなければ何も返さない", () => {
    // makeSpec は total(合計金額) と unit_price(単価) の2候補。
    // 誤った項目に上限を付けるくらいなら何もしない、という安全側の設計。
    expect(keywordFallback(makeSpec(), "10万円を超えたらアラート")).toEqual([]);
  });

  it("ラベルが文中にあれば、その項目を選ぶ", () => {
    const spec = getScenario("chumonsho").spec;
    expect(keywordFallback(spec, "合計金額が8万円を超えたら社長承認")).toContainEqual({
      op: "setNumberLimit",
      fieldId: "total",
      max: 80000,
    });
  });

  it("明細列もラベル一致で選べる(chumonsho の unit_price は明細側にしかない)", () => {
    // 注意: chumonsho の明細列ラベルは「単価」そのものなので、ここで効いているのは
    // 一般語フォールバックではなく完全一致パス。一般語パスは下の it.each で検証する。
    const spec = getScenario("chumonsho").spec;
    expect(findCol(spec, "unit_price")?.label).toBe("単価");
    expect(keywordFallback(spec, "単価の上限を3000円に")).toEqual([
      { op: "setNumberLimit", fieldId: "unit_price", max: 3000 },
    ]);
  });

  /** 一般語フォールバック検証用。ラベルは文中に現れず、一般語だけが手がかりになる */
  const generalWordSpec = (): AppSpec => ({
    ...makeSpec(),
    fields: [
      numField("cost", { label: "発注単価" }),
      numField("billed", { label: "請求金額" }),
      numField("press", { label: "吐出圧力" }),
      numField("temp", { label: "本体温度" }),
      numField("dur", { label: "作業時間" }),
    ],
    lineItems: null,
    listColumns: [],
  });

  it.each([
    { word: "単価", text: "単価が3,000円を超えたらアラート", fieldId: "cost", max: 3000 },
    { word: "金額", text: "金額が5万円以上はアラート", fieldId: "billed", max: 50000 },
    { word: "圧力", text: "圧力が0.6以上でアラート", fieldId: "press", max: 0.6 },
    { word: "温度", text: "温度が40以上でアラート", fieldId: "temp", max: 40 },
    { word: "時間", text: "時間が10以上でアラート", fieldId: "dur", max: 10 },
  ])("一般語「$word」で、ラベル完全一致しない項目にも到達できる", ({ text, fieldId, max }) => {
    // 候補が5つあるので「1つしかないから採用」のフォールバックには救われない。
    // 一般語リストから語を1つ落とすと、この行だけが落ちる。
    expect(keywordFallback(generalWordSpec(), text)).toEqual([
      { op: "setNumberLimit", fieldId, max },
    ]);
  });

  it("ラベルの括弧書きを外した形でも項目に到達できる", () => {
    // 「納品数(個)」を文中で「納品数」と呼んでも当たる。一般語リストには載っていない語なので、
    // 括弧除去パスが落ちるとこのテストだけが落ちる。
    const spec: AppSpec = {
      ...makeSpec(),
      fields: [numField("delivered", { label: "納品数(個)" }), numField("other", { label: "予備数" })],
      lineItems: null,
      listColumns: [],
    };
    expect(keywordFallback(spec, "納品数が100以上でアラート")).toEqual([
      { op: "setNumberLimit", fieldId: "delivered", max: 100 },
    ]);
  });

  it("【既知の取りこぼし】数値と上限語の間に単位が挟まると閾値を読めない", () => {
    const spec = getScenario("tenken").spec;
    // 「0.6を超えたら」は 数値+上限語 の隣接パターンに一致しないため何も返らない。
    expect(keywordFallback(spec, "圧力が0.6を超えたらアラート")).toEqual([]);
    // 隣接していれば読める
    expect(keywordFallback(spec, "吐出圧力が0.6以上でアラート")).toEqual([
      { op: "setNumberLimit", fieldId: "pressure", max: 0.6 },
    ]);
  });
});

describe("keywordFallback / 閾値の読み取り", () => {
  it.each([
    { text: "10万円を超えたらアラート", expected: { max: 100000 }, why: "万円は1万=10000で換算" },
    { text: "1,000円以上でアラート", expected: { max: 1000 }, why: "カンマを除去" },
    { text: "5万以上は要確認", expected: { max: 50000 }, why: "円が無くても万は効く" },
    { text: "100以上でアラート", expected: { max: 100 }, why: "「N以上」は上限として扱う" },
    { text: "10万円まで", expected: { max: 100000 }, why: "「まで」も上限語" },
    { text: "100未満は下限アラート", expected: { min: 100 }, why: "未満は下限語" },
    { text: "下限を100円にして", expected: { min: 100 }, why: "「下限」で min に切り替わる" },
  ])("$text → $why", ({ text, expected }) => {
    expect(keywordFallback(singleNumSpec(), text)).toEqual([
      { op: "setNumberLimit", fieldId: "amount", ...expected },
    ]);
  });

  it("数値が無ければ上限操作は生成しない", () => {
    expect(keywordFallback(singleNumSpec(), "上限を設定して")).toEqual([]);
  });

  it("上限語に隣接しない数字を閾値に誤読しない", () => {
    // 「2段階」の 2 を閾値にしてはいけない
    expect(keywordFallback(singleNumSpec(), "2段階の承認にして、10万円超はアラート")).toEqual([
      { op: "addApprovalStep", name: "社長承認", role: "社長" },
      { op: "setNumberLimit", fieldId: "amount", max: 100000 },
    ]);
  });
});

/* ------------------------------------------------------------
 * トリガー語彙の誤爆防止。
 * 各 op の生成条件は「語彙AのAND語彙B」で書かれている。片方の条件を落としても
 * 肯定側テストは全部通ってしまうため、否定側をここで個別に固定する。
 * ここが無いと「一覧に備考を追加」だけで承認ステップが増える、といった
 * 誤爆リグレッションを誰も検知できない。
 * ---------------------------------------------------------- */
describe("keywordFallback / トリガー語彙(誤爆防止)", () => {
  it("承認: 追加を意味する語が無ければ承認ステップを作らない", () => {
    // 「承認」に言及しただけの文で勝手にフローが伸びてはいけない
    expect(keywordFallback(makeSpec(), "承認の状況を知りたい")).toEqual([]);
  });

  it("承認: 追加語だけで「承認」が無ければ承認ステップを作らない", () => {
    // 「一覧に備考を追加」は列追加のみ。ここに承認が混ざるのが最も起きやすい誤爆。
    expect(keywordFallback(makeSpec(), "一覧に備考を追加して")).toEqual([
      { op: "addFilterColumn", fieldId: "note" },
    ]);
  });

  it.each([
    { text: "10万円の予算です", why: "金額を述べただけ" },
    { text: "100未満にする", why: "『未満』は閾値の読み取りには効くが、トリガー語彙には無い" },
  ])("上限: 上限語彙が無ければ閾値が読めても操作を作らない($why)", ({ text }) => {
    expect(keywordFallback(singleNumSpec(), text)).toEqual([]);
  });

  it("一覧: 「一覧」が無ければ列を追加しない", () => {
    expect(keywordFallback(makeSpec(), "備考を表示して")).toEqual([]);
  });

  it("一覧: 表示を意味する語が無ければ列を追加しない", () => {
    expect(keywordFallback(makeSpec(), "一覧の備考について")).toEqual([]);
  });
});

describe("keywordFallback / 複数トリガー", () => {
  it("1文から承認・上限・集計・一覧列を順に生成する", () => {
    const diffs = keywordFallback(
      makeSpec(),
      "承認を追加して、合計金額が10万円超はアラート、平均をダッシュボードに、一覧に備考も表示",
    );

    expect(diffs).toEqual([
      { op: "addApprovalStep", name: "社長承認", role: "社長" },
      { op: "setNumberLimit", fieldId: "total", max: 100000 },
      // ラベルは field.label 由来で組み立てる(文中の言い回しは使わない)
      { op: "addAggregation", label: "平均: 合計金額", fieldId: "total", agg: "avg" },
      { op: "addFilterColumn", fieldId: "note" },
    ]);
  });

  it("承認フローに既に社長がいれば役員確認を提案する", () => {
    const spec: AppSpec = { ...makeSpec(), approvalFlow: [{ name: "社長承認", role: "社長" }] };
    expect(keywordFallback(spec, "承認を追加して")).toEqual([
      { op: "addApprovalStep", name: "役員確認", role: "役員" },
    ]);
  });

  it("集計は「平均/合計/件数」と「集計/ダッシュボード/カード」の両方が要る", () => {
    expect(keywordFallback(makeSpec(), "平均を知りたい")).toEqual([]);
    expect(keywordFallback(makeSpec(), "平均を集計して")).toEqual([
      { op: "addAggregation", label: "平均: 合計金額", fieldId: "total", agg: "avg" },
    ]);
  });

  it("既に一覧に出ている項目は追加提案しない", () => {
    // chumonsho の listColumns には delivery_date(納期)が既に入っている
    expect(keywordFallback(getScenario("chumonsho").spec, "一覧に納期を出して")).toEqual([]);
  });

  it("集計対象は「先頭の数値項目」ではなく文中で名指しされた項目", () => {
    // makeSpec だと total が先頭の数値項目なので、ラベル一致を落としても気づけない。
    // 名指し項目を2番目に置いて、優先順位そのものを固定する。
    const spec: AppSpec = {
      ...makeSpec(),
      fields: [numField("total", { label: "合計金額" }), numField("qty", { label: "数量" })],
      lineItems: null,
      listColumns: [],
    };
    expect(keywordFallback(spec, "数量の平均を集計して")).toEqual([
      { op: "addAggregation", label: "平均: 数量", fieldId: "qty", agg: "avg" },
    ]);
    // 名指しが無ければ先頭の数値項目にフォールバックする
    expect(keywordFallback(spec, "平均を集計して")).toEqual([
      { op: "addAggregation", label: "平均: 合計金額", fieldId: "total", agg: "avg" },
    ]);
  });

  it("生成した diff の妥当性は検証しない — 安全弁は applyDiff 側にある", () => {
    const full = withFlow(5);
    const diffs = keywordFallback(full, "承認を追加して");

    expect(diffs).toHaveLength(1); // 5段でも diff は作られてしまう
    const { results } = applyDiffs(full, diffs);
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toBe("承認ステップは5段までです");
  });
});

/* ============================================================
 * チップ
 * ============================================================ */

describe("chipsForScenario", () => {
  it("未知のシナリオIDは空配列", () => {
    expect(chipsForScenario("nope")).toEqual([]);
  });

  it.each(SCENARIOS.map((s) => s.id))("%s: 全チップの全 op が素のスペックに対して成功する", (id) => {
    const sc = getScenario(id);
    const chips = chipsForScenario(id);

    expect(chips.length).toBeGreaterThan(0);
    const { results } = applyDiffs(sc.spec, chips.flatMap((c) => c.ops));
    // 1つでも失敗すればデモ中に「✗」が出る。これは許容できない。
    expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual([]);
  });

  it.each(SCENARIOS.map((s) => s.id))("%s: 参照先の制約(op種別ごとに見る先が違う)を守っている", (id) => {
    const spec = getScenario(id).spec;
    const fieldIds = new Set(spec.fields.map((f) => f.id));
    const colIds = new Set(spec.lineItems?.columns.map((c) => c.id) ?? []);

    for (const op of chipsForScenario(id).flatMap((c) => c.ops)) {
      switch (op.op) {
        case "addField":
          expect(fieldIds.has(op.id)).toBe(false); // 既存IDと衝突しない
          break;
        case "setNumberLimit": {
          // fields か明細列のどちらかに存在し、かつ number であること
          const f = spec.fields.find((x) => x.id === op.fieldId);
          const c = spec.lineItems?.columns.find((x) => x.id === op.fieldId);
          expect((f ?? c) !== undefined).toBe(true);
          expect((f ?? c)?.type).toBe("number");
          break;
        }
        case "addAggregation":
        case "addFilterColumn":
          // この2つは fields しか見ないので、明細列を指していたら必ず失敗する
          expect(fieldIds.has(op.fieldId)).toBe(true);
          expect(colIds.has(op.fieldId)).toBe(false);
          break;
        case "addApprovalStep":
          expect(op.name.trim()).not.toBe("");
          expect(op.role.trim()).not.toBe("");
          break;
      }
    }
  });

  it.each(SCENARIOS.map((s) => s.id))("%s: 適用前は全チップが押せる(グレーアウトが早すぎない)", (id) => {
    const spec = getScenario(id).spec;
    const chips = chipsForScenario(id);

    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      // disabled = !ops.some(ok) なので、この述語が最初から false ならチップは
      // 一度も押せないまま灰色で並ぶ。適用後の無効化(下)と対で初めて意味を持つ。
      expect(chip.ops.some((op) => applyDiff(spec, op).ok), `chip=${chip.id}`).toBe(true);
    }
  });

  it.each(SCENARIOS.map((s) => s.id))("%s: 全チップが適用後に無効化される", (id) => {
    const spec = getScenario(id).spec;
    for (const chip of chipsForScenario(id)) {
      const applied = applyDiffs(spec, chip.ops).spec;
      // KamiwazaApp は some(op => applyDiff(...).ok) で disabled を決めている
      expect(chip.ops.some((op) => applyDiff(applied, op).ok), `chip=${chip.id}`).toBe(false);
    }
  });

  it("適用後も押せたままのチップは1つも無い(F01の回帰テスト)", () => {
    // かつては setNumberLimit の同値再適用が ok:true だったため、上限系チップだけが
    // 押しても何も起きない状態で光り続けていた。全シナリオ横断でその再発を止める。
    const stale: string[] = [];
    for (const sc of SCENARIOS) {
      for (const chip of chipsForScenario(sc.id)) {
        const applied = applyDiffs(sc.spec, chip.ops).spec;
        if (chip.ops.some((op) => applyDiff(applied, op).ok)) stale.push(`${sc.id}/${chip.id}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("genericChips の適用後グレーアウト", () => {
  // ライブ写真経路(審査員が自分の紙を出す経路)は chipsForScenario ではなく
  // genericChips が並ぶ。上限チップ g-limit はここにも居るので、同じ保証を別途固定する。
  it.each(SCENARIOS.map((s) => s.id))("%s: ライブ写真経路の g-limit も適用後に無効化される", (id) => {
    const spec = getScenario(id).spec;
    const chips = genericChips(spec, spec.firstRecord);
    const limit = chips.find((c) => c.id === "g-limit");

    expect(limit, `${id} に g-limit が出ない`).toBeDefined();
    expect(limit!.ops.some((op) => applyDiff(spec, op).ok)).toBe(true); // 適用前は押せる

    const applied = applyDiffs(spec, limit!.ops).spec;
    expect(limit!.ops.some((op) => applyDiff(applied, op).ok)).toBe(false); // 適用後は押せない
  });

  it.each(SCENARIOS.map((s) => s.id))("%s: g-limit 以外の汎用チップも適用後に無効化される", (id) => {
    const spec = getScenario(id).spec;
    for (const chip of genericChips(spec, spec.firstRecord)) {
      const applied = applyDiffs(spec, chip.ops).spec;
      expect(chip.ops.some((op) => applyDiff(applied, op).ok), `chip=${chip.id}`).toBe(false);
    }
  });
});

describe("genericChips", () => {
  const rec: AppRecord = { total: 1234 };

  it("承認・上限・平均の3枚をこの順で出す", () => {
    expect(genericChips(makeSpec(), rec).map((c) => c.id)).toEqual(["g-approval", "g-limit", "g-avg"]);
  });

  it("承認フローが満杯なら承認チップを出さない", () => {
    expect(genericChips(withFlow(5), rec).map((c) => c.id)).toEqual(["g-limit", "g-avg"]);
  });

  it("approvalFlow が null でも承認チップは出る", () => {
    const spec: AppSpec = { ...makeSpec(), approvalFlow: null };
    expect(genericChips(spec, rec).map((c) => c.id)).toContain("g-approval");
  });

  it("既に社長がいれば役員確認を提案する", () => {
    const spec: AppSpec = { ...makeSpec(), approvalFlow: [{ name: "社長承認", role: "社長" }] };
    const chip = genericChips(spec, rec).find((c) => c.id === "g-approval");

    expect(chip?.label).toBe("承認に「役員確認」を追加");
    expect(chip?.ops).toEqual([{ op: "addApprovalStep", name: "役員確認", role: "役員" }]);
  });

  it.each([
    { value: undefined, why: "値が無い" },
    { value: 0, why: "0" },
    { value: -5, why: "負数" },
    { value: "1234", why: "数字だが文字列" },
  ])("実データの値が使えないとき($why)は数値系チップを出さない", ({ value }) => {
    const record = (value === undefined ? {} : { total: value }) as AppRecord;
    expect(genericChips(makeSpec(), record).map((c) => c.id)).toEqual(["g-approval"]);
  });

  it("既に上限が設定済みなら上限チップだけ消える", () => {
    const spec = applyDiff(makeSpec(), { op: "setNumberLimit", fieldId: "total", max: 9999 }).spec;
    expect(genericChips(spec, rec).map((c) => c.id)).toEqual(["g-approval", "g-avg"]);
  });

  it("既に平均集計があれば平均チップだけ消える", () => {
    const spec = applyDiff(makeSpec(), { op: "addAggregation", label: "平均", fieldId: "total", agg: "avg" }).spec;
    expect(genericChips(spec, rec).map((c) => c.id)).toEqual(["g-approval", "g-limit"]);
  });

  it("生成したチップは実際に適用できる", () => {
    const spec = makeSpec();
    const { results } = applyDiffs(spec, genericChips(spec, rec).flatMap((c) => c.ops));
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("genericChips のしきい値 (niceFloorBelow)", () => {
  const labelFor = (v: number): string => {
    const spec: AppSpec = { ...makeSpec(), fields: [numField("total", { label: "額" })] };
    return genericChips(spec, { total: v }).find((c) => c.id === "g-limit")?.label ?? "";
  };

  it.each([
    // 「その桁の 0.5 刻みで、実データより必ず下」。ちょうど桁の頭(100, 1000…)は半分に落ちる。
    { v: 7, limit: "6.5" },
    { v: 15, limit: "10" },
    { v: 42, limit: "40" },
    { v: 99, limit: "95" },
    { v: 100, limit: "50" },
    { v: 150, limit: "100" },
    { v: 500, limit: "450" },
    { v: 1000, limit: "500" },
    { v: 1500, limit: "1,000" },
    { v: 96800, limit: "95,000" },
    { v: 0.65, limit: "0.6" },
    { v: 0.6, limit: "0.55" },
    { v: 0.5, limit: "0.45" },
    { v: 5, limit: "4.5" },
    { v: 50, limit: "45" },
  ])("$v → 上限 $limit", ({ v, limit }) => {
    expect(labelFor(v)).toBe(`額に上限チェック(${limit})`);
  });

  it("単位はラベル末尾に付く", () => {
    const spec: AppSpec = { ...makeSpec(), fields: [numField("total", { label: "額", unit: "円" })] };
    expect(genericChips(spec, { total: 1500 }).find((c) => c.id === "g-limit")?.label).toBe(
      "額に上限チェック(1,000円)",
    );
  });

  it("しきい値は常に 0 < limit < 実データ値 になる(必ず1件は発火する絵になる)", () => {
    const spec: AppSpec = { ...makeSpec(), fields: [numField("total", { label: "額" })] };
    const values = [0.001, 0.07, 0.5, 1, 3.3, 9.99, 10, 64, 100, 777, 1000, 12345, 999999, 1e9];

    for (const v of values) {
      const chip = genericChips(spec, { total: v }).find((c) => c.id === "g-limit");
      expect(chip, `v=${v} で上限チップが出ない`).toBeDefined();
      const max = (chip!.ops[0] as { max: number }).max;
      expect(max, `v=${v}`).toBeGreaterThan(0);
      expect(max, `v=${v}`).toBeLessThan(v);
    }
  });
});

/* ============================================================
 * summary(手術ログの表記)
 * ============================================================ */

describe("summary", () => {
  it.each([
    { diff: { op: "addApprovalStep", name: "社長承認", role: "社長" } as SpecDiff, s: "addApprovalStep{社長承認 / 社長}" },
    { diff: { op: "setNumberLimit", fieldId: "total", min: 1, max: 2 } as SpecDiff, s: "setNumberLimit{total, min:1, max:2}" },
    { diff: { op: "setNumberLimit", fieldId: "total", max: 2 } as SpecDiff, s: "setNumberLimit{total, max:2}" },
    // min:0 は「0」でも省略されない(表示上 0 が消えると意味が変わるため)
    { diff: { op: "setNumberLimit", fieldId: "total", min: 0 } as SpecDiff, s: "setNumberLimit{total, min:0}" },
    { diff: { op: "addField", id: "a", label: "b", fieldType: "date" } as SpecDiff, s: "addField{a: b (date)}" },
    { diff: { op: "addAggregation", label: "L", fieldId: "total", agg: "avg" } as SpecDiff, s: "addAggregation{L: avg(total)}" },
    { diff: { op: "renameField", fieldId: "total", label: "新" } as SpecDiff, s: "renameField{total → 新}" },
    { diff: { op: "addFilterColumn", fieldId: "note" } as SpecDiff, s: "addFilterColumn{note}" },
  ])("$s", ({ diff, s }) => {
    expect(applyDiff(makeSpec(), diff).summary).toBe(s);
  });

  it("未知の op でも summary は必ず文字列を返す(ログに undefined を出さない)", () => {
    // 手術ログは1行ずつ画面に流れる。summarize が undefined を返すと
    // 舞台上に「undefined」の1行が出る(fail() は summarize の戻り値をそのまま載せる)。
    for (const [diff, s] of [
      [{ op: "bogus" }, "unknownOp{bogus}"],
      [{}, "unknownOp{?}"],
      // "?" に落ちるのは op が無い(nullish)ときだけ。空文字はそのまま出る
      [{ op: "" }, "unknownOp{}"],
    ] as const) {
      const r = applyDiff(makeSpec(), diff as unknown as SpecDiff);
      expect(typeof r.summary).toBe("string");
      expect(r.summary).toBe(s);
    }
  });

  it("summary は diff だけから決まり、成功しても失敗しても同じ", () => {
    const diff: SpecDiff = { op: "renameField", fieldId: "total", label: "新" };
    const ok = applyDiff(makeSpec(), diff);
    const missing = applyDiff({ ...makeSpec(), fields: [] }, diff); // 項目が無いので失敗する

    expect(ok.ok).toBe(true);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe(ok.summary);
  });
});

/* ============================================================
 * 不正な操作の封じ込め
 * このモジュールの対外主張「不正な操作は適用されず元のspecが返る」(specdiff.ts 冒頭)を
 * 型の上ではなく実行時に証明する層。SSE 由来の diff は実行時 any 同然なので、
 * 型で到達不能な形の入力もここで受け止められなければ主張が嘘になる。
 * ============================================================ */

describe("不正な操作の封じ込め", () => {
  it("未知の op でも DiffResult が返り、spec は入力と同一参照", () => {
    const spec = makeSpec();
    const r: DiffResult = applyDiff(spec, { op: "bogus" } as unknown as SpecDiff);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("未知の操作です");
    expect(r.summary).toBe("unknownOp{bogus}"); // ログには必ず何かが残る
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it("op プロパティが無いゴミでも落ちない", () => {
    const spec = makeSpec();
    const r: DiffResult = applyDiff(spec, {} as unknown as SpecDiff);

    expect(r.ok).toBe(false);
    expect(r.summary).toBe("unknownOp{?}"); // op が読めないことまで手術ログに出す
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["文字列", "addField"],
    ["配列", []],
  ])("diff が %s でも例外を投げず、元の spec が同一参照で返る", (_name, bad) => {
    // ここが投げると sendInstruction の try が握り潰し、指示が黙ってキーワード解釈に
    // 落ちる(舞台上では「入力したのに別物が起きた」に見える)。
    // KamiwazaApp.tsx:406-408 のコメントが主張しているのはこの範囲まで。
    const spec = makeSpec();
    const r: DiffResult = applyDiff(spec, bad as unknown as SpecDiff);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("未知の操作です");
    expect(r.summary).toBe("unknownOp{?}");
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it("applyDiffs に不正opが混ざっても、正当なopだけが適用される", () => {
    const spec = makeSpec();
    const { spec: out, results } = applyDiffs(spec, [
      { op: "addFilterColumn", fieldId: "note" },
      { op: "bogus" } as unknown as SpecDiff,
      { op: "addApprovalStep", name: "社長承認", role: "社長" },
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.listColumns).toEqual(["total", "note"]);
    expect(out.approvalFlow).toHaveLength(2);
  });

  it("addField は明細列と同じ id を拒否する", () => {
    const spec = makeSpec(); // lineItems に unit_price が既にある
    const r = applyDiff(spec, { op: "addField", id: "unit_price", label: "単価(重複)", fieldType: "number" });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("明細列");
    expect(r.reason).toBe("「unit_price」は明細列「単価」と同じidです");
    expect(Object.is(r.spec, spec)).toBe(true);
  });

  it("拒否されるので、setNumberLimit / renameField が明細列に届かなくなる衝突も起きない", () => {
    // id が衝突すると、以降 fields 側が先に拾われて明細列が永久に触れなくなる。
    // 追加を拒否している限り、明細列への操作は素通しで届く。
    const spec = applyDiff(makeSpec(), {
      op: "addField",
      id: "unit_price",
      label: "単価(重複)",
      fieldType: "number",
    }).spec;

    expect(applyDiff(spec, { op: "renameField", fieldId: "unit_price", label: "Z" }).spec.lineItems?.columns[0].label).toBe(
      "Z",
    );
    expect(findCol(applyDiff(spec, { op: "setNumberLimit", fieldId: "unit_price", max: 9 }).spec, "unit_price")).toMatchObject(
      { max: 9 },
    );
  });

  it("id の trim 後に明細列と衝突する場合も拒否する", () => {
    // 保存されるのは trim 後の id なので、判定も trim 後の id で行う必要がある
    const spec = makeSpec();
    const r = applyDiff(spec, { op: "addField", id: "  unit_price  ", label: "L", fieldType: "text" });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("「unit_price」は明細列「単価」と同じidです");
  });
});

/* ============================================================
 * 一度目の適用結果の不変性(F01〜F05 の修正前に採取したゴールデン)
 *
 * F01〜F05 は「二度目以降の挙動」と「不正入力の扱い」を変えた修正であり、
 * 舞台に出る一度目の見え方は1文字も変えていない、というのが対外的な主張。
 * 下の FIRST_APPLY_GOLDEN は修正前のコードで採取した実測値そのもので、
 * 5シナリオ × 全チップ(シナリオチップ + ライブ写真経路の汎用チップ)について
 *   - 手術ログの行(✓/✗・summary・reason)と順序
 *   - 素のスペックからの構造差分(= 適用結果そのもの)
 *   - 画面に出る派生値(ROI文言・赤バッジ)
 * を1本の文字列配列に畳んである。1行でも変われば舞台の絵が変わったということ。
 *
 * このテストが赤いのに「意図した変更だ」と言い切れるとき以外、値を書き換えてはいけない。
 * ============================================================ */

/** undefined を「キーごと消える」ではなく「未設定」として残す決定論シリアライザ */
function stable(v: unknown): unknown {
  if (v === undefined) return "(未設定)";
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stable);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = stable(o[k]);
  return out;
}
const canon = (v: unknown) => JSON.stringify(stable(v));

/** base から applied への構造差分を "path: 旧 → 新" の行に落とす */
function deltaLines(base: unknown, applied: unknown, path = ""): string[] {
  if (canon(base) === canon(applied)) return [];
  const isObj = (x: unknown) => x !== null && typeof x === "object";
  if (!isObj(base) || !isObj(applied) || Array.isArray(base) !== Array.isArray(applied))
    return [`${path}: ${canon(base)} → ${canon(applied)}`];
  if (Array.isArray(base) && Array.isArray(applied)) {
    const out: string[] = [];
    for (let i = 0; i < Math.max(base.length, applied.length); i++)
      out.push(...deltaLines(base[i], applied[i], `${path}[${i}]`));
    return out;
  }
  const a = base as Record<string, unknown>;
  const b = applied as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((k) => deltaLines(a[k], b[k], path ? `${path}.${k}` : k));
}

/** 画面に出る派生値(ROI文言・赤バッジ)。リミットが載った項目だけを見る */
function derivedLines(spec: AppSpec, records: AppRecord[]): string[] {
  const out: string[] = [];
  for (const f of spec.fields) {
    if (f.type !== "number" || (f.min === undefined && f.max === undefined)) continue;
    out.push(`roi[${f.id}]=${roiSummary(f, records)}`);
    out.push(
      `badge[${f.id}]=${records
        .map((r) => {
          const v = checkLimit(f, r[f.id]);
          return v ? `${v.kind}:${v.amount}` : "-";
        })
        .join(",")}`,
    );
  }
  for (const c of spec.lineItems?.columns ?? []) {
    if (c.type !== "number" || (c.min === undefined && c.max === undefined)) continue;
    out.push(`col[${c.id}]=min:${c.min ?? "(未設定)"},max:${c.max ?? "(未設定)"}`);
  }
  return out;
}

/**
 * チップを1回押したときに観測できるものを全部集める。
 * ops の畳み込みは KamiwazaApp.runOps と同じ(ok な op だけが spec に残り patches に積まれる)。
 */
function trace(base: AppSpec, seedRecords: AppRecord[], chip: CommandChip): string[] {
  let cur = base;
  const log: string[] = [];
  let patches = 0;
  for (const op of chip.ops) {
    const r = applyDiff(cur, op);
    log.push(`log ${r.ok ? "✓" : "✗"} ${r.summary}${r.reason ? ` — ${r.reason}` : ""}`);
    if (r.ok) {
      cur = r.spec;
      patches++;
    }
  }
  return [
    `label=${chip.label}`,
    ...log,
    `patches=${patches}`,
    ...deltaLines(base, cur).map((l) => `spec ${l}`),
    ...derivedLines(cur, [cur.firstRecord, ...seedRecords]).map((l) => `view ${l}`),
  ];
}

/** 修正前のコードで採取した実測値。キーは "シナリオid/チップid" */
const FIRST_APPLY_GOLDEN: Record<string, string[]> = {
  "seikyu/exec-check": [
    "label=10万円超の請求は役員確認に",
    "log ✓ addApprovalStep{役員確認 / 役員}",
    "log ✓ setNumberLimit{billed, max:100000}",
    "patches=2",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"役員確認\",\"role\":\"役員\"}",
    "spec fields[10].max: \"(未設定)\" → 100000",
    "view roi[billed]=今あるデータで上限超過 1件・計¥67,200 → 年間換算 約81万円の確認対象",
    "view badge[billed]=max:67200,-,-,-,-",
  ],
  "seikyu/price-cap": [
    "label=明細単価に200円の上限アラート",
    "log ✓ setNumberLimit{unit_price, max:200}",
    "patches=1",
    "spec lineItems.columns[4].max: \"(未設定)\" → 200",
    "view col[unit_price]=min:(未設定),max:200",
  ],
  "seikyu/avg-agg": [
    "label=平均請求額をダッシュボードに",
    "log ✓ addAggregation{平均請求額: avg(billed)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"billed\",\"id\":\"agg_avg_billed\",\"label\":\"平均請求額\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
  "seikyu/list-purchase": [
    "label=一覧に今回買上額を表示",
    "log ✓ addFilterColumn{purchase}",
    "patches=1",
    "spec listColumns[4]: \"(未設定)\" → \"purchase\"",
  ],
  "seikyu/g-approval": [
    "label=承認に「社長承認」を追加",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
  ],
  "seikyu/g-limit": [
    "label=前回御請求額に上限チェック(200,000円)",
    "log ✓ setNumberLimit{prev_amount, max:200000}",
    "patches=1",
    "spec fields[5].max: \"(未設定)\" → 200000",
    "view roi[prev_amount]=今あるデータで上限超過 1件・計¥14,500 → 年間換算 約17万円の確認対象",
    "view badge[prev_amount]=max:14500,-,-,-,-",
  ],
  "seikyu/g-avg": [
    "label=平均前回御請求額を集計",
    "log ✓ addAggregation{平均前回御請求額: avg(prev_amount)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"prev_amount\",\"id\":\"agg_avg_prev_amount\",\"label\":\"平均前回御請求額\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
  "chumonsho/big-order-approval": [
    "label=8万円超の発注は社長承認に",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "log ✓ setNumberLimit{total, max:80000}",
    "patches=2",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
    "spec fields[3].max: \"(未設定)\" → 80000",
    "view roi[total]=今あるデータで上限超過 2件・計¥73,800 → 年間換算 約89万円の確認対象",
    "view badge[total]=max:5800,-,max:68000,-,-,-,-",
  ],
  "chumonsho/unit-price-cap": [
    "label=単価に3,000円の上限チェック",
    "log ✓ setNumberLimit{unit_price, max:3000}",
    "patches=1",
    "spec lineItems.columns[2].max: \"(未設定)\" → 3000",
    "view col[unit_price]=min:(未設定),max:3000",
  ],
  "chumonsho/list-note": [
    "label=一覧に備考も表示",
    "log ✓ addFilterColumn{note}",
    "patches=1",
    "spec listColumns[4]: \"(未設定)\" → \"note\"",
  ],
  "chumonsho/avg-total": [
    "label=平均発注額を集計",
    "log ✓ addAggregation{平均発注額: avg(total)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"total\",\"id\":\"agg_avg_total\",\"label\":\"平均発注額\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
  "chumonsho/g-approval": [
    "label=承認に「社長承認」を追加",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
  ],
  "chumonsho/g-limit": [
    "label=合計金額に上限チェック(85,000円)",
    "log ✓ setNumberLimit{total, max:85000}",
    "patches=1",
    "spec fields[3].max: \"(未設定)\" → 85000",
    "view roi[total]=今あるデータで上限超過 2件・計¥63,800 → 年間換算 約77万円の確認対象",
    "view badge[total]=max:800,-,max:63000,-,-,-,-",
  ],
  "chumonsho/g-avg": [
    "label=平均合計金額を集計",
    "log ✓ addAggregation{平均合計金額: avg(total)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"total\",\"id\":\"agg_avg_total\",\"label\":\"平均合計金額\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
  "nippo/safety-approval": [
    "label=安全責任者の確認を追加",
    "log ✓ addApprovalStep{安全確認 / 安全責任者}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"安全確認\",\"role\":\"安全責任者\"}",
  ],
  "nippo/overtime-field": [
    "label=残業時間の項目を追加",
    "log ✓ addField{overtime_hours: 残業時間 (number)}",
    "patches=1",
    "spec fields[10]: \"(未設定)\" → {\"confidence\":1,\"id\":\"overtime_hours\",\"label\":\"残業時間\",\"options\":\"(未設定)\",\"required\":false,\"type\":\"number\",\"unit\":\"時間\"}",
  ],
  "nippo/list-weather": [
    "label=一覧に天候を表示",
    "log ✓ addFilterColumn{weather}",
    "patches=1",
    "spec listColumns[4]: \"(未設定)\" → \"weather\"",
  ],
  "nippo/g-approval": [
    "label=承認に「社長承認」を追加",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
  ],
  "nippo/g-limit": [
    "label=休憩時間に上限チェック(0.5時間)",
    "log ✓ setNumberLimit{break_hours, max:0.5}",
    "patches=1",
    "spec fields[5].max: \"(未設定)\" → 0.5",
    "view roi[break_hours]=今あるデータで上限超過 6件",
    "view badge[break_hours]=max:0.5,max:0.5,max:0.5,max:0.5,max:0.5,max:0.5",
  ],
  "tenken/pressure-cap": [
    "label=圧力0.6MPa超を自動アラート",
    "log ✓ setNumberLimit{pressure, max:0.6}",
    "patches=1",
    "spec fields[7].max: \"(未設定)\" → 0.6",
    "view roi[pressure]=今あるデータで上限超過 3件",
    "view badge[pressure]=max:0.05,max:0.03,-,max:0.02,-,-",
  ],
  "tenken/maint-approval": [
    "label=保全課長の確認を追加",
    "log ✓ addApprovalStep{保全課長確認 / 保全課長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"保全課長確認\",\"role\":\"保全課長\"}",
  ],
  "tenken/temp-cap": [
    "label=本体温度40℃の上限チェック",
    "log ✓ setNumberLimit{temperature, max:40}",
    "patches=1",
    "spec fields[8].max: \"(未設定)\" → 40",
    "view roi[temperature]=今あるデータで上限超過 3件",
    "view badge[temperature]=max:2,max:1,-,max:3,-,-",
  ],
  "tenken/avg-temp": [
    "label=平均本体温度を集計",
    "log ✓ addAggregation{平均本体温度: avg(temperature)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"temperature\",\"id\":\"agg_avg_temperature\",\"label\":\"平均本体温度\",\"op\":\"avg\",\"unit\":\"℃\"}",
  ],
  "tenken/g-approval": [
    "label=承認に「社長承認」を追加",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
  ],
  "tenken/g-limit": [
    "label=吐出圧力に上限チェック(0.6MPa)",
    "log ✓ setNumberLimit{pressure, max:0.6}",
    "patches=1",
    "spec fields[7].max: \"(未設定)\" → 0.6",
    "view roi[pressure]=今あるデータで上限超過 3件",
    "view badge[pressure]=max:0.05,max:0.03,-,max:0.02,-,-",
  ],
  "hacchusho/big-po-check": [
    "label=30万円超の発注は経理部確認に",
    "log ✓ addApprovalStep{経理部確認 / 経理部}",
    "log ✓ setNumberLimit{total, max:300000}",
    "patches=2",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"経理部確認\",\"role\":\"経理部\"}",
    "spec fields[9].max: \"(未設定)\" → 300000",
    "view roi[total]=今あるデータで上限超過 3件・計¥750,000 → 年間換算 約900万円の確認対象",
    "view badge[total]=max:30000,max:580000,-,max:140000,-,-",
  ],
  "hacchusho/list-area": [
    "label=一覧に施策エリアを表示",
    "log ✓ addFilterColumn{area}",
    "patches=1",
    "spec listColumns[4]: \"(未設定)\" → \"area\"",
  ],
  "hacchusho/acceptance-notice": [
    "label=検収連絡日の項目を追加",
    "log ✓ addField{acceptance_notice: 検収連絡日 (date)}",
    "patches=1",
    "spec fields[11]: \"(未設定)\" → {\"confidence\":1,\"id\":\"acceptance_notice\",\"label\":\"検収連絡日\",\"options\":\"(未設定)\",\"required\":false,\"type\":\"date\",\"unit\":\"(未設定)\"}",
  ],
  "hacchusho/avg-po": [
    "label=平均発注額を集計",
    "log ✓ addAggregation{平均発注額: avg(total)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"total\",\"id\":\"agg_avg_total\",\"label\":\"平均発注額\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
  "hacchusho/g-approval": [
    "label=承認に「社長承認」を追加",
    "log ✓ addApprovalStep{社長承認 / 社長}",
    "patches=1",
    "spec approvalFlow[2]: \"(未設定)\" → {\"name\":\"社長承認\",\"role\":\"社長\"}",
  ],
  "hacchusho/g-limit": [
    "label=総合計に上限チェック(300,000円)",
    "log ✓ setNumberLimit{total, max:300000}",
    "patches=1",
    "spec fields[9].max: \"(未設定)\" → 300000",
    "view roi[total]=今あるデータで上限超過 3件・計¥750,000 → 年間換算 約900万円の確認対象",
    "view badge[total]=max:30000,max:580000,-,max:140000,-,-",
  ],
  "hacchusho/g-avg": [
    "label=平均総合計を集計",
    "log ✓ addAggregation{平均総合計: avg(total)}",
    "patches=1",
    "spec aggregations[2]: \"(未設定)\" → {\"fieldId\":\"total\",\"id\":\"agg_avg_total\",\"label\":\"平均総合計\",\"op\":\"avg\",\"unit\":\"円\"}",
  ],
};

describe("一度目の適用結果の不変性", () => {
  /** シナリオチップ + ライブ写真経路の汎用チップ(実UIではこの2つは同時には出ない) */
  const chipsOf = (id: string): CommandChip[] => {
    const spec = getScenario(id).spec;
    return [...chipsForScenario(id), ...genericChips(spec, spec.firstRecord)];
  };

  const keys = SCENARIOS.flatMap((sc) => chipsOf(sc.id).map((c) => `${sc.id}/${c.id}`));

  it("ゴールデンの網羅範囲が実際のチップ集合と完全に一致する", () => {
    // チップが増減したのにゴールデンが据え置きだと、新しいチップが素通りしてしまう
    expect(keys).toEqual(Object.keys(FIRST_APPLY_GOLDEN));
  });

  it.each(keys)("%s: 1押し目のログ・spec差分・画面表示が修正前と同一", (key) => {
    const [scenarioId, chipId] = key.split("/");
    const sc = getScenario(scenarioId);
    const chip = chipsOf(scenarioId).find((c) => c.id === chipId);

    expect(chip, `${key} のチップが見つからない`).toBeDefined();
    expect(trace(sc.spec, sc.seedRecords, chip!)).toEqual(FIRST_APPLY_GOLDEN[key]);
  });
});
