import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLAUDE_MODEL,
  ORCAROUTER_BASE_URL,
  getLlmClient,
  hasLlmClient,
  resolveLlmRoute,
  toOrcaRouterModelId,
} from "../llm-client";

/* ============================================================================
 * llm-client — 経路解決とモデルID変換
 *
 * OrcaRouter実測(2026-08-08): モデルIDはドット表記 anthropic/claude-opus-4.8。
 * ハイフン表記 claude-opus-4-8 は model_not_found で拒否される。
 * ==========================================================================*/

/** テストごとに3つの環境変数を明示的に固定する(実行環境の.envに依存しない) */
function stubEnv(env: { orca?: string; anthropic?: string; forceDirect?: string }) {
  vi.stubEnv("ORCAROUTER_API_KEY", env.orca ?? "");
  vi.stubEnv("ANTHROPIC_API_KEY", env.anthropic ?? "");
  vi.stubEnv("LLM_FORCE_DIRECT", env.forceDirect ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("toOrcaRouterModelId: ハイフン表記 → anthropic/ドット表記", () => {
  it.each([
    ["claude-opus-4-8", "anthropic/claude-opus-4.8"],
    ["claude-opus-4-7", "anthropic/claude-opus-4.7"],
    ["claude-sonnet-4-6", "anthropic/claude-sonnet-4.6"],
    ["claude-haiku-4-5", "anthropic/claude-haiku-4.5"],
  ])("%s → %s", (input, expected) => {
    expect(toOrcaRouterModelId(input)).toBe(expected);
  });

  it("マイナーバージョンなし(claude-opus-5)はドット変換不要でプレフィクスのみ付く", () => {
    expect(toOrcaRouterModelId("claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("数値バージョンを持たないIDはそのままプレフィクスだけ付く", () => {
    expect(toOrcaRouterModelId("claude")).toBe("anthropic/claude");
  });

  it("既にプロバイダ表記('/'入り)のIDは変換せずそのまま返す", () => {
    expect(toOrcaRouterModelId("anthropic/claude-opus-4.8")).toBe("anthropic/claude-opus-4.8");
  });

  it("既定モデルの変換結果は実測済みのOrcaRouter IDと一致する", () => {
    expect(toOrcaRouterModelId(DEFAULT_CLAUDE_MODEL)).toBe("anthropic/claude-opus-4.8");
  });
});

describe("resolveLlmRoute: 環境変数による経路解決", () => {
  it("ORCAROUTER_API_KEY があれば orcarouter(ANTHROPIC_API_KEY の有無に関わらず)", () => {
    stubEnv({ orca: "orca-key" });
    expect(resolveLlmRoute()).toBe("orcarouter");

    stubEnv({ orca: "orca-key", anthropic: "sk-ant" });
    expect(resolveLlmRoute()).toBe("orcarouter");
  });

  it("LLM_FORCE_DIRECT=1 で直接Anthropicに強制される(障害時の保険)", () => {
    stubEnv({ orca: "orca-key", anthropic: "sk-ant", forceDirect: "1" });
    expect(resolveLlmRoute()).toBe("anthropic");
  });

  it("LLM_FORCE_DIRECT=1 でも ANTHROPIC_API_KEY が無ければ null(デモモード)", () => {
    stubEnv({ orca: "orca-key", forceDirect: "1" });
    expect(resolveLlmRoute()).toBeNull();
    expect(hasLlmClient()).toBe(false);
  });

  it("ANTHROPIC_API_KEY のみなら従来どおり anthropic", () => {
    stubEnv({ anthropic: "sk-ant" });
    expect(resolveLlmRoute()).toBe("anthropic");
  });

  it("どちらのキーも無ければ null(デモモードのみ)", () => {
    stubEnv({});
    expect(resolveLlmRoute()).toBeNull();
    expect(hasLlmClient()).toBe(false);
  });

  it("LLM_FORCE_DIRECT が '1' 以外の値なら強制は働かない", () => {
    stubEnv({ orca: "orca-key", anthropic: "sk-ant", forceDirect: "true" });
    expect(resolveLlmRoute()).toBe("orcarouter");
  });
});

describe("getLlmClient: 経路に応じたクライアント構成", () => {
  it("orcarouter経路: baseURLとモデルID変換が適用され、経路情報を返す", () => {
    stubEnv({ orca: "orca-key" });
    const llm = getLlmClient();
    expect(llm).not.toBeNull();
    expect(llm!.route).toBe("orcarouter");
    expect(llm!.model).toBe("anthropic/claude-opus-4.8");
    expect(llm!.client.baseURL).toBe(ORCAROUTER_BASE_URL);
    // Bearer認証(authToken)。x-api-key は明示的に無効化されている
    expect(llm!.client.authToken).toBe("orca-key");
    expect(llm!.client.apiKey).toBeNull();
  });

  it("orcarouter経路: ANTHROPIC_API_KEY が同居していても x-api-key は無効のまま", () => {
    stubEnv({ orca: "orca-key", anthropic: "sk-ant" });
    const llm = getLlmClient();
    expect(llm!.route).toBe("orcarouter");
    expect(llm!.client.apiKey).toBeNull();
  });

  it("anthropic経路: モデルIDは無変換で、既定のbaseURLを使う", () => {
    stubEnv({ anthropic: "sk-ant" });
    const llm = getLlmClient();
    expect(llm).not.toBeNull();
    expect(llm!.route).toBe("anthropic");
    expect(llm!.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(llm!.client.baseURL).not.toBe(ORCAROUTER_BASE_URL);
  });

  it("キーなしなら null(呼び出し元はデモモードへ)", () => {
    stubEnv({});
    expect(getLlmClient()).toBeNull();
  });

  it("モデルIDを指定した場合も経路ごとの変換が適用される", () => {
    stubEnv({ orca: "orca-key" });
    expect(getLlmClient("claude-sonnet-4-6")!.model).toBe("anthropic/claude-sonnet-4.6");

    stubEnv({ anthropic: "sk-ant", forceDirect: "1" });
    expect(getLlmClient("claude-sonnet-4-6")!.model).toBe("claude-sonnet-4-6");
  });
});
