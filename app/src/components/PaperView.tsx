// 紙の描画。デモシナリオの帳票(データ駆動レンダリング)と
// ライブモードでアップロードされた実写真の両方を扱い、
// AppSpecのsourceBox(%)による出典ハイライトを重ねる。

import type { SourceBox } from "@/lib/appspec";
import type { PaperElement } from "@/lib/scenarios";

interface PaperViewProps {
  elements?: PaperElement[];
  imageSrc?: string;
  highlight?: SourceBox | null;
  scanning?: boolean;
  className?: string;
}

function elementStyle(el: PaperElement): React.CSSProperties {
  const style: React.CSSProperties = {
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    height: `${el.h}%`,
  };
  if (el.size) style.fontSize = `${el.size}cqw`;
  if (el.align) style.textAlign = el.align;
  if (el.rotate) style.transform = `rotate(${el.rotate}deg)`;
  if (el.bold) style.fontWeight = 700;
  return style;
}

function PaperElementView({ el }: { el: PaperElement }) {
  switch (el.kind) {
    case "printed":
      return (
        <div className="paper-el paper-printed" style={elementStyle(el)}>
          {el.text}
        </div>
      );
    case "hand":
      return (
        <div className="paper-el paper-hand" style={elementStyle(el)}>
          {el.text}
        </div>
      );
    case "line":
      return <div className="paper-el paper-line" style={elementStyle(el)} />;
    case "box":
      return <div className="paper-el paper-box" style={elementStyle(el)} />;
    case "stamp":
      return (
        <div
          className="paper-el paper-stamp"
          style={{ ...elementStyle(el), fontSize: `${(el.size ?? 2.2)}cqw` }}
        >
          {el.text}
        </div>
      );
    case "circle":
      return <div className="paper-el paper-circle" style={elementStyle(el)} />;
  }
}

export function PaperView({
  elements,
  imageSrc,
  highlight,
  scanning,
  className,
}: PaperViewProps) {
  const overlay = (
    <>
      {scanning && <div className="scanline" />}
      {highlight && (
        <div
          className="source-highlight"
          style={{
            left: `${highlight.x}%`,
            top: `${highlight.y}%`,
            width: `${highlight.w}%`,
            height: `${highlight.h}%`,
          }}
        />
      )}
    </>
  );

  if (imageSrc) {
    return (
      <div
        className={`relative overflow-hidden rounded-sm shadow-2xl ${className ?? ""}`}
        style={{ containerType: "inline-size" }}
      >
        {/* ライブモードのアップロード画像はNext/Imageの最適化対象外(data URL)のためimgを使用 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageSrc} alt="アップロードされた帳票" className="w-full h-auto block" />
        {overlay}
      </div>
    );
  }

  return (
    <div className={`paper ${className ?? ""}`}>
      {(elements ?? []).map((el, i) => (
        <PaperElementView key={i} el={el} />
      ))}
      {overlay}
    </div>
  );
}
