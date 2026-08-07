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
  groupCommits,
  takeLastPeriods,
  isPeriodInProgress,
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
  applyCliOverrides,
  type CliOverrides,
} from "./config.js";
export { createLogger, silentLogger, type Logger, type LogLevel } from "./logger.js";
export {
  collectCommits,
  getFirstCommitDate,
  getLastCommitDate,
  groupCommits,
  takeLastPeriods,
  getWeekStart,
  getWeekEnd,
  getPeriodStart,
  getPeriodEnd,
  formatDate,
  parseDate,
  getCurrentPeriodStart,
  isPeriodInProgress,
  resolveTagToDate,
  isChangelogOnlyCommit,
} from "./git-collect.js";
export {
  generateChangelogSection,
  chunkCommits,
  mergeChangelogSections,
  mergePublicChangelogSections,
} from "./ai-generate.js";
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
  const period = options;

  const paths = config.git.paths ?? (config.git.subPath ? [config.git.subPath] : []);
  const primaryFilePath = getPrimaryFilePath(config);

  // Resolve period options (ADR-0004)
  const resolvedSince = period?.sinceTag
    ? (resolveTagToDate(config.git.repoRoot, period.sinceTag) ?? period.since)
    : period?.since;
  const resolvedUntil = period?.untilTag
    ? (resolveTagToDate(config.git.repoRoot, period.untilTag) ?? period.until)
    : period?.until;
  const force = period?.force ?? false;
  const includeInProgress = period?.includeInProgress ?? false;

  // Build effective commit filter: config filter merged with CLI --no-merges override (ADR-0006)
  const effectiveFilter = {
    excludeMerges:
      config.filter.excludeMerges ||
      ((options as GenerateOptions & { noMerges?: boolean })?.noMerges ?? false),
    excludeAuthors: config.filter.excludeAuthors,
    excludePatterns: config.filter.excludePatterns,
    excludeChangelogOnlyCommits: config.filter.excludeChangelogOnlyCommits,
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
      // Collect commits since the start of the last known period
      sinceDate = lastSection.periodStart;
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

  // 3. Group by period
  let groups = groupCommits(commits, config.grouping.period, config.grouping.startDay);

  // 4. First run: apply maxHistoryPeriods if set
  if (!existingContent && config.maxHistoryPeriods) {
    groups = takeLastPeriods(groups, config.maxHistoryPeriods);
  }

  // 5. Filter out periods that are already in the changelog or still in progress.
  //    Only fully completed periods not yet in the changelog are generated.
  if (existingParsed) {
    const existingPeriods = new Set(existingParsed.sections.map((s) => s.periodStart));

    groups = groups.filter((g) => {
      // Skip periods that are still in progress (not yet fully completed)
      if (!includeInProgress && isPeriodInProgress(g.periodEnd)) return false;
      // Skip periods that are already in the changelog unless --force is set
      if (!force && existingPeriods.has(g.periodStart)) return false;
      return true;
    });
  } else {
    // First run: still skip in-progress periods unless includeInProgress is set
    groups = groups.filter((g) => includeInProgress || !isPeriodInProgress(g.periodEnd));
  }

  if (groups.length === 0 && !config.publicChangelog) {
    logger.info("changelog-live: all periods already covered, skipping.");
    return {
      sectionsGenerated: 0,
      commitMessage: "no changes",
      filesWritten: [],
      skipped: true,
    };
  }

  const internalSkipped = groups.length === 0;

  // 6. Generate AI sections for each period
  const newSections: ChangelogSection[] = [];
  let lastCommitMessage = "no changes";
  const filesWritten: string[] = [];

  if (!internalSkipped) {
    for (const group of groups) {
      logger.info(
        `changelog-live: generating section for period ${group.periodStart} — ${group.periodEnd} (${group.commits.length} commits)`,
      );
      logger.verbose(`changelog-live: ${group.commits.length} commits for this period:`);
      for (const c of group.commits) {
        logger.verbose(`  ${c.hash.slice(0, 7)} ${c.date} ${c.message.split("\n")[0]}`);
      }
      const section = await generateChangelogSection({
        provider: config.ai.generation.provider,
        model: config.ai.generation.model!,
        language: config.languages.primary,
        group,
        systemPrompt: config.ai.generation.systemPrompt,
        logger,
        chunkSize: config.commitChunkSize,
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
        publicSinceDate = lastPublicSection.periodStart;
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
      // Group by period
      let publicGroups = groupCommits(
        publicCommits,
        config.grouping.period,
        config.grouping.startDay,
      );

      // First run: apply maxHistoryPeriods if set
      if (!existingPublicContent && config.maxHistoryPeriods) {
        publicGroups = takeLastPeriods(publicGroups, config.maxHistoryPeriods);
      }

      // Filter out in-progress and already-covered periods
      if (existingPublicParsed) {
        const existingPublicPeriods = new Set(
          existingPublicParsed.sections.map((s) => s.periodStart),
        );
        publicGroups = publicGroups.filter((g) => {
          if (!includeInProgress && isPeriodInProgress(g.periodEnd)) return false;
          if (!force && existingPublicPeriods.has(g.periodStart)) return false;
          return true;
        });
      } else {
        publicGroups = publicGroups.filter(
          (g) => includeInProgress || !isPeriodInProgress(g.periodEnd),
        );
      }

      if (publicGroups.length === 0) {
        logger.info("changelog-live: public changelog already up to date.");
      } else {
        // Generate public sections for each new period
        const newPublicSections: PublicChangelogSection[] = [];
        for (const group of publicGroups) {
          logger.info(
            `changelog-live: generating public section for period ${group.periodStart} — ${group.periodEnd}`,
          );
          logger.verbose(`changelog-live: ${group.commits.length} public commits for this period:`);
          for (const c of group.commits) {
            logger.verbose(`  ${c.hash.slice(0, 7)} ${c.date} ${c.message.split("\n")[0]}`);
          }
          const publicSection = await generatePublicChangelogSection({
            provider: config.ai.generation.provider,
            model: config.ai.generation.model!,
            language: config.languages.primary,
            group,
            systemPrompt: config.ai.generation.systemPrompt,
            logger,
            chunkSize: config.commitChunkSize,
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
