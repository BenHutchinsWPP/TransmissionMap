// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WILDFIRE_LIVE } from './wildfire-staleness.js';
import { NWS_LIVE } from './nws-staleness.js';
import { ODIN_STALE } from './odin-outages.js';
import { staleDialog, type StaleDialogCfg } from './stale-dialog.js';

// The fixture is each dialog as index.html shipped it, translated with the en strings.
const fixture = JSON.parse(readFileSync(join(__dirname, 'stale-dialog.fixture.json'), 'utf8')) as Record<string, string>;
const feeds = { wildfire: WILDFIRE_LIVE, nws: NWS_LIVE, odin: ODIN_STALE };
const locales = import.meta.glob<Record<string, string>>('../../src/i18n/locales/*.ts', { eager: true, import: 'default' });
const norm = (html: string) => html.replace(/>\s+</g, '><').trim();

describe('stale dialogs', () => {
  for (const [feed, cfg] of Object.entries(feeds)) {
    const build = () => { document.body.innerHTML = ''; return staleDialog({ ...cfg, feed: feed as StaleDialogCfg['feed'] }); };
    it(`${feed}: the translated dialog equals the shipped markup`, () => {
      expect(norm(build().outerHTML)).toBe(fixture[feed]);
    });

    it(`${feed}: the age element exists after translation`, () => {
      expect(build().querySelector(`#${cfg.ageElId}`)).not.toBeNull();
    });
  }
});

describe('stale body 1 in every locale', () => {
  for (const [feed, cfg] of Object.entries(feeds)) {
    it(`${feed}: each locale's string carries id="${cfg.ageElId}"`, () => {
      for (const [file, dict] of Object.entries(locales)) {
        expect(dict[`stale.${feed}.body1`], file).toContain(`id="${cfg.ageElId}"`);
      }
    });
  }
});
