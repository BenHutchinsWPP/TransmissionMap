// ─── i18n Type Definitions ──────────────────────────────────────────────────
// Defines supported locale codes, locale metadata structure, and dictionaries.
// Zero external runtime dependencies.

export type SupportedLocale = 'en' | 'es' | 'fr' | 'de' | 'zh' | 'pt' | 'ru' | 'ja' | 'ar' | 'ko' | 'it' | 'hi' | 'nv' | 'vi' | 'tl';

export interface LocaleDef {
  code: SupportedLocale;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
}

export type LocaleDictionary = Record<string, string>;
