/*
<MODULE_CONTRACT>
<purpose>Collect and analyze git commit data by week</purpose>
<non-goals>
  <item>Provide detailed commit message analysis</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of git commit analysis</item>
  <item>ADR-0006: added author field to git log format, filter parameter to collectCommits, post-collection filtering for merges/authors/patterns</item>
  <item>ADR-0004: added untilDate parameter to collectCommits() and resolveTagToDate() helper</item>
</CHANGE_SUMMARY>
*/

import { execSync } from "node:child_process";

import type {
  CommitFilter,
  GitCommit,
  GitFileStat,
  PeriodGroup,
  Period,
  Weekday,
} from "./types.js";

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
export function collectCommits(
  repoRoot: string,
  paths: string[],
  sinceDate?: string,
  untilDate?: string,
  filter?: CommitFilter,
): GitCommit[] {
  const pathArgs = paths.length > 0 ? ["--", ...paths] : [];
  const sinceArg = sinceDate ? [`--since="${sinceDate} 00:00:00"`] : [];
  const untilArg = untilDate ? [`--until="${untilDate} 23:59:59"`] : [];
  const noMergesArg = filter?.excludeMerges ? ["--no-merges"] : [];

  const format = `%H${FIELD_SEP}%ad${FIELD_SEP}%an${FIELD_SEP}%s${FIELD_SEP}${RECORD_SEP}`;
  const args = [
    "log",
    `--format=${format}`,
    `--date=format:%Y-%m-%d`,
    ...sinceArg,
    ...untilArg,
    ...noMergesArg,
    ...pathArgs,
  ];

  const output = execSync(`git ${args.join(" ")}`, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let commits = parseCommits(output, repoRoot);

  if (filter) {
    commits = applyCommitFilter(commits, filter);
  }

  return commits;
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
    if (parts.length < 4) continue;
    const hash = parts[0].trim();
    const date = parts[1].trim();
    const author = parts[2].trim();
    const message = parts[3].trim();

    const files = getCommitFiles(repoRoot, hash);
    commits.push({ hash, date, author, message, files });
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
// Commit filtering (ADR-0006)
// ---------------------------------------------------------------------------

/**
 * Apply post-collection commit filtering.
 * excludeMerges is handled at git log level (--no-merges), but this function
 * handles excludeAuthors and excludePatterns as post-collection filters.
 */
function applyCommitFilter(commits: GitCommit[], filter: CommitFilter): GitCommit[] {
  const excludeAuthors = new Set(filter.excludeAuthors);
  const excludePatterns = filter.excludePatterns.map((p) => new RegExp(p));

  return commits.filter((commit) => {
    if (excludeAuthors.has(commit.author)) return false;
    for (const pattern of excludePatterns) {
      if (pattern.test(commit.message)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Period grouping
// ---------------------------------------------------------------------------

/**
 * Calculate the start of the biweekly period for a given date.
 * Biweekly periods are 14 days long, aligned to startDay.
 * Even/odd weeks are determined from the Unix epoch (1970-01-01).
 */
function getBiweeklyStart(date: Date, startDay: Weekday): Date {
  const weekStart = getWeekStart(date, startDay);
  const daysSinceEpoch = Math.floor(weekStart.getTime() / (1000 * 60 * 60 * 24));
  const weekIndex = Math.floor(daysSinceEpoch / 7);
  if (weekIndex % 2 !== 0) {
    const result = new Date(weekStart);
    result.setDate(result.getDate() - 7);
    return result;
  }
  return weekStart;
}

/**
 * Calculate the start of the month for a given date.
 */
function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Calculate the end of the month for a given date (last day at 23:59:59.999).
 */
function getMonthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

/**
 * Calculate the period start for a given date, based on the period type and configured start day.
 */
export function getPeriodStart(date: Date, period: Period, startDay: Weekday): Date {
  switch (period) {
    case "day":
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    case "week":
      return getWeekStart(date, startDay);
    case "biweekly":
      return getBiweeklyStart(date, startDay);
    case "month":
      return getMonthStart(date);
  }
}

/**
 * Calculate the period end (23:59:59.999) based on the period start and type.
 */
export function getPeriodEnd(periodStart: Date, period: Period): Date {
  switch (period) {
    case "day":
      return new Date(
        periodStart.getFullYear(),
        periodStart.getMonth(),
        periodStart.getDate(),
        23,
        59,
        59,
        999,
      );
    case "week":
      return getWeekEnd(periodStart);
    case "biweekly": {
      const end = new Date(periodStart);
      end.setDate(end.getDate() + 13);
      end.setHours(23, 59, 59, 999);
      return end;
    }
    case "month":
      return getMonthEnd(periodStart);
  }
}

/**
 * Calculate the group key for a commit date based on the period type.
 */
function getGroupKey(date: Date, period: Period, startDay: Weekday): string {
  switch (period) {
    case "day":
      return formatDate(date);
    case "week":
      return formatDate(getWeekStart(date, startDay));
    case "biweekly":
      return formatDate(getBiweeklyStart(date, startDay));
    case "month":
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
}

/**
 * Group commits by the configured period (day, week, biweekly, month).
 * Returns periods in chronological order (oldest first).
 */
export function groupCommits(
  commits: GitCommit[],
  period: Period,
  startDay: Weekday,
): PeriodGroup[] {
  const groupMap = new Map<string, PeriodGroup>();

  for (const commit of commits) {
    const commitDate = parseDate(commit.date);
    const groupKey = getGroupKey(commitDate, period, startDay);

    let group = groupMap.get(groupKey);
    if (!group) {
      const periodStartDate = getPeriodStart(commitDate, period, startDay);
      const periodEndDate = getPeriodEnd(periodStartDate, period);
      group = {
        periodStart: formatDate(periodStartDate),
        periodEnd: formatDate(periodEndDate),
        commits: [],
      };
      groupMap.set(groupKey, group);
    }
    group.commits.push(commit);
  }

  return Array.from(groupMap.values()).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

/**
 * Filter period groups to only the last N periods (from the end).
 */
export function takeLastPeriods(periods: PeriodGroup[], n: number): PeriodGroup[] {
  if (n <= 0) return periods;
  return periods.slice(-n);
}

/**
 * Get the current period start date.
 */
export function getCurrentPeriodStart(period: Period, startDay: Weekday): string {
  return formatDate(getPeriodStart(new Date(), period, startDay));
}

/**
 * Check if a period is still in progress (period end date is today or in the future).
 */
export function isPeriodInProgress(periodEnd: string): boolean {
  const end = parseDate(periodEnd);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return end >= now;
}

/**
 * Resolve a git tag to its commit date as YYYY-MM-DD.
 * Uses `git log -1 --format=%ad --date=short <tag>`.
 * Returns null if the tag does not exist.
 */
export function resolveTagToDate(repoRoot: string, tag: string): string | null {
  try {
    const output = execSync(`git log -1 --format=%ad --date=short ${tag}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const date = output.trim();
    return date || null;
  } catch {
    return null;
  }
}
