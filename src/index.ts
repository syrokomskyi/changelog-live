import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig, getPrimaryFilePath, getTranslationFilePath } from "./config.js";
import {
  collectCommits,
  groupCommitsByWeek,
  takeLastWeeks,
  isWeekInProgress,
} from "./git-collect.js";
import { generateChangelogSection } from "./ai-generate.js";
import { translateChangelogSection } from "./ai-translate.js";
import {
  parseChangelog,
  getLastSection,
  renderSection,
  renderHeader,
  renderFullChangelog,
  mergeSections,
} from "./markdown.js";

import type { ChangelogConfig, ChangelogSection } from "./types.js";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export * from "./types.js";
export {
  loadConfig,
  validateConfig,
  getApiKey,
  getPrimaryFilePath,
  getTranslationFilePath,
} from "./config.js";
export {
  collectCommits,
  getFirstCommitDate,
  getLastCommitDate,
  groupCommitsByWeek,
  takeLastWeeks,
  getWeekStart,
  getWeekEnd,
  formatDate,
  parseDate,
  getCurrentWeekStart,
  isWeekInProgress,
} from "./git-collect.js";
export { generateChangelogSection } from "./ai-generate.js";
export { translateChangelogSection } from "./ai-translate.js";
export {
  parseChangelog,
  getLastSection,
  renderSection,
  renderHeader,
  renderFullChangelog,
  mergeSections,
} from "./markdown.js";

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export interface GenerateChangelogResult {
  sectionsGenerated: number;
  commitMessage: string;
  filesWritten: string[];
  skipped: boolean;
}

/**
 * Generate or update a CHANGELOG.md (and translations) from git history.
 *
 * @param configPath Path to a YAML config file, or a config object.
 * @returns Result with info about what was generated.
 */
export async function generateChangelog(
  configOrPath: string | ChangelogConfig,
): Promise<GenerateChangelogResult> {
  const config: ChangelogConfig =
    typeof configOrPath === "string" ? await loadConfig(configOrPath) : configOrPath;

  const paths = config.git.paths ?? (config.git.subPath ? [config.git.subPath] : []);
  const primaryFilePath = getPrimaryFilePath(config);

  // 1. Read existing CHANGELOG to find last entry date
  let existingContent: string | null = null;
  try {
    existingContent = await fs.readFile(primaryFilePath, "utf-8");
  } catch {
    // No existing CHANGELOG — first run
  }

  let sinceDate: string | undefined;
  let existingParsed = null;

  if (existingContent) {
    existingParsed = parseChangelog(existingContent);
    const lastSection = getLastSection(existingParsed);
    if (lastSection) {
      // Collect commits since the start of the last known week
      sinceDate = lastSection.weekStart;
    }
  }

  // 2. Collect commits
  let commits = collectCommits(config.git.repoRoot, paths, sinceDate);

  if (commits.length === 0) {
    console.log("changelog-live: no new commits since last entry, skipping.");
    return {
      sectionsGenerated: 0,
      commitMessage: "no changes",
      filesWritten: [],
      skipped: true,
    };
  }

  // 3. Group by week
  let weeks = groupCommitsByWeek(commits, config.grouping.startDay);

  // 4. First run: apply maxHistoryWeeks if set
  if (!existingContent && config.maxHistoryWeeks) {
    weeks = takeLastWeeks(weeks, config.maxHistoryWeeks);
  }

  // 5. Filter out weeks that are already in the changelog or still in progress.
  //    Only fully completed weeks not yet in the changelog are generated.
  if (existingParsed) {
    const existingWeeks = new Set(existingParsed.sections.map((s) => s.weekStart));

    weeks = weeks.filter((w) => {
      // Skip weeks that are still in progress (not yet fully completed)
      if (isWeekInProgress(w.weekEnd)) return false;
      // Skip weeks that are already in the changelog
      if (existingWeeks.has(w.weekStart)) return false;
      return true;
    });
  } else {
    // First run: still skip in-progress weeks
    weeks = weeks.filter((w) => !isWeekInProgress(w.weekEnd));
  }

  if (weeks.length === 0) {
    console.log("changelog-live: all weeks already covered, skipping.");
    return {
      sectionsGenerated: 0,
      commitMessage: "no changes",
      filesWritten: [],
      skipped: true,
    };
  }

  // 6. Generate AI sections for each week
  const newSections: ChangelogSection[] = [];
  let lastCommitMessage = "no changes";

  for (const week of weeks) {
    console.log(
      `changelog-live: generating section for week ${week.weekStart} — ${week.weekEnd} (${week.commits.length} commits)`,
    );
    const section = await generateChangelogSection({
      provider: config.ai.generation.provider,
      model: config.ai.generation.model!,
      language: config.languages.primary,
      week,
    });
    newSections.push(section);
    lastCommitMessage = section.commitMessage;
  }

  // 7. Merge with existing sections and write primary CHANGELOG
  let allSections: ChangelogSection[];
  let header: string;

  if (existingParsed) {
    allSections = mergeSections(existingParsed, newSections);
    header = existingParsed.header;
  } else {
    allSections = newSections;
    const projectName =
      typeof configOrPath === "string"
        ? path.basename(path.dirname(path.resolve(configOrPath)))
        : path.basename(config.output.dir);
    header = renderHeader(projectName);
  }

  const primaryMarkdown = renderFullChangelog(allSections, config.sortOrder, header);
  await fs.writeFile(primaryFilePath, primaryMarkdown, "utf-8");
  const filesWritten = [primaryFilePath];

  // 8. Translate new sections and update translation files
  for (const lang of config.languages.translations) {
    const translationPath = getTranslationFilePath(config, lang);

    let translationContent: string | null = null;
    try {
      translationContent = await fs.readFile(translationPath, "utf-8");
    } catch {
      // No existing translation — will create
    }

    // Translate only the new sections
    const translatedSections: ChangelogSection[] = [];
    for (const section of newSections) {
      const sectionMd = renderSection(section);
      const translatedMd = await translateChangelogSection({
        provider: config.ai.translation.provider,
        model: config.ai.translation.model!,
        sourceLanguage: config.languages.primary,
        targetLanguage: lang,
        markdown: sectionMd,
      });

      // Parse the translated markdown back into a section
      const translated = parseTranslatedSection(translatedMd, section);
      translatedSections.push(translated);
    }

    // Merge with existing translation
    let allTranslatedSections: ChangelogSection[];
    let translatedHeader: string;

    if (translationContent) {
      const translatedParsed = parseChangelog(translationContent);
      allTranslatedSections = mergeSections(translatedParsed, translatedSections);
      translatedHeader = translatedParsed.header;
    } else {
      // Translate the header too
      const translatedHeaderMd = await translateChangelogSection({
        provider: config.ai.translation.provider,
        model: config.ai.translation.model!,
        sourceLanguage: config.languages.primary,
        targetLanguage: lang,
        markdown: header,
      });
      allTranslatedSections = translatedSections;
      translatedHeader = translatedHeaderMd;
    }

    const translationMarkdown = renderFullChangelog(
      allTranslatedSections,
      config.sortOrder,
      translatedHeader,
    );
    await fs.writeFile(translationPath, translationMarkdown, "utf-8");
    filesWritten.push(translationPath);
  }

  console.log(
    `changelog-live: generated ${newSections.length} section(s), wrote ${filesWritten.length} file(s).`,
  );

  return {
    sectionsGenerated: newSections.length,
    commitMessage: lastCommitMessage,
    filesWritten,
    skipped: false,
  };
}

/**
 * Parse a translated markdown section back into a ChangelogSection.
 * Preserves the weekStart/weekEnd/commitMessage from the original.
 */
function parseTranslatedSection(
  translatedMd: string,
  original: ChangelogSection,
): ChangelogSection {
  const parsed = parseChangelog(translatedMd);

  if (parsed.sections.length > 0) {
    const section = parsed.sections[0];
    // Re-parse the raw section to get categories
    const lines = section.raw.split("\n");
    const categories = {
      added: [] as string[],
      changed: [] as string[],
      fixed: [] as string[],
      removed: [] as string[],
      security: [] as string[],
      documentation: [] as string[],
    };

    let currentCat: keyof typeof categories | null = null;
    for (const line of lines) {
      const catMatch = line.match(/^###\s+(.+)$/);
      if (catMatch) {
        const label = catMatch[1].toLowerCase();
        const catKey = (
          ["added", "changed", "fixed", "removed", "security", "documentation"] as const
        ).find((c) => {
          const labels: Record<string, string> = {
            added: "Added",
            changed: "Changed",
            fixed: "Fixed",
            removed: "Removed",
            security: "Security",
            documentation: "Documentation",
          };
          return labels[c].toLowerCase() === label;
        });
        currentCat = catKey ?? null;
        continue;
      }
      const entryMatch = line.match(/^-\s+(.+)$/);
      if (entryMatch && currentCat) {
        categories[currentCat].push(entryMatch[1]);
      }
    }

    return {
      weekStart: original.weekStart,
      weekEnd: original.weekEnd,
      categories,
      commitMessage: original.commitMessage,
    };
  }

  // Fallback: return original with empty categories
  return {
    weekStart: original.weekStart,
    weekEnd: original.weekEnd,
    categories: {
      added: [],
      changed: [],
      fixed: [],
      removed: [],
      security: [],
      documentation: [],
    },
    commitMessage: original.commitMessage,
  };
}
