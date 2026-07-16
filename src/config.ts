import fs from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import {
  CHANGELOG_CONFIG_SCHEMA,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_ENV_KEYS,
  type ChangelogConfig,
  type Provider,
} from "./types.js";

/**
 * Load and validate a changelog config from a YAML file.
 */
export async function loadConfig(configPath: string): Promise<ChangelogConfig> {
  const raw = await fs.readFile(configPath, "utf-8");
  const parsed = YAML.parse(raw);
  return validateConfig(parsed);
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
