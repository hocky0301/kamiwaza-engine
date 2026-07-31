# カミワザ (KAMIWAZA) — プロトタイプ本体

紙の帳票の写真1枚を業務アプリに変換する Paper-to-App エンジン。プロジェクト全体の説明・検証実績・設計思想は **[../README.md](../README.md)** を参照。

## 起動

```bash
npm install
npm run dev     # http://localhost:3000
```

**APIキーなしでデモが最後まで動く**(5シナリオの決定論リプレイ)。実物の紙を解析するライブモードを使う場合のみ、`.env.local` に APIキーを置く。

```bash
# app/.env.local(gitignore 済み・絶対にコミットしない)
ANTHROPIC_API_KEY=sk-ant-...
```

キーがあると「自分の紙を撮る」が有効になり、Claude Vision(`claude-opus-4-8`)が実画像を解析する。失敗時は自動でデモリプレイにフォールバックする。

## テスト・検査

```bash
npm test          # vitest run — 664本
npm run test:watch
npm run lint      # errors 0(warning 1 は既知: specdiff.ts の未使用 import)
npm run build
```

## 構成

```
src/
├── app/
│   ├── page.tsx                    エントリ(APIキーの有無を判定して渡すだけ)
│   ├── layout.tsx / globals.css
│   └── api/
│       ├── analyze/route.ts        解析 SSE(デモ/ライブ振り分け + フォールバック)
│       └── reconfigure/route.ts    自由文 → SpecDiff の SSE
├── lib/
│   ├── appspec.ts                  AppSpec DSL(型 + structured outputs 用 JSON Schema)
│   ├── specdiff.ts                 「日本語で書いて直す」の核(閉じた6操作 + applyDiff)
│   ├── scenarios.ts                デモシナリオ5種(紙 + spec + シードデータ)
│   ├── claude-live.ts              ライブ解析(向き検出 → sharp 回転補正 → streaming)
│   ├── demo.ts                     デモのイベント列を決定論的に生成
│   ├── events.ts                   SSE プロトコル定義(デモ/ライブ共通)
│   └── __tests__/                  specdiff 270 / scenarios 295 / appspec 99
└── components/
    ├── KamiwazaApp.tsx             画面状態機械 + SSE クライアント + Undo
    ├── SpecApp.tsx                 決定論的レンダラー(生成アプリの UI)
    ├── PaperView.tsx               紙の描画 + sourceBox ハイライト
    ├── BuildPanel.tsx              生成過程パネル
    └── field-meta.tsx              フィールド種別メタ
```

## DSL — LLMに生コードを書かせない

- **生成時**: Claude の出力は `src/lib/appspec.ts` の **AppSpec DSL** のみ(structured outputs で制約)。UI の品質・安全性は常にレンダラー側で担保する。
- **再構成時**: Claude の出力は AppSpec ですらなく、`src/lib/specdiff.ts` の **6操作だけ**(`addApprovalStep` / `setNumberLimit` / `addField` / `addAggregation` / `renameField` / `addFilterColumn`)。target には現行 spec の実IDを enum で注入するため、存在しない項目は指定できない。適用は決定論的な純粋関数で、不正な操作は適用されず元の spec がそのまま返る。**モデルはアプリを壊せない。**

設計の背景・却下した案・一見おかしなコードの理由は [../docs/DESIGN_NOTES.md](../docs/DESIGN_NOTES.md)。

## スタック

Next.js 16.2.10 / React 19.2.4 / Tailwind v4 / TypeScript 5 / `@anthropic-ai/sdk` ^0.110.0 / `sharp` ^0.35.3(サーバ側の回転補正)/ vitest ^4.1.10。パッケージマネージャは npm(`package-lock.json` のみ)。

> **コードを書く前に**: この Next.js は訓練データと異なる。`node_modules/next/dist/docs/` の該当ガイドを読んでから書くこと([AGENTS.md](AGENTS.md))。
