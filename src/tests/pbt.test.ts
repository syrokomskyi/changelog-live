import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  getWeekStart,
  getWeekEnd,
  formatDate,
  parseDate,
  groupCommits,
  takeLastPeriods,
  isPeriodInProgress,
} from "../git-collect.js";
import {
  renderSection,
  parseChangelog,
  renderFullChangelog,
  mergeSections,
  getLastSection,
} from "../markdown.js";
import type { GitCommit, ParsedChangelog } from "../types.js";
import { CHANGELOG_CATEGORIES } from "../types.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const arbWeekday = fc.constantFrom(...WEEKDAYS);

const arbValidDate = fc
  .date({
    min: new Date(2000, 0, 1),
    max: new Date(2100, 11, 31),
  })
  .filter((d) => !isNaN(d.getTime()));

const arbDateString = arbValidDate.map((d) => formatDate(d));

const arbGitCommit = fc.record({
  hash: fc.string({ minLength: 1, maxLength: 40 }),
  date: arbDateString,
  author: fc.string({ minLength: 1, maxLength: 50 }),
  message: fc.string({ minLength: 1, maxLength: 100 }),
  files: fc.array(
    fc.record({
      path: fc.string({ minLength: 1, maxLength: 50 }),
      additions: fc.nat({ max: 1000 }),
      deletions: fc.nat({ max: 1000 }),
    }),
  ),
});

const arbCategoryEntries = fc.array(fc.string({ minLength: 1, maxLength: 80 }), {
  maxLength: 5,
});

const arbChangelogSection = fc.record({
  periodStart: arbDateString,
  periodEnd: arbDateString,
  categories: fc.record({
    added: arbCategoryEntries,
    changed: arbCategoryEntries,
    fixed: arbCategoryEntries,
    removed: arbCategoryEntries,
    security: arbCategoryEntries,
    documentation: arbCategoryEntries,
  }),
  commitMessage: fc.string({ minLength: 1, maxLength: 72 }),
});

// ---------------------------------------------------------------------------
// Date utility properties
// ---------------------------------------------------------------------------

describe("PBT: formatDate / parseDate roundtrip", () => {
  it("formatDate(parseDate(s)) === s for any YYYY-MM-DD string", () => {
    fc.assert(
      fc.property(arbDateString, (dateStr) => {
        expect(formatDate(parseDate(dateStr))).toBe(dateStr);
      }),
    );
  });
});

describe("PBT: getWeekStart invariants", () => {
  it("week start is always on or before the input date", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws = getWeekStart(date, startDay);
        expect(ws.getTime()).toBeLessThanOrEqual(date.getTime());
      }),
    );
  });

  it("week start time is always 00:00:00:000", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws = getWeekStart(date, startDay);
        expect(ws.getHours()).toBe(0);
        expect(ws.getMinutes()).toBe(0);
        expect(ws.getSeconds()).toBe(0);
        expect(ws.getMilliseconds()).toBe(0);
      }),
    );
  });

  it("week start is at most 6 days before the input date", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws = getWeekStart(date, startDay);
        // Compare by date strings, not raw timestamps, to avoid timezone offset issues
        const wsDate = parseDate(formatDate(ws));
        const inDate = parseDate(formatDate(date));
        const diffDays = Math.round((inDate.getTime() - wsDate.getTime()) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBeGreaterThanOrEqual(0);
        expect(diffDays).toBeLessThanOrEqual(6);
      }),
    );
  });

  it("getWeekStart is idempotent", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws1 = getWeekStart(date, startDay);
        const ws2 = getWeekStart(ws1, startDay);
        expect(formatDate(ws1)).toBe(formatDate(ws2));
      }),
    );
  });
});

describe("PBT: getWeekEnd invariants", () => {
  it("week end is always 6 days after week start", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws = getWeekStart(date, startDay);
        const we = getWeekEnd(ws);
        // Compare by date strings to avoid timezone offset issues
        const wsDate = parseDate(formatDate(ws));
        const weDate = parseDate(formatDate(we));
        const diffDays = Math.round((weDate.getTime() - wsDate.getTime()) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBe(6);
      }),
    );
  });

  it("week end time is 23:59:59.999", () => {
    fc.assert(
      fc.property(arbValidDate, arbWeekday, (date, startDay) => {
        const ws = getWeekStart(date, startDay);
        const we = getWeekEnd(ws);
        expect(we.getHours()).toBe(23);
        expect(we.getMinutes()).toBe(59);
        expect(we.getSeconds()).toBe(59);
        expect(we.getMilliseconds()).toBe(999);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Week grouping properties
// ---------------------------------------------------------------------------

describe("PBT: groupCommits invariants", () => {
  it("periods are in chronological order", () => {
    fc.assert(
      fc.property(fc.array(arbGitCommit, { maxLength: 50 }), arbWeekday, (commits, startDay) => {
        const periods = groupCommits(commits, "week", startDay);
        for (let i = 1; i < periods.length; i++) {
          expect(
            periods[i].periodStart.localeCompare(periods[i - 1].periodStart),
          ).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("every commit appears in exactly one period (partition)", () => {
    fc.assert(
      fc.property(fc.array(arbGitCommit, { maxLength: 50 }), arbWeekday, (commits, startDay) => {
        const periods = groupCommits(commits, "week", startDay);
        const totalCommitsInPeriods = periods.reduce((sum: number, w) => sum + w.commits.length, 0);
        expect(totalCommitsInPeriods).toBe(commits.length);
      }),
    );
  });

  it("no two periods share the same periodStart", () => {
    fc.assert(
      fc.property(fc.array(arbGitCommit, { maxLength: 50 }), arbWeekday, (commits, startDay) => {
        const periods = groupCommits(commits, "week", startDay);
        const periodStarts = periods.map((w) => w.periodStart);
        const unique = new Set(periodStarts);
        expect(unique.size).toBe(periodStarts.length);
      }),
    );
  });

  it("empty commits produces empty periods", () => {
    fc.assert(
      fc.property(arbWeekday, (startDay) => {
        expect(groupCommits([], "week", startDay)).toEqual([]);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// takeLastWeeks properties
// ---------------------------------------------------------------------------

describe("PBT: takeLastPeriods invariants", () => {
  const arbPeriods = fc.array(
    fc.record({
      periodStart: fc.string({ minLength: 10, maxLength: 10 }),
      periodEnd: fc.string({ minLength: 10, maxLength: 10 }),
      commits: fc.constant<GitCommit[]>([]),
    }),
    { maxLength: 20 },
  );

  it("returns at most n periods for n > 0", () => {
    fc.assert(
      fc.property(arbPeriods, fc.integer({ min: 1, max: 100 }), (periods, n) => {
        const result = takeLastPeriods(periods, n);
        expect(result.length).toBe(Math.min(periods.length, n));
      }),
    );
  });

  it("returns all periods for n <= 0", () => {
    fc.assert(
      fc.property(arbPeriods, fc.integer({ min: -100, max: 0 }), (periods, n) => {
        const result = takeLastPeriods(periods, n);
        expect(result.length).toBe(periods.length);
      }),
    );
  });

  it("result is a suffix of the input", () => {
    fc.assert(
      fc.property(arbPeriods, fc.integer({ min: 1, max: 100 }), (periods, n) => {
        const result = takeLastPeriods(periods, n);
        if (result.length > 0) {
          expect(result[0]).toBe(periods[periods.length - result.length]);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// isWeekInProgress properties
// ---------------------------------------------------------------------------

describe("PBT: isPeriodInProgress invariants", () => {
  it("any past date is not in progress", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2000, 0, 1), max: new Date(2010, 11, 31) }), (d) => {
        expect(isPeriodInProgress(formatDate(d))).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown roundtrip properties
// ---------------------------------------------------------------------------

describe("PBT: renderSection / parseChangelog roundtrip", () => {
  it("parseChangelog(renderSection(section)) recovers periodStart and periodEnd", () => {
    fc.assert(
      fc.property(arbChangelogSection, (section) => {
        const md = renderSection(section);
        const parsed = parseChangelog(`# Changelog\n\n${md}`);
        expect(parsed.sections.length).toBe(1);
        expect(parsed.sections[0].periodStart).toBe(section.periodStart);
        expect(parsed.sections[0].periodEnd).toBe(section.periodEnd);
      }),
    );
  });

  it("parseChangelog(renderFullChangelog(sections)) recovers all section period ranges", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbChangelogSection, { maxLength: 10, selector: (s) => s.periodStart }),
        (sections) => {
          const md = renderFullChangelog(sections, "desc");
          const parsed = parseChangelog(md);
          expect(parsed.sections.length).toBe(sections.length);

          // Each section's periodStart should appear in parsed sections
          for (const s of sections) {
            const found = parsed.sections.find((ps) => ps.periodStart === s.periodStart);
            expect(found).toBeDefined();
          }
        },
      ),
    );
  });

  it("renderSection only includes non-empty categories", () => {
    fc.assert(
      fc.property(arbChangelogSection, (section) => {
        const md = renderSection(section);
        for (const cat of CHANGELOG_CATEGORIES) {
          const entries = section.categories[cat];
          if (entries.length > 0) {
            expect(md).toContain(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
          }
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// mergeSections properties
// ---------------------------------------------------------------------------

describe("PBT: mergeSections invariants", () => {
  it("no duplicate periodStart after merge", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbChangelogSection, { maxLength: 5, selector: (s) => s.periodStart }),
        fc.uniqueArray(arbChangelogSection, { maxLength: 5, selector: (s) => s.periodStart }),
        (existing, newSections) => {
          const parsedExisting: ParsedChangelog = {
            header: "# Changelog",
            sections: existing.map((s) => ({
              periodStart: s.periodStart,
              periodEnd: s.periodEnd,
              raw: renderSection(s),
            })),
          };

          const merged = mergeSections(parsedExisting, newSections);
          const periodStarts = merged.map((s) => s.periodStart);
          const unique = new Set(periodStarts);
          expect(unique.size).toBe(periodStarts.length);
        },
      ),
    );
  });

  it("new sections replace existing ones with same periodStart", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbChangelogSection, { maxLength: 3, selector: (s) => s.periodStart }),
        fc.uniqueArray(arbChangelogSection, { maxLength: 3, selector: (s) => s.periodStart }),
        (existing, newSections) => {
          const parsedExisting: ParsedChangelog = {
            header: "# Changelog",
            sections: existing.map((s) => ({
              periodStart: s.periodStart,
              periodEnd: s.periodEnd,
              raw: renderSection(s),
            })),
          };

          const merged = mergeSections(parsedExisting, newSections);

          // For every new section, if its periodStart existed before, the merged
          // version should have the new categories, not the old ones
          for (const newSec of newSections) {
            const mergedSec = merged.find((s) => s.periodStart === newSec.periodStart);
            if (mergedSec) {
              expect(mergedSec.categories.added).toEqual(newSec.categories.added);
              expect(mergedSec.commitMessage).toBe(newSec.commitMessage);
            }
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// getLastSection properties
// ---------------------------------------------------------------------------

describe("PBT: getLastSection invariants", () => {
  it("returns section with max periodStart", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            periodStart: fc.string({ minLength: 10, maxLength: 10 }),
            periodEnd: fc.string({ minLength: 10, maxLength: 10 }),
            raw: fc.constant(""),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (sections) => {
          const parsed: ParsedChangelog = { header: "", sections };
          const last = getLastSection(parsed);
          expect(last).not.toBeNull();
          const maxPeriodStart = sections.reduce(
            (max, s) => (s.periodStart > max ? s.periodStart : max),
            sections[0].periodStart,
          );
          expect(last!.periodStart).toBe(maxPeriodStart);
        },
      ),
    );
  });

  it("returns null for empty sections", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const parsed: ParsedChangelog = { header: "", sections: [] };
        expect(getLastSection(parsed)).toBeNull();
      }),
    );
  });
});
