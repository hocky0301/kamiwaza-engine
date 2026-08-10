import { KamiwazaApp } from "@/components/KamiwazaApp";
import { resolveLlmRoute } from "@/lib/llm-client";

export default function Home() {
  // ライブ可否はサーバー側でしか分からないため、ここで判定してクライアントに渡す。
  // 判定は必ず resolveLlmRoute() に一本化する(analyze/reconfigure の分岐と同じ関数)。
  // ANTHROPIC_API_KEY だけを見ていると、OrcaRouterキーのみの構成で
  // 「サーバーはライブ解析できるのに UI は DEMO MODE を出し撮影ボタンが disabled」
  // という食い違いが起き、ブースでライブ実演そのものが起動できなくなる(F08)。
  const liveRoute = resolveLlmRoute();
  return <KamiwazaApp liveAvailable={liveRoute !== null} liveRoute={liveRoute} />;
}
