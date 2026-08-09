import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "カミワザ — その紙、30秒で「動くシステム」になる。",
  description:
    "手書き帳票・FAX注文書の写真1枚を、その場で業務アプリに変換するPaper-to-Appエンジン。",
  // ホーム画面起動対応(ブースのiPad動線)。Service Worker/manifest.jsonは
  // 追加しない — 「PWA」とは主張しない線(docs/06 C18)を維持する。
  // apple-touch-icon は src/app/apple-icon.png のファイル規約で自動注入される
  appleWebApp: {
    capable: true,
    title: "カミワザ",
    statusBarStyle: "black-translucent",
  },
  other: {
    // Next 16 は capable を mobile-web-app-capable として出力するため、
    // 旧iOS向けの apple-mobile-web-app-capable も明示的に併記する
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  // width=device-width, initial-scale=1 はNextのデフォルトが維持される(上書き項目のみ指定)
  themeColor: "#12100e",
  // black-translucent時にステータスバー背面まで背景を敷く(余白はbodyのsafe-area padding)
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
