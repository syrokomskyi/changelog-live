import { describe, it, expect } from "vitest";

import {
  getWeekStart,
  getWeekEnd,
  formatDate,
  parseDate,
  groupCommits,
  takeLastPeriods,
  isPeriodInProgress,
} from "../git-collect.js";
import type { GitCommit } from "../types.js";

describe("getWeekStart", () => {
  it("returns Thursday for a Friday", () => {
    const fri = new Date(2026, 6, 17); // Fri Jul 17 2026
    const thu = getWeekStart(fri, "thu");
    expect(formatDate(thu)).toBe("2026-07-16");
  });

  it("returns same Thursday for a Thursday", () => {
    const thu = new Date(2026, 6, 16); // Thu Jul 16 2026
    const start = getWeekStart(thu, "thu");
    expect(formatDate(start)).toBe("2026-07-16");
  });

  it("returns previous Thursday for a Wednesday", () => {
    const wed = new Date(2026, 6, 22); // Wed Jul 22 2026
    const start = getWeekStart(wed, "thu");
    expect(formatDate(start)).toBe("2026-07-16");
  });

  it("returns previous Thursday for a Monday", () => {
    const mon = new Date(2026, 6, 20); // Mon Jul 20 2026
    const start = getWeekStart(mon, "thu");
    expect(formatDate(start)).toBe("2026-07-16");
  });

  it("handles Sunday correctly", () => {
    const sun = new Date(2026, 6, 19); // Sun Jul 19 2026
    const start = getWeekStart(sun, "thu");
    expect(formatDate(start)).toBe("2026-07-16");
  });

  it("sets time to 00:00:00", () => {
    const date = new Date(2026, 6, 17, 15, 30, 45);
    const start = getWeekStart(date, "thu");
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });
});

describe("getWeekEnd", () => {
  it("returns Wednesday 6 days after Thursday", () => {
    const thu = new Date(2026, 6, 16); // Thu Jul 16
    const end = getWeekEnd(thu);
    expect(formatDate(end)).toBe("2026-07-22"); // Wed Jul 22
  });
});

describe("formatDate / parseDate", () => {
  it("formats date as YYYY-MM-DD", () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("parses YYYY-MM-DD back to Date", () => {
    const d = parseDate("2026-07-14");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July = 6
    expect(d.getDate()).toBe(14);
  });
});

describe("groupCommits", () => {
  function makeCommit(date: string, message: string): GitCommit {
    return { hash: `hash-${date}`, date, message, files: [] };
  }

  it("groups commits into correct weeks", () => {
    const commits = [
      makeCommit("2026-07-16", "commit on Thursday"),
      makeCommit("2026-07-17", "commit on Friday"),
      makeCommit("2026-07-22", "commit on Wednesday"),
      makeCommit("2026-07-23", "commit on next Thursday"),
    ];

    const weeks = groupCommits(commits, "week", "thu");
    expect(weeks).toHaveLength(2);
    expect(weeks[0].periodStart).toBe("2026-07-16");
    expect(weeks[0].periodEnd).toBe("2026-07-22");
    expect(weeks[0].commits).toHaveLength(3);
    expect(weeks[1].periodStart).toBe("2026-07-23");
    expect(weeks[1].commits).toHaveLength(1);
  });

  it("returns empty array for no commits", () => {
    expect(groupCommits([], "week", "thu")).toEqual([]);
  });

  it("sorts weeks chronologically", () => {
    const commits = [makeCommit("2026-07-23", "later"), makeCommit("2026-07-16", "earlier")];
    const weeks = groupCommits(commits, "week", "thu");
    expect(weeks[0].periodStart).toBe("2026-07-16");
    expect(weeks[1].periodStart).toBe("2026-07-23");
  });
});

describe("takeLastPeriods", () => {
  it("returns last N periods", () => {
    const periods = [
      { periodStart: "2026-06-18", periodEnd: "2026-06-24", commits: [] },
      { periodStart: "2026-06-25", periodEnd: "2026-07-01", commits: [] },
      { periodStart: "2026-07-02", periodEnd: "2026-07-08", commits: [] },
      { periodStart: "2026-07-09", periodEnd: "2026-07-15", commits: [] },
    ];
    const result = takeLastPeriods(periods, 2);
    expect(result).toHaveLength(2);
    expect(result[0].periodStart).toBe("2026-07-02");
    expect(result[1].periodStart).toBe("2026-07-09");
  });

  it("returns all periods when n is 0 or negative", () => {
    const periods = [{ periodStart: "2026-07-02", periodEnd: "2026-07-08", commits: [] }];
    expect(takeLastPeriods(periods, 0)).toHaveLength(1);
  });
});

describe("isPeriodInProgress", () => {
  it("returns true for today or future", () => {
    const today = formatDate(new Date());
    expect(isPeriodInProgress(today)).toBe(true);
  });

  it("returns false for past dates", () => {
    expect(isPeriodInProgress("2020-01-01")).toBe(false);
  });
});
