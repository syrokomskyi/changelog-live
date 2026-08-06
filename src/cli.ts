#!/usr/bin/env node

/*
<MODULE_CONTRACT>
<purpose>Generates AI-powered CHANGELOG.md from git history</purpose>
<non-goals>
  <item>Does not handle non-git version control systems</item>
  <item>Does not provide manual changelog editing features</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of changelog generation CLI</item>
  <item>ADR-0004: added --since, --until, --since-tag, --until-tag, --force CLI flags</item>
  <item>ADR-0010: added --force flag to init, .env loading from CWD</item>
  <item>ADR-0006: added --no-merges CLI flag for commit filtering</item>
  <item>ADR-0005: added --dry-run, --verbose, --quiet, --provider, --model, --output CLI flags</item>
</CHANGE_SUMMARY>
*/

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { generateChangelog } from "./index.js";
import { traceHistoricalPaths } from "./git-trace.js";
import { loadConfig, applyCliOverrides } from "./config.js";
import { createLogger, type LogLevel } from "./logger.js";

/**
 * Auto-load .env from the git repo root so API keys are available
 * without manual --env-file in every consumer's npm script.
 * Uses `git rev-parse --show-toplevel` to find the repo root.
 */
function loadRepoEnv(): void {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    const envPath = path.join(repoRoot, ".env");
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  } catch {
    // Not in a git repo or no .env — rely on existing process.env
  }

  // CWD .env takes priority over repo root .env (loaded second, overwrites values)
  const cwdEnvPath = path.join(process.cwd(), ".env");
  if (existsSync(cwdEnvPath)) {
    try {
      process.loadEnvFile(cwdEnvPath);
    } catch {
      // .env exists but failed to load — ignore
    }
  }
}

loadRepoEnv();

const NO_CONFIG_MESSAGE = `changelog-live: No changelog.config.yaml found in this directory.

To enable AI-powered CHANGELOG generation, create a changelog.config.yaml file here.
Either run \`changelog-live init\` to auto-discover git history paths,
or create the file manually.

Minimal example:
  git:
    repoRoot: "."
    paths: ["."]
  grouping:
    period: week
    startDay: thu
  languages:
    primary: en
    translations: []
  ai:
    generation:
      provider: openai
    translation:
      provider: openai

Requires OPENAI_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY) in environment.
Docs: https://github.com/wgogol/changelog-live
`;

// ---------------------------------------------------------------------------
// init subcommand
// ---------------------------------------------------------------------------

const FALLBACK_DEFAULTS = `grouping:
  period: week
  startDay: thu

languages:
  primary: en
  translations: []

ai:
  generation:
    provider: openai
  translation:
    provider: openai

output:
  dir: "."
  filename: CHANGELOG

sortOrder: desc

publicChangelog: false
`;

function findDefaultConfig(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, "changelog.config.default.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildConfigYaml(repoRoot: string, gitPaths: string[], defaultsYaml: string): string {
  const lines: string[] = [];

  lines.push("git:");
  lines.push(`  repoRoot: "${repoRoot}"`);
  lines.push("  paths:");
  for (const p of gitPaths) {
    lines.push(`    - ${p}`);
  }

  // Strip comment lines from the defaults template to avoid leaking
  // instructions like "Place this file at the repository root" into generated configs
  const defaultsBody = defaultsYaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

  lines.push("");
  lines.push(defaultsBody);

  return lines.join("\n") + "\n";
}

async function initCommand(options: { force?: boolean }): Promise<void> {
  const cwd = process.cwd();

  const configPath = path.join(cwd, "changelog.config.yaml");
  if (existsSync(configPath) && !options.force) {
    console.log("changelog-live init: changelog.config.yaml already exists in this directory.");
    console.log(
      "  Use --force to overwrite, or delete it first if you want to re-initialize git history paths.",
    );
    process.exit(0);
  }

  if (existsSync(configPath) && options.force) {
    console.log("changelog-live init: WARNING — overwriting existing changelog.config.yaml");
  }

  const defaultConfigPath = findDefaultConfig(cwd);
  if (!defaultConfigPath) {
    console.log(
      "changelog-live init: No changelog.config.default.yaml found in ancestor directories.",
    );
    console.log("  Using built-in defaults. You can create changelog.config.default.yaml");
    console.log("  at the repository root to customize default settings.");
    console.log("");
  }

  const defaultsYaml = defaultConfigPath
    ? readFileSync(defaultConfigPath, "utf-8")
    : FALLBACK_DEFAULTS;

  console.log("changelog-live init: tracing git history...");
  const trace = traceHistoricalPaths(cwd);

  console.log(`  repo root: ${trace.repoRoot}`);
  console.log(`  discovered ${trace.paths.length} path(s):`);
  for (const p of trace.paths) {
    console.log(`    - ${p}`);
  }

  const yaml = buildConfigYaml(trace.repoRoot, trace.paths, defaultsYaml);
  writeFileSync(configPath, yaml, "utf-8");
  console.log("\nchangelog-live init: wrote changelog.config.yaml");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

program
  .name("changelog-live")
  .description("AI-powered CHANGELOG.md generator from git history")
  .version(pkg.version)
  .option("-c, --config <path>", "Path to changelog.config.yaml", "changelog.config.yaml")
  .option("--since <date>", "Collect commits since this date (YYYY-MM-DD)")
  .option("--until <date>", "Collect commits until this date (YYYY-MM-DD)")
  .option("--since-tag <tag>", "Resolve tag to date and use as --since")
  .option("--until-tag <tag>", "Resolve tag to date and use as --until")
  .option("--force", "Regenerate existing periods (in-progress periods still skipped)")
  .option("--no-merges", "Exclude merge commits (shorthand for filter.excludeMerges)")
  .option("--dry-run", "Run pipeline without writing files (output to stdout)")
  .option("--verbose", "Show detailed output (commits, AI prompts, timing)")
  .option("--quiet", "Suppress all output except errors")
  .option("--provider <name>", "Override AI provider (openai, anthropic, gemini)")
  .option("--model <name>", "Override AI model for generation and translation")
  .option("--output <path>", "Override output directory or file path")
  .action(
    async (opts: {
      config: string;
      since?: string;
      until?: string;
      sinceTag?: string;
      untilTag?: string;
      force?: boolean;
      noMerges?: boolean;
      dryRun?: boolean;
      verbose?: boolean;
      quiet?: boolean;
      provider?: string;
      model?: string;
      output?: string;
    }) => {
      const configPath = path.resolve(opts.config);

      if (!existsSync(configPath)) {
        console.log(NO_CONFIG_MESSAGE);
        process.exit(0);
      }

      // Determine log level: --quiet takes priority over --verbose
      let logLevel: LogLevel = "normal";
      if (opts.quiet) logLevel = "quiet";
      else if (opts.verbose) logLevel = "verbose";
      const logger = createLogger(logLevel);

      const period = {
        since: opts.since,
        until: opts.until,
        sinceTag: opts.sinceTag,
        untilTag: opts.untilTag,
        force: opts.force ?? false,
        noMerges: opts.noMerges ?? false,
        dryRun: opts.dryRun ?? false,
        logger,
      };
      const hasPeriodOpts =
        period.since ||
        period.until ||
        period.sinceTag ||
        period.untilTag ||
        period.force ||
        period.noMerges ||
        opts.dryRun;

      try {
        // Load config and apply CLI overrides (ADR-0005)
        let config = await loadConfig(configPath);
        const hasOverrides = opts.provider || opts.model || opts.output;
        if (hasOverrides) {
          config = applyCliOverrides(config, {
            provider: opts.provider,
            model: opts.model,
            output: opts.output,
          });
          logger.verbose(
            `changelog-live: applied CLI overrides — provider: ${opts.provider ?? "(none)"}, model: ${opts.model ?? "(none)"}, output: ${opts.output ?? "(none)"}`,
          );
        }

        const result = await generateChangelog(config, hasPeriodOpts ? period : undefined);

        if (result.skipped) {
          logger.info("changelog-live: no new commits, CHANGELOG unchanged.");
          process.exit(0);
        }

        logger.info(`changelog-live: ${result.sectionsGenerated} section(s) generated.`);
        if (!opts.quiet) {
          logger.info(`  commit message: ${result.commitMessage}`);
          if (result.filesWritten.length > 0) {
            logger.info("  files written:");
            for (const f of result.filesWritten) {
              logger.info(`    ${f}`);
            }
          }
          if (opts.dryRun) {
            logger.info("  (dry-run mode — no files written)");
          }
        }
      } catch (err) {
        logger.error(`changelog-live failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );

program
  .command("init")
  .description("Discover all git history paths and create changelog.config.yaml")
  .option("-f, --force", "Overwrite existing changelog.config.yaml")
  .action(async (opts: { force?: boolean }) => {
    try {
      await initCommand(opts);
    } catch (err) {
      console.error("changelog-live init failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
