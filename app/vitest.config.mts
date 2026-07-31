import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Targets are pure TS modules (specdiff / appspec / scenarios) — no DOM needed.
    environment: "node",
    include: ["src/lib/__tests__/**/*.test.ts"],
  },
});
