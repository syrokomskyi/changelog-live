import { describe, it, expect } from "vitest";

import path from "node:path";

import { validateConfig } from "../config.js";
import { getPublicPrimaryFilePath, getPublicTranslationFilePath } from "../config.js";
import {
  renderPublicSection,
  renderPublicHeader,
  renderFullPublicChangelog,
  parsePublicChangelog,
  mergePublicSections,
} from "../markdown.js";
import { parsePublicGenerationResponse } from "../ai-generate.js";
import type { PublicChangelogSection, WeekGroup } from "../types.js";

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

describe("publicChangelog config", () => {
  it("defaults to false", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    expect(config.publicChangelog).toBe(false);
  });

  it("accepts true", () => {
    const config = validateConfig({ git: { subPath: "src" }, publicChangelog: true });
    expect(config.publicChangelog).toBe(true);
  });

  it("rejects non-boolean", () => {
    expect(() => validateConfig({ git: { subPath: "src" }, publicChangelog: "yes" })).toThrow();
  });
});

describe("getPublicPrimaryFilePath", () => {
  it("returns CHANGELOG_PUBLIC.md in output dir", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    expect(getPublicPrimaryFilePath(config)).toBe("CHANGELOG_PUBLIC.md");
  });

  it("respects custom dir", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      output: { dir: "docs", filename: "CHANGELOG" },
    });
    expect(getPublicPrimaryFilePath(config)).toBe(path.join("docs", "CHANGELOG_PUBLIC.md"));
  });
});

describe("getPublicTranslationFilePath", () => {
  it("returns CHANGELOG_PUBLIC.{lang}.md", () => {
    const config = validateConfig({ git: { subPath: "src" } });
    expect(getPublicTranslationFilePath(config, "en")).toBe("CHANGELOG_PUBLIC.en.md");
  });

  it("respects custom dir", () => {
    const config = validateConfig({
      git: { subPath: "src" },
      output: { dir: "docs", filename: "CHANGELOG" },
    });
    expect(getPublicTranslationFilePath(config, "de")).toBe(
      path.join("docs", "CHANGELOG_PUBLIC.de.md"),
    );
  });
});

// ---------------------------------------------------------------------------
// Markdown render tests
// ---------------------------------------------------------------------------

describe("renderPublicSection", () => {
  it("renders title, summary, and categories", () => {
    const section: PublicChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-17",
      title: "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17",
      summary: "We improved dashboard loading times and added DSGVO-compliant privacy pages.",
      categories: {
        added: ["New privacy page (DE)"],
        improved: ["Dashboard load times reduced by 40%"],
        fixed: [],
        security_compliance: ["DSGVO-compliant cookie consent"],
        integrations: [],
      },
    };

    const md = renderPublicSection(section);
    expect(md).toContain("## Plattform-Updates für die Woche 2026-07-10 — 2026-07-17");
    expect(md).toContain("We improved dashboard loading times");
    expect(md).toContain("### Added");
    expect(md).toContain("- New privacy page (DE)");
    expect(md).toContain("### Improved");
    expect(md).toContain("### Security & Compliance");
    expect(md).not.toContain("### Fixed");
    expect(md).not.toContain("### Integrations");
  });

  it("renders without summary when empty", () => {
    const section: PublicChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-17",
      title: "Updates 2026-07-10 — 2026-07-17",
      summary: "",
      categories: {
        added: ["Feature A"],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };

    const md = renderPublicSection(section);
    expect(md).toContain("## Updates 2026-07-10 — 2026-07-17");
    expect(md).toContain("### Added");
    expect(md).toContain("- Feature A");
  });
});

describe("renderPublicHeader", () => {
  it("renders with project name", () => {
    const header = renderPublicHeader("hdri");
    expect(header).toContain("# Changelog");
    expect(header).toContain("client-facing");
    expect(header).toContain("`hdri`");
  });

  it("renders with default when no project name", () => {
    const header = renderPublicHeader();
    expect(header).toContain("`this`");
  });
});

describe("renderFullPublicChangelog", () => {
  it("sorts sections desc by default", () => {
    const sections: PublicChangelogSection[] = [
      {
        weekStart: "2026-07-03",
        weekEnd: "2026-07-10",
        title: "Week 1 2026-07-03 — 2026-07-10",
        summary: "Summary 1",
        categories: {
          added: [],
          improved: [],
          fixed: [],
          security_compliance: [],
          integrations: [],
        },
      },
      {
        weekStart: "2026-07-10",
        weekEnd: "2026-07-17",
        title: "Week 2 2026-07-10 — 2026-07-17",
        summary: "Summary 2",
        categories: {
          added: [],
          improved: [],
          fixed: [],
          security_compliance: [],
          integrations: [],
        },
      },
    ];

    const md = renderFullPublicChangelog(sections, "desc", "# Changelog\n\nHeader");
    const week1Idx = md.indexOf("2026-07-03");
    const week2Idx = md.indexOf("2026-07-10 — 2026-07-17");
    expect(week2Idx).toBeLessThan(week1Idx);
  });
});

// ---------------------------------------------------------------------------
// Markdown parse tests
// ---------------------------------------------------------------------------

describe("parsePublicChangelog", () => {
  it("parses header and sections", () => {
    const md = `# Changelog

All notable client-facing changes to the \`hdri\` project are documented here.

## Plattform-Updates für die Woche 2026-07-10 — 2026-07-17

We improved loading times and added privacy pages.

### Added
- New privacy page (DE)

### Improved
- Dashboard load times reduced by 40%

## Updates 2026-07-03 — 2026-07-10

Minor fixes.

### Fixed
- Login redirect bug
`;

    const parsed = parsePublicChangelog(md);
    expect(parsed.header).toContain("# Changelog");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0].weekStart).toBe("2026-07-10");
    expect(parsed.sections[0].weekEnd).toBe("2026-07-17");
    expect(parsed.sections[0].title).toBe(
      "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17",
    );
    expect(parsed.sections[0].summary).toContain("We improved loading times");
    expect(parsed.sections[1].weekStart).toBe("2026-07-03");
    expect(parsed.sections[1].title).toBe("Updates 2026-07-03 — 2026-07-10");
  });

  it("handles empty content", () => {
    const parsed = parsePublicChangelog("");
    expect(parsed.sections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Merge tests
// ---------------------------------------------------------------------------

describe("mergePublicSections", () => {
  it("adds new sections to existing", () => {
    const existing = parsePublicChangelog(
      `# Changelog\n\n## Old 2026-07-03 — 2026-07-10\n\nSummary.\n\n### Added\n- Old feature\n`,
    );

    const newSection: PublicChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-17",
      title: "New 2026-07-10 — 2026-07-17",
      summary: "New summary",
      categories: {
        added: ["New feature"],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };

    const merged = mergePublicSections(existing, [newSection]);
    expect(merged).toHaveLength(2);
  });

  it("replaces existing week with new section", () => {
    const existing = parsePublicChangelog(
      `# Changelog\n\n## Week 2026-07-10 — 2026-07-17\n\nOld summary.\n\n### Added\n- Old\n`,
    );

    const newSection: PublicChangelogSection = {
      weekStart: "2026-07-10",
      weekEnd: "2026-07-17",
      title: "Updated 2026-07-10 — 2026-07-17",
      summary: "Updated summary",
      categories: {
        added: ["New"],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    };

    const merged = mergePublicSections(existing, [newSection]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("Updated 2026-07-10 — 2026-07-17");
    expect(merged[0].categories.added).toEqual(["New"]);
  });
});

// ---------------------------------------------------------------------------
// AI generation parse tests
// ---------------------------------------------------------------------------

describe("parsePublicGenerationResponse", () => {
  const week: WeekGroup = {
    weekStart: "2026-07-10",
    weekEnd: "2026-07-17",
    commits: [],
  };

  it("parses valid response with dates in title", () => {
    const raw = JSON.stringify({
      title: "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17",
      summary: "We improved things.",
      categories: {
        added: ["Feature A"],
        improved: ["Speed B"],
        fixed: [],
        security_compliance: ["DSGVO update"],
        integrations: [],
      },
    });

    const section = parsePublicGenerationResponse(raw, week);
    expect(section).not.toBeNull();
    expect(section!.weekStart).toBe("2026-07-10");
    expect(section!.weekEnd).toBe("2026-07-17");
    expect(section!.title).toContain("Plattform-Updates");
    expect(section!.summary).toBe("We improved things.");
    expect(section!.categories.added).toEqual(["Feature A"]);
    expect(section!.categories.security_compliance).toEqual(["DSGVO update"]);
  });

  it("returns null when title has no date range", () => {
    const raw = JSON.stringify({
      title: "Weekly updates",
      summary: "Some summary",
      categories: {
        added: [],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    });

    const section = parsePublicGenerationResponse(raw, week);
    expect(section).toBeNull();
  });

  it("throws on invalid JSON", () => {
    expect(() => parsePublicGenerationResponse("not json", week)).toThrow();
  });

  it("handles en-dash separator in title", () => {
    const raw = JSON.stringify({
      title: "Updates 2026-07-10 – 2026-07-17",
      summary: "Summary",
      categories: {
        added: [],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    });

    const section = parsePublicGenerationResponse(raw, week);
    expect(section).not.toBeNull();
    expect(section!.weekStart).toBe("2026-07-10");
    expect(section!.weekEnd).toBe("2026-07-17");
  });

  it("uses config-driven week boundaries, not AI-generated dates in title", () => {
    const configWeek: WeekGroup = {
      weekStart: "2026-07-09",
      weekEnd: "2026-07-15",
      commits: [],
    };

    const raw = JSON.stringify({
      title: "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17",
      summary: "AI used wrong dates.",
      categories: {
        added: ["Feature A"],
        improved: [],
        fixed: [],
        security_compliance: [],
        integrations: [],
      },
    });

    const section = parsePublicGenerationResponse(raw, configWeek);
    expect(section).not.toBeNull();
    expect(section!.weekStart).toBe("2026-07-09");
    expect(section!.weekEnd).toBe("2026-07-15");
    expect(section!.title).toBe("Plattform-Updates für die Woche 2026-07-09 — 2026-07-15");
  });
});
