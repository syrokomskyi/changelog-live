import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  collectCommits,
  getFirstCommitDate,
  groupCommits,
  isPeriodInProgress,
  formatDate,
  getWeekStart,
  resolveTagToDate,
} from "../git-collect.js";

async function createTempRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changelog-test-"));
  const { execSync } = await import("node:child_process");

  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });

  const cleanup = async () => {
    await fs.rm(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

async function commitFile(
  dir: string,
  filePath: string,
  content: string,
  message: string,
  date: string,
): Promise<void> {
  const { execSync } = await import("node:child_process");
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "${message}" --date="${date} 12:00:00"`, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${date} 12:00:00`,
      GIT_COMMITTER_DATE: `${date} 12:00:00`,
    },
    stdio: "pipe",
  });
}

describe("integration: git collect + group", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await createTempRepo();
    dir = result.dir;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("collects commits from a subPath", async () => {
    await commitFile(dir, "apps/hdri/file1.ts", "content1", "Add file1", "2026-07-16");
    await commitFile(dir, "apps/other/file2.ts", "content2", "Add file2", "2026-07-17");

    const commits = collectCommits(dir, ["apps/hdri"]);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Add file1");
  });

  it("collects commits since a date", async () => {
    await commitFile(dir, "src/a.ts", "a", "Old commit", "2026-06-01");
    await commitFile(dir, "src/b.ts", "b", "New commit", "2026-07-15");

    const commits = collectCommits(dir, ["src"], "2026-07-01");
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("New commit");
  });

  it("collects commits with untilDate", async () => {
    await commitFile(dir, "src/a.ts", "a", "Old commit", "2026-06-01");
    await commitFile(dir, "src/b.ts", "b", "Mid commit", "2026-07-10");
    await commitFile(dir, "src/c.ts", "c", "New commit", "2026-07-15");

    const commits = collectCommits(dir, ["src"], undefined, "2026-07-12");
    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe("Mid commit");
    expect(commits[1].message).toBe("Old commit");
  });

  it("collects commits with both sinceDate and untilDate", async () => {
    await commitFile(dir, "src/a.ts", "a", "Old commit", "2026-06-01");
    await commitFile(dir, "src/b.ts", "b", "Mid commit", "2026-07-10");
    await commitFile(dir, "src/c.ts", "c", "New commit", "2026-07-15");

    const commits = collectCommits(dir, ["src"], "2026-07-01", "2026-07-12");
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Mid commit");
  });

  it("gets first commit date", async () => {
    await commitFile(dir, "src/a.ts", "a", "First", "2026-05-01");
    await commitFile(dir, "src/b.ts", "b", "Second", "2026-07-15");

    const first = getFirstCommitDate(dir, ["src"]);
    expect(first).toBe("2026-05-01");
  });

  it("returns null for no commits", async () => {
    const first = getFirstCommitDate(dir, ["src"]);
    expect(first).toBeNull();
  });

  it("collects file stats", async () => {
    await commitFile(dir, "src/a.ts", "line1\nline2\nline3\n", "Add a.ts", "2026-07-16");

    const commits = collectCommits(dir, ["src"]);
    expect(commits).toHaveLength(1);
    expect(commits[0].files.length).toBeGreaterThan(0);
    expect(commits[0].files[0].path).toContain("a.ts");
  });

  it("groups commits across a week boundary", async () => {
    await commitFile(dir, "src/a.ts", "a", "Thu commit", "2026-07-16"); // Thursday
    await commitFile(dir, "src/b.ts", "b", "Wed commit", "2026-07-22"); // Wednesday (same week)
    await commitFile(dir, "src/c.ts", "c", "Next Thu", "2026-07-23"); // Next Thursday

    const commits = collectCommits(dir, ["src"]);
    const weeks = groupCommits(commits, "week", "thu");
    expect(weeks).toHaveLength(2);
    expect(weeks[0].commits).toHaveLength(2);
    expect(weeks[1].commits).toHaveLength(1);
  });

  it("filters out in-progress periods, keeps only completed periods", async () => {
    // Commit 2 weeks ago (completed week)
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    await commitFile(dir, "src/old.ts", "old", "Old commit", formatDate(twoWeeksAgo));

    // Commit today (current in-progress week)
    await commitFile(dir, "src/today.ts", "today", "Today commit", formatDate(new Date()));

    const commits = collectCommits(dir, ["src"]);
    const weeks = groupCommits(commits, "week", "thu");
    const completed = weeks.filter((w) => !isPeriodInProgress(w.periodEnd));

    // Only the completed week should pass the filter
    expect(completed).toHaveLength(1);
    expect(completed[0].commits[0].message).toBe("Old commit");

    // The current week must be flagged as in-progress
    const currentWeekStart = formatDate(getWeekStart(new Date(), "thu"));
    const currentWeek = weeks.find((w) => w.periodStart === currentWeekStart);
    expect(currentWeek).toBeDefined();
    expect(isPeriodInProgress(currentWeek!.periodEnd)).toBe(true);
  });
});

describe("integration: resolveTagToDate", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await createTempRepo();
    dir = result.dir;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("resolves a tag to its commit date", async () => {
    await commitFile(dir, "src/a.ts", "a", "Tagged commit", "2026-07-15");
    const { execSync } = await import("node:child_process");
    execSync("git tag v1.0.0", { cwd: dir, stdio: "pipe" });

    const date = resolveTagToDate(dir, "v1.0.0");
    expect(date).toBe("2026-07-15");
  });

  it("returns null for non-existent tag", async () => {
    const date = resolveTagToDate(dir, "nonexistent-tag");
    expect(date).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR-0006: Commit filtering tests
// ---------------------------------------------------------------------------

async function commitWithAuthor(
  dir: string,
  filePath: string,
  content: string,
  message: string,
  date: string,
  authorName: string,
): Promise<void> {
  const { execSync } = await import("node:child_process");
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync(
    `git -c user.name="${authorName}" -c user.email="${authorName.toLowerCase()}@bot.com" commit -m "${message}" --date="${date} 12:00:00"`,
    {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${date} 12:00:00`,
        GIT_COMMITTER_DATE: `${date} 12:00:00`,
      },
      stdio: "pipe",
    },
  );
}

describe("integration: commit filtering (ADR-0006)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await createTempRepo();
    dir = result.dir;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("populates author field on collected commits", async () => {
    await commitFile(dir, "src/a.ts", "a", "Add a", "2026-07-16");

    const commits = collectCommits(dir, ["src"]);
    expect(commits).toHaveLength(1);
    expect(commits[0].author).toBe("Test");
  });

  it("excludes merge commits when excludeMerges is true", async () => {
    await commitFile(dir, "src/a.ts", "a", "Add a", "2026-07-16");
    await commitFile(dir, "src/b.ts", "b", "Add b", "2026-07-17");

    // Create a merge commit
    const { execSync } = await import("node:child_process");
    execSync("git checkout -b feature", { cwd: dir, stdio: "pipe" });
    await commitFile(dir, "src/c.ts", "c", "Add c on feature", "2026-07-18");
    execSync("git checkout main", { cwd: dir, stdio: "pipe" });
    execSync("git merge --no-ff feature -m \"Merge branch 'feature'\"", {
      cwd: dir,
      stdio: "pipe",
    });

    const filter: CommitFilter = {
      excludeMerges: true,
      excludeAuthors: [],
      excludePatterns: [],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    const messages = commits.map((c) => c.message);
    expect(messages).not.toContain("Merge branch 'feature'");
    expect(messages).toContain("Add a");
    expect(messages).toContain("Add b");
    expect(messages).toContain("Add c on feature");
  });

  it("includes merge commits when excludeMerges is false", async () => {
    await commitFile(dir, "src/a.ts", "a", "Add a", "2026-07-16");

    const { execSync } = await import("node:child_process");
    execSync("git checkout -b feature", { cwd: dir, stdio: "pipe" });
    await commitFile(dir, "src/b.ts", "b", "Add b", "2026-07-17");
    execSync("git checkout main", { cwd: dir, stdio: "pipe" });
    execSync("git merge --no-ff feature -m \"Merge branch 'feature'\"", {
      cwd: dir,
      stdio: "pipe",
    });

    const filter: CommitFilter = {
      excludeMerges: false,
      excludeAuthors: [],
      excludePatterns: [],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    expect(commits.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes commits by excluded authors", async () => {
    await commitFile(dir, "src/a.ts", "a", "Human commit", "2026-07-16");
    await commitWithAuthor(dir, "src/b.ts", "b", "Bot commit", "2026-07-17", "dependabot[bot]");

    const filter: CommitFilter = {
      excludeMerges: false,
      excludeAuthors: ["dependabot[bot]"],
      excludePatterns: [],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Human commit");
  });

  it("excludes commits matching excludePatterns", async () => {
    await commitFile(dir, "src/a.ts", "a", "feat: add feature", "2026-07-16");
    await commitFile(dir, "src/b.ts", "b", "chore(deps): bump packages", "2026-07-17");
    await commitFile(dir, "src/c.ts", "c", "ci: configure pipeline", "2026-07-18");

    const filter: CommitFilter = {
      excludeMerges: false,
      excludeAuthors: [],
      excludePatterns: ["^chore\\(deps\\):", "^ci:"],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("feat: add feature");
  });

  it("applies all filters simultaneously", async () => {
    await commitFile(dir, "src/a.ts", "a", "feat: add feature", "2026-07-16");
    await commitWithAuthor(dir, "src/b.ts", "b", "feat: bot work", "2026-07-17", "renovate[bot]");
    await commitFile(dir, "src/c.ts", "c", "chore(deps): bump", "2026-07-18");

    const filter: CommitFilter = {
      excludeMerges: true,
      excludeAuthors: ["renovate[bot]"],
      excludePatterns: ["^chore\\(deps\\):"],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("feat: add feature");
  });

  it("returns all commits when filter has defaults (no exclusions)", async () => {
    await commitFile(dir, "src/a.ts", "a", "Add a", "2026-07-16");
    await commitFile(dir, "src/b.ts", "b", "Add b", "2026-07-17");

    const filter: CommitFilter = {
      excludeMerges: false,
      excludeAuthors: [],
      excludePatterns: [],
    };

    const commits = collectCommits(dir, ["src"], undefined, undefined, filter);
    expect(commits).toHaveLength(2);
  });
});
