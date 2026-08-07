import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  chunkCommits,
  mergeChangelogSections,
  mergePublicChangelogSections,
  generateChangelogSection,
  generatePublicChangelogSection,
} from "../ai-generate.js";
import type {
  GitCommit,
  PeriodGroup,
  ChangelogSection,
  PublicChangelogSection,
} from "../types.js";

vi.mock("../config.js", () => ({
  getApiKey: () => "test-key",
}));

const callAiProviderMock = vi.hoisted(() => vi.fn());

vi.mock("../ai-provider.js", () => ({
  callAiProvider: callAiProviderMock,
}));

// ---------------------------------------------------------------------------
// Helper: generate N mock commits
// ---------------------------------------------------------------------------

function makeCommits(n: number): GitCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `hash${i}`,
    date: "2026-07-16",
    author: "Test",
    message: `Commit ${i}`,
    files: [{ path: `src/file${i}.ts`, additions: i, deletions: 0 }],
  }));
}

// ---------------------------------------------------------------------------
// chunkCommits
// ---------------------------------------------------------------------------

describe("chunkCommits", () => {
  it("returns single array when commits fit within chunk size", () => {
    const commits = makeCommits(50);
    const chunks = chunkCommits(commits, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(commits);
  });

  it("returns single array when commits equal chunk size", () => {
    const commits = makeCommits(200);
    const chunks = chunkCommits(commits, 200);
    expect(chunks).toHaveLength(1);
  });

  it("splits into multiple chunks when exceeding chunk size", () => {
    const commits = makeCommits(500);
    const chunks = chunkCommits(commits, 200);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
    expect(chunks[2]).toHaveLength(100);
  });

  it("splits exactly at boundary", () => {
    const commits = makeCommits(400);
    const chunks = chunkCommits(commits, 200);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(200);
    expect(chunks[1]).toHaveLength(200);
  });

  it("handles empty array", () => {
    const chunks = chunkCommits([], 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(0);
  });

  it("preserves commit order across chunks", () => {
    const commits = makeCommits(450);
    const chunks = chunkCommits(commits, 200);
    const allHashes = chunks.flatMap((c) => c.map((x) => x.hash));
    expect(allHashes).toEqual(commits.map((c) => c.hash));
  });
});

// ---------------------------------------------------------------------------
// mergeChangelogSections
// ---------------------------------------------------------------------------

describe("mergeChangelogSections", () => {
  it("concatenates entries within each category", () => {
    const s1: ChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      categories: {
        added: ["Feature A", "Feature B"],
        changed: [],
        fixed: ["Bug 1"],
        removed: [],
        security: [],
        documentation: [],
      },
      commitMessage: "chunk 1",
    };
    const s2: ChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      categories: {
        added: ["Feature C"],
        changed: ["Update X"],
        fixed: ["Bug 2"],
        removed: [],
        security: ["CVE fix"],
        documentation: [],
      },
      commitMessage: "chunk 2",
    };

    const merged = mergeChangelogSections([s1, s2]);
    expect(merged.periodStart).toBe("2026-07-10");
    expect(merged.periodEnd).toBe("2026-07-17");
    expect(merged.categories.added).toEqual(["Feature A", "Feature B", "Feature C"]);
    expect(merged.categories.changed).toEqual(["Update X"]);
    expect(merged.categories.fixed).toEqual(["Bug 1", "Bug 2"]);
    expect(merged.categories.security).toEqual(["CVE fix"]);
    expect(merged.categories.removed).toEqual([]);
    expect(merged.categories.documentation).toEqual([]);
    expect(merged.commitMessage).toBe("chunk 2");
  });

  it("uses period from first section", () => {
    const s1: ChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      categories: {
        added: ["A"],
        changed: [],
        fixed: [],
        removed: [],
        security: [],
        documentation: [],
      },
      commitMessage: "first",
    };
    const s2: ChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      categories: {
        added: ["B"],
        changed: [],
        fixed: [],
        removed: [],
        security: [],
        documentation: [],
      },
      commitMessage: "second",
    };

    const merged = mergeChangelogSections([s1, s2]);
    expect(merged.periodStart).toBe("2026-07-10");
    expect(merged.commitMessage).toBe("second");
  });

  it("handles single section", () => {
    const s: ChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      categories: {
        added: ["Only"],
        changed: [],
        fixed: [],
        removed: [],
        security: [],
        documentation: [],
      },
      commitMessage: "only",
    };

    const merged = mergeChangelogSections([s]);
    expect(merged.categories.added).toEqual(["Only"]);
    expect(merged.commitMessage).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// mergePublicChangelogSections
// ---------------------------------------------------------------------------

describe("mergePublicChangelogSections", () => {
  it("concatenates entries within each category", () => {
    const s1: PublicChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      title: "Updates 2026-07-10 — 2026-07-17",
      summary: "First chunk summary",
      categories: {
        added: ["Feature A"],
        improved: ["Speed B"],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };
    const s2: PublicChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      title: "Updates 2026-07-10 — 2026-07-17",
      summary: "Second chunk summary",
      categories: {
        added: ["Feature C"],
        improved: [],
        fixed: ["Bug 1"],
        security_compliance: ["DSGVO update"],
        integrations: ["New payment provider"],
      },
    };

    const merged = mergePublicChangelogSections([s1, s2]);
    expect(merged.categories.added).toEqual(["Feature A", "Feature C"]);
    expect(merged.categories.improved).toEqual(["Speed B"]);
    expect(merged.categories.fixed).toEqual(["Bug 1"]);
    expect(merged.categories.security_compliance).toEqual(["DSGVO update"]);
    expect(merged.categories.integrations).toEqual(["New payment provider"]);
  });

  it("takes title and summary from first section", () => {
    const s1: PublicChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      title: "First Title 2026-07-10 — 2026-07-17",
      summary: "First summary",
      categories: {
        added: [],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };
    const s2: PublicChangelogSection = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      title: "Second Title 2026-07-10 — 2026-07-17",
      summary: "Second summary",
      categories: {
        added: [],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };

    const merged = mergePublicChangelogSections([s1, s2]);
    expect(merged.title).toBe("First Title 2026-07-10 — 2026-07-17");
    expect(merged.summary).toBe("First summary");
  });
});

// ---------------------------------------------------------------------------
// generateChangelogSection with chunking
// ---------------------------------------------------------------------------

describe("generateChangelogSection chunking", () => {
  const validResponse = JSON.stringify({
    categories: { added: ["Feature"] },
    commitMessage: "Add feature",
  });

  beforeEach(() => {
    callAiProviderMock.mockReset();
  });

  it("does not chunk when commits are below chunkSize", async () => {
    callAiProviderMock.mockResolvedValue(validResponse);
    const group: PeriodGroup = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      commits: makeCommits(50),
    };

    await generateChangelogSection({
      provider: "openai",
      model: "gpt-4",
      language: "en",
      group,
      chunkSize: 200,
    });

    expect(callAiProviderMock).toHaveBeenCalledTimes(1);
  });

  it("chunks and merges when commits exceed chunkSize", async () => {
    callAiProviderMock
      .mockResolvedValueOnce(
        JSON.stringify({
          categories: { added: ["Feature A"], fixed: ["Bug 1"] },
          commitMessage: "chunk 1",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          categories: { added: ["Feature B"], changed: ["Update X"] },
          commitMessage: "chunk 2",
        }),
      );

    const group: PeriodGroup = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      commits: makeCommits(250),
    };

    const section = await generateChangelogSection({
      provider: "openai",
      model: "gpt-4",
      language: "en",
      group,
      chunkSize: 200,
    });

    expect(callAiProviderMock).toHaveBeenCalledTimes(2);
    expect(section.categories.added).toEqual(["Feature A", "Feature B"]);
    expect(section.categories.fixed).toEqual(["Bug 1"]);
    expect(section.categories.changed).toEqual(["Update X"]);
    expect(section.commitMessage).toBe("chunk 2");
  });

  it("uses default chunk size of 200 when not specified", async () => {
    callAiProviderMock.mockResolvedValue(validResponse);
    const group: PeriodGroup = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      commits: makeCommits(200),
    };

    await generateChangelogSection({
      provider: "openai",
      model: "gpt-4",
      language: "en",
      group,
    });

    expect(callAiProviderMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// generatePublicChangelogSection with chunking
// ---------------------------------------------------------------------------

describe("generatePublicChangelogSection chunking", () => {
  const validResponse = JSON.stringify({
    title: "Updates 2026-07-10 — 2026-07-17",
    summary: "Summary",
    categories: { added: ["Feature"], improved: [], fixed: [], security_compliance: [], integrations: [] },
  });

  beforeEach(() => {
    callAiProviderMock.mockReset();
  });

  it("does not chunk when commits are below chunkSize", async () => {
    callAiProviderMock.mockResolvedValue(validResponse);
    const group: PeriodGroup = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      commits: makeCommits(50),
    };

    await generatePublicChangelogSection({
      provider: "openai",
      model: "gpt-4",
      language: "en",
      group,
      chunkSize: 200,
    });

    expect(callAiProviderMock).toHaveBeenCalledTimes(1);
  });

  it("chunks and merges when commits exceed chunkSize", async () => {
    callAiProviderMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "Updates 2026-07-10 — 2026-07-17",
          summary: "First summary",
          categories: { added: ["Feature A"], improved: ["Speed"], fixed: [], security_compliance: [], integrations: [] },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "Updates 2026-07-10 — 2026-07-17",
          summary: "Second summary",
          categories: { added: ["Feature B"], improved: [], fixed: ["Bug 1"], security_compliance: [], integrations: [] },
        }),
      );

    const group: PeriodGroup = {
      periodStart: "2026-07-10",
      periodEnd: "2026-07-17",
      commits: makeCommits(250),
    };

    const section = await generatePublicChangelogSection({
      provider: "openai",
      model: "gpt-4",
      language: "en",
      group,
      chunkSize: 200,
    });

    expect(callAiProviderMock).toHaveBeenCalledTimes(2);
    expect(section.categories.added).toEqual(["Feature A", "Feature B"]);
    expect(section.categories.improved).toEqual(["Speed"]);
    expect(section.categories.fixed).toEqual(["Bug 1"]);
    expect(section.title).toBe("Updates 2026-07-10 — 2026-07-17");
    expect(section.summary).toBe("First summary");
  });
});
