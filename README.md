# AI HACKATHON 2026 事前準備 — カミワザ (KAMIWAZA)

**その紙、30秒で「動くシステム」になる。**

手書き帳票・FAX注文書の写真1枚を、その場で業務アプリ(フォーム/一覧/承認フロー/ダッシュボード)に変換するPaper-to-Appエンジンのプロトタイプ。[AI HACKATHON 2026 / TOKYO](https://aihackathon.jp)(2026/8/8–8/16)の事前準備物。

## ディレクトリ構成

```
├── app/    プロトタイプ本体(Next.js 16 + React 19 + Tailwind v4 + Claude API)
└── docs/   戦略ドキュメント
    ├── 00_hackathon_summary.md   ハッカソン要項サマリ(審査員分析込み)
    ├── 01_strategy.md            プロダクト戦略・審査員対策・想定ツッコミ
    ├── 02_pitch.md               5分ピッチ台本
    ├── 03_day1_pivot_playbook.md テーマ別ピボット手順(Day1発表対応)
    └── 04_schedule.md            残タスクと本番9日間の計画
```

## 動かし方

```bash
cd app
npm install
npm run dev   # http://localhost:3000
npm test      # ユニットテスト 664本(vitest)
```

**APIキー不要で完全動作します**(デモモード = イベントリプレイ)。3種類のサンプル帳票(FAX注文書・作業日報・設備点検表)から選ぶと、解析→アプリ生成→1件目データ登録までの流れが本番と同じ見た目でストリーミング再生されます。

### ライブモード(実物の紙を解析)

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

キーを設定すると「自分の紙を撮る」が有効になり、Claude Vision(claude-opus-4-8)が実画像を解析します。ライブ解析が失敗した場合は自動でデモリプレイにフォールバックします(本番ピッチの保険)。

> ⚠️ ライブモードは実APIキーでの検証がまだです。7月中に実物の紙10枚以上で精度検証をしてください(docs/04_schedule.md)。

## アーキテクチャ

```
紙の写真 ─▶ Claude Vision ─▶ AppSpec DSL(JSON Schema制約付き) ─▶ 決定論的レンダラー
              (streaming)      structured outputsで生成を制約        (React、品質を担保)
                                      │
                                      ├─ 出典バウンディングボックス(幻覚対策)
                                      ├─ 信頼度スコア → 逆質問ループ(HITL)
                                      └─ 1件目レコード自動登録
```

- **LLMに生コードを書かせない**: 出力は `src/lib/appspec.ts` のDSLのみ。UIの品質・安全性はレンダラー側(`src/components/SpecApp.tsx`)で常に担保
- **デモ/ライブ同一プロトコル**: どちらも同じSSEイベント列(`src/lib/events.ts`)を流すため、クライアントは接続先を意識しない
- **紙とスペックの座標共有**: サンプル帳票の描画(`src/lib/scenarios.ts`)とsourceBoxが同じ%座標系のため、出典ハイライトが構造的にズレない

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `app/src/lib/appspec.ts` | AppSpec DSL(型 + structured outputs用JSON Schema) |
| `app/src/lib/scenarios.ts` | デモシナリオ3種(紙レイアウト+スペック+シードデータ) |
| `app/src/lib/claude-live.ts` | Claude Visionライブ解析(ストリーミング+部分JSONパース) |
| `app/src/app/api/analyze/route.ts` | SSEエンドポイント(デモ/ライブ振り分け) |
| `app/src/components/KamiwazaApp.tsx` | 画面状態機械+SSEクライアント |
| `app/src/components/SpecApp.tsx` | 決定論的レンダラー(生成アプリのUI) |
