// assets/units-store.ts — Load/save display-unit preferences from localStorage.
// Deps: src/units (getUnits, setUnits, UNIT_OPTIONS)

import { UNIT_OPTIONS, getUnits, setUnits, type UnitPrefs } from '../src/units.js';

const KEY = 'tm-units';

export function loadUnits(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const validated: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(parsed)) {
      const dim = key as keyof UnitPrefs;
      // hasOwn, not `in` — a stored key inherited from Object.prototype
      // (toString, constructor, …) would otherwise index UNIT_OPTIONS to
      // undefined and throw, discarding the valid keys alongside it.
      if (Object.hasOwn(UNIT_OPTIONS, dim)) {
        const matched = UNIT_OPTIONS[dim].options.find(opt => opt.value === val);
        if (matched) {
          validated[dim] = matched.value;
        }
      }
    }
    setUnits(validated as Partial<UnitPrefs>);
  } catch {
    // Silently swallow: malformed JSON, quota exceeded, etc.
  }
}

export function saveUnits(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(getUnits()));
  } catch {
    // Silently swallow: quota exceeded, private browsing, etc.
  }
}
