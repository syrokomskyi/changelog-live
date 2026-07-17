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

  const categories = {
    added: [] as string[],
    changed: [] as string[],
    fixed: [] as string[],
    removed: [] as string[],
    security: [] as string[],
    documentation: [] as string[],
  };

  let currentCat: keyof typeof categories | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const catMatch = line.match(/^###\s+(.+)$/);
    if (catMatch) {
      const label = catMatch[1].toLowerCase();
      const catKey = CHANGELOG_CATEGORIES.find((c) => CATEGORY_LABELS[c].toLowerCase() === label);
      currentCat = catKey ?? null;
      continue;
    }

    const entryMatch = line.match(/^-\s+(.+)$/);
    if (entryMatch && currentCat) {
      categories[currentCat].push(entryMatch[1]);
    }
  }

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

  const categories = {
    added: [] as string[],
    improved: [] as string[],
    fixed: [] as string[],
    security_compliance: [] as string[],
    integrations: [] as string[],
  };

  let currentCat: keyof typeof categories | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const catMatch = line.match(/^###\s+(.+)$/);
    if (catMatch) {
      const label = catMatch[1].toLowerCase();
      const catKey = PUBLIC_CHANGELOG_CATEGORIES.find(
        (c) => PUBLIC_CATEGORY_LABELS[c].toLowerCase() === label,
      );
      currentCat = catKey ?? null;
      continue;
    }

    const entryMatch = line.match(/^-\s+(.+)$/);
    if (entryMatch && currentCat) {
      categories[currentCat].push(entryMatch[1]);
    }
  }

  return {
    weekStart: s.weekStart,
    weekEnd: s.weekEnd,
    title: s.title,
    summary: s.summary,
    categories,
  };
}
