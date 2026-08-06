import { describe, it, expect, vi } from "vitest";

import { validateConfig, applyCliOverrides } from "../config.js";
import { createLogger, silentLogger } from "../logger.js";

// ---------------------------------------------------------------------------
// applyCliOverrides (ADR-0005)
// ---------------------------------------------------------------------------

describe("applyCliOverrides", () => {
  const baseConfig = validateConfig({
    git: { repoRoot: "." },
    ai: {
      generation: { provider: "openai", model: "gpt-4.1" },
      translation: { provider: "openai", model: "gpt-4.1" },
    },
    output: { dir: ".", filename: "CHANGELOG" },
  });

  it("returns a new config object (does not mutate input)", () => {
    const result = applyCliOverrides(baseConfig, {});
    expect(result).not.toBe(baseConfig);
    expect(result).toEqual(baseConfig);
  });

  it("overrides provider for both generation and translation", () => {
    const result = applyCliOverrides(baseConfig, { provider: "anthropic" });
    expect(result.ai.generation.provider).toBe("anthropic");
    expect(result.ai.translation.provider).toBe("anthropic");
  });

  it("resets model to provider default when provider changes", () => {
    const result = applyCliOverrides(baseConfig, { provider: "anthropic" });
    expect(result.ai.generation.model).toBe("claude-sonnet-4-20250514");
    expect(result.ai.translation.model).toBe("claude-sonnet-4-20250514");
  });

  it("overrides model for both generation and translation", () => {
    const result = applyCliOverrides(baseConfig, { model: "custom-model-x" });
    expect(result.ai.generation.model).toBe("custom-model-x");
    expect(result.ai.translation.model).toBe("custom-model-x");
  });

  it("overrides both provider and model simultaneously", () => {
    const result = applyCliOverrides(baseConfig, {
      provider: "gemini",
      model: "gemini-1.5-pro",
    });
    expect(result.ai.generation.provider).toBe("gemini");
    expect(result.ai.generation.model).toBe("gemini-1.5-pro");
    expect(result.ai.translation.provider).toBe("gemini");
    expect(result.ai.translation.model).toBe("gemini-1.5-pro");
  });

  it("overrides output directory", () => {
    const result = applyCliOverrides(baseConfig, { output: "docs/changelog" });
    expect(result.output.dir).toBe("docs/changelog");
    expect(result.output.filename).toBe("CHANGELOG");
  });

  it("overrides output file path (parses dir + filename)", () => {
    const result = applyCliOverrides(baseConfig, { output: "output/CHANGES.md" });
    expect(result.output.dir).toBe("output");
    expect(result.output.filename).toBe("CHANGES");
  });

  it("handles output file path in current directory", () => {
    const result = applyCliOverrides(baseConfig, { output: "CHANGES.md" });
    expect(result.output.dir).toBe(".");
    expect(result.output.filename).toBe("CHANGES");
  });

  it("throws for invalid provider", () => {
    expect(() => applyCliOverrides(baseConfig, { provider: "invalid" })).toThrow();
  });

  it("does not modify original config", () => {
    const original = validateConfig({
      git: { repoRoot: "." },
      ai: {
        generation: { provider: "openai", model: "gpt-4.1" },
        translation: { provider: "openai", model: "gpt-4.1" },
      },
    });
    applyCliOverrides(original, { provider: "anthropic", model: "claude-x" });
    expect(original.ai.generation.provider).toBe("openai");
    expect(original.ai.generation.model).toBe("gpt-4.1");
  });
});

// ---------------------------------------------------------------------------
// Logger (ADR-0005)
// ---------------------------------------------------------------------------

describe("createLogger", () => {
  it("quiet logger suppresses info and verbose", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("quiet");
    logger.info("should not appear");
    logger.verbose("should not appear");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("quiet logger still shows errors", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("quiet");
    logger.error("error message");
    expect(err).toHaveBeenCalledWith("error message");
    err.mockRestore();
  });

  it("normal logger shows info but not verbose", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("normal");
    logger.info("info message");
    logger.verbose("verbose message");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("info message");
    log.mockRestore();
  });

  it("verbose logger shows info and verbose", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger("verbose");
    logger.info("info message");
    logger.verbose("verbose message");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "info message");
    expect(log).toHaveBeenNthCalledWith(2, "verbose message");
    log.mockRestore();
  });
});

describe("silentLogger", () => {
  it("suppresses info and verbose", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    silentLogger.info("should not appear");
    silentLogger.verbose("should not appear");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("still shows errors", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    silentLogger.error("error message");
    expect(err).toHaveBeenCalledWith("error message");
    err.mockRestore();
  });
});
