// ─── Core i18n Engine ────────────────────────────────────────────────────────
// Zero-dependency internationalization engine for TransmissionMap.
// Manages active locale, string translation, parameter interpolation,
// fallback resolution, document direction, and DOM updates.
// The route planner's strings (route.*, src/i18n/route/*.ts) load with the panel
// (loadRouteStrings); the route.* keys the boot bundle reads stay in locales/.
// Deps: ./types.js, ./locales/en.js (bundled) + ./locales/*.ts and ./route/*.ts (lazy chunks)

import type { SupportedLocale, LocaleDef, LocaleDictionary } from './types.js';
import en from './locales/en.js';

export type { SupportedLocale, LocaleDef, LocaleDictionary } from './types.js';

export const SUPPORTED_LOCALES: readonly LocaleDef[] = [
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', dir: 'ltr' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
  // Navajo is withheld from the picker until a Diné speaker reviews the
  // dictionary — `stale.odin.*` in locales/nv.ts is still English. The
  // dictionary and its loader stay in place: uncomment this line to list it.
  // { code: 'nv', name: 'Navajo', nativeName: 'Diné Bizaad', dir: 'ltr' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', dir: 'ltr' },
  { code: 'tl', name: 'Tagalog', nativeName: 'Wikang Tagalog', dir: 'ltr' },
] as const;

// Every locale but `en` is its own chunk, fetched on demand by loadDictionary().
const loaders = import.meta.glob<LocaleDictionary>(['./locales/*.ts', '!./locales/en.ts'], { import: 'default' });

export const DICTIONARIES: Partial<Record<SupportedLocale, LocaleDictionary>> & { en: LocaleDictionary } = { en };

// The route planner's strings, one chunk per locale, fetched once the panel has been asked for.
const routeLoaders = import.meta.glob<LocaleDictionary>('./route/*.ts', { import: 'default' });
export const ROUTE_DICTIONARIES: Partial<Record<SupportedLocale, LocaleDictionary>> = {};
let routeWanted = false;

// Best effort: a failed fetch leaves t() on the English route text.
async function loadRoutePart(locale: SupportedLocale): Promise<void> {
  const loader = routeLoaders[`./route/${locale}.ts`];
  if (ROUTE_DICTIONARIES[locale] || !loader) return;
  try { ROUTE_DICTIONARIES[locale] = await loader(); } catch { /* English route text */ }
}

/** Load the route strings for English and the current language; later language switches keep them in step. */
export async function loadRouteStrings(): Promise<void> {
  routeWanted = true;
  await Promise.all([loadRoutePart('en'), loadRoutePart(currentLocale)]);
}

export async function loadDictionary(locale: SupportedLocale): Promise<void> {
  const loader = loaders[`./locales/${locale}.ts`];
  if (!DICTIONARIES[locale] && loader) DICTIONARIES[locale] = await loader();
  if (routeWanted) await loadRoutePart(locale);
}

let currentLocale: SupportedLocale = 'en';

export function getLocale(): SupportedLocale {
  return currentLocale;
}

export function setLocale(locale: SupportedLocale): void {
  if (isValidLocale(locale)) {
    currentLocale = locale;
    applyDocumentDirection(locale);
  }
}

export function isValidLocale(code: string): code is SupportedLocale {
  return SUPPORTED_LOCALES.some(l => l.code === code);
}

export function getLocaleDef(locale: SupportedLocale): LocaleDef {
  return SUPPORTED_LOCALES.find(l => l.code === locale) ?? SUPPORTED_LOCALES[0];
}

export function applyDocumentDirection(locale: SupportedLocale): void {
  const def = getLocaleDef(locale);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dir = def.dir;
    document.documentElement.lang = def.code;
  }
}

export function t(key: string, params?: Record<string, string | number>): string {
  let val: string | undefined;
  for (const dict of [DICTIONARIES[currentLocale], ROUTE_DICTIONARIES[currentLocale], DICTIONARIES.en, ROUTE_DICTIONARIES.en]) {
    if (dict && Object.hasOwn(dict, key)) { val = dict[key]; break; }
  }
  val ??= key;
  if (params) {
    return val.replace(/\{([^{}]+)\}/g, (match, paramKey) => {
      return paramKey in params ? String(params[paramKey]) : match;
    });
  }
  return val;
}

export function updateDomTranslations(root?: HTMLElement | Document): void {
  const target = root ?? (typeof document !== 'undefined' ? document : null);
  if (!target) return;

  const updateEl = (el: Element) => {
    const textKey = el.getAttribute('data-i18n');
    if (textKey) {
      el.textContent = t(textKey);
    }

    const htmlKey = el.getAttribute('data-i18n-html');
    if (htmlKey) {
      el.innerHTML = t(htmlKey);
    }

    const titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) {
      el.setAttribute('title', t(titleKey));
    }

    const placeholderKey = el.getAttribute('data-i18n-placeholder');
    if (placeholderKey) {
      if ('placeholder' in el) {
        (el as HTMLInputElement).placeholder = t(placeholderKey);
      } else {
        el.setAttribute('placeholder', t(placeholderKey));
      }
    }

    const ariaLabelKey = el.getAttribute('data-i18n-aria-label');
    if (ariaLabelKey) {
      el.setAttribute('aria-label', t(ariaLabelKey));
    }
  };

  if (target instanceof Element) {
    updateEl(target);
  }

  const elements = target.querySelectorAll(
    '[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]'
  );
  elements.forEach(updateEl);
}
