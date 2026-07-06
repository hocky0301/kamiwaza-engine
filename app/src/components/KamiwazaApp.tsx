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
import { SCENARIOS, getScenario } from "@/lib/scenarios";
import { PaperView } from "./PaperView";
import { BuildPanel, type BuildState } from "./BuildPanel";
import { SpecApp, QuestionCard, type QuestionState } from "./SpecApp";

type Screen = "select" | "analyzing" | "ready";

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

export function KamiwazaApp({ liveAvailable }: { liveAvailable: boolean }) {
  const [screen, setScreen] = useState<Screen>("select");
  const [scenarioId, setScenarioId] = useState("chumonsho");
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);

  // 解析ストリームの進行状態
  const [phases, setPhases] = useState<string[]>([]);
  const [meta, setMeta] = useState<BuildState["meta"]>(null);
  const [fields, setFields] = useState<FieldSpec[]>([]);
  const [approval, setApproval] = useState<ApprovalStep[] | null | undefined>(undefined);
  const [aggs, setAggs] = useState<AggregationSpec[]>([]);
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [question, setQuestion] = useState<QuestionState | null>(null);
  const [spec, setSpec] = useState<AppSpec | null>(null);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [highlight, setHighlight] = useState<SourceBox | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setApproval(undefined);
    setAggs([]);
    setRecord(null);
    setQuestion(null);
    setSpec(null);
    setError(null);
    setFailed(false);
    setHighlight(null);
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
        setApproval(undefined);
        setAggs([]);
        setRecord(null);
        break;
      case "field":
        setFields((f) => [...f, ev.field]);
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
        break;
      case "aggregation":
        setAggs((a) => [...a, ev.agg]);
        break;
      case "record":
        setRecord(ev.record);
        break;
      case "done":
        setSpec(ev.spec);
        setMode(ev.mode);
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

  const answerQuestion = useCallback((i: number) => {
    setQuestion((q) => (q ? { ...q, answer: i } : q));
  }, []);

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

  const records = useMemo<AppRecord[]>(() => {
    if (!effectiveSpec) return [];
    if (mode === "live") return [effectiveSpec.firstRecord];
    return [effectiveSpec.firstRecord, ...scenario.seedRecords];
  }, [effectiveSpec, mode, scenario]);

  /* ---------------- 画面 ---------------- */

  const header = (
    <header className="flex items-center gap-3 px-6 py-4 border-b border-line">
      <button
        onClick={backToSelect}
        className="flex items-center gap-2.5 cursor-pointer"
        title="トップに戻る"
      >
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-full border-2 border-accent text-accent font-serif font-bold text-lg -rotate-6">
          紙
        </span>
        <span className="font-bold text-lg tracking-wide">カミワザ</span>
        <span className="text-dim text-xs hidden sm:inline">Paper-to-App Engine</span>
      </button>
      <div className="ml-auto flex items-center gap-2">
        {screen !== "select" && (
          <button
            onClick={backToSelect}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim hover:text-fg hover:border-dim transition-colors cursor-pointer"
          >
            ← 別の紙を試す
          </button>
        )}
        <span
          className={`text-[11px] rounded-full px-3 py-1 font-bold ${
            liveAvailable ? "bg-ok/15 text-ok" : "bg-accent-soft text-accent"
          }`}
          title={
            liveAvailable
              ? "ANTHROPIC_API_KEY が設定されています。写真のライブ解析が使えます"
              : "APIキーなしでも完全動作するデモモードで動いています"
          }
        >
          {liveAvailable ? "LIVE READY" : "DEMO MODE"}
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
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => startScenario(s.id)}
                className="group card p-4 text-left hover:border-accent/60 transition-colors cursor-pointer"
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
                  : "ANTHROPIC_API_KEY を設定すると、実物の紙のライブ解析が有効になります"}
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

        {/* 右: ビルド or アプリ */}
        <div className="min-h-[70vh] md:h-[calc(100vh-7.5rem)] flex flex-col">
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
          {screen === "ready" && effectiveSpec && (
            <SpecApp
              spec={effectiveSpec}
              records={records}
              alert={mode === "demo" ? scenario.alert : null}
              mode={mode}
              onHighlight={setHighlight}
              question={question}
              onAnswer={answerQuestion}
            />
          )}
        </div>
      </main>
    </div>
  );
}
