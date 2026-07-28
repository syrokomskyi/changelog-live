/*
<MODULE_CONTRACT>
<purpose>Parses and renders changelog data to and from markdown format.</purpose>
<non-goals>
  <item>Does not handle file I/O operations for reading or writing changelog files.</item>
  <item>Does not provide a user interface for changelog management.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of changelog parsing and rendering functions.</item>
</CHANGE_SUMMARY>
*/

import type {
  ChangelogSection,
  ParsedChangelog,
  ParsedSection,
  ParsedPublicChangelog,
  ParsedPublicSection,
  PublicChangelogSection,
  SortOrder,
} from "./types.js";
import {
  CHANGELOG_CATEGORIES,
  CATEGORY_LABELS,
  PUBLIC_CHANGELOG_CATEGORIES,
  PUBLIC_CATEGORY_LABELS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared category parser
// ---------------------------------------------------------------------------

/**
 * Parse markdown lines into category buckets.
 *
 * Scans for `### Label` headers and `- entry` lines, mapping labels to
 * category keys via the provided label map. Returns a record of empty
 * arrays for all categories, filled with entries found in the text.
 */
function parseCategoriesFromMarkdown<C extends string>(
  text: string,
  categories: readonly C[],
  labels: Record<C, string>,
): Record<C, string[]> {
  const result = Object.fromEntries(categories.map((c) => [c, [] as string[]])) as Record<
    C,
    string[]
  >;

  let currentCat: C | null = null;
  for (const line of text.split("\n")) {
    const catMatch = line.match(/^###\s+(.+)$/);
    if (catMatch) {
      const label = catMatch[1].toLowerCase();
      const catKey = categories.find((c) => labels[c].toLowerCase() === label);
      currentCat = catKey ?? null;
      continue;
    }
    const entryMatch = line.match(/^-\s+(.+)$/);
    if (entryMatch && currentCat) {
      result[currentCat].push(entryMatch[1]);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Render: ChangelogSection → markdown
// ---------------------------------------------------------------------------

/**
 * Render a single changelog section as markdown.
 */
export function renderSection(section: ChangelogSection): string {
  const lines: string[] = [];
  lines.push(`## ${section.weekStart} .. ${section.weekEnd}`);
  lines.push("");

  for (const cat of CHANGELOG_CATEGORIES) {
    const entries = section.categories[cat];
    if (!entries || entries.length === 0) continue;

    lines.push(`### ${CATEGORY_LABELS[cat]}`);
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render the CHANGELOG header.
 */
export function renderHeader(projectName?: string): string {
  const name = projectName ?? "this";
  return `# Changelog\n\nAll notable changes to the \`${name}\` project are documented here.\n`;
}

/**
 * Render the full CHANGELOG.md from sections.
 * sortOrder "desc" = newest first (top), "asc" = oldest first.
 */
export function renderFullChangelog(
  sections: ChangelogSection[],
  sortOrder: SortOrder = "desc",
  existingHeader?: string,
): string {
  const header = existingHeader ?? renderHeader();
  const sorted = [...sections].sort((a, b) =>
    sortOrder === "desc"
      ? b.weekStart.localeCompare(a.weekStart)
      : a.weekStart.localeCompare(b.weekStart),
  );

  const body = sorted.map(renderSection).join("\n");
  return `${header}\n${body}`;
}

// ---------------------------------------------------------------------------
// Parse: existing CHANGELOG.md → sections
// ---------------------------------------------------------------------------

const SECTION_HEADER_REGEX = /^##\s+(\d{4}-\d{2}-\d{2})\s+(?:\.\.|[—–-])\s+(\d{4}-\d{2}-\d{2})/;

/**
 * Parse an existing CHANGELOG.md into header + sections.
 */
export function parseChangelog(content: string): ParsedChangelog {
  const lines = content.split("\n");
  const sections: ParsedSection[] = [];
  const headerLines: string[] = [];
  let currentSection: ParsedSection | null = null;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(SECTION_HEADER_REGEX);

    if (match) {
      if (currentSection) {
        currentSection.raw = currentLines.join("\n");
        sections.push(currentSection);
      }
      currentSection = {
        weekStart: match[1],
        weekEnd: match[2],
        raw: "",
      };
      currentLines = [line];
    } else if (currentSection) {
      currentLines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  if (currentSection) {
    currentSection.raw = currentLines.join("\n");
    sections.push(currentSection);
  }

  const header = headerLines.join("\n").trimEnd();
  return { header, sections };
}

/**
 * Find the last (most recent) section in a parsed changelog.
 * "Last" = the section with the latest weekStart, regardless of file order.
 */
export function getLastSection(parsed: ParsedChangelog): ParsedSection | null {
  if (parsed.sections.length === 0) return null;
  return parsed.sections.reduce((latest, s) => (s.weekStart > latest.weekStart ? s : latest));
}

// ---------------------------------------------------------------------------
// Merge: combine existing + new sections
// ---------------------------------------------------------------------------

/**
 * Merge new sections into an existing parsed changelog.
 * If a new section's week already exists in the parsed changelog, it replaces it.
 * Otherwise, it's added.
 */
export function mergeSections(
  existing: ParsedChangelog,
  newSections: ChangelogSection[],
): ChangelogSection[] {
  const existingWeeks = new Set(existing.sections.map((s) => s.weekStart));
  const allSections: ChangelogSection[] = [];

  // Convert existing sections to ChangelogSection format (raw preserved)
  for (const s of existing.sections) {
    const parsed = parseSectionRaw(s.raw);
    if (parsed) {
      allSections.push(parsed);
    }
  }

  // Add or replace with new sections
  for (const newSection of newSections) {
    if (existingWeeks.has(newSection.weekStart)) {
      const idx = allSections.findIndex((s) => s.weekStart === newSection.weekStart);
      if (idx >= 0) {
        allSections[idx] = newSection;
      } else {
        allSections.push(newSection);
      }
    } else {
      allSections.push(newSection);
    }
  }

  return allSections;
}

/**
 * Parse a raw section markdown back into a ChangelogSection.
 * This is used for existing sections that we want to preserve.
 */
function parseSectionRaw(raw: string): ChangelogSection | null {
  const lines = raw.split("\n");
  const headerMatch = lines[0]?.match(SECTION_HEADER_REGEX);
  if (!headerMatch) return null;

  const weekStart = headerMatch[1];
  const weekEnd = headerMatch[2];

  const categories = parseCategoriesFromMarkdown(raw, CHANGELOG_CATEGORIES, CATEGORY_LABELS);

  return {
    weekStart,
    weekEnd,
    categories,
    commitMessage: "",
  };
}

// ---------------------------------------------------------------------------
// Public changelog: render, parse, merge
// ---------------------------------------------------------------------------

const PUBLIC_SECTION_HEADER_REGEX = /^##\s+.+?(\d{4}-\d{2}-\d{2})\s+[—–-]\s+(\d{4}-\d{2}-\d{2})/;

/**
 * Render a single public changelog section as markdown.
 */
export function renderPublicSection(section: PublicChangelogSection): string {
  const lines: string[] = [];
  lines.push(`## ${section.title}`);
  lines.push("");
  if (section.summary) {
    lines.push(section.summary);
    lines.push("");
  }

  for (const cat of PUBLIC_CHANGELOG_CATEGORIES) {
    const entries = section.categories[cat];
    if (!entries || entries.length === 0) continue;

    lines.push(`### ${PUBLIC_CATEGORY_LABELS[cat]}`);
    for (const entry of entries) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render the public CHANGELOG header.
 */
export function renderPublicHeader(projectName?: string): string {
  const name = projectName ?? "this";
  return `# Changelog\n\nAll notable client-facing changes to the \`${name}\` project are documented here.\n`;
}

/**
 * Render the full public CHANGELOG_PUBLIC.md from sections.
 */
export function renderFullPublicChangelog(
  sections: PublicChangelogSection[],
  sortOrder: SortOrder = "desc",
  existingHeader?: string,
): string {
  const header = existingHeader ?? renderPublicHeader();
  const sorted = [...sections].sort((a, b) =>
    sortOrder === "desc"
      ? b.weekStart.localeCompare(a.weekStart)
      : a.weekStart.localeCompare(b.weekStart),
  );

  const body = sorted.map(renderPublicSection).join("\n");
  return `${header}\n${body}`;
}

/**
 * Parse an existing CHANGELOG_PUBLIC.md into header + sections.
 */
export function parsePublicChangelog(content: string): ParsedPublicChangelog {
  const lines = content.split("\n");
  const sections: ParsedPublicSection[] = [];
  const headerLines: string[] = [];
  let currentSection: ParsedPublicSection | null = null;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(PUBLIC_SECTION_HEADER_REGEX);

    if (match) {
      if (currentSection) {
        const parsed = parsePublicSectionRaw(currentLines.join("\n"));
        if (parsed) sections.push(parsed);
      }
      currentSection = {
        weekStart: match[1],
        weekEnd: match[2],
        title: line.replace(/^##\s+/, "").trim(),
        summary: "",
        raw: "",
      };
      currentLines = [line];
    } else if (currentSection) {
      currentLines.push(line);
    } else {
      headerLines.push(line);
    }
  }

  if (currentSection) {
    const parsed = parsePublicSectionRaw(currentLines.join("\n"));
    if (parsed) sections.push(parsed);
  }

  const header = headerLines.join("\n").trimEnd();
  return { header, sections };
}

/**
 * Find the last (most recent) section in a parsed public changelog.
 */
export function getLastPublicSection(parsed: ParsedPublicChangelog): ParsedPublicSection | null {
  if (parsed.sections.length === 0) return null;
  return parsed.sections.reduce((latest, s) => (s.weekStart > latest.weekStart ? s : latest));
}

/**
 * Merge new public sections into an existing parsed public changelog.
 * If a new section's week already exists, it replaces it.
 */
export function mergePublicSections(
  existing: ParsedPublicChangelog,
  newSections: PublicChangelogSection[],
): PublicChangelogSection[] {
  const existingWeeks = new Set(existing.sections.map((s) => s.weekStart));
  const allSections: PublicChangelogSection[] = [];

  for (const s of existing.sections) {
    const parsed = parsePublicSectionRawFull(s);
    if (parsed) allSections.push(parsed);
  }

  for (const newSection of newSections) {
    if (existingWeeks.has(newSection.weekStart)) {
      const idx = allSections.findIndex((s) => s.weekStart === newSection.weekStart);
      if (idx >= 0) {
        allSections[idx] = newSection;
      } else {
        allSections.push(newSection);
      }
    } else {
      allSections.push(newSection);
    }
  }

  return allSections;
}

/**
 * Parse a raw public section markdown back into a ParsedPublicSection.
 */
function parsePublicSectionRaw(raw: string): ParsedPublicSection | null {
  const lines = raw.split("\n");
  const headerMatch = lines[0]?.match(PUBLIC_SECTION_HEADER_REGEX);
  if (!headerMatch) return null;

  const weekStart = headerMatch[1];
  const weekEnd = headerMatch[2];
  const title = lines[0].replace(/^##\s+/, "").trim();

  // Extract summary: text between header and first ### category
  let summary = "";
  let startedSummary = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("### ")) break;
    if (line.trim() === "") {
      if (startedSummary) continue;
      continue;
    }
    startedSummary = true;
    summary = summary ? summary + " " + line.trim() : line.trim();
  }

  return {
    weekStart,
    weekEnd,
    title,
    summary,
    raw,
  };
}

/**
 * Parse a ParsedPublicSection into a full PublicChangelogSection with categories.
 */
function parsePublicSectionRawFull(s: ParsedPublicSection): PublicChangelogSection | null {
  const lines = s.raw.split("\n");
  const headerMatch = lines[0]?.match(PUBLIC_SECTION_HEADER_REGEX);
  if (!headerMatch) return null;

  const categories = parseCategoriesFromMarkdown(
    s.raw,
    PUBLIC_CHANGELOG_CATEGORIES,
    PUBLIC_CATEGORY_LABELS,
  );

  return {
    weekStart: s.weekStart,
    weekEnd: s.weekEnd,
    title: s.title,
    summary: s.summary,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Translated section parsing
// ---------------------------------------------------------------------------

/**
 * Parse a translated markdown section back into a ChangelogSection.
 * Preserves the weekStart/weekEnd/commitMessage from the original.
 */
export function parseTranslatedSection(
  translatedMd: string,
  original: ChangelogSection,
): ChangelogSection {
  const parsed = parseChangelog(translatedMd);

  if (parsed.sections.length > 0) {
    const section = parsed.sections[0];
    const categories = parseCategoriesFromMarkdown(
      section.raw,
      CHANGELOG_CATEGORIES,
      CATEGORY_LABELS,
    );

    return {
      weekStart: original.weekStart,
      weekEnd: original.weekEnd,
      categories,
      commitMessage: original.commitMessage,
    };
  }

  return {
    weekStart: original.weekStart,
    weekEnd: original.weekEnd,
    categories: parseCategoriesFromMarkdown("", CHANGELOG_CATEGORIES, CATEGORY_LABELS),
    commitMessage: original.commitMessage,
  };
}

/**
 * Parse a translated public markdown section back into a PublicChangelogSection.
 * Preserves weekStart/weekEnd/title from the original.
 */
export function parseTranslatedPublicSection(
  translatedMd: string,
  original: PublicChangelogSection,
): PublicChangelogSection {
  const parsed = parsePublicChangelog(translatedMd);

  if (parsed.sections.length > 0) {
    const section = parsed.sections[0];
    const categories = parseCategoriesFromMarkdown(
      section.raw,
      PUBLIC_CHANGELOG_CATEGORIES,
      PUBLIC_CATEGORY_LABELS,
    );

    return {
      weekStart: original.weekStart,
      weekEnd: original.weekEnd,
      title: section.title || original.title,
      summary: section.summary || original.summary,
      categories,
    };
  }

  return {
    weekStart: original.weekStart,
    weekEnd: original.weekEnd,
    title: original.title,
    summary: original.summary,
    categories: parseCategoriesFromMarkdown(
      "",
      PUBLIC_CHANGELOG_CATEGORIES,
      PUBLIC_CATEGORY_LABELS,
    ),
  };
}
