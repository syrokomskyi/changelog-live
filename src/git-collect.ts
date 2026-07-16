import { execSync } from "node:child_process";

import type { GitCommit, GitFileStat, WeekGroup, Weekday } from "./types.js";

// ---------------------------------------------------------------------------
// Weekday helpers
// ---------------------------------------------------------------------------

const WEEKDAY_NUM: Record<Weekday, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

/**
 * Calculate the start of the week (00:00) for a given date, based on the configured start day.
 * For any date D, the week start is D minus (D.weekday - startDay + 7) % 7 days.
 */
export function getWeekStart(date: Date, startDay: Weekday): Date {
  const dayNum = date.getDay();
  const startNum = WEEKDAY_NUM[startDay];
  const offset = (dayNum - startNum + 7) % 7;
  const result = new Date(date);
  result.setDate(result.getDate() - offset);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Calculate the end of the week (23:59:59.999) — 6 days after week start.
 */
export function getWeekEnd(weekStart: Date): Date {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

/**
 * Format a Date as YYYY-MM-DD.
 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parse a YYYY-MM-DD string into a Date at 00:00 local time.
 */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ---------------------------------------------------------------------------
// Git log collection
// ---------------------------------------------------------------------------

/**
 * Unique separator for parsing git log output.
 */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/**
 * Collect git commits affecting the given paths, since a specific date (exclusive).
 * If sinceDate is undefined, collects all commits.
 */
export function collectCommits(repoRoot: string, paths: string[], sinceDate?: string): GitCommit[] {
  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
  const sinceArg = sinceDate ? [`--since="${sinceDate} 00:00:00"`] : [];

  const format = `%H${FIELD_SEP}%ad${FIELD_SEP}%s${FIELD_SEP}${RECORD_SEP}`;
  const args = ["log", `--format=${format}`, `--date=format:%Y-%m-%d`, ...sinceArg, ...pathArgs];

  const output = execSync(`git ${args.join(" ")}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  return parseCommits(output, repoRoot);
}

/**
 * Get the date of the first commit affecting the given paths.
 */
export function getFirstCommitDate(repoRoot: string, paths: string[]): string | null {
  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
  const args = ["log", "--reverse", "--format=%ad", "--date=format:%Y-%m-%d", ...pathArgs];

  try {
    const output = execSync(`git ${args.join(" ")}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const firstLine = output.trim().split("\n")[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Get the date of the last commit affecting the given paths.
 */
export function getLastCommitDate(repoRoot: string, paths: string[]): string | null {
  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
  const args = ["log", "--format=%ad", "--date=format:%Y-%m-%d", ...pathArgs];

  try {
    const output = execSync(`git ${args.join(" ")}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const firstLine = output.trim().split("\n")[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Parse git log output with stat into GitCommit[].
 */
function parseCommits(output: string, repoRoot: string): GitCommit[] {
  const records = output.split(RECORD_SEP).filter((r) => r.trim());
  const commits: GitCommit[] = [];

  for (const record of records) {
    const parts = record.split(FIELD_SEP);
    if (parts.length < 3) continue;
    const hash = parts[0].trim();
    const date = parts[1].trim();
    const message = parts[2].trim();

    const files = getCommitFiles(repoRoot, hash);
    commits.push({ hash, date, message, files });
  }

  return commits;
}

/**
 * Get file stats for a single commit.
 */
function getCommitFiles(repoRoot: string, hash: string): GitFileStat[] {
  try {
    const output = execSync(`git show --stat --format="" ${hash}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const files: GitFileStat[] = [];
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/);
      if (match) {
        const filePath = match[1].trim();
        const plusMinus = match[3];
        const additions = (plusMinus.match(/\+/g) || []).length;
        const deletions = (plusMinus.match(/-/g) || []).length;
        files.push({ path: filePath, additions, deletions });
        continue;
      }
      // Binary file line: "foo.png | Bin 1234 -> 5678 bytes"
      const binMatch = line.match(/^\s*(.+?)\s+\|\s+Bin/);
      if (binMatch) {
        files.push({ path: binMatch[1].trim(), additions: 0, deletions: 0 });
      }
    }
    return files;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Week grouping
// ---------------------------------------------------------------------------

/**
 * Group commits by week (startDay-based).
 * Returns weeks in chronological order (oldest first).
 */
export function groupCommitsByWeek(commits: GitCommit[], startDay: Weekday): WeekGroup[] {
  const weekMap = new Map<string, WeekGroup>();

  for (const commit of commits) {
    const commitDate = parseDate(commit.date);
    const weekStart = getWeekStart(commitDate, startDay);
    const weekKey = formatDate(weekStart);

    let group = weekMap.get(weekKey);
    if (!group) {
      const weekEnd = getWeekEnd(weekStart);
      group = {
        weekStart: weekKey,
        weekEnd: formatDate(weekEnd),
        commits: [],
      };
      weekMap.set(weekKey, group);
    }
    group.commits.push(commit);
  }

  return Array.from(weekMap.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Filter week groups to only the last N weeks (from the end).
 */
export function takeLastWeeks(weeks: WeekGroup[], n: number): WeekGroup[] {
  if (n <= 0) return weeks;
  return weeks.slice(-n);
}

/**
 * Get the current week start date.
 */
export function getCurrentWeekStart(startDay: Weekday): string {
  return formatDate(getWeekStart(new Date(), startDay));
}

/**
 * Check if a week is still in progress (week end date is today or in the future).
 */
export function isWeekInProgress(weekEnd: string): boolean {
  const end = parseDate(weekEnd);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return end >= now;
}
