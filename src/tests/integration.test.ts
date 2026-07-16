import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  collectCommits,
  getFirstCommitDate,
  groupCommitsByWeek,
  isWeekInProgress,
  formatDate,
  getWeekStart,
  getWeekEnd,
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
    const weeks = groupCommitsByWeek(commits, "thu");
    expect(weeks).toHaveLength(2);
    expect(weeks[0].commits).toHaveLength(2);
    expect(weeks[1].commits).toHaveLength(1);
  });

  it("filters out in-progress weeks, keeps only completed weeks", async () => {
    // Commit 2 weeks ago (completed week)
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    await commitFile(dir, "src/old.ts", "old", "Old commit", formatDate(twoWeeksAgo));

    // Commit today (current in-progress week)
    await commitFile(dir, "src/today.ts", "today", "Today commit", formatDate(new Date()));

    const commits = collectCommits(dir, ["src"]);
    const weeks = groupCommitsByWeek(commits, "thu");
    const completed = weeks.filter((w) => !isWeekInProgress(w.weekEnd));

    // Only the completed week should pass the filter
    expect(completed).toHaveLength(1);
    expect(completed[0].commits[0].message).toBe("Old commit");

    // The current week must be flagged as in-progress
    const currentWeekStart = formatDate(getWeekStart(new Date(), "thu"));
    const currentWeek = weeks.find((w) => w.weekStart === currentWeekStart);
    expect(currentWeek).toBeDefined();
    expect(isWeekInProgress(currentWeek!.weekEnd)).toBe(true);
  });
});
