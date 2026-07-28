/*
<MODULE_CONTRACT>
<purpose>Shared AI provider call adapter for OpenAI, Anthropic, and Gemini — eliminates duplicated provider boilerplate.</purpose>
<non-goals>
  <item>Does not build prompts or parse responses — callers handle domain-specific prompt/response logic.</item>
  <item>Does not manage API keys — caller must provide a valid key.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Extracted from ai-generate.ts and ai-translate.ts to eliminate ~160 lines of duplicated provider call boilerplate.</item>
</CHANGE_SUMMARY>
*/

import type { Provider } from "./types.js";

export interface CallProviderOptions {
  provider: Provider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
  /** Optional JSON schema for OpenAI structured outputs. When omitted, OpenAI uses plain text mode. */
  schema?: Record<string, unknown>;
  /** Schema name for OpenAI structured outputs. Defaults to "changelog_section". */
  schemaName?: string;
}

/**
 * Call the appropriate AI provider and return the raw response text.
 * When a schema is provided, OpenAI uses structured outputs with that schema.
 */
export async function callAiProvider(opts: CallProviderOptions): Promise<string> {
  switch (opts.provider) {
    case "openai":
      return callOpenAI(opts);
    case "anthropic":
      return callAnthropic(opts);
    case "gemini":
      return callGemini(opts);
  }
}

async function callOpenAI(opts: CallProviderOptions): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: opts.apiKey });

  const responseFormat = opts.schema
    ? {
        type: "json_schema" as const,
        json_schema: {
          name: opts.schemaName ?? "changelog_section",
          schema: opts.schema,
          strict: true,
        },
      }
    : undefined;

  const response = await client.chat.completions.create({
    model: opts.model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callAnthropic(opts: CallProviderOptions): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: opts.apiKey });

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 4096,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

async function callGemini(opts: CallProviderOptions): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const genModel = genAI.getGenerativeModel({
    model: opts.model,
    systemInstruction: opts.systemPrompt,
    ...(opts.schema
      ? { generationConfig: { responseMimeType: "application/json" } }
      : {}),
  });

  const result = await genModel.generateContent(opts.userPrompt);
  return result.response.text();
}
