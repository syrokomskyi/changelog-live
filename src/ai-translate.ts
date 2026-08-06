/*
<MODULE_CONTRACT>
<purpose>Translates markdown changelog sections between languages while preserving formatting.</purpose>
<non-goals>
  <item>Does not handle non-markdown content translation.</item>
  <item>Does not provide language detection capabilities.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial implementation of translation module with provider support.</item>
  <item>ADR-0007: Added optional systemPrompt to TranslateOptions for custom translation prompts via config</item>
</CHANGE_SUMMARY>
*/

import type { Provider } from "./types.js";
import { getApiKey } from "./config.js";
import { callAiProvider } from "./ai-provider.js";
import { getLanguageName } from "./languages.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export interface TranslateOptions {
  provider: Provider;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  markdown: string;
  systemPrompt?: string;
  logger?: Logger;
}

/**
 * Translate a markdown changelog section from source language to target language.
 * Preserves markdown structure (headers, lists, formatting).
 * Throws if the API key is missing or the API call fails.
 */
export async function translateChangelogSection(opts: TranslateOptions): Promise<string> {
  const apiKey = getApiKey(opts.provider);
  const systemPrompt =
    opts.systemPrompt ?? buildTranslationPrompt(opts.sourceLanguage, opts.targetLanguage);
  const userPrompt = opts.markdown;
  const logger = opts.logger;

  logger?.verbose(`changelog-live: [AI] translation prompt (${opts.sourceLanguage} → ${opts.targetLanguage}):
${userPrompt.slice(0, 500)}...`);
  const startTime = Date.now();
  const raw = await callAiProvider({
    provider: opts.provider,
    model: opts.model,
    apiKey,
    systemPrompt,
    userPrompt,
  });
  const elapsed = Date.now() - startTime;
  logger?.verbose(`changelog-live: [AI] translation response (${elapsed}ms):
${raw.slice(0, 500)}...`);
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
