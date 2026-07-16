import type {
  ChangelogCategory,
  ChangelogSection,
  GitCommit,
  Provider,
  WeekGroup,
} from "./types.js";
import { CHANGELOG_CATEGORIES, CATEGORY_LABELS } from "./types.js";
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

function formatCommitsForPrompt(commits: GitCommit[]): string {
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
 */
async function callProvider(
  provider: Provider,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  switch (provider) {
    case "openai":
      return callOpenAI(model, apiKey, systemPrompt, userPrompt);
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
): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "changelog_section",
        schema: RESPONSE_SCHEMA,
        strict: true,
      },
    },
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

function parseGenerationResponse(raw: string, week: WeekGroup): ChangelogSection {
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
