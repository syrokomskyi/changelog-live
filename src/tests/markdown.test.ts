import { describe, it, expect } from "vitest";

import {
  parseChangelog,
  getLastSection,
  renderSection,
  renderFullChangelog,
  mergeSections,
} from "../markdown.js";
import type { ChangelogSection, ParsedChangelog } from "../types.js";

describe("renderSection", () => {
  it("renders a section with categories", () => {
    const section: ChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-16",
      categories: {
        added: ["Add Matomo analytics", "Add privacy-first config"],
        changed: [],
        fixed: ["Fix k-anonymity threshold"],
        removed: [],
        security: [],
        documentation: ["Update methodology docs"],
      },
      commitMessage: "Add analytics and fix threshold",
    };

    const md = renderSection(section);
    expect(md).toContain("## 2026-07-10 .. 2026-07-16");
    expect(md).toContain("### Added");
    expect(md).toContain("- Add Matomo analytics");
    expect(md).toContain("### Fixed");
    expect(md).toContain("- Fix k-anonymity threshold");
    expect(md).toContain("### Documentation");
    expect(md).not.toContain("### Changed");
    expect(md).not.toContain("### Removed");
  });

  it("renders empty section with just header", () => {
    const section: ChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-16",
      categories: {
        added: [],
        changed: [],
        fixed: [],
        removed: [],
        security: [],
        documentation: [],
      },
      commitMessage: "no changes",
    };

    const md = renderSection(section);
    expect(md).toContain("## 2026-07-10 .. 2026-07-16");
    expect(md).not.toContain("### Added");
  });
});

describe("renderFullChangelog", () => {
  it("renders with desc sort (newest first)", () => {
    const sections: ChangelogSection[] = [
      {
        weekStart: "2026-07-03",
        weekEnd: "2026-07-09",
        categories: {
          added: ["Earlier"],
          changed: [],
          fixed: [],
          removed: [],
          security: [],
          documentation: [],
        },
        commitMessage: "earlier",
      },
      {
        weekStart: "2026-07-10",
        weekEnd: "2026-07-16",
        categories: {
          added: ["Later"],
          changed: [],
          fixed: [],
          removed: [],
          security: [],
          documentation: [],
        },
        commitMessage: "later",
      },
    ];

    const md = renderFullChangelog(sections, "desc");
    const laterIdx = md.indexOf("Later");
    const earlierIdx = md.indexOf("Earlier");
    expect(laterIdx).toBeLessThan(earlierIdx);
  });

  it("includes header", () => {
    const md = renderFullChangelog([], "desc", "# My Changelog\n");
    expect(md.startsWith("# My Changelog")).toBe(true);
  });
});

describe("parseChangelog", () => {
  it("parses header and sections", () => {
    const content = `# Changelog

All notable changes.

## 2026-07-10 .. 2026-07-16

### Added
- Add feature A

### Fixed
- Fix bug B

## 2026-07-03 .. 2026-07-09

### Changed
- Update C
`;

    const parsed = parseChangelog(content);
    expect(parsed.header).toContain("# Changelog");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].weekStart).toBe("2026-07-10");
    expect(parsed.sections[0].weekEnd).toBe("2026-07-16");
    expect(parsed.sections[1].weekStart).toBe("2026-07-03");
  });

  it("handles empty changelog", () => {
    const parsed = parseChangelog("# Changelog\n\nNo entries yet.\n");
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.header).toContain("# Changelog");
  });

  it("handles legacy dash separator in dates", () => {
    const content = `# Changelog\n\n## 2026-07-10 - 2026-07-16\n\n### Added\n- Test\n`;
    const parsed = parseChangelog(content);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].weekStart).toBe("2026-07-10");
  });

  it("handles dotdot separator in dates", () => {
    const content = `# Changelog\n\n## 2026-07-10 .. 2026-07-16\n\n### Added\n- Test\n`;
    const parsed = parseChangelog(content);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0].weekStart).toBe("2026-07-10");
  });
});

describe("getLastSection", () => {
  it("returns section with latest weekStart", () => {
    const parsed: ParsedChangelog = {
      header: "# Changelog",
      sections: [
        { weekStart: "2026-07-03", weekEnd: "2026-07-09", raw: "" },
        { weekStart: "2026-07-10", weekEnd: "2026-07-16", raw: "" },
        { weekStart: "2026-06-25", weekEnd: "2026-07-01", raw: "" },
      ],
    };

    const last = getLastSection(parsed);
    expect(last?.weekStart).toBe("2026-07-10");
  });

  it("returns null for empty sections", () => {
    const parsed: ParsedChangelog = { header: "", sections: [] };
    expect(getLastSection(parsed)).toBeNull();
  });
});

describe("mergeSections", () => {
  it("adds new sections to existing", () => {
    const existing: ParsedChangelog = {
      header: "# Changelog",
      sections: [
        {
          weekStart: "2026-06-25",
          weekEnd: "2026-07-01",
          raw: "## 2026-06-25 .. 2026-07-01\n\n### Added\n- Old feature\n",
        },
      ],
    };

    const newSections: ChangelogSection[] = [
      {
        weekStart: "2026-07-10",
        weekEnd: "2026-07-16",
        categories: {
          added: ["New feature"],
          changed: [],
          fixed: [],
          removed: [],
          security: [],
          documentation: [],
        },
        commitMessage: "new",
      },
    ];

    const merged = mergeSections(existing, newSections);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.weekStart === "2026-06-25")).toBeDefined();
    expect(merged.find((s) => s.weekStart === "2026-07-10")).toBeDefined();
  });

  it("replaces existing week with new section", () => {
    const existing: ParsedChangelog = {
      header: "# Changelog",
      sections: [
        {
          weekStart: "2026-07-10",
          weekEnd: "2026-07-16",
          raw: "## 2026-07-10 .. 2026-07-16\n\n### Added\n- Old entry\n",
        },
      ],
    };

    const newSections: ChangelogSection[] = [
      {
        weekStart: "2026-07-10",
        weekEnd: "2026-07-16",
        categories: {
          added: ["New entry", "Another entry"],
          changed: [],
          fixed: [],
          removed: [],
          security: [],
          documentation: [],
        },
        commitMessage: "updated",
      },
    ];

    const merged = mergeSections(existing, newSections);
    expect(merged).toHaveLength(1);
    expect(merged[0].categories.added).toContain("New entry");
    expect(merged[0].categories.added).not.toContain("Old entry");
  });
});
