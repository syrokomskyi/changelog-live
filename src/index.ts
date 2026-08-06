/*
<MODULE_CONTRACT>
<purpose>Generates and updates changelogs from git history using AI.</purpose>
<non-goals>
  <item>Does not manually edit changelog entries.</item>
  <item>Does not handle non-git version control systems.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of changelog generation and translation.</item>
  <item>ADR-0006: pass config.filter (merged with CLI --no-merges) to collectCommits</item>
</CHANGE_SUMMARY>
*/

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
  resolveTagToDate,
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
  parseTranslatedSection,
  parseTranslatedPublicSection,
} from "./markdown.js";

import type {
  ChangelogConfig,
  ChangelogSection,
  PublicChangelogSection,
  PeriodOptions,
  GenerateOptions,
} from "./types.js";
import { createLogger, type Logger } from "./logger.js";

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
  resolveTagToDate,
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
  parseTranslatedSection,
  parseTranslatedPublicSection,
} from "./markdown.js";

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export interface GenerateChangelogResult {
  sectionsGenerated: number;
  commitMessage: string;
  filesWritten: string[];
  skipped: boolean;
  dryRunOutput?: string;
}

/**
 * Generate or update a CHANGELOG.md (and translations) from git history.
 *
 * @param configOrPath Path to a YAML config file, or a config object.
 * @param options Period options and/or generation options (dryRun, logger).
 * @returns Result with info about what was generated.
 */
export async function generateChangelog(
  configOrPath: string | ChangelogConfig,
  options?: PeriodOptions | GenerateOptions,
): Promise<GenerateChangelogResult> {
  const config: ChangelogConfig =
    typeof configOrPath === "string" ? await loadConfig(configOrPath) : configOrPath;

  const dryRun = (options as GenerateOptions)?.dryRun ?? false;
  const logger: Logger = (options as GenerateOptions)?.logger ?? createLogger("normal");

  const paths = config.git.paths ?? (config.git.subPath ? [config.git.subPath] : []);
  const primaryFilePath = getPrimaryFilePath(config);

  // Resolve period options (ADR-0004)
  const resolvedSince = options?.sinceTag
    ? (resolveTagToDate(config.git.repoRoot, options.sinceTag) ?? options.since)
    : options?.since;
  const resolvedUntil = options?.untilTag
    ? (resolveTagToDate(config.git.repoRoot, options.untilTag) ?? options.until)
    : options?.until;
  const force = options?.force ?? false;

  // Build effective commit filter: config filter merged with CLI --no-merges override (ADR-0006)
  const effectiveFilter = {
    excludeMerges:
      config.filter.excludeMerges ||
      ((options as GenerateOptions & { noMerges?: boolean })?.noMerges ?? false),
    excludeAuthors: config.filter.excludeAuthors,
    excludePatterns: config.filter.excludePatterns,
  };

  // 1. Read existing CHANGELOG to find last entry date
  let existingContent: string | null = null;
  try {
    existingContent = await fs.readFile(primaryFilePath, "utf-8");
  } catch {
    // No existing CHANGELOG — first run
  }

  let sinceDate: string | undefined;
  let existingParsed = null;

  if (resolvedSince) {
    // CLI --since takes priority over auto-detected sinceDate
    sinceDate = resolvedSince;
  } else if (existingContent) {
    existingParsed = parseChangelog(existingContent);
    const lastSection = getLastSection(existingParsed);
    if (lastSection) {
      // Collect commits since the start of the last known week
      sinceDate = lastSection.weekStart;
    }
  }

  // 2. Collect commits
  const commits = collectCommits(
    config.git.repoRoot,
    paths,
    sinceDate,
    resolvedUntil,
    effectiveFilter,
  );

  if (commits.length === 0 && !config.publicChangelog) {
    logger.info("changelog-live: no new commits since last entry, skipping.");
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
      // Skip weeks that are already in the changelog unless --force is set
      if (!force && existingWeeks.has(w.weekStart)) return false;
      return true;
    });
  } else {
    // First run: still skip in-progress weeks
    weeks = weeks.filter((w) => !isWeekInProgress(w.weekEnd));
  }

  if (weeks.length === 0 && !config.publicChangelog) {
    logger.info("changelog-live: all weeks already covered, skipping.");
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
      logger.info(
        `changelog-live: generating section for week ${week.weekStart} — ${week.weekEnd} (${week.commits.length} commits)`,
      );
      logger.verbose(`changelog-live: ${week.commits.length} commits for this week:`);
      for (const c of week.commits) {
        logger.verbose(`  ${c.hash.slice(0, 7)} ${c.date} ${c.message.split("\n")[0]}`);
      }
      const section = await generateChangelogSection({
        provider: config.ai.generation.provider,
        model: config.ai.generation.model!,
        language: config.languages.primary,
        week,
        systemPrompt: config.ai.generation.systemPrompt,
        logger,
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
    if (dryRun) {
      logger.info("changelog-live: [dry-run] primary changelog:");
      logger.verbose(primaryMarkdown);
    } else {
      await fs.writeFile(primaryFilePath, primaryMarkdown, "utf-8");
      filesWritten.push(primaryFilePath);
    }

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
          systemPrompt: config.ai.translation.systemPrompt,
          logger,
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
          systemPrompt: config.ai.translation.systemPrompt,
          logger,
        });
        allTranslatedSections = translatedSections;
        translatedHeader = translatedHeaderMd;
      }

      const translationMarkdown = renderFullChangelog(
        allTranslatedSections,
        config.sortOrder,
        translatedHeader,
      );
      if (dryRun) {
        logger.info(`changelog-live: [dry-run] translation (${lang}):`);
        logger.verbose(translationMarkdown);
      } else {
        await fs.writeFile(translationPath, translationMarkdown, "utf-8");
        filesWritten.push(translationPath);
      }
    }
  } else {
    logger.info(
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
    if (resolvedSince) {
      publicSinceDate = resolvedSince;
    } else if (existingPublicContent) {
      existingPublicParsed = parsePublicChangelog(existingPublicContent);
      const lastPublicSection = getLastPublicSection(existingPublicParsed);
      if (lastPublicSection) {
        publicSinceDate = lastPublicSection.weekStart;
      }
    }

    // Collect commits for public changelog independently
    const publicCommits = collectCommits(
      config.git.repoRoot,
      paths,
      publicSinceDate,
      resolvedUntil,
      effectiveFilter,
    );
    if (publicCommits.length === 0) {
      logger.info("changelog-live: public changelog already up to date, no new commits.");
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
          if (!force && existingPublicWeeks.has(w.weekStart)) return false;
          return true;
        });
      } else {
        publicWeeks = publicWeeks.filter((w) => !isWeekInProgress(w.weekEnd));
      }

      if (publicWeeks.length === 0) {
        logger.info("changelog-live: public changelog already up to date.");
      } else {
        // Generate public sections for each new week
        const newPublicSections: PublicChangelogSection[] = [];
        for (const week of publicWeeks) {
          logger.info(
            `changelog-live: generating public section for week ${week.weekStart} — ${week.weekEnd}`,
          );
          logger.verbose(`changelog-live: ${week.commits.length} public commits for this week:`);
          for (const c of week.commits) {
            logger.verbose(`  ${c.hash.slice(0, 7)} ${c.date} ${c.message.split("\n")[0]}`);
          }
          const publicSection = await generatePublicChangelogSection({
            provider: config.ai.generation.provider,
            model: config.ai.generation.model!,
            language: config.languages.primary,
            week,
            systemPrompt: config.ai.generation.systemPrompt,
            logger,
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
        if (dryRun) {
          logger.info("changelog-live: [dry-run] public changelog:");
          logger.verbose(publicMarkdown);
        } else {
          await fs.writeFile(publicFilePath, publicMarkdown, "utf-8");
          filesWritten.push(publicFilePath);
        }

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
              systemPrompt: config.ai.translation.systemPrompt,
              logger,
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
              systemPrompt: config.ai.translation.systemPrompt,
            });
            allTranslatedPublicSections = translatedPublicSections;
            translatedPublicHeader = translatedHeaderMd;
          }

          const publicTranslationMarkdown = renderFullPublicChangelog(
            allTranslatedPublicSections,
            config.sortOrder,
            translatedPublicHeader,
          );
          if (dryRun) {
            logger.info(`changelog-live: [dry-run] public translation (${lang}):`);
            logger.verbose(publicTranslationMarkdown);
          } else {
            await fs.writeFile(publicTranslationPath, publicTranslationMarkdown, "utf-8");
            filesWritten.push(publicTranslationPath);
          }
        }
      }
    }
  }

  if (dryRun) {
    logger.info(
      `changelog-live: [dry-run] generated ${newSections.length} section(s), 0 file(s) written (dry-run mode).`,
    );
  } else {
    logger.info(
      `changelog-live: generated ${newSections.length} section(s), wrote ${filesWritten.length} file(s).`,
    );
  }

  return {
    sectionsGenerated: newSections.length,
    commitMessage: lastCommitMessage,
    filesWritten,
    skipped: false,
  };
}
