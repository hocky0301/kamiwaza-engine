// ライブモード: Claude Vision で実際の帳票写真を解析する(サーバー専用)。
// structured outputs でAppSpec DSLに制約した出力をストリーミングし、
// 途中経過をデモモードと同じ AnalyzeEvent 列として流す。
//
// LLM経路は llm-client.ts のファクトリが解決する(OrcaRouter / 直接Anthropic)。
// OrcaRouter経路では structured outputs が握りつぶされるため、
// フェンス耐性パーサ(partial-json.ts)とアプリ側スキーマ検証(validate-spec.ts)で防御する。

import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import {
  ANALYZE_OUTPUT_JSON_SCHEMA,
  toAppSpec,
  type AnalyzeOutput,
  type FieldSpec,
} from "./appspec";
import type { AnalyzeEvent, LlmUsage } from "./events";
import { getLlmClient } from "./llm-client";
import { estimateCostUsd, getModelRates, warmPricingCache } from "./llm-pricing";
import { extractBalancedJson, stripCodeFences, tryParsePartial } from "./partial-json";
import { parseRotationResponse, resolveRotationVotes, type Rotation } from "./rotation";
import { validateAnalyzeOutput } from "./validate-spec";

const SYSTEM_PROMPT = `あなたは「カミワザ」— 紙の帳票の写真から業務アプリの仕様(AppSpec)を生成するエンジンです。
渡された帳票画像を解析し、スキーマに従ったJSONだけを出力してください。

ルール:
- fields は帳票の上から下の順に並べる。id は英小文字スネークケース。label は帳票の記載に忠実な日本語
- 手書きの記入値は firstRecord に {fieldId, value} として入れる。date は YYYY-MM-DD(年の記載が無ければ2026年とみなす)、number は数字のみの文字列、checkbox/stamp は "true" / "false"
- sourceBox は画像全体に対する%座標(左上原点、0-100)。その項目のラベルと記入値を囲む範囲
- confidence はその項目の読み取り確度(0-1)。かすれ・判読困難・業務上の意味の曖昧さがあれば正直に下げる
- 品目・行単位の明細テーブルがある帳票では lineItems に列定義を、lineRows に全行の値を入れる(各行は columns と同順の文字列配列、空欄は空文字列)。明細の値を fields に重複させない。合計金額・小計などのサマリ値は fields へ
- 明細が20行を超える場合は主要20行までにし、最終行の品名欄に「ほか◯行」と書く。明細テーブルが無い帳票は lineItems: null, lineRows: []
- 数値は小数点とカンマ(桁区切り)を厳密に区別する(重量・単価・数量は小数を含みうる。例: 1,096.100 は 1096.1)
- 社名・人名の旧字体・異体字(鐵・榮・髙・﨑 など)は新字体に置き換えず、そのまま読み取る
- 印鑑欄・承認欄が読み取れる場合のみ approvalFlow に自然な承認ステップ(起票+最大2段)を設定。無ければ null
- aggregations はこの業務のダッシュボードに出すと有用な集計を最大3つ
- appName は簡潔な業務アプリ名、icon はこの業務を表す絵文字1文字、description は業務の一行説明`;

type SupportedMedia = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const SUPPORTED_MEDIA: SupportedMedia[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

/** usage合算(回転検出+本解析)。フィールドがnullのAPI応答は0として扱う */
function addUsage(total: LlmUsage, u: Anthropic.Usage | null | undefined): void {
  if (!u) return;
  total.inputTokens += u.input_tokens ?? 0;
  total.outputTokens += u.output_tokens ?? 0;
  total.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
  total.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
}

function isCompleteField(f: unknown): f is FieldSpec {
  if (!f || typeof f !== "object") return false;
  const o = f as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.type === "string" &&
    typeof o.confidence === "number"
  );
}

/**
 * 文書の向きを検出する。FAXスキャンは本文が90°/180°回転していることがある
 * (FAXヘッダだけ正向きのケースもあるため、本文基準で判定させる)。
 * 返り値は「時計回りに何度回すと正しい向きになるか」。
 */
async function askRotationOnce(
  client: Anthropic,
  model: string,
  data: string,
  mediaType: SupportedMedia,
): Promise<{ vote: Rotation | null; usage: Anthropic.Usage | null }> {
  const res = await client.messages.create({
    model,
    max_tokens: 200,
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            rotation: {
              type: "integer",
              enum: [0, 90, 180, 270],
              description: "時計回りに回転させるべき角度",
            },
          },
          required: ["rotation"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          },
          {
            type: "text",
            // OrcaRouter経路では output_config が透過されずスキーマ強制が効かないため、
            // 出力形式の指示をプロンプト本文にも重ねて書く(F07)
            text: 'この事務書類のスキャン画像を、本文が正しく読める向きにするには時計回りに何度回転させる必要がありますか。注意: FAX送信ヘッダ(最上部の細い送信情報行)は本文と逆向きに印字されることがあります。必ず本文(タイトル・表・記入内容)の向きを基準に判定してください。回答は {"rotation": 0} のようなJSONのみで返してください(0/90/180/270のいずれか)。説明文は不要です。',
          },
        ],
      },
    ],
  });
  const usage = res.usage ?? null;
  if (res.stop_reason === "refusal") return { vote: 0, usage };
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) return { vote: null, usage }; // 空content(2026-08-09実測)は判定不能扱い
  return { vote: parseRotationResponse(text), usage };
}

async function detectRotation(
  client: Anthropic,
  model: string,
  data: string,
  mediaType: SupportedMedia,
): Promise<{ rotation: 0 | 90 | 180 | 270; usage: Anthropic.Usage | null }> {
  // 1回目の判定。0(または判定不能)なら追加コストゼロでそのまま採用。
  const first = await askRotationOnce(client, model, data, mediaType);
  if (!first.vote) return { rotation: 0, usage: first.usage };
  // 非ゼロ判定のみ二重確認: 画像を見ずに妥当なJSONを返す誤判定が実測されており(F07)、
  // 誤回転は読み取り崩壊を誘発するため、2回の合議一致時のみ適用する。
  const second = await askRotationOnce(client, model, data, mediaType);
  const merged: Anthropic.Usage | null = first.usage
    ? {
        ...first.usage,
        input_tokens: (first.usage.input_tokens ?? 0) + (second.usage?.input_tokens ?? 0),
        output_tokens: (first.usage.output_tokens ?? 0) + (second.usage?.output_tokens ?? 0),
        cache_creation_input_tokens:
          (first.usage.cache_creation_input_tokens ?? 0) +
          (second.usage?.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens:
          (first.usage.cache_read_input_tokens ?? 0) +
          (second.usage?.cache_read_input_tokens ?? 0),
      }
    : second.usage;
  return { rotation: resolveRotationVotes(first.vote, second.vote), usage: merged };
}

export async function streamLiveAnalysis(
  image: { data: string; mediaType: string },
  emit: (e: AnalyzeEvent) => void,
): Promise<void> {
  let mediaType = SUPPORTED_MEDIA.includes(image.mediaType as SupportedMedia)
    ? (image.mediaType as SupportedMedia)
    : "image/jpeg";
  let imageData = image.data;

  const llm = getLlmClient();
  if (!llm) throw new Error("LLMのAPIキーが設定されていません");
  const { client, model } = llm;
  console.log(`live analysis via ${llm.route} (${model})`);
  // 原価チップ用の単価を先に温める(解析中に取得が終わり、done発行時の待ちゼロ)
  warmPricingCache(llm.route);

  const usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  emit({ type: "phase", label: "画像を受信しました" });
  emit({ type: "phase", label: "文書の向きを確認しています…" });

  try {
    const { rotation, usage: rotationUsage } = await detectRotation(
      client,
      model,
      imageData,
      mediaType,
    );
    addUsage(usage, rotationUsage);
    if (rotation !== 0) {
      const rotated = await sharp(Buffer.from(imageData, "base64"))
        .rotate(rotation)
        .jpeg({ quality: 88 })
        .toBuffer();
      imageData = rotated.toString("base64");
      mediaType = "image/jpeg";
      emit({
        type: "phase",
        label: `${rotation}°回転した文書を検出 — 向きを自動補正しました`,
      });
      emit({ type: "image", dataUrl: `data:image/jpeg;base64,${imageData}` });
    }
  } catch (err) {
    // 向き検出はベストエフォート。失敗しても元画像で解析を続行する
    console.error("rotation detection failed:", err);
  }

  emit({ type: "phase", label: "Claude Vision が帳票を読み取っています…(ライブ)" });

  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: ANALYZE_OUTPUT_JSON_SCHEMA,
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageData },
          },
          {
            type: "text",
            text: "この帳票画像を解析して、AppSpecを生成してください。",
          },
        ],
      },
    ],
  });

  let buffer = "";
  let metaEmitted = false;
  let emittedFields = 0;

  stream.on("text", (delta) => {
    buffer += delta;
    const parsed = tryParsePartial(buffer);
    if (!parsed) return;

    // スキーマ順で fields は description の直後。"fields":[ が現れた時点で
    // description の文字列が実際に閉じている(=切断されていない)ことが保証される
    if (
      !metaEmitted &&
      Array.isArray(parsed.fields) &&
      typeof parsed.appName === "string" &&
      typeof parsed.icon === "string" &&
      typeof parsed.description === "string"
    ) {
      metaEmitted = true;
      emit({
        type: "meta",
        appName: parsed.appName,
        icon: parsed.icon,
        description: parsed.description,
      });
    }

    if (Array.isArray(parsed.fields)) {
      // 最後の要素は生成途中の可能性があるため、それ以外の完成済みフィールドを流す
      const completeCount = Math.max(0, parsed.fields.length - 1);
      for (let i = emittedFields; i < completeCount; i++) {
        const f = parsed.fields[i];
        if (isCompleteField(f)) {
          emit({ type: "field", field: f });
          emittedFields = i + 1;
        }
      }
    }
  });

  const final = await stream.finalMessage();
  addUsage(usage, final.usage);

  if (final.stop_reason === "refusal") {
    throw new Error("解析リクエストが拒否されました");
  }
  if (final.stop_reason === "max_tokens") {
    throw new Error("出力がトークン上限に達しました(明細が多すぎる帳票の可能性)");
  }

  const text = final.content.find((b) => b.type === "text")?.text ?? "";
  // OrcaRouter経路では```jsonフェンス付きで返るため、除去してからパースする。
  // それでも失敗する場合(閉じフェンスの後に散文が続く等)は、括弧の対応が取れた
  // 先頭のJSONだけを取り出して再試行する(直接Anthropic経路の生JSONはここに来ない)
  const stripped = stripCodeFences(text);
  let output: AnalyzeOutput;
  try {
    output = JSON.parse(stripped) as AnalyzeOutput;
  } catch {
    const rescued = extractBalancedJson(stripped);
    if (!rescued) throw new Error("LLM応答からJSONを取り出せませんでした");
    output = JSON.parse(rescued) as AnalyzeOutput;
  }

  // アプリ側スキーマ強制: サーバー側スキーマ強制が効かない経路(OrcaRouter)でも
  // 出力がAppSpec DSLに収まっていることを保証する。違反時はthrowして
  // 既存の「ライブ失敗→デモフォールバック」連鎖に流す(新しい失敗モードは作らない)。
  // 部分バッファには適用しない(生成途中のrequired欠落は正常)。
  const violations = validateAnalyzeOutput(output);
  emit({ type: "validation", ok: violations.length === 0, violations: violations.length });
  if (violations.length > 0) {
    const detail = violations
      .slice(0, 5)
      .map((v) => `${v.keyword}@${v.path}`)
      .join(", ");
    throw new Error(`出力がスキーマ検証に失敗 (${violations.length}件: ${detail})`);
  }

  const spec = toAppSpec(output);

  if (!metaEmitted) {
    emit({
      type: "meta",
      appName: spec.appName,
      icon: spec.icon,
      description: spec.description,
    });
  }
  for (let i = emittedFields; i < spec.fields.length; i++) {
    emit({ type: "field", field: spec.fields[i] });
  }

  // 信頼度の低い項目があれば逆質問(賢さの証明+幻覚の混入防止)
  const lowConf = spec.fields.find((f) => f.confidence < 0.7);
  if (lowConf) {
    emit({
      type: "question",
      fieldId: lowConf.id,
      question: `「${lowConf.label}」の読み取り信頼度が ${Math.round(lowConf.confidence * 100)}% です。この項目をアプリに含めますか?`,
      choices: ["はい、含める", "いいえ、除外する"],
    });
  }

  if (spec.lineItems) {
    emit({
      type: "lineitems",
      spec: spec.lineItems,
      rowCount: spec.firstRecordLines.length,
    });
  }
  emit({ type: "approval", flow: spec.approvalFlow });
  for (const agg of spec.aggregations) {
    emit({ type: "aggregation", agg });
  }
  emit({ type: "record", record: spec.firstRecord, lines: spec.firstRecordLines });
  emit({ type: "phase", label: "紙に書かれていた内容を 1件目のデータとして登録しました" });
  // 推定原価: トークン実測×公表単価の保守的上限(課金の正はダッシュボード)。
  // getModelRates は絶対に throw しない(失敗時は定数$5/$25にフォールバック)
  const { rates, source } = await getModelRates(model, llm.route);
  emit({
    type: "done",
    spec,
    mode: "live",
    usage,
    llmRoute: llm.route,
    costUsd: estimateCostUsd(usage, rates),
    pricingSource: source,
  });
}
