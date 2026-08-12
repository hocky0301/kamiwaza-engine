"use client";

// カミワザ本体: 紙を選ぶ/撮る → 解析ストリーム → 生成アプリ、の状態機械。

import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AppSpec,
  AppRecord,
  AggregationSpec,
  ApprovalStep,
  FieldSpec,
  SourceBox,
} from "@/lib/appspec";
import type { AnalyzeEvent } from "@/lib/events";
import {
  applyDiff,
  chipsForScenario,
  genericChips,
  keywordFallback,
  type PatchLogEntry,
  type ReconfigureEvent,
  type SpecDiff,
} from "@/lib/specdiff";
import { SCENARIOS, getScenario } from "@/lib/scenarios";
import {
  buildStateFromSpec,
  diffBuildState,
  initialBuildState,
  type StreamedBuildState,
} from "@/lib/reconcile";
import { toggleHighlight } from "@/lib/highlight";
import { PaperView } from "./PaperView";
import { BuildPanel, type BuildState } from "./BuildPanel";
import {
  SpecApp,
  QuestionCard,
  type CostState,
  type QuestionState,
  type ChipState,
} from "./SpecApp";
import type { LlmRoute } from "@/lib/llm-client";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Screen = "select" | "analyzing" | "ready";

// 実在企業の実スキャン帳票50枚での検証実績(docs/05参照)。再検証のたびに更新する
const VERIFIED_STATS = [
  "✓ 実在企業の実スキャン帳票50枚で検証",
  "全項目正解 96%・値精度 99.9%",
  "幻覚(捏造値) 0件",
  "明細196行を欠落ゼロで抽出",
  "180°逆さまFAXも自動補正",
];

interface UploadedImage {
  dataUrl: string;
  base64: string;
  mediaType: string;
}

/** 画像を最大1600pxに縮小してJPEG base64にする(通信量とビジョンコストの節約) */
async function downscaleImage(file: File): Promise<UploadedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  if (!img.width || !img.height) throw new Error("画像サイズを取得できませんでした");
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  const base64 = jpeg.split(",")[1];
  if (!base64) throw new Error("画像の変換に失敗しました");
  return {
    dataUrl: jpeg,
    base64,
    mediaType: "image/jpeg",
  };
}

export function KamiwazaApp({
  liveAvailable,
  liveRoute = null,
}: {
  liveAvailable: boolean;
  /** ライブ経路の実値。バッジの説明文を実際の経路に一致させる(誤表示防止・F08) */
  liveRoute?: LlmRoute | null;
}) {
  const [screen, setScreen] = useState<Screen>("select");
  const [scenarioId, setScenarioId] = useState("chumonsho");
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);

  // 解析ストリームの進行状態
  const [phases, setPhases] = useState<string[]>([]);
  const [meta, setMeta] = useState<BuildState["meta"]>(null);
  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [lineItems, setLineItems] = useState<BuildState["lineItems"]>(null);
  const [approval, setApproval] = useState<ApprovalStep[] | null | undefined>(undefined);
  const [aggs, setAggs] = useState<AggregationSpec[]>([]);
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [spec, setSpec] = useState<AppSpec | null>(null);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [highlight, setHighlight] = useState<SourceBox | null>(null);
  // LIVE READY/DEMO MODEバッジの説明(title)はタッチで見えないため、タップで開くポップオーバーを持つ
  const [statusInfoOpen, setStatusInfoOpen] = useState(false);

  // 「日本語で書いて直す」— 適用済みパッチ(1ユーザー操作=1グループ)と手術ログ
  const [patches, setPatches] = useState<SpecDiff[][]>([]);
  const [patchLog, setPatchLog] = useState<PatchLogEntry[]>([]);
  const [reconfBusy, setReconfBusy] = useState(false);

  // 推定原価の累計(解析+ライブ再構成)。ライブ経路でusage実測があるときのみ非null。
  // Undoしても減算しない(トークンは実際に消費済み=誠実)
  const [cost, setCost] = useState<CostState | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * ストリームから組み立てた画面状態のミラー(三重保険 第2層)。
   * meta/fields/... の state と並行して更新し、done 受信時に ev.spec と照合する。
   * state を直接読まないのは、handleEvent が deps 空の useCallback で
   * 古いクロージャの state しか見えないため(refは常に最新)。
   */
  const streamedRef = useRef<StreamedBuildState>(initialBuildState());
  /** 最新のreconfiguredSpecを非同期処理から参照するためのref */
  const specRef = useRef<AppSpec | null>(null);
  /**
   * 再構成の世代カウンタ。resetStreamでインクリメントされ、
   * 生き残った古い非同期処理(SSE購読・staggerループ)が
   * 新しいアプリのpatches/patchLog/busyへ書き込むのを防ぐ。
   */
  const reconfGenRef = useRef(0);
  const reconfAbortRef = useRef<AbortController | null>(null);

  const scenario = getScenario(scenarioId);
  const isUpload = uploaded !== null;

  const resetStream = useCallback(() => {
    if (readyTimerRef.current !== null) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    setPhases([]);
    setMeta(null);
    setFields([]);
    setLineItems(null);
    setApproval(undefined);
    setAggs([]);
    setRecord(null);
    setQuestion(null);
    setSpec(null);
    setError(null);
    setFailed(false);
    setHighlight(null);
    setPatches([]);
    setPatchLog([]);
    setReconfBusy(false);
    setCost(null);
    streamedRef.current = initialBuildState();
    // 進行中の再構成を無効化(世代を進め、in-flightのfetchも切る)
    reconfGenRef.current += 1;
    reconfAbortRef.current?.abort();
    reconfAbortRef.current = null;
  }, []);

  const handleEvent = useCallback((ev: AnalyzeEvent) => {
    switch (ev.type) {
      case "phase":
        setPhases((p) => [...p, ev.label]);
        break;
      case "image":
        // サーバー側で回転補正された画像に表示を差し替える
        setUploaded((u) => (u ? { ...u, dataUrl: ev.dataUrl } : u));
        break;
      case "meta":
        // ライブ失敗→デモ続行などで解析がやり直されるケースに備え、組み立て状態をリセット
        setMeta({ appName: ev.appName, icon: ev.icon, description: ev.description });
        setFields([]);
        setLineItems(null);
        setApproval(undefined);
        setAggs([]);
        setRecord(null);
        streamedRef.current = {
          ...initialBuildState(),
          meta: { appName: ev.appName, icon: ev.icon, description: ev.description },
        };
        break;
      case "field":
        setFields((f) => [...f, ev.field]);
        streamedRef.current.fields.push(ev.field);
        break;
      case "lineitems":
        setLineItems({ spec: ev.spec, rowCount: ev.rowCount });
        streamedRef.current.lineItems = { spec: ev.spec, rowCount: ev.rowCount };
        break;
      case "question":
        setQuestion({
          fieldId: ev.fieldId,
          question: ev.question,
          choices: ev.choices,
          answer: null,
        });
        break;
      case "approval":
        setApproval(ev.flow);
        streamedRef.current.approval = ev.flow;
        break;
      case "aggregation":
        setAggs((a) => [...a, ev.agg]);
        streamedRef.current.aggs.push(ev.agg);
        break;
      case "record":
        setRecord(ev.record);
        streamedRef.current.record = ev.record;
        break;
      case "validation":
        // アプリ側スキーマ検証の結果を開発ログに残す(UI変更なし)。
        // ok: false のときはサーバー側で直後にライブ解析が失敗扱い→デモフォールバックが走る
        console.info(
          ev.ok
            ? "[kamiwaza] アプリ側スキーマ検証: ok(違反0件)"
            : `[kamiwaza] アプリ側スキーマ検証: ${ev.violations}件の違反 — デモフォールバックへ`,
        );
        break;
      case "done": {
        // 三重保険 第2層: done.spec を正としてストリーム組み立て状態を照合・復元する。
        // 正常時は streamed ≡ done.spec(ライブ実測で確認済み・デモは構成上恒等)なので
        // 視覚的差分ゼロ。デルタ重複による文字列破損・SSE行破損によるイベント欠落など
        // 破損時のみ、done後〜ready遷移(900ms)の間の BuildPanel 表示が静かに直る。
        // 照合結果はブースでのデバッグ用にコンソールへ残す。
        const issues = diffBuildState(streamedRef.current, ev.spec);
        if (issues.length > 0) {
          console.warn(
            `[kamiwaza] done.spec照合: ${issues.length}件の不一致を検出 — done.specを正として再描画`,
            issues,
          );
        } else {
          console.info("[kamiwaza] done.spec照合: ストリーム組み立て状態と一致");
        }
        const rebuilt = buildStateFromSpec(ev.spec);
        streamedRef.current = rebuilt;
        setMeta(rebuilt.meta);
        setFields(rebuilt.fields);
        setLineItems(rebuilt.lineItems);
        setApproval(rebuilt.approval);
        setAggs(rebuilt.aggs);
        setRecord(rebuilt.record);

        setSpec(ev.spec);
        setMode(ev.mode);
        // 原価チップ: ライブ経路でusage実測+推定原価があるときだけ初期化。
        // デモ再生・usage欠落時はnull(実額を捏造しない)
        if (ev.mode === "live" && ev.usage && ev.costUsd !== undefined) {
          setCost({
            usd: ev.costUsd,
            usage: ev.usage,
            source: ev.pricingSource ?? "fallback",
            reconfCalls: 0,
            route: ev.llmRoute ?? null,
          });
        } else {
          setCost(null);
        }
        if (ev.mode === "demo") {
          // ライブ解析失敗→デモ続行のフォールバック時: 左の紙をリプレイ元の
          // サンプル帳票に切り替え、seedRecords/alertの参照元も揃える
          setUploaded(null);
          if (ev.scenarioId) setScenarioId(ev.scenarioId);
        }
        readyTimerRef.current = setTimeout(() => {
          setScreen("ready");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }, 900);
        break;
      }
      case "error":
        setError(ev.message);
        break;
    }
  }, []);

  const start = useCallback(
    async (payload: { scenarioId?: string; image?: { data: string; mediaType: string } }) => {
      resetStream();
      setScreen("analyzing");
      window.scrollTo({ top: 0 });
      const ac = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ac;
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`解析APIエラー (${res.status})`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let sawDone = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            try {
              const ev = JSON.parse(line.slice(6)) as AnalyzeEvent;
              if (ev.type === "done") sawDone = true;
              handleEvent(ev);
            } catch {
              // 壊れた行はスキップ
            }
          }
        }
        // doneが来ないままストリームが閉じた(ネットワーク断など)
        if (!sawDone && !ac.signal.aborted) {
          setError("接続が中断されました。「別の紙を試す」からやり直してください");
          setFailed(true);
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          setError(e instanceof Error ? e.message : "接続に失敗しました");
          setFailed(true);
        }
      }
    },
    [handleEvent, resetStream],
  );

  const startScenario = useCallback(
    (id: string) => {
      setScenarioId(id);
      setUploaded(null);
      void start({ scenarioId: id });
    },
    [start],
  );

  const startUpload = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const img = await downscaleImage(file);
        setUploaded(img);
        // scenarioIdも送る: ライブ解析が失敗した場合のフォールバック先を
        // 直前に選んでいたシナリオに揃えるため
        void start({ scenarioId, image: { data: img.base64, mediaType: img.mediaType } });
      } catch {
        setError(
          "画像の読み込みに失敗しました。HEIC形式の場合はJPEG/PNGに変換してお試しください",
        );
      }
    },
    [start, scenarioId],
  );

  const backToSelect = useCallback(() => {
    abortRef.current?.abort();
    setUploaded(null);
    resetStream();
    setScreen("select");
    window.scrollTo({ top: 0 });
  }, [resetStream]);

  const answerQuestion = useCallback(
    (i: number) => {
      // 再構成の適用中はspecスナップショットの整合が崩れるため回答を受け付けない
      if (reconfBusy) return;
      setQuestion((q) => (q ? { ...q, answer: i } : q));
    },
    [reconfBusy],
  );

  // 逆質問の回答をスペックに反映した「有効スペック」
  const effectiveSpec = useMemo(() => {
    if (!spec) return null;
    if (!question || question.answer !== 1) return spec;
    const target = spec.fields.find((f) => f.id === question.fieldId);
    return {
      ...spec,
      fields: spec.fields.filter((f) => f.id !== question.fieldId),
      listColumns: spec.listColumns.filter((c) => c !== question.fieldId),
      approvalFlow: target?.type === "stamp" ? null : spec.approvalFlow,
    };
  }, [spec, question]);

  // 「日本語で書いて直す」のパッチを畳み込んだ最終スペック。
  // applyDiffは純粋関数で、未知op・null・非オブジェクトのどれでもfail()に落ちて
  // 入力specを同一参照で返す(specdiff.ts の入口ガードと default 節)ため常に安全
  const reconfiguredSpec = useMemo(() => {
    if (!effectiveSpec) return null;
    return patches.flat().reduce((s, d) => applyDiff(s, d).spec, effectiveSpec);
  }, [effectiveSpec, patches]);
  specRef.current = reconfiguredSpec;

  const records = useMemo<AppRecord[]>(() => {
    if (!reconfiguredSpec) return [];
    if (mode === "live") return [reconfiguredSpec.firstRecord];
    return [reconfiguredSpec.firstRecord, ...scenario.seedRecords];
  }, [reconfiguredSpec, mode, scenario]);

  // 提案チップ。生成元はパッチの影響を受けないeffectiveSpecに固定し
  // (適用のたびにチップが消えてレイアウトが跳ねるのを防ぐ)、
  // 適用可否の判定だけを最新のreconfiguredSpecで行う
  const chips = useMemo<ChipState[]>(() => {
    if (!effectiveSpec || !reconfiguredSpec || screen !== "ready") return [];
    const base =
      mode === "live" && isUpload
        ? genericChips(effectiveSpec, effectiveSpec.firstRecord)
        : chipsForScenario(scenarioId);
    // 全opが適用不能になったチップ(適用済み等)はグレーアウト
    return base.map((chip) => ({
      ...chip,
      disabled: !chip.ops.some((op) => applyDiff(reconfiguredSpec, op).ok),
    }));
  }, [effectiveSpec, reconfiguredSpec, screen, mode, isUpload, scenarioId]);

  /**
   * opの列を1つずつ(手術ログを流しながら)適用する。
   * 1回の呼び出し=1グループとしてpatchesに積む(Undoは操作単位で戻る)。
   * 世代が変わったら(リセット後)即座に打ち切り、一切書き込まない。
   */
  const runOps = useCallback(async (ops: SpecDiff[], stagger = 300) => {
    const gen = reconfGenRef.current;
    let groupStarted = false;
    const pushOp = (op: SpecDiff) => {
      setPatches((p) =>
        groupStarted && p.length > 0
          ? [...p.slice(0, -1), [...p[p.length - 1], op]]
          : [...p, [op]],
      );
      groupStarted = true;
    };
    setReconfBusy(true);
    try {
      let cur = specRef.current;
      for (const op of ops) {
        if (gen !== reconfGenRef.current || !cur) return;
        const r = applyDiff(cur, op);
        setPatchLog((l) => [...l, { summary: r.summary, ok: r.ok, reason: r.reason }]);
        if (r.ok) {
          cur = r.spec;
          pushOp(op);
        }
        await sleep(stagger);
        if (gen !== reconfGenRef.current) return;
      }
    } finally {
      if (gen === reconfGenRef.current) setReconfBusy(false);
    }
  }, []);

  /** 提案チップ: ネットワークを一切通らずローカルで確実にモーフ(デモの生命線) */
  const applyChip = useCallback(
    (chip: ChipState) => {
      if (reconfBusy || chip.disabled) return;
      void runOps(chip.ops);
    },
    [reconfBusy, runOps],
  );

  /** 自由文入力: ライブtool use経路。失敗したらローカルのキーワード解釈へ */
  const sendInstruction = useCallback(
    async (text: string) => {
      const instruction = text.trim();
      if (!instruction || reconfBusy || !specRef.current) return;
      const gen = reconfGenRef.current;
      const ac = new AbortController();
      reconfAbortRef.current?.abort();
      reconfAbortRef.current = ac;
      let groupStarted = false;
      const pushOp = (op: SpecDiff) => {
        setPatches((p) =>
          groupStarted && p.length > 0
            ? [...p.slice(0, -1), [...p[p.length - 1], op]]
            : [...p, [op]],
        );
        groupStarted = true;
      };
      setReconfBusy(true);
      setPatchLog((l) => [...l, { summary: `「${instruction}」`, ok: true, info: true }]);
      try {
        const res = await fetch("/api/reconfigure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ spec: specRef.current, instruction }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`reconfigure API ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let cur = specRef.current;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (gen !== reconfGenRef.current) return; // リセット後は一切書き込まない
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            let ev: ReconfigureEvent;
            try {
              ev = JSON.parse(line.slice(6)) as ReconfigureEvent;
            } catch {
              continue;
            }
            if (gen !== reconfGenRef.current) return;
            if (ev.type === "rphase") {
              setPatchLog((l) => [...l, { summary: ev.label, ok: true, info: true }]);
            } else if (ev.type === "patch") {
              // サーバーの判定に頼らず、手元の最新specでも再検証してから適用
              const r = cur ? applyDiff(cur, ev.diff) : null;
              if (ev.ok && r?.ok) {
                cur = r.spec;
                pushOp(ev.diff);
                setPatchLog((l) => [...l, { summary: ev.summary, ok: true }]);
              } else {
                setPatchLog((l) => [
                  ...l,
                  { summary: ev.summary, ok: false, reason: ev.reason ?? r?.reason },
                ]);
              }
              await sleep(220);
              if (gen !== reconfGenRef.current) return;
            } else if (ev.type === "rdone") {
              // ライブ解釈がAPIを呼んだときのみ原価を累計に加算する
              // (キーワードフォールバック単独=usageなしは加算しない。捏造しない)
              if (ev.costUsd !== undefined && ev.usage) {
                const { usage: u, costUsd, pricingSource } = ev;
                setCost((c) =>
                  c
                    ? {
                        usd: Math.round((c.usd + costUsd) * 1e6) / 1e6,
                        usage: {
                          inputTokens: c.usage.inputTokens + u.inputTokens,
                          outputTokens: c.usage.outputTokens + u.outputTokens,
                          cacheCreationInputTokens:
                            c.usage.cacheCreationInputTokens + u.cacheCreationInputTokens,
                          cacheReadInputTokens:
                            c.usage.cacheReadInputTokens + u.cacheReadInputTokens,
                        },
                        // 1回でもfallback単価を含んだ累計は全体をfallback扱い(保守側に倒す)
                        source:
                          c.source === "fallback" || pricingSource !== "live"
                            ? "fallback"
                            : "live",
                        reconfCalls: c.reconfCalls + 1,
                        route: c.route,
                      }
                    : {
                        usd: costUsd,
                        usage: u,
                        source: pricingSource ?? "fallback",
                        reconfCalls: 1,
                        route: null,
                      },
                );
              }
            } else if (ev.type === "rerror") {
              setPatchLog((l) => [...l, { summary: ev.message, ok: false }]);
            }
          }
        }
      } catch {
        // リセット/中断済みの旧処理はフォールバックさせない(新アプリ汚染の防止)
        if (gen !== reconfGenRef.current || ac.signal.aborted) return;
        // ネットワーク断でも止めない: ローカルのキーワード解釈にフォールバック
        const diffs = specRef.current ? keywordFallback(specRef.current, instruction) : [];
        if (diffs.length === 0) {
          setPatchLog((l) => [
            ...l,
            { summary: "指示を解釈できませんでした。言い換えてみてください", ok: false },
          ]);
        } else {
          setPatchLog((l) => [...l, { summary: "オフライン解釈で適用します", ok: true, info: true }]);
          await runOps(diffs);
        }
      } finally {
        if (gen === reconfGenRef.current) setReconfBusy(false);
        if (reconfAbortRef.current === ac) reconfAbortRef.current = null;
      }
    },
    [reconfBusy, runOps],
  );

  // バッジの説明は実際の経路に一致させる。OrcaRouter経由なのに
  // 「ANTHROPIC_API_KEY が設定されています」と出ると、審査員に直結運用と誤解される
  const liveStatusText = !liveAvailable
    ? "APIキーなしでも完全動作するデモモードで動いています"
    : liveRoute === "orcarouter"
      ? "OrcaRouter 経由でライブ解析が使えます(ORCAROUTER_API_KEY)"
      : "Anthropic に直結してライブ解析が使えます(ANTHROPIC_API_KEY)";

  /** タップ発火用: 同じ出典の再タップで解除、別の出典で切り替え(規則はlib/highlight.ts) */
  const handleHighlightToggle = useCallback((box: SourceBox) => {
    setHighlight((cur) => toggleHighlight(cur, box));
  }, []);

  const undoPatch = useCallback(() => {
    if (reconfBusy || patches.length === 0) return;
    const n = patches[patches.length - 1].length;
    setPatches((p) => p.slice(0, -1));
    setPatchLog((l) => [
      ...l,
      { summary: `↩ 直前の変更を元に戻しました(${n}件の操作)`, ok: true, info: true },
    ]);
  }, [reconfBusy, patches]);

  /* ---------------- 画面 ---------------- */

  const header = (
    <header className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-line">
      <button
        onClick={backToSelect}
        className="flex items-center gap-2 sm:gap-2.5 cursor-pointer shrink-0"
        title="トップに戻る"
      >
        <span className="inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-full border-2 border-accent text-accent font-serif font-bold text-base sm:text-lg -rotate-6 shrink-0">
          紙
        </span>
        <span className="font-bold text-base sm:text-lg tracking-wide whitespace-nowrap">
          カミワザ
        </span>
        <span className="text-dim text-xs hidden sm:inline">Paper-to-App Engine</span>
      </button>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {screen !== "select" && (
          <button
            onClick={backToSelect}
            // タッチ端末は見た目を変えず疑似要素でヒット領域だけ44pt相当へ拡張
            className="relative rounded-lg border border-line px-3 py-1.5 text-sm text-dim hover:text-fg hover:border-dim transition-colors cursor-pointer whitespace-nowrap shrink-0 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-1.5 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-['']"
          >
            {/* モバイルは横幅が足りないので短縮ラベル(意味は同じ) */}
            <span className="sm:hidden">← 別の紙</span>
            <span className="hidden sm:inline">← 別の紙を試す</span>
          </button>
        )}
        {/* titleツールチップはタッチで見えないため、タップで説明ポップオーバーを開くbutton化 */}
        <span className="relative shrink-0">
          <button
            onClick={() => setStatusInfoOpen((o) => !o)}
            className={`relative text-[11px] rounded-full px-3 py-1 font-bold whitespace-nowrap cursor-pointer pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:inset-x-0 pointer-coarse:after:content-[''] ${
              liveAvailable ? "bg-ok/15 text-ok" : "bg-accent-soft text-accent"
            }`}
            title={
              liveStatusText
            }
          >
            {liveAvailable ? "LIVE READY" : "DEMO MODE"}
          </button>
          {statusInfoOpen && (
            <span className="absolute right-0 top-full mt-2 z-30 block w-64 card p-3 text-xs leading-relaxed text-dim font-normal text-left whitespace-normal shadow-xl">
              {liveStatusText}
            </span>
          )}
        </span>
      </div>
    </header>
  );

  if (screen === "select") {
    return (
      <div className="min-h-screen flex flex-col">
        {header}
        <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-10">
          {error && (
            <div className="card border-accent/60 bg-accent-soft p-4 mb-6 text-sm max-w-2xl mx-auto">
              ⚠ {error}
            </div>
          )}
          <div className="text-center mb-10">
            <h1 className="text-4xl sm:text-5xl font-bold leading-tight tracking-tight">
              その紙、30秒で
              <br className="sm:hidden" />
              <span className="text-accent">「動くシステム」</span>になる。
            </h1>
            <p className="text-dim mt-4 max-w-2xl mx-auto leading-relaxed">
              手書き帳票・FAX注文書の写真1枚を、カミワザが<b className="text-fg">その場で業務アプリに変換</b>します。
              設定画面はありません。撮った紙が、1件目のデータになります。
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-5 text-xs">
              {VERIFIED_STATS.map((s) => (
                <span
                  key={s}
                  className="rounded-full border border-line bg-card px-3 py-1.5 text-dim"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => startScenario(s.id)}
                // active: はタッチでも効く押下フィードバック(hoverリフトのタッチ代替)
                className="group card p-4 text-left hover:border-accent/60 active:border-accent/60 transition-colors cursor-pointer"
              >
                <div className="pointer-events-none mb-3 group-hover:-translate-y-1 transition-transform">
                  <PaperView elements={s.paper} />
                </div>
                <div className="font-bold">{s.label}</div>
                <div className="text-dim text-xs mt-0.5">{s.paperKind}</div>
                <div className="text-accent text-sm mt-2 font-medium">
                  この紙をアプリにする →
                </div>
              </button>
            ))}

            <label
              className={`card p-4 flex flex-col items-center justify-center text-center gap-3 border-dashed transition-colors ${
                liveAvailable
                  ? "hover:border-accent/60 cursor-pointer"
                  : "opacity-60 cursor-not-allowed"
              }`}
            >
              <input
                type="file"
                accept="image/*"
                // モバイルでは背面カメラが直接起動する(その場で紙を撮る動線)。
                // デスクトップのブラウザはcaptureを無視し、通常のファイル選択のまま
                capture="environment"
                className="hidden"
                disabled={!liveAvailable}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void startUpload(f);
                  e.target.value = "";
                }}
              />
              <span className="text-4xl">📷</span>
              <div className="font-bold">自分の紙を撮る</div>
              <div className="text-dim text-xs leading-relaxed">
                {liveAvailable
                  ? "手元の帳票を撮影して、Claude Vision でライブ解析します"
                  : "ORCAROUTER_API_KEY または ANTHROPIC_API_KEY を設定すると、実物の紙のライブ解析が有効になります"}
              </div>
            </label>
          </div>

          <p className="text-center text-dim text-xs mt-12">
            AI HACKATHON 2026 事前プロトタイプ — Powered by Claude
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {header}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-[minmax(300px,5fr)_7fr] gap-6 items-start">
        {/* 左: 紙 */}
        <div className="md:sticky md:top-6">
          <div className="text-xs text-dim mb-2 flex items-center gap-2">
            <span>📠</span>
            <span>{isUpload ? "撮影された帳票" : `${scenario.paperKind}(サンプル)`}</span>
          </div>
          {isUpload ? (
            <PaperView
              imageSrc={uploaded.dataUrl}
              highlight={highlight}
              scanning={screen === "analyzing"}
            />
          ) : (
            <PaperView
              elements={scenario.paper}
              highlight={highlight}
              scanning={screen === "analyzing"}
            />
          )}
        </div>

        {/* 右: ビルド or アプリ。
            min-w-0 がないとグリッド項目の min-width:auto が中身の最小幅まで広がり、
            タブレット幅(768px前後)でページ全体が横スクロールして右端が切れる */}
        <div className="min-w-0 min-h-[70vh] md:h-[calc(100vh-7.5rem)] flex flex-col">
          {error && (
            <div className="card border-accent/60 bg-accent-soft p-4 mb-3 text-sm">
              ⚠ {error}
            </div>
          )}
          {screen === "analyzing" && (
            <>
              <BuildPanel
                state={{
                  phases,
                  meta,
                  fields,
                  lineItems,
                  approval,
                  aggs,
                  recordArrived: record !== null,
                  done: spec !== null || failed,
                }}
              />
              {question && question.answer === null && (
                <div className="mt-3">
                  <QuestionCard question={question} onAnswer={answerQuestion} />
                </div>
              )}
            </>
          )}
          {screen === "ready" && reconfiguredSpec && (
            <SpecApp
              spec={reconfiguredSpec}
              records={records}
              alert={mode === "demo" ? scenario.alert : null}
              mode={mode}
              cost={mode === "live" ? cost : null}
              onHighlight={setHighlight}
              onHighlightToggle={handleHighlightToggle}
              question={question}
              onAnswer={answerQuestion}
              chips={chips}
              onChip={applyChip}
              onInstruction={sendInstruction}
              onUndo={undoPatch}
              canUndo={patches.length > 0}
              patchLog={patchLog}
              busy={reconfBusy}
            />
          )}
        </div>
      </main>
    </div>
  );
}
