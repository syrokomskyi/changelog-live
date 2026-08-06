/*
<MODULE_CONTRACT>
<purpose>Defines schemas and types for AI provider configurations, changelog structures, and git commit data.</purpose>
<non-goals>
  <item>Does not implement API calls or data fetching logic.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial definition of schemas and types for configuration and changelog management.</item>
  <item>ADR-0007: Added optional systemPrompt field to AI_PROVIDER_SCHEMA for custom AI prompts</item>
</CHANGE_SUMMARY>
*/

import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider / model enums
// ---------------------------------------------------------------------------

export const PROVIDER_SCHEMA = z.enum(["openai", "anthropic", "gemini"]);
export type Provider = z.infer<typeof PROVIDER_SCHEMA>;

export const WEEKDAY_SCHEMA = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof WEEKDAY_SCHEMA>;

export const PERIOD_SCHEMA = z.enum(["day", "week", "biweekly", "month"]);
export type Period = z.infer<typeof PERIOD_SCHEMA>;

export const SORT_ORDER_SCHEMA = z.enum(["asc", "desc"]);
export type SortOrder = z.infer<typeof SORT_ORDER_SCHEMA>;

// ---------------------------------------------------------------------------
// AI provider defaults
// ---------------------------------------------------------------------------

export const PROVIDER_DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4.1",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
};

export const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

// ---------------------------------------------------------------------------
// Configuration schema (Zod)
// ---------------------------------------------------------------------------

export const AI_PROVIDER_SCHEMA = z.object({
  provider: PROVIDER_SCHEMA,
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
});

export const CHANGELOG_CONFIG_SCHEMA = z.object({
  git: z
    .object({
      repoRoot: z.string().default("."),
      subPath: z.string().optional(),
      paths: z.array(z.string()).optional(),
    })
    .default({ repoRoot: "." }),
  grouping: z
    .object({
      period: PERIOD_SCHEMA.default("week"),
      startDay: WEEKDAY_SCHEMA.default("thu"),
    })
    .default({ period: "week", startDay: "thu" }),
  languages: z
    .object({
      primary: z.string().default("en"),
      translations: z.array(z.string()).default([]),
    })
    .default({ primary: "en", translations: [] }),
  ai: z
    .object({
      generation: AI_PROVIDER_SCHEMA.default({ provider: "openai" }),
      translation: AI_PROVIDER_SCHEMA.default({ provider: "openai" }),
    })
    .default({ generation: { provider: "openai" }, translation: { provider: "openai" } }),
  output: z
    .object({
      dir: z.string().default("."),
      filename: z.string().default("CHANGELOG"),
    })
    .default({ dir: ".", filename: "CHANGELOG" }),
  maxHistoryPeriods: z.number().int().positive().optional(),
  sortOrder: SORT_ORDER_SCHEMA.default("desc"),
  publicChangelog: z.boolean().default(false),
});

export type ChangelogConfig = z.infer<typeof CHANGELOG_CONFIG_SCHEMA>;

// ---------------------------------------------------------------------------
// Git commit types
// ---------------------------------------------------------------------------

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  files: GitFileStat[];
}

export interface GitFileStat {
  path: string;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Period grouping
// ---------------------------------------------------------------------------

export interface PeriodGroup {
  periodStart: string;
  periodEnd: string;
  commits: GitCommit[];
}

// ---------------------------------------------------------------------------
// AI generation result
// ---------------------------------------------------------------------------

export const CHANGELOG_CATEGORIES = [
  "added",
  "changed",
  "fixed",
  "removed",
  "security",
  "documentation",
] as const;

export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ChangelogCategory, string> = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
  security: "Security",
  documentation: "Documentation",
};

export interface ChangelogSection {
  periodStart: string;
  periodEnd: string;
  categories: Record<ChangelogCategory, string[]>;
  commitMessage: string;
}

// ---------------------------------------------------------------------------
// Parsed CHANGELOG structure
// ---------------------------------------------------------------------------

export interface ParsedChangelog {
  header: string;
  sections: ParsedSection[];
}

export interface ParsedSection {
  periodStart: string;
  periodEnd: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Public changelog types
// ---------------------------------------------------------------------------

export const PUBLIC_CHANGELOG_CATEGORIES = [
  "added",
  "improved",
  "fixed",
  "security_compliance",
  "integrations",
] as const;

export type PublicChangelogCategory = (typeof PUBLIC_CHANGELOG_CATEGORIES)[number];

export const PUBLIC_CATEGORY_LABELS: Record<PublicChangelogCategory, string> = {
  added: "Added",
  improved: "Improved",
  fixed: "Fixed",
  security_compliance: "Security & Compliance",
  integrations: "Integrations",
};

export interface PublicChangelogSection {
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: string;
  categories: Record<PublicChangelogCategory, string[]>;
}

export interface ParsedPublicChangelog {
  header: string;
  sections: ParsedPublicSection[];
}

export interface ParsedPublicSection {
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Period control options (ADR-0004)
// ---------------------------------------------------------------------------

export interface PeriodOptions {
  since?: string;
  until?: string;
  sinceTag?: string;
  untilTag?: string;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Generation options (ADR-0005)
// ---------------------------------------------------------------------------

export interface GenerateOptions extends PeriodOptions {
  /** Skip file writes and output generated markdown to stdout instead. */
  dryRun?: boolean;
  /** Logger instance for leveled output (quiet/normal/verbose). Defaults to console. */
  logger?: import("./logger.js").Logger;
}
