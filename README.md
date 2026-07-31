# AI HACKATHON 2026 — カミワザ (KAMIWAZA)

**その紙、30秒で「動くシステム」になる。**(処理時間はライブ実測で中央値27.3秒/枚)

手書き帳票・FAX注文書の写真1枚を、その場で業務アプリ(フォーム/明細テーブル/一覧/承認フロー/ダッシュボード)に変換する Paper-to-App エンジンのプロトタイプ。さらに **「日本語で書いて直す」** — 生成後のアプリを自由文の指示で作り替えられる。[AI HACKATHON 2026 / TOKYO](https://aihackathon.jp)(2026/8/8–8/16)の提出物および事前準備リポジトリ。

- **APIキーなしでデモが最後まで動く**(5シナリオの決定論リプレイ)
- **実スキャン50枚のライブ検証済み** — 全項目正解 96%(48/50)、値レベル 99.87%(1,516/1,518)、幻覚 0件(通算 0/2,225)
- **ユニットテスト 664本**(vitest)

---

## ディレクトリ構成

```
├── app/     プロトタイプ本体(Next.js 16.2.10 / React 19.2.4 / Tailwind v4 /
│            @anthropic-ai/sdk ^0.110.0 / sharp ^0.35.3 / vitest ^4.1.10)
├── docs/    戦略・検証ドキュメント 14本(下表)
├── pitch/   本選ピッチデッキ(生成スクリプト + 機械ゲート + pptx/pdf)
│   ├── deck.js         pptx を生成(スライド面テキストとノートを分離して定義)
│   ├── check_deck.py   凍結値の一致・禁句の不在を機械チェック(exit 0 = 通過)
│   ├── カミワザ_ピッチ.pptx
│   └── カミワザ_ピッチ.pdf
└── .claude/launch.json  dev サーバ起動設定(npm run dev --prefix app / port 3000)
```

**git 管理外(`.gitignore`)**: `docs_private/`(取引先実名・実パスを含むサニタイズ前の原本レポートと50枚検証の生データ)、`会社書類_*/`(実書類そのもの)、`pitch/.check_out/`(機械チェックの抽出結果)、`.env*.local`(APIキー)。**このリポジトリの追跡ファイルには実企業名・実書類・APIキーを一切含めない**方針で運用している(監査記録は `docs/09_public_release_checklist.md`)。

### docs/ 一覧

| ファイル | 内容 |
|---|---|
| `00_hackathon_summary.md` | ハッカソン要項サマリ(日程・審査基準・審査員分析) |
| `01_strategy.md` | プロダクト戦略・コンセプト選定の記録・審査員対策 |
| `02_pitch.md` | 5分ピッチ台本(プロトタイプのデモフローに対応) |
| `03_day1_pivot_playbook.md` | Day1 テーマ発表への即応手順(コア実装は無改修、冒頭2分だけ差し替え) |
| `04_schedule.md` | 事前準備タスクと本番9日間(8/8–8/16)の計画、合格基準と撤退ライン |
| `05_real_docs_insights.md` | 実書類アーカイブ分析(サニタイズ版)+ **ライブ検証の全結果**(初回3枚 / 50枚バッチ v1・v2) |
| `06_claims_ledger.md` | **主張台帳** — 全対外主張を証拠と照合する正本。§3 が凍結値表、§4 が危険ワード表 |
| `07_qa_magazine.md` | 質疑弾倉(全25問)。想定質問 → 3文以内の口頭回答 → 根拠(file:line) |
| `08_demo_storyboard.md` | デモ動画の絵コンテ + ライブデモ進行台本(保険動画の収録指示書を兼ねる) |
| `09_public_release_checklist.md` | リポジトリ public 化の監査表(実名・鍵・個人情報の混入チェック) |
| `10_day_of_playbook.md` | 本番9日間の運用書(時間予算を破ったとき何をどの順で削るか) |
| `11_prompts_for_days.md` | 9日間ぶんの発火条件つきプロンプト集(P0〜P8) |
| `DESIGN_NOTES.md` | **なぜそうなったか** — 設計思想・却下した案・一見おかしなコードの理由 |
| `HANDOFF.md` | **いま何があるか** — 次セッションが最小コンテキストで再開するための引き継ぎ書 |

コードを変更する前に `DESIGN_NOTES.md` を読むこと。検証と敵対的レビューを経て意図的にそうなっている箇所が多い。

---

## 動かし方

```bash
cd app
npm install
npm run dev     # http://localhost:3000
npm test        # ユニットテスト 664本(vitest)
```

その他の scripts: `npm run build` / `npm start` / `npm run lint` / `npm run test:watch`。

### デモモード(APIキー不要)

**APIキーなしで、本番と同じ見た目のストリームが最後まで流れます**(ネットワークも不要)。5種類のサンプル帳票から選ぶと、解析フェーズ → アプリ定義(項目・明細テーブル・承認フロー・集計) → 逆質問 → 1件目データ自動登録 → ダッシュボードまでが決定論的にリプレイされます。本番ピッチの保険であり、同時にテスト対象でもあります。

| id | ラベル | 紙の種別 | 特徴 |
|---|---|---|---|
| `seikyu` | 月締め請求明細書 | 販売管理ソフト印字(実在様式準拠) | **既定表示**。明細行あり・検算ノートつき |
| `chumonsho` | FAX注文書 | 手書き(製造業) | 承認印欄を逆質問 |
| `nippo` | 作業日報 | 手書き(建設業) | 監督確認印を逆質問、残業傾向を検知 |
| `tenken` | 設備点検表 | 手書き(工場) | 逆質問なし。基準値超過の推移を検知 |
| `hacchusho` | 発注書 | 購買システム印字の標準様式 | 明細行あり・検算ノートつき、押印決裁を逆質問 |

定義は `app/src/lib/scenarios.ts`(`SCENARIOS` 配列)。紙のレイアウト・AppSpec・シードデータ・アラート文・逆質問が1シナリオに同梱されている。

### ライブモード(実物の紙を解析)

```bash
# app/.env.local に置くか、環境変数で渡す
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

キーがあると「自分の紙を撮る」が有効になり、Claude Vision(`claude-opus-4-8`)が実画像を解析します。**ライブ解析が失敗した場合は自動でデモリプレイにフォールバック**します(本番ピッチの保険)。キーがない場合、「日本語で書いて直す」の自由文はLLMではなくキーワードフォールバックで解釈されます(提案チップはどちらの場合もローカルで確実に適用されます)。

#### ライブ検証の実績(実測日 2026-07-06)

実在の化学品商社1社の書類アーカイブから、**実スキャン50枚**(手書き見積FAX / 貿易定型帳票 / 印字納品FAX / 複写伝票スキャン / 様式多様な仕入請求書 の5セット × 各10枚、シード固定サンプリング)を抽出してバッチ検証済み。

| 指標 | v1(明細フラット) | **v2(lineItems / 現行)** |
|---|---|---|
| 全項目正解 | 38/50(76%) | **48/50(96%)** |
| 値レベル精度 | 704/707(99.58%) | **1,516/1,518(99.87%)** |
| 失敗 | 1 | **0** |
| 明細行の抽出 | 大半が1行目のみ | **196/196 行(欠落ゼロ)** |
| 幻覚 | 0件 | **0件** — 通算 0/2,225 値 |
| 処理時間(中央値) | 23.3秒/枚 | **27.3秒/枚** |
| 回転補正 | 11/50 で発動・誤発動0 | 同(発動 index の集合が v1 と一致) |

残る欠損2値は旧字体の誤読1件と補助明細の未抽出1件。**開示すべき留保**: 採点は LLM 評価(v1 は 49体採点+自動fail 1、v2 は 50体)。ルーブリックと採点生データは `docs_private/batch50/`(git管理外)にあり提示可能だが、元画像は保存していないため同一セットでの再実行は不可。詳細は `docs/05_real_docs_insights.md`、統計的な言い方の制約(95%CI が重なるため「有意に改善」とは言わない)は `docs/06_claims_ledger.md` §5。

---

## アーキテクチャ

**① 生成パス** — 紙 → 動くアプリ

```
紙の写真
  └─▶ 向き検出(Claude tool use)→ sharp.rotate() で自動補正
        └─▶ image イベントで補正画像をクライアントへ配信
  └─▶ Claude Vision(streaming)
        └─▶ AppSpec DSL(structured outputs で生成を制約)
              ├─ 項目 + 出典バウンディングボックス(幻覚対策)
              ├─ 信頼度スコア → 逆質問ループ(HITL)
              ├─ 明細テーブル(DSL v2: lineItems)
              ├─ 承認フロー / 集計
              └─ 1件目レコード自動登録
                    └─▶ 決定論的レンダラー(React / SpecApp.tsx)
```

**② 再構成パス** — 「日本語で書いて直す」

```
自由文(例:「上長承認をつけて」)
  └─▶ Claude tool use ──┐          キーワードフォールバック ──┐
      (キーあり)         │          (キーなし/失敗時)          │
                        ▼                                     ▼
              SpecDiff — 閉じた6操作だけを発行
              addApprovalStep / setNumberLimit / addField /
              addAggregation / renameField / addFilterColumn
                        │
                        └─▶ applyDiff(純粋関数・決定論的)
                              ├─ 不正な操作は適用されず元の spec を返す
                              ├─ 手術ログに1行ずつ追記
                              └─ 1ユーザー操作 = 1グループの Undo
                                    └─▶ 同じレンダラーへ
```

- **LLMに生コードも spec 全体も書かせない**: 生成時の出力は `src/lib/appspec.ts` の DSL(structured outputs で制約)、再構成時の出力は `src/lib/specdiff.ts` の **6操作だけ**(target には現行 spec の実IDを enum で注入するため、存在しない項目は指定できない)。適用は決定論的な純粋関数で、不正な操作は適用されず元の spec がそのまま返る。**モデルはアプリを壊せない。**
- **デモ/ライブ同一プロトコル**: どちらも同じ SSE イベント列(`src/lib/events.ts`)を流すため、クライアントは接続先を意識しない。デモは `src/lib/demo.ts` が決定論的に生成する。
- **紙とスペックの座標共有**: サンプル帳票の描画(`src/lib/scenarios.ts`)と sourceBox が同じ%座標系のため、出典ハイライトが構造的にズレない。
- **回転補正はベストエフォート**: 向き検出に失敗しても元画像で解析を続行する。FAX ヘッダが本文と逆向きに印字されるケースがあるため、本文基準で判定させている。

---

## 主要ファイル

| ファイル | 行数 | 役割 |
|---|---|---|
| `app/src/lib/appspec.ts` | 301 | AppSpec DSL(型 + structured outputs 用 JSON Schema)。DSL v2 で lineItems 対応 |
| `app/src/lib/specdiff.ts` | 774 | **「日本語で書いて直す」の核** — 閉じた6操作の型定義と決定論的な `applyDiff` |
| `app/src/lib/scenarios.ts` | 811 | デモシナリオ5種(紙レイアウト + AppSpec + シードデータ + 逆質問) |
| `app/src/lib/claude-live.ts` | 322 | Claude Vision ライブ解析(向き検出 → sharp 回転補正 → ストリーミング + 部分JSONパース) |
| `app/src/lib/demo.ts` | 68 | デモモードのイベント列を決定論的に生成 |
| `app/src/lib/events.ts` | 32 | SSE プロトコル定義(デモ/ライブ共通) |
| `app/src/app/api/analyze/route.ts` | 90 | 解析 SSE エンドポイント(デモ/ライブ振り分け + フォールバック) |
| `app/src/app/api/reconfigure/route.ts` | 175 | 自由文 → SpecDiff の SSE エンドポイント(tool use / キーワードフォールバック) |
| `app/src/components/KamiwazaApp.tsx` | 694 | 画面状態機械 + SSE クライアント + パッチ管理(手術ログ・Undo) |
| `app/src/components/SpecApp.tsx` | 848 | 決定論的レンダラー(生成されたアプリの UI) |
| `app/src/components/PaperView.tsx` | 114 | 紙の描画 + sourceBox ハイライト |
| `app/src/components/BuildPanel.tsx` | 157 | 生成過程パネル(解析フェーズの可視化) |
| `app/src/components/field-meta.tsx` | 27 | フィールド種別のアイコン・表示メタ |
| `app/src/lib/__tests__/specdiff.test.ts` | 2,080 | SpecDiff テスト 270本 |
| `app/src/lib/__tests__/scenarios.test.ts` | 1,192 | シナリオ整合性テスト 295本 |
| `app/src/lib/__tests__/appspec.test.ts` | 1,087 | DSL テスト 99本 |
| `app/vitest.config.mts` | – | テスト設定 |
| `app/AGENTS.md`(= `CLAUDE.md`) | – | エージェント規約: この Next.js は訓練データと異なる。`node_modules/next/dist/docs/` を読んでから書く |

---

## 品質の実測値(2026-08-01 時点)

| 検査 | 結果 |
|---|---|
| `npm test` | **Test Files 3 passed / Tests 664 passed**(specdiff 270 / scenarios 295 / appspec 99) |
| `npm run lint` | errors 0(warning 1 = 既知: `specdiff.ts` の未使用 import `ColumnSpec`) |
| `tsc --noEmit` | exit 0 |
| `npm run build` | 成功(4ルート) |

「テストがあるからバグはない」への拡大解釈は不可。テストで**発見して直した**不具合5件の記録は `docs/06_claims_ledger.md` §1-F にある。

---

## ピッチ資産の再生成

```bash
node pitch/deck.js          # カミワザ_ピッチ.pptx を再生成
python3 pitch/check_deck.py # 機械ゲート。exit 0 で通過
```

`check_deck.py` は pptx のスライド面テキストとスピーカーノートを分離して抽出し、**凍結値の一致・禁句の不在・出典限定句の有無・TAM の算術**を機械チェックする。ノートに残る旧値は「禁止/旧値/使わない」等の文脈語を伴っているかで可否を判定する。抽出結果は `pitch/.check_out/`(git管理外)。

---

## 数字を書くときの規律

**このリポジトリに数字を書くときは、`docs/06_claims_ledger.md` §3 凍結値表の値だけを使う。** 凍結値を変えるときは台帳を先に更新し、その後でスライド・スクリプト・本 README を更新する。

主な凍結値: 中小企業 **336.5万者**(中小企業庁、2021年6月時点)/ 受発注が電話・FAX **24.6%**(東京商工会議所、限定句4点セットとセットで言う)/ TAM **約396億円** / 全項目正解 **96%**(48/50)/ 値レベル **99.87%**(1,516/1,518)/ 幻覚 **0件**(通算 0/2,225)/ 明細 **196/196 行** / 処理時間 **中央値27.3秒** / ユニットテスト **664本** / デモ **5シナリオ**。

**恒久使用禁止の旧値**: 「358万社」「421億円 / 420億円」「12兆円」「130〜155時間」「2,700時間」「1.4人年」「17/17」「599/599」。また「完全」「100%」「必ず30秒」「有意に改善」「幻覚ゼロを保証」は使わない(`docs/06_claims_ledger.md` §4 危険ワード表)。
