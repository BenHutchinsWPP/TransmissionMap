// @vitest-environment jsdom
// The Area picker: the pure search (ranking, scope order, accents, duplicate
// labels, codes without labels) and the field end to end — a pick, a pick of
// another kind, Backspace and Clear are each one setArea() and one url:write.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { state } from '../state.js';
import { on } from '../state-bus.js';
import { buildAreaIndex, searchAreas, codeHits, kindOrder, wireAreaPicker, areaAction, fold } from './ui-area.js';
import { loadAreaLabels, type AreaLabels } from './area-labels.js';

const TABLE = {
  states: { TX: 'Texas', NM: 'New Mexico' },
  counties: { '48201': 'Harris County, TX', '48203': 'Harrison County, TX', '13145': 'Harris County, GA' },
  ba: { ERCO: 'ERCOT ISO' },
  nerc: { TRE: 'TRE — Texas (ERCOT)', SERC: 'SERC — Southeast' },
  retail: { '44372': 'TEXAS-NEW MEXICO POWER CO (TX)' },
  countries: { USA: 'United States', CHE: 'Switzerland', IRN: 'Iran' },
  admin1: { USAB: ['Texas', 'USA'], CHE5: ['Zürich', 'CHE'], IRN0: ['Mazandaran', 'IRN'], IRNO: ['Mazandaran', 'IRN'] },
} as AreaLabels;
const index = buildAreaIndex(TABLE);

describe('searchAreas', () => {
  it('ranks a name that starts with the query first, US kinds first on the USA scope', () => {
    const hits = searchAreas(index, 'tex', null, kindOrder('usa'));
    expect(hits[0]).toMatchObject({ kind: 'states', code: 'TX', label: 'Texas' });
    expect(hits.map(h => h.kind)).toEqual(['states', 'retail', 'admin1', 'nerc']);
  });

  it('lists world kinds first on the Global scope', () => {
    expect(searchAreas(index, 'tex', null, kindOrder('global'))[0]).toMatchObject({ kind: 'admin1', label: 'Texas — United States' });
  });

  it('finds counties by name and narrows to one kind', () => {
    expect(searchAreas(index, 'Harris', null, kindOrder('usa')).map(h => h.label))
      .toEqual(['Harris County, GA', 'Harris County, TX', 'Harrison County, TX']);
    expect(searchAreas(index, 'tex', 'nerc', kindOrder('usa')).map(h => h.code)).toEqual(['TRE']);
  });

  it('puts a county in a state of the current area first', () => {
    expect(searchAreas(index, 'Harris', null, kindOrder('usa'), { kind: 'states', codes: ['TX'] }).map(h => h.label))
      .toEqual(['Harris County, TX', 'Harrison County, TX', 'Harris County, GA']);
  });

  it('matches across accents and case, and by exact code', () => {
    expect(searchAreas(index, 'zurich', null, kindOrder('usa'))[0]).toMatchObject({ code: 'CHE5' });
    expect(searchAreas(index, 'erco', null, kindOrder('usa'))[0]).toMatchObject({ kind: 'ba', code: 'ERCO' });
    expect(fold('ZÜRICH')).toBe('zurich');
  });

  it('marks duplicate labels so the code can be shown', () => {
    const hits = searchAreas(index, 'mazandaran', null, kindOrder('usa'));
    expect(hits.map(h => [h.code, h.dup])).toEqual([['IRN0', true], ['IRNO', true]]);
    expect(searchAreas(index, 'texas', 'states', kindOrder('usa'))[0].dup).toBe(false);
  });

  it('lists a whole kind for an empty query once that kind is chosen', () => {
    expect(searchAreas(index, '', 'nerc', kindOrder('usa')).map(h => h.code)).toEqual(['SERC', 'TRE']);
    expect(searchAreas(index, '', null, kindOrder('usa'))).toEqual([]);
  });
});

describe('codeHits (labels unavailable)', () => {
  it('offers the typed code under each kind that accepts it', () => {
    expect(codeHits('tx', null, kindOrder('usa')).map(h => h.kind)).toEqual(['states']);
    // A five-digit code is also a valid utility id and admin-1 shape.
    expect(codeHits('48201', null, kindOrder('usa')).map(h => h.kind)).toEqual(['counties', 'retail', 'admin1']);
    expect(codeHits('USAB', null, kindOrder('usa')).map(h => h.kind)).toEqual(['admin1']);
  });
  it('offers nothing for a shape no kind accepts, or for none', () => {
    expect(codeHits('T|X', null, kindOrder('usa'))).toEqual([]);
    expect(codeHits('none', null, kindOrder('usa'))).toEqual([]);
    expect(codeHits('ZZ', 'states', kindOrder('usa'))).toEqual([]);
  });
});

describe('the Area field', () => {
  let writes = 0;
  on('url:write', () => { writes++; });
  const input = () => document.getElementById('areaInput') as HTMLInputElement;
  const type = (text: string) => { input().value = text; input().dispatchEvent(new Event('input')); };
  const key = (k: string, init: KeyboardEventInit = {}) =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  const chips = () => [...document.querySelectorAll<HTMLElement>('#areaChips [data-area-code]')].map(b => b.dataset.areaCode);

  beforeAll(async () => {
    Element.prototype.scrollIntoView ??= () => {};   // not in jsdom
    document.body.innerHTML = `
      <div id="areaRow">
        <button id="areaClear" data-area-action="clear" hidden></button>
        <div id="areaBox"><span id="areaChips"></span><input id="areaInput"></div>
        <div id="areaNote" hidden></div>
        <div id="areaSummary" hidden><span id="areaSummaryText"></span></div>
      </div>`;
    state.mapReady = false;
    state.regionScope = 'usa';
    expect(await loadAreaLabels()).not.toBeNull();
    wireAreaPicker();
    await new Promise(r => setTimeout(r, 0));
  });
  beforeEach(() => { writes = 0; });

  it('a pick sets the area once, and its chip shows the name', () => {
    state.area = null;
    input().focus();
    type('tex');
    expect(document.querySelector('#areaPopup')!.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#areaOpt0')!.textContent).toContain('Texas');
    key('Enter');
    expect(state.area).toEqual({ kind: 'states', codes: ['TX'] });
    expect(writes).toBe(1);
    expect(chips()).toEqual(['TX']);
    expect(document.querySelector('#areaChips')!.textContent).toContain('Texas');
    expect(input().value).toBe('');
  });

  it('typing alone commits nothing', () => {
    type('new mex');
    key('ArrowDown');
    key('ArrowUp');
    expect(writes).toBe(0);
    key('Escape');
    expect(document.querySelector('#areaPopup')!.hasAttribute('hidden')).toBe(true);
  });

  it('another of the same kind adds to it; another kind replaces it and says so', () => {
    type('new mexico');
    key('Enter');
    expect(state.area).toEqual({ kind: 'states', codes: ['NM', 'TX'] });
    type('harris county, tx');
    expect(document.querySelector('.area-replaces')!.textContent).toContain('2 selected');
    key('Enter');
    expect(state.area).toEqual({ kind: 'counties', codes: ['48201'] });
    expect(document.getElementById('areaNote')!.hidden).toBe(false);
    expect(writes).toBe(2);
  });

  it('Backspace in an empty field removes the last chip; Clear removes all', () => {
    state.area = { kind: 'states', codes: ['NM', 'TX'] };
    type('');
    key('Backspace');
    expect(state.area).toEqual({ kind: 'states', codes: ['NM'] });
    areaAction(document.getElementById('areaClear')!);
    expect(state.area).toBeNull();
    expect(writes).toBe(2);
  });
});
