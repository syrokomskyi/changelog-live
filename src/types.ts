import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider / model enums
// ---------------------------------------------------------------------------

export const PROVIDER_SCHEMA = z.enum(["openai", "anthropic", "gemini"]);
export type Provider = z.infer<typeof PROVIDER_SCHEMA>;

export const WEEKDAY_SCHEMA = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof WEEKDAY_SCHEMA>;

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
      period: z.literal("week").default("week"),
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
  maxHistoryWeeks: z.number().int().positive().optional(),
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
// Week grouping
// ---------------------------------------------------------------------------

export interface WeekGroup {
  weekStart: string;
  weekEnd: string;
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
  weekStart: string;
  weekEnd: string;
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
  weekStart: string;
  weekEnd: string;
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
  weekStart: string;
  weekEnd: string;
  title: string;
  summary: string;
  categories: Record<PublicChangelogCategory, string[]>;
}

export interface ParsedPublicChangelog {
  header: string;
  sections: ParsedPublicSection[];
}

export interface ParsedPublicSection {
  weekStart: string;
  weekEnd: string;
  title: string;
  summary: string;
  raw: string;
}
