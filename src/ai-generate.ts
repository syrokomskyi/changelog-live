import type {
  ChangelogCategory,
  ChangelogSection,
  GitCommit,
  Provider,
  PublicChangelogCategory,
  PublicChangelogSection,
  WeekGroup,
} from "./types.js";
import {
  CHANGELOG_CATEGORIES,
  CATEGORY_LABELS,
  PUBLIC_CHANGELOG_CATEGORIES,
  PUBLIC_CATEGORY_LABELS,
} from "./types.js";
import { getApiKey } from "./config.js";

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  de: "German",
  uk: "Ukrainian",
  ru: "Russian",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
};

function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

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
      properties: {
        added: { type: "array", items: { type: "string" } },
        changed: { type: "array", items: { type: "string" } },
        fixed: { type: "array", items: { type: "string" } },
        removed: { type: "array", items: { type: "string" } },
        security: { type: "array", items: { type: "string" } },
        documentation: { type: "array", items: { type: "string" } },
      },
      required: ["added", "changed", "fixed", "removed", "security", "documentation"],
    },
    commitMessage: { type: "string" },
  },
  required: ["categories", "commitMessage"],
};

// ---------------------------------------------------------------------------
// AI generation
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  provider: Provider;
  model: string;
  language: string;
  week: WeekGroup;
}

/**
 * Generate a changelog section for a week's worth of commits using AI.
 * Throws if the API key is missing or the API call fails.
 */
export async function generateChangelogSection(opts: GenerateOptions): Promise<ChangelogSection> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt = buildSystemPrompt(opts.language);
  const userPrompt = formatCommitsForPrompt(opts.week.commits);

  const raw = await callProvider(opts.provider, opts.model, apiKey, systemPrompt, userPrompt);
  return parseGenerationResponse(raw, opts.week);
}

/**
 * Call the appropriate AI provider and return the raw response text.
 * When schema is provided, OpenAI uses structured outputs with that schema.
 */
async function callProvider(
  provider: Provider,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  schema?: Record<string, unknown>,
): Promise<string> {
  switch (provider) {
    case "openai":
      return callOpenAI(model, apiKey, systemPrompt, userPrompt, schema);
    case "anthropic":
      return callAnthropic(model, apiKey, systemPrompt, userPrompt);
    case "gemini":
      return callGemini(model, apiKey, systemPrompt, userPrompt);
  }
}

async function callOpenAI(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  schema?: Record<string, unknown>,
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const responseFormat = schema
    ? {
        type: "json_schema" as const,
        json_schema: {
          name: "changelog_section",
          schema,
          strict: true,
        },
      }
    : {
        type: "json_schema" as const,
        json_schema: {
          name: "changelog_section",
          schema: RESPONSE_SCHEMA,
          strict: true,
        },
      };

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: responseFormat,
  });

  return response.choices[0]?.message?.content ?? "{}";
}

async function callAnthropic(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "{}";
}

async function callGemini(
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
    },
  });

  const result = await genModel.generateContent(userPrompt);
  return result.response.text();
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseGenerationResponse(raw: string, week: WeekGroup): ChangelogSection {
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

  const commitMessage = parsed.commitMessage ?? `export ${week.weekStart}`;

  return {
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
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
16. The title should be a brief release/period heading, e.g. "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17".
17. The summary should be 2-3 sentences explaining what changed overall and why it matters to the client.

Return a JSON object with this exact structure:
{
  "title": "Plattform-Updates für die Woche 2026-07-10 — 2026-07-17",
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
      properties: {
        added: { type: "array", items: { type: "string" } },
        improved: { type: "array", items: { type: "string" } },
        fixed: { type: "array", items: { type: "string" } },
        security_compliance: { type: "array", items: { type: "string" } },
        integrations: { type: "array", items: { type: "string" } },
      },
      required: ["added", "improved", "fixed", "security_compliance", "integrations"],
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
  week: WeekGroup;
}

/**
 * Generate a public changelog section for a week's worth of commits using AI.
 * Uses an escalating retry (up to 3 attempts) if the AI-generated title
 * does not contain the required date range.
 */
export async function generatePublicChangelogSection(
  opts: PublicGenerateOptions,
): Promise<PublicChangelogSection> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt = buildPublicSystemPrompt(opts.language);
  const baseUserPrompt = formatCommitsForPrompt(opts.week.commits);

  let lastRaw = "";

  for (let attempt = 1; attempt <= MAX_PUBLIC_RETRIES; attempt++) {
    let userPrompt = baseUserPrompt;

    if (attempt === 2) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nYour previous response did not include the required date range " +
        "YYYY-MM-DD — YYYY-MM-DD in the title. Please regenerate with the date range " +
        `${opts.week.weekStart} — ${opts.week.weekEnd} in the title.`;
    } else if (attempt === 3) {
      userPrompt =
        baseUserPrompt +
        "\n\n---\nFINAL ATTEMPT: The title MUST contain the exact date range " +
        `${opts.week.weekStart} — ${opts.week.weekEnd}. ` +
        `Example title: "Plattform-Updates für die Woche ${opts.week.weekStart} — ${opts.week.weekEnd}".`;
    }

    const raw = await callProvider(
      opts.provider,
      opts.model,
      apiKey,
      systemPrompt,
      userPrompt,
      PUBLIC_RESPONSE_SCHEMA,
    );
    lastRaw = raw;

    const section = parsePublicGenerationResponse(raw, opts.week);
    if (section) return section;

    console.log(
      `changelog-live: public section title missing date range (attempt ${attempt}/${MAX_PUBLIC_RETRIES}), retrying...`,
    );
  }

  throw new Error(
    `AI failed to produce a public changelog title with date range after ${MAX_PUBLIC_RETRIES} attempts. ` +
      `Last response: ${lastRaw.slice(0, 300)}`,
  );
}

/**
 * Parse a public generation response into a PublicChangelogSection.
 * Returns null if the title does not contain the required date range.
 */
export function parsePublicGenerationResponse(
  raw: string,
  week: WeekGroup,
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

  const weekStart = dateMatch[1];
  const weekEnd = dateMatch[2];

  const categories = {} as Record<PublicChangelogCategory, string[]>;
  for (const cat of PUBLIC_CHANGELOG_CATEGORIES) {
    categories[cat] = parsed.categories?.[cat] ?? [];
  }

  return {
    weekStart,
    weekEnd,
    title,
    summary: parsed.summary ?? "",
    categories,
  };
}
