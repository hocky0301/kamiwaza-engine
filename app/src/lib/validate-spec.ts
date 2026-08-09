// アプリ側JSON Schemaバリデータ(最小実装)— ライブ解析の最終JSONに適用する。
//
// OrcaRouter経路では structured outputs(サーバー側スキーマ強制)が握りつぶされるため
// (2026-08-08実測)、モデル出力がAppSpec DSLに収まっている保証はプロンプト頼みになる。
// このモジュールはその穴をアプリ側で塞ぐ: claude-live.ts が最終JSONのパース直後・
// toAppSpec の前に validateAnalyzeOutput() を実行し、違反があれば throw して
// 既存の「ライブ失敗→デモフォールバック」連鎖に流す。
//
// ajv は直接依存ではない(eslint 経由の推移的依存 v6.15.0 が居るだけ)ため、
// それに寄りかからず、ANALYZE_OUTPUT_JSON_SCHEMA が使うキーワードだけを実装した検証器を置く。
// 「対応していないキーワードに出会ったら黙って通さず throw する」設計にして、
// スキーマが育ったときにバリデータがザルになる事故を防いでいる。
// この検証器自体の妥当性は appspec.test.ts の「テスト基盤の自己検証」describe が担保する。
//
// 純粋関数のみで構成されており、サーバー/クライアント両用可。
// 実行コストはLLM出力サイズに線形で無視できる。

import { ANALYZE_OUTPUT_JSON_SCHEMA } from "./appspec";

/**
 * `as const` により ANALYZE_OUTPUT_JSON_SCHEMA は deeply readonly。
 * 汎用の再帰処理では構造を型で辿れないので、緩い SchemaNode へ1回だけ落とす。
 * (appspec.ts 側の const 型は appspec.test.ts の個別 assert が literal 型として参照する)
 */
export interface SchemaNode {
  type?: string | readonly string[];
  properties?: Readonly<Record<string, SchemaNode>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  // draft-07 のタプル形式 items に備えて配列も許す（このスキーマでは未使用）。
  // Array.isArray が readonly 配列を絞り込めないため、あえて mutable 配列で宣言している。
  items?: SchemaNode | SchemaNode[];
  enum?: readonly unknown[];
  anyOf?: readonly SchemaNode[];
  description?: string;
}

/**
 * 汎用走査・バリデーション用の緩いビュー（読み取り専用で使うこと）。
 * `as unknown as SchemaNode` のcastはこのモジュールの1箇所に閉じ込める。
 */
export const ANALYZE_OUTPUT_SCHEMA = ANALYZE_OUTPUT_JSON_SCHEMA as unknown as SchemaNode;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface WalkHit {
  path: string;
  node: SchemaNode;
}

/**
 * スキーマを再帰的に走査し、述語に一致したノードの JSON パスを返す。
 * properties / items / anyOf / oneOf / allOf / $defs をすべて辿る。
 */
export function walkSchema(root: SchemaNode, isTarget: (n: SchemaNode) => boolean): WalkHit[] {
  const hits: WalkHit[] = [];

  const visit = (raw: unknown, path: string): void => {
    if (!isPlainObject(raw)) return;
    const node = raw as SchemaNode;
    if (isTarget(node)) hits.push({ path, node });

    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) {
        visit(sub, `${path}.properties.${key}`);
      }
    }
    if (Array.isArray(node.items)) {
      node.items.forEach((sub, i) => visit(sub, `${path}.items[${i}]`));
    } else if (node.items) {
      visit(node.items, `${path}.items`);
    }
    for (const kw of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = (node as Record<string, unknown>)[kw];
      if (Array.isArray(branches)) {
        branches.forEach((sub, i) => visit(sub, `${path}.${kw}[${i}]`));
      }
    }
    const defs = (node as Record<string, unknown>).$defs;
    if (isPlainObject(defs)) {
      for (const [key, sub] of Object.entries(defs)) visit(sub, `${path}.$defs.${key}`);
    }
  };

  visit(root, "$");
  return hits;
}

/** type を配列/単体/未定義で正規化したうえで「オブジェクト型ノード」を判定する */
export function isObjectNode(node: SchemaNode): boolean {
  const types = Array.isArray(node.type)
    ? node.type
    : node.type === undefined
      ? []
      : [node.type as string];
  return types.includes("object") || node.properties !== undefined;
}

export const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
  "description",
]);

export interface ValidationError {
  path: string;
  keyword: string;
}

function matchesType(t: string, data: unknown): boolean {
  switch (t) {
    case "object":
      return isPlainObject(data);
    case "array":
      return Array.isArray(data);
    case "string":
      return typeof data === "string";
    case "number":
      return typeof data === "number" && Number.isFinite(data);
    case "integer":
      return Number.isInteger(data);
    case "boolean":
      return typeof data === "boolean";
    case "null":
      return data === null;
    default:
      throw new Error(`ミニバリデータ未対応の type: ${t}`);
  }
}

export function validate(schema: SchemaNode, data: unknown, path = "$"): ValidationError[] {
  for (const kw of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(kw)) {
      throw new Error(`ミニバリデータ未対応のキーワード: ${kw} (@${path})`);
    }
  }

  const errors: ValidationError[] = [];

  if (schema.anyOf) {
    const someBranchPasses = schema.anyOf.some((sub) => validate(sub, data, path).length === 0);
    if (!someBranchPasses) errors.push({ path, keyword: "anyOf" });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type as string];
    if (!types.some((t) => matchesType(t, data))) {
      // 型が違う時点で以降のキーワードは評価しない（無関係なエラーの雪崩を防ぐ）
      return [...errors, { path, keyword: "type" }];
    }
  }

  if (schema.enum && !schema.enum.some((v) => Object.is(v, data))) {
    errors.push({ path, keyword: "enum" });
  }

  // required / properties / additionalProperties は JSON Schema 上
  // 「実インスタンスがオブジェクトのとき」のみ適用される。
  // lineItems: null のケースで inert になるのはこの分岐のおかげ。
  if (isPlainObject(data)) {
    for (const key of schema.required ?? []) {
      if (!(key in data)) errors.push({ path: `${path}.${key}`, keyword: "required" });
    }
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      if (key in props) {
        errors.push(...validate(props[key], value, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, keyword: "additionalProperties" });
      }
    }
  }

  if (Array.isArray(data) && schema.items && !Array.isArray(schema.items)) {
    const itemSchema = schema.items;
    data.forEach((item, i) => errors.push(...validate(itemSchema, item, `${path}[${i}]`)));
  }

  return errors;
}

/**
 * ライブ解析の最終JSONを ANALYZE_OUTPUT_JSON_SCHEMA で検証する。
 * 生成途中の部分バッファには適用しないこと(required欠落が正常なため)。
 */
export function validateAnalyzeOutput(data: unknown): ValidationError[] {
  return validate(ANALYZE_OUTPUT_SCHEMA, data);
}
