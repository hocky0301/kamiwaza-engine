import { KamiwazaApp } from "@/components/KamiwazaApp";

export default function Home() {
  // APIキーの有無はサーバー側でしか分からないため、ここで判定してクライアントに渡す
  const liveAvailable = !!process.env.ANTHROPIC_API_KEY;
  return <KamiwazaApp liveAvailable={liveAvailable} />;
}
