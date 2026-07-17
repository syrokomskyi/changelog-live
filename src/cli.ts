#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { generateChangelog } from "./index.js";
import { traceHistoricalPaths } from "./git-trace.js";

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

async function initCommand(): Promise<void> {
  const cwd = process.cwd();

  const configPath = path.join(cwd, "changelog.config.yaml");
  if (existsSync(configPath)) {
    console.log("changelog-live init: changelog.config.yaml already exists in this directory.");
    console.log("  Delete it first if you want to re-initialize git history paths.");
    process.exit(0);
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
  .action(async (opts: { config: string }) => {
    const configPath = path.resolve(opts.config);

    if (!existsSync(configPath)) {
      console.log(NO_CONFIG_MESSAGE);
      process.exit(0);
    }

    try {
      const result = await generateChangelog(configPath);

      if (result.skipped) {
        console.log("changelog-live: no new commits, CHANGELOG unchanged.");
        process.exit(0);
      }

      console.log(`changelog-live: ${result.sectionsGenerated} section(s) generated.`);
      console.log(`  commit message: ${result.commitMessage}`);
      console.log("  files written:");
      for (const f of result.filesWritten) {
        console.log(`    ${f}`);
      }
    } catch (err) {
      console.error("changelog-live failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Discover all git history paths and create changelog.config.yaml")
  .action(async () => {
    try {
      await initCommand();
    } catch (err) {
      console.error("changelog-live init failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
