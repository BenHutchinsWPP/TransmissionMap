// @vitest-environment jsdom
// CSV point import: the picker dialog (guessed columns, name joining, ID column), the features it builds,
// skipped rows and the alerts. user-data.ts is mocked; the dialog is real jsdom DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { addImportedLayer } = vi.hoisted(() => ({ addImportedLayer: vi.fn() }));
vi.mock('./user-data.js', () => ({ addImportedLayer }));

import { handleCSV, pickCsvPoints } from './user-data-csv.js';
import { t } from '../../src/i18n/index.js';

const tick = () => new Promise(r => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog');
const q = <T extends Element>(sel: string) => document.querySelector(sel) as unknown as T;
const click = (sel: string) => q<HTMLElement>(sel).click();
const file = (text: string, name = 'sites.csv') => new File([text], name, { type: 'text/csv' });
let alertMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const p = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  p.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  p.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  alertMock = vi.fn();
  vi.stubGlobal('alert', alertMock);
  addImportedLayer.mockClear();
});
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('handleCSV', () => {
  it('guesses lat/long and name from headers', async () => {
    handleCSV(file('name,lat,lon,kv\nA,40,-100,69\n'));
    await tick();
    expect(dlg()).not.toBeNull();
    expect(q<HTMLSelectElement>('#csvLatSel').value).toBe('1');
    expect(q<HTMLSelectElement>('#csvLngSel').value).toBe('2');
    expect(q<HTMLInputElement>('input[name="csvName"][value="0"]').checked).toBe(true);
    expect(q<HTMLInputElement>('input[name="csvName"][value="3"]').checked).toBe(false);
  });

  it('imports features with properties, joined name and uids; counts skipped rows', async () => {
    handleCSV(file('site,town,lat,lon,kv\nA,X,40,-100,69\nB,Y,999,-100,138\nC,Z,41,-101,230\n', 'my.csv'));
    await tick();
    q<HTMLInputElement>('input[name="csvName"][value="0"]').checked = true;
    q<HTMLInputElement>('input[name="csvName"][value="1"]').checked = true;
    q<HTMLInputElement>('#csvDelim').value = ' | ';
    click('#csvImport');
    await tick();
    expect(dlg()).toBeNull();
    expect(addImportedLayer).toHaveBeenCalledTimes(1);
    const [name, fc] = addImportedLayer.mock.calls[0];
    expect(name).toBe('my.csv');
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-100, 40] });
    expect(fc.features[0].properties).toMatchObject({ site: 'A', town: 'X', kv: '69', name: 'A | X' });
    expect(fc.features[0].properties).not.toHaveProperty('lat');
    expect(fc.features[1].geometry.coordinates).toEqual([-101, 41]);
    expect(fc.features[1].properties.name).toBe('C | Z');
    const uids = fc.features.map((f: GeoJSON.Feature) => f.properties!.__uid);
    expect(uids.every((u: unknown) => typeof u === 'string' && u !== '')).toBe(true);
    expect(new Set(uids).size).toBe(2);
    expect(alertMock).toHaveBeenCalledWith(t('csv.importSuccessSkipped', { count: 2, skipped: 1 }));
  });

  it('no skipped rows: no alert; no name column: no name property', async () => {
    handleCSV(file('a,lat,lng\nx,1,2\n'));
    await tick();
    click('#csvImport');
    await tick();
    const fc = addImportedLayer.mock.calls[0][1];
    expect(fc.features[0].properties).toEqual({ a: 'x', __uid: expect.any(String) });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('alerts when there are no data rows', async () => {
    handleCSV(file('lat,lon\n'));
    await tick();
    expect(alertMock).toHaveBeenCalledWith(t('csv.noDataRows'));
    expect(dlg()).toBeNull();
  });

  it('alerts when lat and long are the same column and keeps the dialog', async () => {
    handleCSV(file('lat,lon\n1,2\n'));
    await tick();
    q<HTMLSelectElement>('#csvLngSel').value = '0';
    click('#csvImport');
    expect(alertMock).toHaveBeenCalledWith(t('csv.sameColError'));
    expect(dlg()).not.toBeNull();
    expect(addImportedLayer).not.toHaveBeenCalled();
  });

  it('alerts when no row has valid coordinates', async () => {
    handleCSV(file('lat,lon\n999,2\nx,y\n'));
    await tick();
    click('#csvImport');
    await tick();
    expect(alertMock).toHaveBeenCalledWith(t('csv.noValidCoords'));
    expect(addImportedLayer).not.toHaveBeenCalled();
    expect(dlg()).toBeNull();
  });

  it('Cancel closes without importing', async () => {
    handleCSV(file('lat,lon\n1,2\n'));
    await tick();
    click('#csvCancel');
    expect(dlg()).toBeNull();
    expect(addImportedLayer).not.toHaveBeenCalled();
  });

  it('escapes header text in the dialog', async () => {
    handleCSV(file('<b>x</b>,lat,lon\n1,2,3\n'));
    await tick();
    expect(document.querySelector('dialog b')).toBeNull();
  });
});

describe('pickCsvPoints', () => {
  const labels = { title: 'Pick T', submit: 'Go Now', idLabel: 'ID column', idNone: 'None' };

  it('uses the submit text and title from labels', async () => {
    const p = pickCsvPoints(file('lat,lon\n1,2\n'), labels);
    await tick();
    expect(q<HTMLElement>('#csvImport').textContent).toBe('Go Now');
    expect(q<HTMLElement>('dialog h2').textContent).toBe('Pick T');
    click('#csvImport');
    expect((await p)!.features).toHaveLength(1);
  });

  it('returns the chosen ID column and maps features to data rows past skipped rows', async () => {
    const p = pickCsvPoints(file('num,lat,lon\nA,40,-100\nB,999,0\nC,41,-101\n'), labels);
    await tick();
    const sel = q<HTMLSelectElement>('#csvIdSel');
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('-1');
    sel.value = '0';
    click('#csvImport');
    const r = (await p)!;
    expect(r.idCol).toBe(0);
    expect(r.latCol).toBe(1);
    expect(r.lngCol).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.fileName).toBe('sites.csv');
    expect(r.headers).toEqual(['num', 'lat', 'lon']);
    expect([...r.dataRowIndex]).toEqual([0, 2]);
    expect(r.features[1].properties).toMatchObject({ num: 'C' });
  });

  it('idCol is null when None is kept; no ID select without idLabel', async () => {
    let p = pickCsvPoints(file('num,lat,lon\nA,1,2\n'), labels);
    await tick();
    click('#csvImport');
    expect((await p)!.idCol).toBeNull();
    p = pickCsvPoints(file('num,lat,lon\nA,1,2\n'), { title: 'T', submit: 'S' });
    await tick();
    expect(document.querySelector('#csvIdSel')).toBeNull();
    click('#csvImport');
    expect((await p)!.idCol).toBeNull();
  });

  it('resolves null on cancel and on a refused file; addImportedLayer is never called', async () => {
    let p = pickCsvPoints(file('lat,lon\n1,2\n'), labels);
    await tick();
    click('#csvCancel');
    expect(await p).toBeNull();
    p = pickCsvPoints(file('lat,lon\n'), labels);
    expect(await p).toBeNull();
    expect(alertMock).toHaveBeenCalledWith(t('csv.noDataRows'));
    expect(addImportedLayer).not.toHaveBeenCalled();
  });

  it('refuses more data rows than maxRows right after parsing: no dialog, no alert, onTooMany gets the count', async () => {
    const onTooMany = vi.fn();
    const p = await pickCsvPoints(file('lat,lon\n1,2\n3,4\n5,6\n'), { ...labels, maxRows: 2, onTooMany });
    expect(p).toBeNull();
    expect(onTooMany).toHaveBeenCalledWith(3);
    expect(document.querySelector('dialog')).toBeNull();
    expect(alertMock).not.toHaveBeenCalled();
  });
});
