import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceResult {
  /** All discovered paths (current + historical), relative to repo root, posix-style. */
  paths: string[];
  /** Relative path from CWD to repo root, posix-style (e.g. "../.."). */
  repoRoot: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitRepoRoot(cwd: string): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
}

/**
 * Get the path of CWD relative to the git repo root, posix-style.
 * Uses `git rev-parse --show-prefix` to avoid Windows short-name path issues.
 * Returns "" when CWD is the repo root.
 */
function gitShowPrefix(cwd: string): string {
  const prefix = execSync("git rev-parse --show-prefix", { cwd, encoding: "utf-8" }).trim();
  // git returns path with trailing slash, e.g. "apps/hdri/"
  return prefix.replace(/\/$/, "");
}

/**
 * Get relative path from CWD to repo root, posix-style.
 * Uses `git rev-parse --show-cdup` to avoid Windows short-name path issues.
 */
function gitShowCdup(cwd: string): string {
  const cdup = execSync("git rev-parse --show-cdup", { cwd, encoding: "utf-8" }).trim();
  return toPosix(cdup).replace(/\/+$/, "") || ".";
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Rename tracing
// ---------------------------------------------------------------------------

/**
 * Extract directory prefix from a file path (everything except the last segment).
 * "apps/hdri/factory/run/main.ts" → "apps/hdri/factory/run"
 */
function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

/**
 * Generate all ancestor directories of a path (excluding root).
 * "apps/v1/run" → ["apps", "apps/v1", "apps/v1/run"]
 */
function ancestorsOf(dirPath: string): string[] {
  const parts = dirPath.split("/");
  const result: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    result.push(acc);
  }
  return result;
}

/**
 * Find a seed file in a directory to use for --follow rename tracing.
 * Tries HEAD first, then falls back to the most recent commit that touched the path.
 */
function findSeedFile(repoRoot: string, gitPath: string): string | null {
  const prefix = gitPath === "." ? "" : gitPath + "/";
  // Try current HEAD first — recursive, but filter out hidden/dash-prefixed subdirs
  let output: string;
  try {
    output = execSync(`git ls-tree -r --name-only HEAD -- "${gitPath}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const files = output
      .split("\n")
      .filter(Boolean)
      .filter((f) => {
        if (!f.startsWith(prefix)) return false;
        const rest = f.slice(prefix.length);
        // Exclude paths through hidden or dash-prefixed directories
        return !rest.split("/").some((seg) => seg.startsWith(".") || seg.startsWith("-"));
      });
    if (files.length > 0) return files[0];
  } catch {
    // HEAD might not have files under this path
  }

  // Fallback: find files that were ever added under this path
  try {
    output = execSync(`git log --all --diff-filter=A --name-only --format="" -- "${gitPath}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const files = output
      .split("\n")
      .filter(Boolean)
      .filter((f) => {
        if (!f.startsWith(prefix)) return false;
        const rest = f.slice(prefix.length);
        return !rest.split("/").some((seg) => seg.startsWith(".") || seg.startsWith("-"));
      });
    if (files.length > 0) return files[0];
  } catch {
    // path might not exist in any commit
  }

  return null;
}

/**
 * Trace the full rename history of a single file using `git log --follow --name-status`.
 * Returns all historical directories where this file (or its ancestors) ever lived.
 */
function traceFileHistory(repoRoot: string, filePath: string): Set<string> {
  let output: string;
  try {
    output = execSync(`git log --all --follow --name-status --format="%H" -- "${filePath}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
    });
  } catch {
    return new Set();
  }

  const dirs = new Set<string>();
  for (const line of output.split("\n")) {
    // A\tpath/to/file.ts  — file was added here
    // R100\told/path/file.ts\tnew/path/file.ts  — file was renamed
    // C100\told/path/file.ts\tnew/path/file.ts  — file was copied
    // M\tpath/to/file.ts  — file was modified
    const renameMatch = /^[RC]\d*\t(.+)\t(.+)$/.exec(line);
    const modifyMatch = /^[AM]\t(.+)$/.exec(line);

    if (renameMatch) {
      const oldFile = renameMatch[1];
      const newFile = renameMatch[2];
      const oldDir = dirOf(oldFile);
      const newDir = dirOf(newFile);
      for (const anc of ancestorsOf(oldDir)) dirs.add(anc);
      for (const anc of ancestorsOf(newDir)) dirs.add(anc);
    } else if (modifyMatch) {
      const file = modifyMatch[1];
      const dir = dirOf(file);
      for (const anc of ancestorsOf(dir)) dirs.add(anc);
    }
  }
  return dirs;
}

/**
 * Scan all rename events that ever touched files under a path.
 * Returns directories extracted from both source and destination of each rename.
 *
 * This complements traceFileHistory by catching directory moves that --follow
 * on a single seed file might miss — e.g. when the seed file was added after
 * the move, or when files were deleted rather than renamed (breaking the
 * --follow chain).
 *
 * Two git queries are needed because `git log -- <path>` with --diff-filter=R
 * matches the SOURCE path of the rename, not the destination. So a rename from
 * `apps/old-dir/file.ts` → `apps/my-dir/file.ts` won't show up when querying
 * `-- "apps/my-dir"`. The second query scans all renames (no pathspec) and
 * filters for destinations under our path in code.
 */
function findRenamePaths(repoRoot: string, gitPath: string): Set<string> {
  const dirs = new Set<string>();
  const prefix = gitPath === "." ? "" : gitPath + "/";

  // 1. Renames where the SOURCE is under our path (git log -- <path> matches source)
  try {
    const output = execSync(
      `git log --all --name-status --diff-filter=R --format="%H" -- "${gitPath}"`,
      { cwd: repoRoot, encoding: "utf-8", timeout: 10000 },
    );
    for (const line of output.split("\n")) {
      const match = /^[RC]\d*\t(.+)\t(.+)$/.exec(line);
      if (match) {
        const oldDir = dirOf(match[1]);
        const newDir = dirOf(match[2]);
        for (const anc of ancestorsOf(oldDir)) dirs.add(anc);
        for (const anc of ancestorsOf(newDir)) dirs.add(anc);
      }
    }
  } catch {
    // ignore — timeout or git error
  }

  // 2. Renames where the DESTINATION is under our path (source is outside)
  //    git log -- <path> misses these, so we scan all renames and filter in code.
  //    Uses -M (rename detection) to ensure renames are detected.
  try {
    const output = execSync(`git log --all -M --name-status --diff-filter=R --format="%H"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 15000,
    });
    for (const line of output.split("\n")) {
      const match = /^[RC]\d*\t(.+)\t(.+)$/.exec(line);
      if (match) {
        const oldFile = match[1];
        const newFile = match[2];
        // Only include if the destination is under our path
        if (prefix === "" || newFile.startsWith(prefix)) {
          const oldDir = dirOf(oldFile);
          const newDir = dirOf(newFile);
          for (const anc of ancestorsOf(oldDir)) dirs.add(anc);
          for (const anc of ancestorsOf(newDir)) dirs.add(anc);
        }
      }
    }
  } catch {
    // ignore — timeout or git error
  }

  return dirs;
}

/**
 * Recursively trace all historical paths for a given starting directory.
 *
 * Algorithm:
 * 1. Find a seed file in the directory (from current HEAD).
 * 2. Use `git log --follow --name-status` to trace the file's full rename history.
 * 3. Extract all directories where the file (or its ancestors) ever lived.
 * 4. For each newly discovered directory, repeat from step 1.
 *
 * Note: findRenamePaths is called separately in traceHistoricalPaths
 * (once per seed, not recursively) to avoid exponential git calls on large repos.
 */
function tracePath(repoRoot: string, startPath: string, visited: Set<string>): void {
  if (visited.has(startPath)) return;
  visited.add(startPath);

  const seedFile = findSeedFile(repoRoot, startPath);
  if (!seedFile) return;

  const dirs = traceFileHistory(repoRoot, seedFile);
  for (const dir of dirs) {
    if (!visited.has(dir)) {
      tracePath(repoRoot, dir, visited);
    }
  }
}

// ---------------------------------------------------------------------------
// Subdirectory discovery
// ---------------------------------------------------------------------------

/**
 * List visible subdirectories (first level) in a directory.
 * Excludes hidden directories (starting with "." or "-").
 */
function listSubdirs(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("-"))
    .map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Subpath pruning
// ---------------------------------------------------------------------------

/**
 * Remove paths that are subdirectories of other paths in the list.
 * `git log -- <dir>` already recurses into nested directories, so listing
 * both `apps/foo` and `apps/foo/bar` is redundant.
 *
 * Path-segment aware: `apps/hdri` does NOT prune `apps/hdri-factory`.
 */
function pruneSubpaths(paths: string[]): string[] {
  const sorted = [...paths].sort();
  const result: string[] = [];
  for (const p of sorted) {
    // Check if p is a subdirectory of any already-kept path
    const isSubpath = result.some((kept) => p === kept || p.startsWith(kept + "/"));
    if (!isSubpath) {
      result.push(p);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Trace all historical git paths for the current working directory.
 *
 * - Discovers CWD + all visible subdirectories of CWD.
 * - For each, traces rename history recursively via `git log --follow --name-status`.
 * - Returns all unique paths (current + historical) relative to repo root.
 */
export function traceHistoricalPaths(cwd: string): TraceResult {
  const repoRootAbs = gitRepoRoot(cwd);
  const cwdRel = gitShowPrefix(cwd) || ".";

  // Collect seed paths: CWD + visible subdirectories
  const seeds: string[] = [cwdRel];
  for (const sub of listSubdirs(cwd)) {
    seeds.push(toPosix(path.posix.join(cwdRel, sub)));
  }

  // Trace each seed via --follow on seed files
  const visited = new Set<string>();
  for (const seed of seeds) {
    tracePath(repoRootAbs, seed, visited);
  }

  // Scan rename events once per seed (not recursively) to catch directory
  // moves that --follow on seed files missed (deleted files, broken chains).
  // Each newly discovered directory is fed back into tracePath.
  const renameQueue: string[] = [];
  for (const seed of seeds) {
    const renameDirs = findRenamePaths(repoRootAbs, seed);
    for (const dir of renameDirs) {
      if (!visited.has(dir)) {
        renameQueue.push(dir);
      }
    }
  }
  for (const dir of renameQueue) {
    tracePath(repoRootAbs, dir, visited);
  }

  // Remove strict ancestors of seeds — they're too broad for git log filtering
  // (e.g., "apps" would catch commits from all projects, not just ours)
  const seedSet = new Set(seeds);
  const noAncestors = Array.from(visited).filter((p) => {
    if (seedSet.has(p)) return true;
    // Remove if p is a strict ancestor of any seed
    return !seeds.some((s) => s.startsWith(p + "/"));
  });

  // Sort: current paths first, then historical (alphabetical within each group)
  const sorted = noAncestors.sort((a, b) => {
    const aIsSeed = seedSet.has(a) ? 0 : 1;
    const bIsSeed = seedSet.has(b) ? 0 : 1;
    if (aIsSeed !== bIsSeed) return aIsSeed - bIsSeed;
    return a.localeCompare(b);
  });

  // Remove redundant subpaths — git log recurses into nested directories
  const pruned = pruneSubpaths(sorted);

  return {
    paths: pruned,
    repoRoot: gitShowCdup(cwd),
  };
}
