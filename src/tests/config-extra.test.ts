import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  validateConfig,
  getApiKey,
  getPrimaryFilePath,
  getTranslationFilePath,
  getAllFilePaths,
  loadConfig,
} from "../config.js";

describe("getApiKey", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns key when set", () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    expect(getApiKey("openai")).toBe("sk-test-key");
  });

  it("throws for missing openai key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => getApiKey("openai")).toThrow("OPENAI_API_KEY");
  });

  it("throws for missing anthropic key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => getApiKey("anthropic")).toThrow("ANTHROPIC_API_KEY");
  });

  it("throws for missing gemini key", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => getApiKey("gemini")).toThrow("GEMINI_API_KEY");
  });

  it("throws with provider name in error", () => {
    delete process.env.OPENAI_API_KEY;
    try {
      getApiKey("openai");
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("openai");
    }
  });
});

describe("getPrimaryFilePath", () => {
  it("joins dir and filename with .md", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    expect(getPrimaryFilePath(config)).toBe(path.join(".", "CHANGELOG.md"));
  });

  it("respects custom dir", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      output: { dir: "docs", filename: "CHANGES" },
    });
    expect(getPrimaryFilePath(config)).toBe(path.join("docs", "CHANGES.md"));
  });
});

describe("getTranslationFilePath", () => {
  it("joins dir, filename, lang, and .md", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    expect(getTranslationFilePath(config, "de")).toBe(path.join(".", "CHANGELOG.de.md"));
  });

  it("respects custom dir and filename", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      output: { dir: "docs", filename: "CHANGES" },
    });
    expect(getTranslationFilePath(config, "uk")).toBe(path.join("docs", "CHANGES.uk.md"));
  });
});

describe("getAllFilePaths", () => {
  it("returns primary only when no translations", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    const paths = getAllFilePaths(config);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(path.join(".", "CHANGELOG.md"));
  });

  it("returns primary + translations", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      languages: { primary: "en", translations: ["de", "uk"] },
    });
    const paths = getAllFilePaths(config);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(path.join(".", "CHANGELOG.md"));
    expect(paths[1]).toBe(path.join(".", "CHANGELOG.de.md"));
    expect(paths[2]).toBe(path.join(".", "CHANGELOG.uk.md"));
  });
});

describe("loadConfig", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "changelog-cfg-"));
    cleanup = async () => {
      await fs.rm(dir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("loads and validates a YAML config file", async () => {
    const yaml = `
git:
  subPath: apps/myproject
grouping:
  startDay: mon
languages:
  primary: de
  translations: [en]
ai:
  generation:
    provider: anthropic
  translation:
    provider: gemini
`;
    const configPath = path.join(dir, "changelog.config.yaml");
    await fs.writeFile(configPath, yaml, "utf-8");

    const config = await loadConfig(configPath);
    expect(config.git.paths).toEqual(["apps/myproject"]);
    expect(config.grouping.startDay).toBe("mon");
    expect(config.languages.primary).toBe("de");
    expect(config.languages.translations).toEqual(["en"]);
    expect(config.ai.generation.provider).toBe("anthropic");
    expect(config.ai.generation.model).toBe("claude-sonnet-4-20250514");
    expect(config.ai.translation.provider).toBe("gemini");
  });

  it("throws for invalid YAML config", async () => {
    const yaml = `
git:
  subPath: apps/myproject
ai:
  generation:
    provider: invalid_provider
`;
    const configPath = path.join(dir, "changelog.config.yaml");
    await fs.writeFile(configPath, yaml, "utf-8");

    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  it("throws for missing file", async () => {
    await expect(loadConfig(path.join(dir, "nonexistent.yaml"))).rejects.toThrow();
  });
});
