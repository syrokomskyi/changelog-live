import { describe, it, expect } from "vitest";

import { validateConfig } from "../config.js";
import { PROVIDER_DEFAULT_MODELS } from "../types.js";

describe("validateConfig", () => {
  it("applies defaults for missing fields", () => {
    const config = validateConfig({
      git: { subPath: "apps/hdri" },
    });

    expect(config.grouping.period).toBe("week");
    expect(config.grouping.startDay).toBe("thu");
    expect(config.languages.primary).toBe("en");
    expect(config.languages.translations).toEqual([]);
    expect(config.ai.generation.provider).toBe("openai");
    expect(config.ai.generation.model).toBe(PROVIDER_DEFAULT_MODELS.openai);
    expect(config.ai.translation.provider).toBe("openai");
    expect(config.output.dir).toBe(".");
    expect(config.output.filename).toBe("CHANGELOG");
    expect(config.sortOrder).toBe("desc");
  });

  it("converts subPath to paths array", () => {
    const config = validateConfig({
      git: { subPath: "apps/hdri" },
    });
    expect(config.git.paths).toEqual(["apps/hdri"]);
  });

  it("preserves explicit paths", () => {
    const config = validateConfig({
      git: { paths: ["apps/hdri/factory", "apps/hdri/observatory"] },
    });
    expect(config.git.paths).toEqual(["apps/hdri/factory", "apps/hdri/observatory"]);
  });

  it("fills default model for anthropic provider", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      ai: {
        generation: { provider: "anthropic" },
        translation: { provider: "gemini" },
      },
    });
    expect(config.ai.generation.model).toBe(PROVIDER_DEFAULT_MODELS.anthropic);
    expect(config.ai.translation.model).toBe(PROVIDER_DEFAULT_MODELS.gemini);
  });

  it("preserves explicit model", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      ai: {
        generation: { provider: "openai", model: "gpt-4o" },
        translation: { provider: "openai" },
      },
    });
    expect(config.ai.generation.model).toBe("gpt-4o");
  });

  it("rejects invalid provider", () => {
    expect(() =>
      validateConfig({
        git: { subPath: "src" },
        ai: { generation: { provider: "invalid" } },
      }),
    ).toThrow();
  });

  it("accepts maxHistoryWeeks", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      maxHistoryWeeks: 4,
    });
    expect(config.maxHistoryWeeks).toBe(4);
  });

  it("accepts sortOrder asc", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      sortOrder: "asc",
    });
    expect(config.sortOrder).toBe("asc");
  });
});
