# cost-batch — 原価バッチハーネス

サンプル帳票を `/api/analyze` へ直列POSTし、1枚ごとの実測トークンと推定原価(costUsd)を集計する。
審査項目⑥(LLMコスト)の凍結値と、ブース想定の負荷テストを兼ねる。app/ のコードは import しない(素の node + fetch のみ)。

## 使い方

1. `cd app && npm run dev` — ORCAROUTER_API_KEY(または ANTHROPIC_API_KEY)を設定して起動
2. `node tools/cost-batch/gen-samples.mjs` — samples/ を再生成する場合のみ(要 playwright-core: `NODE_PATH=<playwright-core入りnode_modules> node ...`)
3. `node tools/cost-batch/run.mjs [画像ディレクトリ]` — 省略時は samples/ の5枚。結果は表 + `out/run-<連番>.json`

## 注意

- 実行のたびに LLM 課金が発生する。**審査用の凍結値は 8/13 9:00 の実行分**(out/ の該当 run-NNN.json)。
- `llmRoute` が無い結果(デモフォールバック=ライブ解析失敗)は FAIL と表示され、終了コードが 1 になる。FAIL を含む実行は凍結値に使わない。
- 合計 costUsd は OrcaRouter コンソールの同時間帯の使用額と突合する(課金の正はダッシュボード側)。
- samples/ の帳票は全て架空の内容(社名・住所・電話は実在しないダミー)。
