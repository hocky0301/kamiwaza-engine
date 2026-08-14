#!/usr/bin/env node
// 検証用サンプル帳票(5種類)を HTML→スクリーンショットで samples/ に生成する。
// 内容は全て架空(実在の社名・住所・電話番号を含めない。電話は 0X0-5550 系のダミー帯)。
// 制約: リポジトリに playwright 依存を持ち込まない。playwright-core は NODE_PATH 経由の
// require で借りる(例: NODE_PATH=<外部のnode_modules> node gen-samples.mjs)。
// 画像はクライアント送信と同条件の 長辺1600px JPEG q0.85 で出力する。

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "samples");
const require = createRequire(import.meta.url);

// A4縦・長辺1600px(クライアントの縮小後サイズに合わせる)
const VIEWPORT = { width: 1131, height: 1600 };

function resolveChromium() {
  if (process.env.COST_BATCH_CHROMIUM) return process.env.COST_BATCH_CHROMIUM;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (existsSync(cache)) {
    const { readdirSync } = require("node:fs");
    for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const p = path.join(
        cache, dir,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      if (existsSync(p)) return p;
    }
  }
  for (const p of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (existsSync(p)) return p;
  }
  return null; // playwright 管理のブラウザに任せる
}

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px;
    background: #fff; color: #1a1a1a;
    font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
    font-size: 22px; padding: 70px 80px;
  }
  h1 { font-size: 44px; letter-spacing: 18px; text-align: center; margin-bottom: 40px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #333; padding: 10px 14px; }
  th { background: #eef1f5; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .meta { text-align: right; margin-bottom: 24px; line-height: 1.7; }
  .to { font-size: 30px; border-bottom: 2px solid #333; display: inline-block; padding: 0 8px 4px 0; margin-bottom: 10px; }
  .from { line-height: 1.7; }
  .cols { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 36px; }
  .total-box { border: 2px solid #333; padding: 14px 24px; font-size: 30px; margin: 28px 0; display: inline-block; }
  .stamp {
    width: 84px; height: 84px; border: 3px solid #c0392b; border-radius: 50%;
    color: #c0392b; display: flex; align-items: center; justify-content: center;
    font-size: 26px; transform: rotate(-6deg); margin-left: 16px;
  }
  .note { margin-top: 28px; line-height: 1.8; font-size: 20px; }
  .sign { display: flex; gap: 0; margin: 24px 0 32px; }
  .sign div { border: 1px solid #333; width: 120px; text-align: center; }
  .sign .label { border-bottom: 1px solid #333; background: #eef1f5; font-size: 18px; padding: 4px; }
  .sign .box { height: 90px; }
`;

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${body}</body></html>`;

const itemsTable = (rows, unitHeader = "単価") => `
  <table>
    <tr><th style="width:52%">品名</th><th>数量</th><th>${unitHeader}</th><th>金額(円)</th></tr>
    ${rows
      .map(
        ([name, qty, unit, amount]) =>
          `<tr><td>${name}</td><td class="num">${qty}</td><td class="num">${unit}</td><td class="num">${amount}</td></tr>`,
      )
      .join("")}
  </table>`;

const DOCS = [
  {
    file: "01-seikyusho.jpg",
    body: `
      <h1>請求書</h1>
      <div class="meta">請求書番号: INV-2026-0731-018<br>発行日: 2026年7月31日<br>お支払期限: 2026年8月31日</div>
      <div class="cols">
        <div>
          <div class="to">株式会社オルカ精密 御中</div>
          <div>下記のとおりご請求申し上げます。</div>
        </div>
        <div style="display:flex">
          <div class="from">
            ハリネズミ化成株式会社<br>
            〒000-0001 東京都架空区海風1-2-3<br>
            TEL: 030-5550-0142 / FAX: 030-5550-0143<br>
            登録番号: T0000000000001
          </div>
          <div class="stamp">化成<br>之印</div>
        </div>
      </div>
      <div class="total-box">ご請求金額: ¥269,500(税込)</div>
      ${itemsTable([
        ["樹脂ペレット AK-101(25kg袋)", "40", "3,200", "128,000"],
        ["帯電防止マスターバッチ MB-7", "12", "8,500", "102,000"],
        ["出荷前検査費(一式)", "1", "15,000", "15,000"],
      ])}
      <table style="width:46%; margin-left:auto; margin-top:16px">
        <tr><th>小計</th><td class="num">245,000</td></tr>
        <tr><th>消費税(10%)</th><td class="num">24,500</td></tr>
        <tr><th>合計</th><td class="num">269,500</td></tr>
      </table>
      <div class="note">
        お振込先: シロクマ銀行 架空支店 普通 1234567 ハリネズミカセイ(カ<br>
        ※ 恐れ入りますが振込手数料は貴社にてご負担願います。
      </div>`,
  },
  {
    file: "02-hachusho.jpg",
    body: `
      <h1>発注書</h1>
      <div class="meta">発注番号: PO-26-0805-042<br>発注日: 2026年8月5日</div>
      <div class="cols">
        <div>
          <div class="to">ペンギンパーツ工業株式会社 御中</div>
          <div>下記のとおり発注いたします。</div>
        </div>
        <div style="display:flex">
          <div class="from">
            株式会社オルカ精密 資材部<br>
            〒000-0002 神奈川県架空市港町4-5-6<br>
            TEL: 030-5550-0287<br>
            担当: 資材部 調達課
          </div>
          <div class="stamp">オルカ<br>資材</div>
        </div>
      </div>
      <div class="sign">
        <div><div class="label">承認</div><div class="box"></div></div>
        <div><div class="label">確認</div><div class="box"></div></div>
        <div><div class="label">担当</div><div class="box"></div></div>
      </div>
      ${itemsTable([
        ["精密ギア G-204", "500", "120", "60,000"],
        ["ベアリングホルダ BH-11", "200", "340", "68,000"],
        ["六角スペーサ M3×12", "1,000", "18", "18,000"],
      ])}
      <table style="width:46%; margin-left:auto; margin-top:16px">
        <tr><th>小計</th><td class="num">146,000</td></tr>
        <tr><th>消費税(10%)</th><td class="num">14,600</td></tr>
        <tr><th>合計</th><td class="num">160,600</td></tr>
      </table>
      <div class="note">
        納期: 2026年8月20日 / 納入場所: 当社 第2工場(神奈川県架空市港町4-5-8)<br>
        支払条件: 月末締め翌月末振込 / 備考: G-204 は分納可(初回250個以上)
      </div>`,
  },
  {
    file: "03-mitsumorisho.jpg",
    body: `
      <h1>御見積書</h1>
      <div class="meta">見積番号: EST-2026-0803-11<br>発行日: 2026年8月3日<br>有効期限: 発行後30日</div>
      <div class="cols">
        <div>
          <div class="to">株式会社オルカ精密 御中</div>
          <div>下記のとおりお見積り申し上げます。</div>
        </div>
        <div style="display:flex">
          <div class="from">
            カワセミ電装株式会社 営業部<br>
            〒000-0003 千葉県架空市青葉2-7-1<br>
            TEL: 030-5550-0193 / FAX: 030-5550-0194<br>
            登録番号: T0000000000002
          </div>
          <div class="stamp">カワセミ<br>電装</div>
        </div>
      </div>
      <div class="total-box">御見積金額: ¥101,200(税込)</div>
      ${itemsTable([
        ["ワイヤーハーネス WH-330 試作品", "10", "4,800", "48,000"],
        ["コネクタ圧着加工費", "10", "900", "9,000"],
        ["専用治具製作費(一式)", "1", "35,000", "35,000"],
      ])}
      <table style="width:46%; margin-left:auto; margin-top:16px">
        <tr><th>小計</th><td class="num">92,000</td></tr>
        <tr><th>消費税(10%)</th><td class="num">9,200</td></tr>
        <tr><th>合計</th><td class="num">101,200</td></tr>
      </table>
      <div class="note">
        納期: 御発注後3週間 / 受渡場所: 貴社指定場所 / 支払条件: 従来どおり<br>
        備考: 量産移行時(500本/月以上)は単価を別途お見積りいたします。
      </div>`,
  },
  {
    file: "04-nohinsho.jpg",
    body: `
      <h1>納品書</h1>
      <div class="meta">伝票番号: DN-26-0808-107<br>納品日: 2026年8月8日</div>
      <div class="cols">
        <div>
          <div class="to">株式会社オルカ精密 御中</div>
          <div>下記のとおり納品いたします。ご査収ください。</div>
        </div>
        <div style="display:flex">
          <div class="from">
            ペンギンパーツ工業株式会社<br>
            〒000-0004 埼玉県架空市機屋3-9-2<br>
            TEL: 030-5550-0366<br>
            登録番号: T0000000000003
          </div>
          <div class="stamp">ペンギン<br>出荷</div>
        </div>
      </div>
      <div class="note" style="margin:0 0 20px">貴社発注番号: PO-26-0805-042(分納 1回目/全2回)</div>
      ${itemsTable([
        ["精密ギア G-204", "250", "120", "30,000"],
        ["六角スペーサ M3×12", "1,000", "18", "18,000"],
      ])}
      <table style="width:46%; margin-left:auto; margin-top:16px">
        <tr><th>合計(税抜)</th><td class="num">48,000</td></tr>
      </table>
      <div class="note">
        備考: G-204 残数 250 個は 2026年8月末 納品予定。<br>
        本伝票は納品の証憑です。請求書は月末締めで別途送付いたします。
      </div>`,
  },
  {
    file: "05-keihiseisan.jpg",
    body: `
      <h1>経費精算書</h1>
      <div class="meta">申請日: 2026年8月7日<br>申請番号: EXP-2026-0807-3</div>
      <div class="cols">
        <div class="from" style="font-size:24px">
          所属: 株式会社オルカ精密 製造部<br>
          氏名: 架空 太郎<br>
          出張件名: 汐風工場 設備立会い(8/3〜8/4)
        </div>
        <div class="sign" style="margin:0">
          <div><div class="label">部長</div><div class="box"></div></div>
          <div><div class="label">課長</div><div class="box"></div></div>
          <div><div class="label">申請者</div><div class="box" style="display:flex;align-items:center;justify-content:center">架空</div></div>
        </div>
      </div>
      <table>
        <tr><th>日付</th><th>費目</th><th style="width:44%">内容</th><th>金額(円)</th></tr>
        <tr><td>8/3</td><td>交通費</td><td>かもめ電鉄 架空駅⇔汐風駅 往復</td><td class="num">1,240</td></tr>
        <tr><td>8/4</td><td>宿泊費</td><td>ホテルシロクマ汐風 1泊</td><td class="num">9,800</td></tr>
        <tr><td>8/4</td><td>会議費</td><td>打合せ喫茶代(2名)</td><td class="num">1,760</td></tr>
        <tr><td>8/6</td><td>交通費</td><td>タクシー(検査治具持込のため)</td><td class="num">3,400</td></tr>
      </table>
      <table style="width:46%; margin-left:auto; margin-top:16px">
        <tr><th>合計</th><td class="num">16,200</td></tr>
      </table>
      <div class="note">
        精算方法: 給与合算(8月25日支給分) / 領収書: 4枚添付<br>
        備考: タクシー利用は治具運搬のため課長事前承認済み。
      </div>`,
  },
];

async function main() {
  const { chromium } = require("playwright-core");
  await mkdir(OUT_DIR, { recursive: true });
  const executablePath = resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const pg = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    for (const doc of DOCS) {
      await pg.setContent(page(doc.body), { waitUntil: "networkidle" });
      const out = path.join(OUT_DIR, doc.file);
      await pg.screenshot({ path: out, type: "jpeg", quality: 85 });
      console.log(`生成: ${out}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
