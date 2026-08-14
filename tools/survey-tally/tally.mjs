// リサーチパネル アンケート集計( の事前凍結規則を機械実装)
// 使い方: node tools/survey-tally/tally.mjs <回答CSVパス>
// 出力: 集計のみ(ニックネーム等の個人特定情報は出力しない)。
// 規則(データを見る前に凍結済み・):
//   - クリーニング: 問2「扱っていない」+問3作業肢 / 問3「転記していない」+作業肢の併選 → 除外(件数開示)
//   - 保守カウント: 選んだ帯の下限 ≥ 980円(税抜)×種類数 の場合のみ「内側」
//     (1種→月2,000円まで以上 / 2〜3種→月3,000円まで以上 / 4種以上→月5,000円まで以上)
//   - %表記は分母20以上のみ。10〜19は実数のみ。5未満は凍結値にしない
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) { console.error("usage: node tally.mjs <csv>"); process.exit(1); }

// 最小CSVパーサ(引用符・カンマ内包対応)
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const rows = parseCsv(readFileSync(path, "utf8"));
const header = rows[0];
const col = (kw) => header.findIndex((h) => h.includes(kw));
const iQ1 = col("どの立場"), iQ2 = col("何種類"), iQ3 = col("あてはまるものをすべて"), iQ4 = col("月額いくら");
const data = rows.slice(1).map((r) => ({ q1: r[iQ1], q2: r[iQ2], q3: r[iQ3], q4: r[iQ4] }));

const WORK = ["手入力している", "データ化していない", "使うのをやめた", "現在も使っている", "依頼している"];
const hasWork = (q3) => WORK.some((w) => q3.includes(w));
const excluded = data.filter(
  (d) => (d.q2 === "扱っていない" && hasWork(d.q3)) || (d.q3.includes("転記の作業はしていない") && hasWork(d.q3)),
);
const clean = data.filter((d) => !excluded.includes(d));
const n = clean.length;

const BANDS = ["金額によらず使わない", "無料なら使いたい", "月500円まで", "月1,000円まで", "月2,000円まで", "月3,000円まで", "月5,000円まで", "月5,000円を超えても検討する"];
const bandIdx = (q4) => BANDS.indexOf(q4);
const pct = (num, den) => (den >= 20 ? ` (${Math.round((num / den) * 100)}%)` : "");

console.log(`# アンケート集計 — 回答 ${data.length} 件 / 除外 ${excluded.length} 件(規則該当) / 集計対象 n=${n}`);
console.log(`実行: ${path.split("/").pop()}\n`);

// 問4分布
console.log("## 問4 支払意向帯(集計対象全体)");
for (const b of BANDS) {
  const c = clean.filter((d) => d.q4 === b).length;
  if (c) console.log(`  ${b}: ${c}${pct(c, n)}`);
}
const pay1000 = clean.filter((d) => bandIdx(d.q4) >= 3).length;
console.log(`  → 月1,000円以上の帯: ${pay1000}/${n}${pct(pay1000, n)}\n`);

// 問1×問4
const DECIDER = ["自分で決められる", "上申すれば通る"];
const dec = clean.filter((d) => DECIDER.some((k) => d.q1.includes(k)));
const decPay = dec.filter((d) => bandIdx(d.q4) >= 3);
console.log(`## 問1×問4(②の主クロス)`);
console.log(`  決裁に関与する回答者 ${dec.length} 人中、月1,000円以上の帯 ${decPay.length} 人${pct(decPay.length, dec.length)}\n`);

// 問2×問4 保守カウント
const NEED = { "1種類": 4, "2〜3種類": 5, "4〜5種類": 6, "6〜10種類": 6, "11種類以上": 6 };
const inside = clean.filter((d) => NEED[d.q2] !== undefined && bandIdx(d.q4) >= NEED[d.q2]);
console.log(`## 問2×問4 保守カウント(帯の下限 ≥ 980円(税抜)×種類数)`);
console.log(`  「内側」: ${inside.length}/${n}${pct(inside.length, n)}\n`);

// 3×3縮約
const KIND = (q2) => (q2 === "1種類" ? "1種" : q2 === "2〜3種類" ? "2〜3種" : "4種以上");
const BAND3 = (q4) => (bandIdx(q4) <= 4 ? "〜月2,000円" : q4 === "月3,000円まで" ? "月3,000円" : "月5,000円〜");
console.log("## 3×3縮約(種類数×意向帯・実数)");
const kinds = ["1種", "2〜3種", "4種以上"], bands3 = ["〜月2,000円", "月3,000円", "月5,000円〜"];
console.log(`  ${"".padEnd(8)}${bands3.map((b) => b.padStart(11)).join("")}`);
for (const k of kinds) {
  const cells = bands3.map((b) => String(clean.filter((d) => KIND(d.q2) === k && BAND3(d.q4) === b).length).padStart(11));
  console.log(`  ${k.padEnd(8)}${cells.join("")}`);
}

// 問3(競合実態)
console.log("\n## 問3 現在の対処(複数選択・集計対象全体)");
const OPTS = ["Excelや会計ソフトなどへ手入力している", "紙のままファイリングして、データ化していない", "OCRや読み取りアプリを試したことがあるが、使うのをやめた", "OCR・読み取りサービスを現在も使っている", "外部(事務代行・スキャン代行など)に依頼している", "転記の作業はしていない"];
for (const o of OPTS) {
  const c = clean.filter((d) => d.q3.includes(o)).length;
  if (c) console.log(`  ${o}: ${c}${pct(c, n)}`);
}

// 種類数分布(1者1帳票前提の保守性の定性根拠)
console.log("\n## 問2 種類数分布");
for (const k of ["1種類", "2〜3種類", "4〜5種類", "6〜10種類", "11種類以上", "扱っていない"]) {
  const c = clean.filter((d) => d.q2 === k).length;
  if (c) console.log(`  ${k}: ${c}${pct(c, n)}`);
}
console.log("\n※限定句: 自主アンケート(リサーチパネル経由)。自己選択・自己申告バイアスあり。全事業者の割合ではない。支払意向は自己申告であり購買実績ではない。");
