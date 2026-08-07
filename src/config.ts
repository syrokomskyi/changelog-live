/*
<MODULE_CONTRACT>
<purpose>Load, validate, and manage changelog configurations from YAML files</purpose>
<non-goals>
  <item>Does not handle file writing operations</item>
  <item>Does not perform actual API calls or network requests</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of configuration management functions</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import {
  CHANGELOG_CONFIG_SCHEMA,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_ENV_KEYS,
  PROVIDER_SCHEMA,
  type ChangelogConfig,
  type Provider,
} from "./types.js";

/**
 * Load and validate a changelog config from a YAML file.
 *
 * Relative paths in `git.repoRoot` and `output.dir` are resolved relative to
 * the directory containing the config file, not the current working directory.
 * This allows running `changelog-live --config apps/hdri/changelog.config.yaml`
 * from the repo root without `cd`-ing into the config directory.
 */
export async function loadConfig(configPath: string): Promise<ChangelogConfig> {
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = YAML.parse(raw);
  const config = validateConfig(parsed);

  const configDir = path.dirname(path.resolve(configPath));

  if (!path.isAbsolute(config.git.repoRoot)) {
    config.git.repoRoot = path.resolve(configDir, config.git.repoRoot);
  }

  if (!path.isAbsolute(config.output.dir)) {
    config.output.dir = path.resolve(configDir, config.output.dir);
  }

  return config;
}

/**
 * Validate a raw config object and apply defaults.
 */
export function validateConfig(raw: unknown): ChangelogConfig {
  const config = CHANGELOG_CONFIG_SCHEMA.parse(raw);

  // Fill in default models for providers that don't specify one
  if (!config.ai.generation.model) {
    config.ai.generation.model = PROVIDER_DEFAULT_MODELS[config.ai.generation.provider];
  }
  if (!config.ai.translation.model) {
    config.ai.translation.model = PROVIDER_DEFAULT_MODELS[config.ai.translation.provider];
  }

  // Normalize: if subPath is set, convert to paths array
  if (config.git.subPath && !config.git.paths) {
    config.git.paths = [config.git.subPath];
  }

  return config;
}

/**
 * Get the API key for a provider from process.env.
 * Throws if the key is missing.
 */
export function getApiKey(provider: Provider): string {
  const envKey = PROVIDER_ENV_KEYS[provider];
  const key = process.env[envKey];
  if (!key) {
    throw new Error(
      `Missing API key for provider "${provider}". Set ${envKey} environment variable.`,
    );
  }
  return key;
}

/**
 * Resolve the output file path for the primary language.
 */
export function getPrimaryFilePath(config: ChangelogConfig): string {
  return path.join(config.output.dir, `${config.output.filename}.md`);
}

/**
 * Resolve the output file path for a translation language.
 */
export function getTranslationFilePath(config: ChangelogConfig, lang: string): string {
  return path.join(config.output.dir, `${config.output.filename}.${lang}.md`);
}

/**
 * Get all output file paths (primary + translations).
 */
export function getAllFilePaths(config: ChangelogConfig): string[] {
  const paths = [getPrimaryFilePath(config)];
  for (const lang of config.languages.translations) {
    paths.push(getTranslationFilePath(config, lang));
  }
  return paths;
}

/**
 * Resolve the output file path for the public changelog (primary language).
 */
export function getPublicPrimaryFilePath(config: ChangelogConfig): string {
  return path.join(config.output.dir, "CHANGELOG_PUBLIC.md");
}

/**
 * Resolve the output file path for a public changelog translation.
 */
export function getPublicTranslationFilePath(config: ChangelogConfig, lang: string): string {
  return path.join(config.output.dir, `CHANGELOG_PUBLIC.${lang}.md`);
}

// ---------------------------------------------------------------------------
// CLI overrides (ADR-0005)
// ---------------------------------------------------------------------------

export interface CliOverrides {
  provider?: string;
  model?: string;
  output?: string;
}

/**
 * Apply CLI flag overrides on top of a loaded config.
 * CLI flags take priority over YAML config values.
 *
 * - `provider` — overrides both generation and translation provider. Validated against PROVIDER_SCHEMA.
 * - `model` — overrides both generation and translation model.
 * - `output` — overrides output.dir if it's a directory path, or parses dir+filename if it's a file path.
 *
 * Returns a new config object; the input config is not mutated.
 */
export function applyCliOverrides(
  config: ChangelogConfig,
  overrides: CliOverrides,
): ChangelogConfig {
  const result: ChangelogConfig = structuredClone(config);

  if (overrides.provider) {
    const provider = PROVIDER_SCHEMA.parse(overrides.provider);
    result.ai.generation.provider = provider;
    result.ai.translation.provider = provider;
    // Reset model to provider default when provider changes
    result.ai.generation.model = PROVIDER_DEFAULT_MODELS[provider];
    result.ai.translation.model = PROVIDER_DEFAULT_MODELS[provider];
  }

  if (overrides.model) {
    result.ai.generation.model = overrides.model;
    result.ai.translation.model = overrides.model;
  }

  if (overrides.output) {
    const parsed = path.parse(overrides.output);
    if (parsed.ext && parsed.ext !== "") {
      // It's a file path — split into dir + filename
      result.output.dir = parsed.dir || ".";
      result.output.filename = parsed.name;
    } else {
      // It's a directory path
      result.output.dir = overrides.output;
    }
  }

  return result;
}
