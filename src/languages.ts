/*
<MODULE_CONTRACT>
<purpose>Shared language name lookup used by AI generation and translation modules.</purpose>
<non-goals>
  <item>Does not perform translation or language detection.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Extracted from ai-generate.ts and ai-translate.ts to eliminate duplicated LANGUAGE_NAMES map.</item>
</CHANGE_SUMMARY>
*/

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

export function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}
