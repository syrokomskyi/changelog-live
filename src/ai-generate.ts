/*
<MODULE_CONTRACT>
<purpose>Generates changelog sections from git commits using AI</purpose>
<non-goals>
  <item>Does not handle manual changelog entry creation</item>
  <item>Does not support non-AI-based changelog generation</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of changelog generation module</item>
  <item>ADR-0007: Added optional systemPrompt to GenerateOptions and PublicGenerateOptions for custom AI prompts via config</item>
  <item>ADR-0009: Added retry (up to 3 attempts) to generateChangelogSection() for invalid JSON responses</item>
</CHANGE_SUMMARY>
*/

import type {
  ChangelogCategory,
  ChangelogSection,
  GitCommit,
  Provider,
  PublicChangelogCategory,
  PublicChangelogSection,
  PeriodGroup,
} from "./types.js";
import {
  CHANGELOG_CATEGORIES,
  CATEGORY_LABELS,
  PUBLIC_CHANGELOG_CATEGORIES,
  PUBLIC_CATEGORY_LABELS,
} from "./types.js";
import { getApiKey } from "./config.js";
import { callAiProvider } from "./ai-provider.js";
import { getLanguageName } from "./languages.js";
import type { Logger } from "./logger.js";

export function formatCommitsForPrompt(commits: GitCommit[]): string {
  return commits
    .map((c) => {
      const fileStats = c.files
        .map((f) => `  ${f.path} (+${f.additions} -${f.deletions})`)
        .join("\n");
      return `commit ${c.hash}\nDate: ${c.date}\nMessage: ${c.message}\nFiles:\n${fileStats}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Commit chunking (large period groups)
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 200;

/**
 * Split a large commit array into chunks of at most `chunkSize` commits.
 * Returns a single-element array containing the original array if no chunking is needed.
 */
export function chunkCommits(commits: GitCommit[], chunkSize: number): GitCommit[][] {
  if (commits.length <= chunkSize) return [commits];
  const chunks: GitCommit[][] = [];
  for (let i = 0; i < commits.length; i += chunkSize) {
    chunks.push(commits.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Merge multiple ChangelogSections (from different chunks) into one by
 * concatenating entries within each category.
 */
export function mergeChangelogSections(sections: ChangelogSection[]): ChangelogSection {
  const categories = {} as Record<ChangelogCategory, string[]>;
  for (const cat of CHANGELOG_CATEGORIES) {
    categories[cat] = sections.flatMap((s) => s.categories[cat] ?? []);
  }
  return {
    periodStart: sections[0].periodStart,
    periodEnd: sections[0].periodEnd,
    categories,
    commitMessage: sections[sections.length - 1].commitMessage,
  };
}

/**
 * Merge multiple PublicChangelogSections (from different chunks) into one by
 * concatenating entries within each category. Title and summary are taken
 * from the first section.
 */
export function mergePublicChangelogSections(
  sections: PublicChangelogSection[],
): PublicChangelogSection {
  const categories = {} as Record<PublicChangelogCategory, string[]>;
  for (const cat of PUBLIC_CHANGELOG_CATEGORIES) {
    categories[cat] = sections.flatMap((s) => s.categories[cat] ?? []);
  }
  return {
    periodStart: sections[0].periodStart,
    periodEnd: sections[0].periodEnd,
    title: sections[0].title,
    summary: sections[0].summary,
    categories,
  };
}

function buildSystemPrompt(language: string): string {
  return `You are a professional changelog author. Given git commits with file statistics, produce a professional changelog section.

Rules:
1. Write in ${getLanguageName(language)}.
2. Group changes into these categories: ${CHANGELOG_CATEGORIES.map((c) => CATEGORY_LABELS[c]).join(", ")}.
3. Merge related commits into single concise entries — do not list every commit individually.
4. Each entry should be a clear, professional sentence describing the user-facing impact.
5. Use imperative mood (e.g., "Add Matomo analytics" not "Added Matomo analytics").
6. Omit empty categories — only include categories that have at least one entry.
7. Also provide a concise commit message (max 72 chars) summarizing all changes.
8. Base each entry ONLY on the files shown in the commit statistics. The commit message may describe repo-wide changes, but this changelog covers only the files listed — describe what changed for those files, not the entire repository.
9. Do not mention "changelog", "CHANGELOG.md", or changes to changelog files themselves.

Return a JSON object with this exact structure:
{
  "categories": {
    "added": ["entry 1", "entry 2"],
    "changed": ["entry 1"],
    "fixed": ["entry 1"],
    "removed": [],
    "security": [],
    "documentation": []
  },
  "commitMessage": "concise summary"
}

Only include categories that have entries. Omit empty arrays entirely.`;
}

// ---------------------------------------------------------------------------
// Response schema (for OpenAI structured outputs)
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    categories: {
      type: "object" as const,
      additionalProperties: false,
      properties: Object.fromEntries(
        CHANGELOG_CATEGORIES.map((c) => [c, { type: "array", items: { type: "string" } }]),
      ),
      required: [...CHANGELOG_CATEGORIES],
    },
    commitMessage: { type: "string" },
  },
  required: ["categories", "commitMessage"],
};

// ---------------------------------------------------------------------------
// AI generation
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;

export interface GenerateOptions {
  provider: Provider;
  model: string;
  language: string;
  group: PeriodGroup;
  logger?: Logger;
  systemPrompt?: string;
  chunkSize?: number;
}

/**
 * Generate a changelog section for a single chunk of commits using AI.
 * Uses retry (up to 3 attempts) if the AI returns invalid JSON.
 * Throws if the API key is missing or all attempts fail.
 */
async function generateSingleChunkSection(
  opts: GenerateOptions,
  apiKey: string,
  systemPrompt: string,
): Promise<ChangelogSection> {
  const baseUserPrompt = formatCommitsForPrompt(opts.group.commits);
  const logger = opts.logger;

  let lastError: Error | null = null;
  let lastRaw = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt === 2) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nYour previous response was not valid JSON. Please return valid JSON with the exact structure requested.";
    } else if (attempt === 3) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nFINAL ATTEMPT: return valid JSON with the exact structure requested.";
    }

    logger?.verbose(`changelog-live: [AI] generation prompt (${attempt}/${MAX_RETRIES}):
${userPrompt.slice(0, 500)}...`);
    const startTime = Date.now();
    const raw = await callAiProvider({
      provider: opts.provider,
      model: opts.model,
      apiKey,
      systemPrompt,
      userPrompt,
      schema: RESPONSE_SCHEMA,
    });
    const elapsed = Date.now() - startTime;
    logger?.verbose(`changelog-live: [AI] generation response (${elapsed}ms):
${raw.slice(0, 500)}...`);
    lastRaw = raw;

    try {
      return parseGenerationResponse(raw, opts.group);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logger?.info(
        `changelog-live: internal section parse error (attempt ${attempt}/${MAX_RETRIES}), retrying...`,
      );
    }
  }

  throw new Error(
    `AI failed to produce valid changelog JSON after ${MAX_RETRIES} attempts. ` +
      `Last error: ${lastError?.message ?? "unknown"}. Last response: ${lastRaw.slice(0, 300)}`,
  );
}

/**
 * Generate a changelog section for a period's worth of commits using AI.
 * If the period has more commits than `chunkSize` (default 200), the commits
 * are split into chunks, each chunk is processed independently, and the
 * resulting sections are merged by concatenating entries within each category.
 * Uses retry (up to 3 attempts) per chunk if the AI returns invalid JSON.
 * Throws if the API key is missing or all attempts fail for any chunk.
 */
export async function generateChangelogSection(opts: GenerateOptions): Promise<ChangelogSection> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.language);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks = chunkCommits(opts.group.commits, chunkSize);
  const logger = opts.logger;

  if (chunks.length <= 1) {
    return generateSingleChunkSection(opts, apiKey, systemPrompt);
  }

  logger?.info(
    `changelog-live: [AI] splitting ${opts.group.commits.length} commits into ${chunks.length} chunks of ~${chunkSize}`,
  );

  const sections: ChangelogSection[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logger?.info(
      `changelog-live: [AI] processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} commits)`,
    );
    const chunkGroup: PeriodGroup = {
      ...opts.group,
      commits: chunks[i],
    };
    const section = await generateSingleChunkSection(
      { ...opts, group: chunkGroup },
      apiKey,
      systemPrompt,
    );
    sections.push(section);
  }

  return mergeChangelogSections(sections);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseGenerationResponse(raw: string, group: PeriodGroup): ChangelogSection {
  let parsed: {
    categories?: Partial<Record<ChangelogCategory, string[]>>;
    commitMessage?: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const categories = {} as Record<ChangelogCategory, string[]>;
  for (const cat of CHANGELOG_CATEGORIES) {
    categories[cat] = parsed.categories?.[cat] ?? [];
  }

  const commitMessage = parsed.commitMessage ?? `export ${group.periodStart}`;

  return {
    periodStart: group.periodStart,
    periodEnd: group.periodEnd,
    categories,
    commitMessage,
  };
}

// ---------------------------------------------------------------------------
// Public changelog generation
// ---------------------------------------------------------------------------

function buildPublicSystemPrompt(language: string): string {
  const langName = getLanguageName(language);
  const categoryList = PUBLIC_CHANGELOG_CATEGORIES.map((c) => PUBLIC_CATEGORY_LABELS[c]).join(", ");

  return `You are a senior technical writer in a modern engineering web studio working for clients in Europe. Your task is to create a concise, client-friendly changelog from git commits with file statistics.

Rules:
1. Write in ${langName}.
2. Show only changes that are noticeable or useful to the client (UI, speed, stability, integrations, security, legal/regulatory).
3. Formulate changes in human language — no "dump git log" or internal jargon.
4. Consider the European context: DSGVO/GDPR, local payment providers, EU hosting, etc.
5. Group changes into these categories: ${categoryList}.
6. Merge related commits into single concise entries — do not list every commit individually.
7. Each entry should describe "what changed" + "what benefit it gives the client".
8. Where possible, indicate region/country in parentheses: (DE), (EU-wide), (NL).
9. Omit empty categories — only include categories that have at least one entry.
10. Ignore internal and purely technical changes that don't affect client-visible behavior (refactoring, file moves, minor test fixes, etc.).
11. Combine multiple small fixes in the same area into one more general item.
12. Avoid vague formulations like "improved stability" without context; briefly explain what exactly improved.
13. Use neutral, understandable tone; no marketing clichés ("revolutionary", "unique").
14. Do not reveal internal task names, tickets, modules, or infrastructure details.
15. The title MUST contain the date range in format YYYY-MM-DD — YYYY-MM-DD (using an em-dash —).
16. The title should be a brief release/period heading in ${langName}, e.g. "Platform Updates 2026-07-10 — 2026-07-17".
17. The summary should be 2-3 sentences explaining what changed overall and why it matters to the client.
18. Base each entry ONLY on the files shown in the commit statistics. The commit message may describe repo-wide changes, but this changelog covers only the files listed.
19. Do not mention "changelog", "CHANGELOG.md", or changes to changelog files themselves.

Return a JSON object with this exact structure:
{
  "title": "Platform Updates 2026-07-10 — 2026-07-17",
  "summary": "2-3 sentence summary",
  "categories": {
    "added": ["entry 1", "entry 2"],
    "improved": ["entry 1"],
    "fixed": ["entry 1"],
    "security_compliance": [],
    "integrations": []
  }
}

Only include categories that have entries. Omit empty arrays entirely.`;
}

const PUBLIC_RESPONSE_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    title: { type: "string" as const },
    summary: { type: "string" as const },
    categories: {
      type: "object" as const,
      additionalProperties: false,
      properties: Object.fromEntries(
        PUBLIC_CHANGELOG_CATEGORIES.map((c) => [c, { type: "array", items: { type: "string" } }]),
      ),
      required: [...PUBLIC_CHANGELOG_CATEGORIES],
    },
  },
  required: ["title", "summary", "categories"],
};

const TITLE_DATE_REGEX = /(\d{4}-\d{2}-\d{2})\s+[—–-]\s+(\d{4}-\d{2}-\d{2})/;

const MAX_PUBLIC_RETRIES = 3;

export interface PublicGenerateOptions {
  provider: Provider;
  model: string;
  language: string;
  group: PeriodGroup;
  logger?: Logger;
  systemPrompt?: string;
  chunkSize?: number;
}

/**
 * Generate a public changelog section for a single chunk of commits using AI.
 * Uses an escalating retry (up to 3 attempts) if the AI-generated title
 * does not contain the required date range.
 */
async function generateSinglePublicChunkSection(
  opts: PublicGenerateOptions,
  apiKey: string,
  systemPrompt: string,
): Promise<PublicChangelogSection> {
  const baseUserPrompt = formatCommitsForPrompt(opts.group.commits);
  const logger = opts.logger;

  let lastRaw = "";

  for (let attempt = 1; attempt <= MAX_PUBLIC_RETRIES; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt === 2) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nYour previous response did not include the required date range " +
        "YYYY-MM-DD — YYYY-MM-DD in the title. Please regenerate with the date range " +
        `${opts.group.periodStart} — ${opts.group.periodEnd} in the title.`;
    } else if (attempt === 3) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nFINAL ATTEMPT: The title MUST contain the exact date range " +
        `${opts.group.periodStart} — ${opts.group.periodEnd}. ` +
        `Example title: "Plattform-Updates für die Woche ${opts.group.periodStart} — ${opts.group.periodEnd}".`;
    }

    logger?.verbose(`changelog-live: [AI] public generation prompt (${attempt}/${MAX_PUBLIC_RETRIES}):
${userPrompt.slice(0, 500)}...`);
    const startTime = Date.now();
    const raw = await callAiProvider({
      provider: opts.provider,
      model: opts.model,
      apiKey,
      systemPrompt,
      userPrompt,
      schema: PUBLIC_RESPONSE_SCHEMA,
      schemaName: "public_changelog_section",
    });
    const elapsed = Date.now() - startTime;
    logger?.verbose(`changelog-live: [AI] public generation response (${elapsed}ms):
${raw.slice(0, 500)}...`);
    lastRaw = raw;

    const section = parsePublicGenerationResponse(raw, opts.group);
    if (section) return section;

    logger?.info(
      `changelog-live: public section title missing date range (attempt ${attempt}/${MAX_PUBLIC_RETRIES}), retrying...`,
    );
  }

  throw new Error(
    `AI failed to produce a public changelog title with date range after ${MAX_PUBLIC_RETRIES} attempts. ` +
      `Last response: ${lastRaw.slice(0, 300)}`,
  );
}

/**
 * Generate a public changelog section for a period's worth of commits using AI.
 * If the period has more commits than `chunkSize` (default 200), the commits
 * are split into chunks, each chunk is processed independently, and the
 * resulting sections are merged by concatenating entries within each category.
 * Title and summary are taken from the first chunk's result.
 * Uses an escalating retry (up to 3 attempts) per chunk if the AI-generated title
 * does not contain the required date range.
 */
export async function generatePublicChangelogSection(
  opts: PublicGenerateOptions,
): Promise<PublicChangelogSection> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt = opts.systemPrompt ?? buildPublicSystemPrompt(opts.language);
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunks = chunkCommits(opts.group.commits, chunkSize);
  const logger = opts.logger;

  if (chunks.length <= 1) {
    return generateSinglePublicChunkSection(opts, apiKey, systemPrompt);
  }

  logger?.info(
    `changelog-live: [AI] splitting ${opts.group.commits.length} public commits into ${chunks.length} chunks of ~${chunkSize}`,
  );

  const sections: PublicChangelogSection[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logger?.info(
      `changelog-live: [AI] processing public chunk ${i + 1}/${chunks.length} (${chunks[i].length} commits)`,
    );
    const chunkGroup: PeriodGroup = {
      ...opts.group,
      commits: chunks[i],
    };
    const section = await generateSinglePublicChunkSection(
      { ...opts, group: chunkGroup },
      apiKey,
      systemPrompt,
    );
    sections.push(section);
  }

  return mergePublicChangelogSections(sections);
}

/**
 * Parse a public generation response into a PublicChangelogSection.
 * Returns null if the title does not contain the required date range.
 */
export function parsePublicGenerationResponse(
  raw: string,
  group: PeriodGroup,
): PublicChangelogSection | null {
  let parsed: {
    title?: string;
    summary?: string;
    categories?: Partial<Record<PublicChangelogCategory, string[]>>;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`AI returned invalid JSON for public section: ${raw.slice(0, 200)}`);
  }

  const title = parsed.title ?? "";
  const dateMatch = title.match(TITLE_DATE_REGEX);
  if (!dateMatch) return null;

  // Always use the config-driven period boundaries (from groupCommits),
  // not the AI-generated dates in the title. This ensures the public changelog
  // has the same period cadence as the internal changelog.
  const correctedTitle = title.replace(
    TITLE_DATE_REGEX,
    `${group.periodStart} — ${group.periodEnd}`,
  );

  const categories = {} as Record<PublicChangelogCategory, string[]>;
  for (const cat of PUBLIC_CHANGELOG_CATEGORIES) {
    categories[cat] = parsed.categories?.[cat] ?? [];
  }

  return {
    periodStart: group.periodStart,
    periodEnd: group.periodEnd,
    title: correctedTitle,
    summary: parsed.summary ?? "",
    categories,
  };
}
