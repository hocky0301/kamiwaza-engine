// ライブモード: Claude Vision で実際の帳票写真を解析する(サーバー専用)。
// structured outputs でAppSpec DSLに制約した出力をストリーミングし、
// 途中経過をデモモードと同じ AnalyzeEvent 列として流す。

import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import {
  ANALYZE_OUTPUT_JSON_SCHEMA,
  toAppSpec,
  type AnalyzeOutput,
  type FieldSpec,
} from "./appspec";
import type { AnalyzeEvent } from "./events";

const SYSTEM_PROMPT = `あなたは「カミワザ」— 紙の帳票の写真から業務アプリの仕様(AppSpec)を生成するエンジンです。
渡された帳票画像を解析し、スキーマに従ったJSONだけを出力してください。

ルール:
- fields は帳票の上から下の順に並べる。id は英小文字スネークケース。label は帳票の記載に忠実な日本語
- 手書きの記入値は firstRecord に {fieldId, value} として入れる。date は YYYY-MM-DD(年の記載が無ければ2026年とみなす)、number は数字のみの文字列、checkbox/stamp は "true" / "false"
- sourceBox は画像全体に対する%座標(左上原点、0-100)。その項目のラベルと記入値を囲む範囲
- confidence はその項目の読み取り確度(0-1)。かすれ・判読困難・業務上の意味の曖昧さがあれば正直に下げる
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

/**
 * 未完成のJSON文字列を閉じてパースを試みる。
 * ストリーミング中のプログレッシブレンダリングに使う(失敗したらnullで次のトークンを待つ)。
 */
function tryParsePartial(buf: string): Record<string, unknown> | null {
  const candidates = [buf];
  const lastComma = buf.lastIndexOf(",");
  if (lastComma > 0) candidates.push(buf.slice(0, lastComma));

  for (const candidate of candidates) {
    const completed = completeJson(candidate);
    if (!completed) continue;
    try {
      const parsed = JSON.parse(completed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

function completeJson(src: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null; // 壊れたJSON
    }
  }
  let out = src;
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/[\s]+$/, "");
  if (out.endsWith(",")) out = out.slice(0, -1);
  if (out.endsWith(":")) out += "null";
  while (stack.length) out += stack.pop();
  return out;
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
async function detectRotation(
  client: Anthropic,
  data: string,
  mediaType: SupportedMedia,
): Promise<0 | 90 | 180 | 270> {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
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
            text: "この事務書類のスキャン画像を、本文が正しく読める向きにするには時計回りに何度回転させる必要がありますか。注意: FAX送信ヘッダ(最上部の細い送信情報行)は本文と逆向きに印字されることがあります。必ず本文(タイトル・表・記入内容)の向きを基準に判定してください。",
          },
        ],
      },
    ],
  });
  if (res.stop_reason === "refusal") return 0;
  const text = res.content.find((b) => b.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(text) as { rotation: number };
    if ([0, 90, 180, 270].includes(parsed.rotation)) {
      return parsed.rotation as 0 | 90 | 180 | 270;
    }
  } catch {
    // 判定失敗時は回転なしとして続行
  }
  return 0;
}

export async function streamLiveAnalysis(
  image: { data: string; mediaType: string },
  emit: (e: AnalyzeEvent) => void,
): Promise<void> {
  let mediaType = SUPPORTED_MEDIA.includes(image.mediaType as SupportedMedia)
    ? (image.mediaType as SupportedMedia)
    : "image/jpeg";
  let imageData = image.data;

  const client = new Anthropic();

  emit({ type: "phase", label: "画像を受信しました" });
  emit({ type: "phase", label: "文書の向きを確認しています…" });

  try {
    const rotation = await detectRotation(client, imageData, mediaType);
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
    model: "claude-opus-4-8",
    max_tokens: 8000,
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

  if (final.stop_reason === "refusal") {
    throw new Error("解析リクエストが拒否されました");
  }

  const text = final.content.find((b) => b.type === "text")?.text ?? "";
  const output = JSON.parse(text) as AnalyzeOutput;
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

  emit({ type: "approval", flow: spec.approvalFlow });
  for (const agg of spec.aggregations) {
    emit({ type: "aggregation", agg });
  }
  emit({ type: "record", record: spec.firstRecord });
  emit({ type: "phase", label: "紙に書かれていた内容を 1件目のデータとして登録しました" });
  emit({ type: "done", spec, mode: "live" });
}
