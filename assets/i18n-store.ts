// assets/i18n-store.ts — Load/save language preference from URL, localStorage, or browser.
// Deps: src/i18n (isValidLocale, setLocale, loadDictionary, type SupportedLocale)

import { isValidLocale, setLocale, loadDictionary, type SupportedLocale } from '../src/i18n/index.js';

const KEY = 'tm-lang';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // localStorage access denied / restricted
  }
}

export async function loadLanguage(urlLang?: string | null): Promise<SupportedLocale> {
  const nav = typeof navigator !== 'undefined' ? navigator.language?.split(/[-_]/)[0] : null;
  const locale = ([urlLang, stored(), nav].find(c => c && isValidLocale(c)) ?? 'en') as SupportedLocale;
  await loadDictionary(locale);
  setLocale(locale);
  return locale;
}

export function saveLanguage(locale: SupportedLocale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Silently swallow: quota exceeded, private browsing, etc.
  }
}
