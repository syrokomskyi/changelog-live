import { describe, it, expect } from "vitest";

import { formatCommitsForPrompt, parseGenerationResponse } from "../ai-generate.js";
import type { GitCommit, WeekGroup } from "../types.js";

describe("formatCommitsForPrompt", () => {
  it("formats a single commit with files", () => {
    const commits: GitCommit[] = [
      {
        hash: "abc123",
        date: "2026-07-16",
        message: "Add feature",
        files: [
          { path: "src/main.ts", additions: 10, deletions: 2 },
          { path: "src/utils.ts", additions: 5, deletions: 0 },
        ],
      },
    ];

    const result = formatCommitsForPrompt(commits);
    expect(result).toContain("commit abc123");
    expect(result).toContain("Date: 2026-07-16");
    expect(result).toContain("Message: Add feature");
    expect(result).toContain("src/main.ts (+10 -2)");
    expect(result).toContain("src/utils.ts (+5 -0)");
  });

  it("formats multiple commits separated by blank lines", () => {
    const commits: GitCommit[] = [
      {
        hash: "aaa",
        date: "2026-07-16",
        message: "First",
        files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      },
      {
        hash: "bbb",
        date: "2026-07-17",
        message: "Second",
        files: [{ path: "b.ts", additions: 2, deletions: 1 }],
      },
    ];

    const result = formatCommitsForPrompt(commits);
    expect(result).toContain("commit aaa");
    expect(result).toContain("commit bbb");
    expect(result.split("\n\n").length).toBe(2);
  });

  it("handles commit with no files", () => {
    const commits: GitCommit[] = [
      {
        hash: "empty",
        date: "2026-07-16",
        message: "Empty commit",
        files: [],
      },
    ];

    const result = formatCommitsForPrompt(commits);
    expect(result).toContain("commit empty");
    expect(result).toContain("Message: Empty commit");
    expect(result).toContain("Files:\n");
  });

  it("returns empty string for no commits", () => {
    expect(formatCommitsForPrompt([])).toBe("");
  });
});

describe("parseGenerationResponse", () => {
  const week: WeekGroup = {
    weekStart: "2026-07-16",
    weekEnd: "2026-07-22",
    commits: [],
  };

  it("parses valid JSON with all categories", () => {
    const raw = JSON.stringify({
      categories: {
        added: ["Add feature A", "Add feature B"],
        changed: ["Update C"],
        fixed: [],
        removed: [],
        security: [],
        documentation: ["Update docs"],
      },
      commitMessage: "Add features and update docs",
    });

    const section = parseGenerationResponse(raw, week);
    expect(section.weekStart).toBe("2026-07-16");
    expect(section.weekEnd).toBe("2026-07-22");
    expect(section.categories.added).toEqual(["Add feature A", "Add feature B"]);
    expect(section.categories.changed).toEqual(["Update C"]);
    expect(section.categories.fixed).toEqual([]);
    expect(section.categories.documentation).toEqual(["Update docs"]);
    expect(section.commitMessage).toBe("Add features and update docs");
  });

  it("fills missing categories with empty arrays", () => {
    const raw = JSON.stringify({
      categories: {
        added: ["Only entry"],
      },
      commitMessage: "minor",
    });

    const section = parseGenerationResponse(raw, week);
    expect(section.categories.added).toEqual(["Only entry"]);
    expect(section.categories.changed).toEqual([]);
    expect(section.categories.fixed).toEqual([]);
    expect(section.categories.removed).toEqual([]);
    expect(section.categories.security).toEqual([]);
    expect(section.categories.documentation).toEqual([]);
  });

  it("fills missing commitMessage with fallback", () => {
    const raw = JSON.stringify({
      categories: { added: ["entry"] },
    });

    const section = parseGenerationResponse(raw, week);
    expect(section.commitMessage).toBe("export 2026-07-16");
  });

  it("fills missing categories object entirely", () => {
    const raw = JSON.stringify({ commitMessage: "test" });

    const section = parseGenerationResponse(raw, week);
    expect(section.categories.added).toEqual([]);
    expect(section.categories.changed).toEqual([]);
    expect(section.commitMessage).toBe("test");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseGenerationResponse("not json", week)).toThrow("invalid JSON");
  });

  it("throws on invalid JSON with truncated content in error", () => {
    const longInvalid = "x".repeat(300);
    try {
      parseGenerationResponse(longInvalid, week);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("invalid JSON");
      expect((err as Error).message.length).toBeLessThan(300);
    }
  });

  it("handles empty JSON object", () => {
    const section = parseGenerationResponse("{}", week);
    expect(section.categories.added).toEqual([]);
    expect(section.commitMessage).toBe("export 2026-07-16");
  });
});
