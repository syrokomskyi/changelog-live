import type { Provider } from "./types.js";
import { getApiKey } from "./config.js";

// ---------------------------------------------------------------------------
// Language helpers
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

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export interface TranslateOptions {
  provider: Provider;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  markdown: string;
}

/**
 * Translate a markdown changelog section from source language to target language.
 * Preserves markdown structure (headers, lists, formatting).
 * Throws if the API key is missing or the API call fails.
 */
export async function translateChangelogSection(opts: TranslateOptions): Promise<string> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt = buildTranslationPrompt(opts.sourceLanguage, opts.targetLanguage);
  const userPrompt = opts.markdown;

  const raw = await callProvider(opts.provider, opts.model, apiKey, systemPrompt, userPrompt);
  return raw;
}

function buildTranslationPrompt(sourceLang: string, targetLang: string): string {
  return `You are a professional translator. Translate the following markdown changelog section from ${getLanguageName(sourceLang)} to ${getLanguageName(targetLang)}.

Rules:
1. Preserve all markdown formatting (headers, lists, bold, links).
2. Do not translate code blocks, file paths, URLs, or technical identifiers.
3. Maintain the same structure and ordering.
4. Use natural, professional language for ${getLanguageName(targetLang)}.
5. Return ONLY the translated markdown — no explanations, no preamble.`;
}

// ---------------------------------------------------------------------------
// Provider calls (simplified — no structured outputs needed for translation)
// ---------------------------------------------------------------------------

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
  });

  return response.choices[0]?.message?.content ?? "";
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
  return textBlock?.text ?? "";
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
  });

  const result = await genModel.generateContent(userPrompt);
  return result.response.text();
}
