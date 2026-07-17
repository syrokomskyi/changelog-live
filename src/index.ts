import fs from "node:fs/promises";
import path from "node:path";

import {
  loadConfig,
  getPrimaryFilePath,
  getTranslationFilePath,
  getPublicPrimaryFilePath,
  getPublicTranslationFilePath,
} from "./config.js";
import {
  collectCommits,
  groupCommitsByWeek,
  takeLastWeeks,
  isWeekInProgress,
} from "./git-collect.js";
import { generateChangelogSection, generatePublicChangelogSection } from "./ai-generate.js";
import { translateChangelogSection } from "./ai-translate.js";
import {
  parseChangelog,
  getLastSection,
  renderSection,
  renderHeader,
  renderFullChangelog,
  mergeSections,
  parsePublicChangelog,
  getLastPublicSection,
  renderPublicSection,
  renderPublicHeader,
  renderFullPublicChangelog,
  mergePublicSections,
} from "./markdown.js";

import type { ChangelogConfig, ChangelogSection, PublicChangelogSection } from "./types.js";

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
  parsePublicChangelog,
  renderPublicSection,
  renderPublicHeader,
  renderFullPublicChangelog,
  mergePublicSections,
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

  if (commits.length === 0 && !config.publicChangelog) {
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

  if (weeks.length === 0 && !config.publicChangelog) {
    console.log("changelog-live: all weeks already covered, skipping.");
    return {
      sectionsGenerated: 0,
      commitMessage: "no changes",
      filesWritten: [],
      skipped: true,
    };
  }

  const internalSkipped = weeks.length === 0;

  // 6. Generate AI sections for each week
  const newSections: ChangelogSection[] = [];
  let lastCommitMessage = "no changes";
  const filesWritten: string[] = [];

  if (!internalSkipped) {
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
    filesWritten.push(primaryFilePath);

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
  } else {
    console.log(
      "changelog-live: internal changelog already up to date, checking public changelog...",
    );
  }

  // 9. Generate public changelog if enabled (independent incremental flow)
  if (config.publicChangelog) {
    const publicFilePath = getPublicPrimaryFilePath(config);

    // Read existing public changelog to determine last entry
    let existingPublicContent: string | null = null;
    try {
      existingPublicContent = await fs.readFile(publicFilePath, "utf-8");
    } catch {
      // No existing public changelog — first run
    }

    // Determine sinceDate for public changelog
    let publicSinceDate: string | undefined;
    let existingPublicParsed = null;
    if (existingPublicContent) {
      existingPublicParsed = parsePublicChangelog(existingPublicContent);
      const lastPublicSection = getLastPublicSection(existingPublicParsed);
      if (lastPublicSection) {
        publicSinceDate = lastPublicSection.weekStart;
      }
    }

    // Collect commits for public changelog independently
    const publicCommits = collectCommits(config.git.repoRoot, paths, publicSinceDate);
    if (publicCommits.length === 0) {
      console.log("changelog-live: public changelog already up to date, no new commits.");
    } else {
      // Group by week
      let publicWeeks = groupCommitsByWeek(publicCommits, config.grouping.startDay);

      // First run: apply maxHistoryWeeks if set
      if (!existingPublicContent && config.maxHistoryWeeks) {
        publicWeeks = takeLastWeeks(publicWeeks, config.maxHistoryWeeks);
      }

      // Filter out in-progress and already-covered weeks
      if (existingPublicParsed) {
        const existingPublicWeeks = new Set(existingPublicParsed.sections.map((s) => s.weekStart));
        publicWeeks = publicWeeks.filter((w) => {
          if (isWeekInProgress(w.weekEnd)) return false;
          if (existingPublicWeeks.has(w.weekStart)) return false;
          return true;
        });
      } else {
        publicWeeks = publicWeeks.filter((w) => !isWeekInProgress(w.weekEnd));
      }

      if (publicWeeks.length === 0) {
        console.log("changelog-live: public changelog already up to date.");
      } else {
        // Generate public sections for each new week
        const newPublicSections: PublicChangelogSection[] = [];
        for (const week of publicWeeks) {
          console.log(
            `changelog-live: generating public section for week ${week.weekStart} — ${week.weekEnd}`,
          );
          const publicSection = await generatePublicChangelogSection({
            provider: config.ai.generation.provider,
            model: config.ai.generation.model!,
            language: config.languages.primary,
            week,
          });
          newPublicSections.push(publicSection);
        }

        let allPublicSections: PublicChangelogSection[];
        let publicHeader: string;

        if (existingPublicParsed) {
          allPublicSections = mergePublicSections(existingPublicParsed, newPublicSections);
          publicHeader = existingPublicParsed.header;
        } else {
          allPublicSections = newPublicSections;
          const projectName =
            typeof configOrPath === "string"
              ? path.basename(path.dirname(path.resolve(configOrPath)))
              : path.basename(config.output.dir);
          publicHeader = renderPublicHeader(projectName);
        }

        const publicMarkdown = renderFullPublicChangelog(
          allPublicSections,
          config.sortOrder,
          publicHeader,
        );
        await fs.writeFile(publicFilePath, publicMarkdown, "utf-8");
        filesWritten.push(publicFilePath);

        // Translate public sections and write translation files
        for (const lang of config.languages.translations) {
          const publicTranslationPath = getPublicTranslationFilePath(config, lang);

          let existingPublicTranslation: string | null = null;
          try {
            existingPublicTranslation = await fs.readFile(publicTranslationPath, "utf-8");
          } catch {
            // No existing translation — will create
          }

          const translatedPublicSections: PublicChangelogSection[] = [];
          for (const section of newPublicSections) {
            const sectionMd = renderPublicSection(section);
            const translatedMd = await translateChangelogSection({
              provider: config.ai.translation.provider,
              model: config.ai.translation.model!,
              sourceLanguage: config.languages.primary,
              targetLanguage: lang,
              markdown: sectionMd,
            });

            const translated = parseTranslatedPublicSection(translatedMd, section);
            translatedPublicSections.push(translated);
          }

          let allTranslatedPublicSections: PublicChangelogSection[];
          let translatedPublicHeader: string;

          if (existingPublicTranslation) {
            const translatedParsed = parsePublicChangelog(existingPublicTranslation);
            allTranslatedPublicSections = mergePublicSections(
              translatedParsed,
              translatedPublicSections,
            );
            translatedPublicHeader = translatedParsed.header;
          } else {
            const translatedHeaderMd = await translateChangelogSection({
              provider: config.ai.translation.provider,
              model: config.ai.translation.model!,
              sourceLanguage: config.languages.primary,
              targetLanguage: lang,
              markdown: publicHeader,
            });
            allTranslatedPublicSections = translatedPublicSections;
            translatedPublicHeader = translatedHeaderMd;
          }

          const publicTranslationMarkdown = renderFullPublicChangelog(
            allTranslatedPublicSections,
            config.sortOrder,
            translatedPublicHeader,
          );
          await fs.writeFile(publicTranslationPath, publicTranslationMarkdown, "utf-8");
          filesWritten.push(publicTranslationPath);
        }
      }
    }
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

/**
 * Parse a translated public markdown section back into a PublicChangelogSection.
 * Preserves weekStart/weekEnd/title from the original.
 */
function parseTranslatedPublicSection(
  translatedMd: string,
  original: PublicChangelogSection,
): PublicChangelogSection {
  const parsed = parsePublicChangelog(translatedMd);

  if (parsed.sections.length > 0) {
    const section = parsed.sections[0];
    const lines = section.raw.split("\n");
    const categories = {
      added: [] as string[],
      improved: [] as string[],
      fixed: [] as string[],
      security_compliance: [] as string[],
      integrations: [] as string[],
    };

    let currentCat: keyof typeof categories | null = null;
    for (const line of lines) {
      const catMatch = line.match(/^###\s+(.+)$/);
      if (catMatch) {
        const label = catMatch[1].toLowerCase();
        const catKey = (
          ["added", "improved", "fixed", "security_compliance", "integrations"] as const
        ).find((c) => {
          const labels: Record<string, string> = {
            added: "Added",
            improved: "Improved",
            fixed: "Fixed",
            security_compliance: "Security & Compliance",
            integrations: "Integrations",
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
      title: section.title || original.title,
      summary: section.summary || original.summary,
      categories,
    };
  }

  // Fallback: return original with empty categories
  return {
    weekStart: original.weekStart,
    weekEnd: original.weekEnd,
    title: original.title,
    summary: original.summary,
    categories: {
      added: [],
      improved: [],
      fixed: [],
      security_compliance: [],
      integrations: [],
    },
  };
}
