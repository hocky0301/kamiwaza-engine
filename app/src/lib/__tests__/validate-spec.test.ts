import { describe, it, expect } from "vitest";

import { validateAnalyzeOutput } from "../validate-spec";

/* ============================================================================
 * validate-spec — ライブ解析の最終JSONに対するアプリ側スキーマ強制
 *
 * OrcaRouter経路では structured outputs(サーバー側スキーマ強制)が握りつぶされるため、
 * このバリデータが唯一のスキーマ防衛線になる。合格/違反検出の両方を凍結する。
 * (バリデータ内部ロジックの網羅テストは appspec.test.ts の「テスト基盤の自己検証」)
 * ==========================================================================*/

/** スキーマ上まったく問題のないライブモード出力(全プロパティを埋めた最小形) */
function validOutput(): Record<string, unknown> {
  return {
    appName: "注文管理",
    icon: "📦",
    description: "紙の注文書をアプリ化する",
    fields: [
      {
        id: "total",
        label: "合計",
        type: "number",
        required: true,
        confidence: 0.9,
        sourceBox: { x: 1, y: 2, w: 3, h: 4 },
      },
    ],
    lineItems: {
      label: "明細",
      columns: [{ id: "name", label: "品名", type: "text" }],
    },
    lineRows: [["ボルト"]],
    listColumns: ["total"],
    approvalFlow: [{ name: "課長承認", role: "課長" }],
    aggregations: [{ id: "a", label: "合計", fieldId: "total", op: "sum" }],
    firstRecord: [{ fieldId: "total", value: "1200" }],
  };
}

describe("validateAnalyzeOutput: 合格", () => {
  it("正常なライブ出力はエラーゼロ", () => {
    expect(validateAnalyzeOutput(validOutput())).toEqual([]);
  });

  it("lineItems/approvalFlow が null の帳票も合格する", () => {
    const out = { ...validOutput(), lineItems: null, lineRows: [], approvalFlow: null };
    expect(validateAnalyzeOutput(out)).toEqual([]);
  });
});

describe("validateAnalyzeOutput: violation検出", () => {
  it("トップレベルの required 欠落を検出する(プロンプト準拠が崩れた出力)", () => {
    const out = validOutput();
    delete out.appName;
    expect(validateAnalyzeOutput(out)).toContainEqual({
      path: "$.appName",
      keyword: "required",
    });
  });

  it("未知キーの混入を additionalProperties で検出する", () => {
    const out = validOutput();
    out.hacked = "x";
    expect(validateAnalyzeOutput(out)).toContainEqual({
      path: "$.hacked",
      keyword: "additionalProperties",
    });
  });

  it("enum 外の fieldType を検出する", () => {
    const out = validOutput();
    (out.fields as Record<string, unknown>[])[0].type = "email";
    expect(validateAnalyzeOutput(out)).toContainEqual({
      path: "$.fields[0].type",
      keyword: "enum",
    });
  });

  it("型違い(confidence が文字列)を検出する", () => {
    const out = validOutput();
    (out.fields as Record<string, unknown>[])[0].confidence = "high";
    expect(validateAnalyzeOutput(out)).toContainEqual({
      path: "$.fields[0].confidence",
      keyword: "type",
    });
  });

  it("そもそもオブジェクトでない入力は type 違反1件で即決する", () => {
    expect(validateAnalyzeOutput("just prose, not json")).toEqual([
      { path: "$", keyword: "type" },
    ]);
    expect(validateAnalyzeOutput(null)).toEqual([{ path: "$", keyword: "type" }]);
  });

  it("違反は keyword@path で特定できる(claude-live のエラーメッセージの素材)", () => {
    const out = validOutput();
    delete out.icon;
    out.evil = 1;
    const reported = validateAnalyzeOutput(out).map((e) => `${e.keyword}@${e.path}`);
    expect(reported).toContain("required@$.icon");
    expect(reported).toContain("additionalProperties@$.evil");
  });
});
