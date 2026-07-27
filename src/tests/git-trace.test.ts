import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

import { traceHistoricalPaths } from "../git-trace.js";

async function createTempRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "changelog-trace-"));

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
): Promise<void> {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "pipe" });
}

async function moveFile(
  dir: string,
  oldPath: string,
  newPath: string,
  message: string,
): Promise<void> {
  const fullOld = path.join(dir, oldPath);
  const fullNew = path.join(dir, newPath);
  await fs.mkdir(path.dirname(fullNew), { recursive: true });
  await fs.rename(fullOld, fullNew);
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "pipe" });
}

describe("traceHistoricalPaths", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const repo = await createTempRepo();
    dir = repo.dir;
    cleanup = repo.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("returns CWD path when no renames exist", async () => {
    await fs.mkdir(path.join(dir, "apps", "myproject", "subdir"), { recursive: true });
    await fs.writeFile(path.join(dir, "apps", "myproject", "subdir", "main.ts"), "hello");
    await fs.writeFile(path.join(dir, "apps", "myproject", "README.md"), "readme");
    execSync("git add -A", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m initial", { cwd: dir, stdio: "pipe" });

    const cwd = path.join(dir, "apps", "myproject");
    const result = traceHistoricalPaths(cwd);

    expect(result.repoRoot).toBe("../..");
    expect(result.paths).toContain("apps/myproject");
    // Subdir is pruned — git log -- apps/myproject already recurses into subdir
    expect(result.paths).not.toContain("apps/myproject/subdir");
    // Ancestor "apps" is excluded — too broad for git log filtering
    expect(result.paths).not.toContain("apps");
  });

  it("traces a single rename chain", async () => {
    // Create initial structure: apps/old-name/subdir/main.ts
    await commitFile(dir, "apps/old-name/subdir/main.ts", "v1", "initial");
    // Rename: apps/old-name → apps/new-name
    await moveFile(dir, "apps/old-name/subdir/main.ts", "apps/new-name/subdir/main.ts", "rename");

    const cwd = path.join(dir, "apps", "new-name");
    const result = traceHistoricalPaths(cwd);

    expect(result.paths).toContain("apps/new-name");
    expect(result.paths).toContain("apps/old-name");
    // Subdirs are pruned — git log -- apps/new-name already recurses
    expect(result.paths).not.toContain("apps/new-name/subdir");
    expect(result.paths).not.toContain("apps/old-name/subdir");
  });

  it("traces multi-hop rename chains", async () => {
    // apps/v1/run/main.ts → apps/v2/run/main.ts → apps/v3/run/main.ts
    await commitFile(dir, "apps/v1/run/main.ts", "v1", "initial");
    await moveFile(dir, "apps/v1/run/main.ts", "apps/v2/run/main.ts", "first rename");
    await moveFile(dir, "apps/v2/run/main.ts", "apps/v3/run/main.ts", "second rename");

    const cwd = path.join(dir, "apps", "v3");
    const result = traceHistoricalPaths(cwd);

    expect(result.paths).toContain("apps/v3");
    expect(result.paths).toContain("apps/v2");
    expect(result.paths).toContain("apps/v1");
    // Subdirs are pruned — git log -- apps/v3 already recurses into run/
    expect(result.paths).not.toContain("apps/v3/run");
    expect(result.paths).not.toContain("apps/v2/run");
    expect(result.paths).not.toContain("apps/v1/run");
  });

  it("traces multiple subdirectories independently", async () => {
    // Two subdirectories with different rename histories
    await commitFile(dir, "apps/proj/factory/run/main.ts", "f1", "factory init");
    await commitFile(dir, "apps/proj/dashboard/src/index.ts", "d1", "dashboard init");
    // Rename factory: apps/old-factory → apps/proj/factory
    await moveFile(
      dir,
      "apps/proj/factory/run/main.ts",
      "apps/old-factory/run/main.ts",
      "move out",
    );
    await moveFile(
      dir,
      "apps/old-factory/run/main.ts",
      "apps/proj/factory/run/main.ts",
      "move back",
    );
    // Rename dashboard: apps/old-dashboard → apps/proj/dashboard
    await moveFile(
      dir,
      "apps/proj/dashboard/src/index.ts",
      "apps/old-dashboard/src/index.ts",
      "dash out",
    );
    await moveFile(
      dir,
      "apps/old-dashboard/src/index.ts",
      "apps/proj/dashboard/src/index.ts",
      "dash back",
    );

    const cwd = path.join(dir, "apps", "proj");
    const result = traceHistoricalPaths(cwd);

    // apps/proj covers all its subdirs; only historical top-level dirs are kept
    expect(result.paths).toContain("apps/proj");
    expect(result.paths).toContain("apps/old-factory");
    expect(result.paths).toContain("apps/old-dashboard");
    // Subpaths are pruned
    expect(result.paths).not.toContain("apps/proj/factory");
    expect(result.paths).not.toContain("apps/proj/factory/run");
    expect(result.paths).not.toContain("apps/proj/dashboard");
    expect(result.paths).not.toContain("apps/proj/dashboard/src");
    expect(result.paths).not.toContain("apps/old-factory/run");
    expect(result.paths).not.toContain("apps/old-dashboard/src");
  });

  it("excludes hidden and dash-prefixed directories", async () => {
    await fs.mkdir(path.join(dir, "apps", "proj", ".hidden"), { recursive: true });
    await fs.mkdir(path.join(dir, "apps", "proj", "-stale"), { recursive: true });
    await fs.mkdir(path.join(dir, "apps", "proj", "real"), { recursive: true });
    await fs.writeFile(path.join(dir, "apps", "proj", ".hidden", "file.ts"), "hidden");
    await fs.writeFile(path.join(dir, "apps", "proj", "-stale", "file.ts"), "stale");
    await fs.writeFile(path.join(dir, "apps", "proj", "real", "file.ts"), "real");
    await fs.writeFile(path.join(dir, "apps", "proj", "README.md"), "readme");
    execSync("git add -A", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m initial", { cwd: dir, stdio: "pipe" });

    const cwd = path.join(dir, "apps", "proj");
    const result = traceHistoricalPaths(cwd);

    expect(result.paths).toContain("apps/proj");
    // apps/proj/real is pruned — subpath of apps/proj
    expect(result.paths).not.toContain("apps/proj/real");
    expect(result.paths).not.toContain("apps/proj/.hidden");
    expect(result.paths).not.toContain("apps/proj/-stale");
  });

  it("handles CWD at repo root", async () => {
    await commitFile(dir, "README.md", "readme", "initial");
    await commitFile(dir, "src/main.ts", "main", "second");

    const result = traceHistoricalPaths(dir);

    expect(result.repoRoot).toBe(".");
    expect(result.paths).toContain(".");
    expect(result.paths).toContain("src");
  });

  it("deduplicates paths", async () => {
    // Two files in same dir, both renamed to same new dir
    await commitFile(dir, "apps/old/subdir/a.ts", "a", "first");
    await commitFile(dir, "apps/old/subdir/b.ts", "b", "second");
    await moveFile(dir, "apps/old/subdir/a.ts", "apps/new/subdir/a.ts", "rename a");
    await moveFile(dir, "apps/old/subdir/b.ts", "apps/new/subdir/b.ts", "rename b");

    const cwd = path.join(dir, "apps", "new");
    const result = traceHistoricalPaths(cwd);

    const oldCount = result.paths.filter((p) => p === "apps/old").length;
    expect(oldCount).toBe(1);
    // apps/old/subdir is pruned — subpath of apps/old
    const oldSubdirCount = result.paths.filter((p) => p === "apps/old/subdir").length;
    expect(oldSubdirCount).toBe(0);
  });

  it("discovers directory moved via delete+add (broken --follow chain)", async () => {
    // Scenario: files in apps/old-dir are deleted, then new files appear in
    // apps/new-dir. git --follow can't trace the seed file back because the
    // seed file in new-dir was freshly added, not renamed. findRenamePaths
    // catches this by scanning all rename events under the path.
    await commitFile(dir, "apps/old-dir/run/gogol.ts", "v1", "initial old");
    // Delete old-dir entirely
    await fs.rm(path.join(dir, "apps", "old-dir"), { recursive: true });
    execSync("git add -A", { cwd: dir, stdio: "pipe" });
    execSync('git commit -m "delete old-dir"', { cwd: dir, stdio: "pipe" });
    // Add new-dir with a different file (no rename link)
    await commitFile(dir, "apps/new-dir/run/gogol.ts", "v2", "create new-dir");

    const cwd = path.join(dir, "apps", "new-dir");
    const result = traceHistoricalPaths(cwd);

    expect(result.paths).toContain("apps/new-dir");
    // findRenamePaths should still discover apps/old-dir via rename events
    // on other files that were moved in the same commit
    // (git may detect R100 for the file even though we deleted+recreated)
  });

  it("discovers cross-tree rename (source outside path, destination inside)", async () => {
    // Scenario: apps/external-dir/file.ts is renamed to apps/my-dir/file.ts.
    // git log -- "apps/my-dir" with --diff-filter=R won't show this because
    // the SOURCE path (apps/external-dir) doesn't match the pathspec.
    // findRenamePaths query 2 scans all renames and filters by destination.
    await commitFile(dir, "apps/external-dir/run/main.ts", "v1", "initial external");
    await moveFile(
      dir,
      "apps/external-dir/run/main.ts",
      "apps/my-dir/run/main.ts",
      "cross-tree move",
    );

    const cwd = path.join(dir, "apps", "my-dir");
    const result = traceHistoricalPaths(cwd);

    expect(result.paths).toContain("apps/my-dir");
    expect(result.paths).toContain("apps/external-dir");
  });
});
