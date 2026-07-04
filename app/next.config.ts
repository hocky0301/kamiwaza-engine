import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ホームディレクトリに別のlockfileがあってもこのアプリをルートとして扱う
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
