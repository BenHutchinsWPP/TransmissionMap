// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadLanguage, saveLanguage } from './i18n-store.js';
import { getLocale, setLocale } from '../src/i18n/index.js';

const KEY = 'tm-lang';

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('en');
});

describe('loadLanguage', () => {
  it('prefers valid urlLang over localStorage and navigator.language', async () => {
    localStorage.setItem(KEY, 'de');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr');

    const result = await loadLanguage('es');
    expect(result).toBe('es');
    expect(getLocale()).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('falls back from invalid urlLang to valid localStorage', async () => {
    localStorage.setItem(KEY, 'de');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr');

    const result = await loadLanguage('invalid-lang');
    expect(result).toBe('de');
    expect(getLocale()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('prefers localStorage over navigator.language when urlLang is absent', async () => {
    localStorage.setItem(KEY, 'fr');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de');

    const result = await loadLanguage();
    expect(result).toBe('fr');
    expect(getLocale()).toBe('fr');
  });

  it('falls back to navigator.language when urlLang and localStorage are absent', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');

    const result = await loadLanguage();
    expect(result).toBe('de');
    expect(getLocale()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
  });

  it('handles RTL document direction when loading Arabic', async () => {
    const result = await loadLanguage('ar');
    expect(result).toBe('ar');
    expect(getLocale()).toBe('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('falls back to "en" when urlLang, localStorage, and navigator.language are all invalid', async () => {
    localStorage.setItem(KEY, 'corrupted_code');
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('xx-YY');

    const result = await loadLanguage('invalid');
    expect(result).toBe('en');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('survives localStorage reading failure and falls back gracefully', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja');

    await expect(loadLanguage()).resolves.toBe('ja');
    expect(getLocale()).toBe('ja');
  });
});

describe('saveLanguage', () => {
  it('saves the selected locale to localStorage', async () => {
    saveLanguage('zh');
    expect(localStorage.getItem(KEY)).toBe('zh');
  });

  it('survives localStorage write refusal without throwing', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => saveLanguage('pt')).not.toThrow();
  });
});
