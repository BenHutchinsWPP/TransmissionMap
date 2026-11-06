// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LinkedService } from '../services/service-spec.js';

const view = vi.hoisted(() => ({
  addService: vi.fn((_s: unknown): string | null => null),
  setServices: vi.fn((_l: unknown): string | null => null),
  skipService: vi.fn((_id: string) => true),
  pendingServices: vi.fn((): unknown[] => []),
  approveAndLoad: vi.fn((_u: string) => {}),
}));
const trust = vi.hoisted(() => ({
  approved: new Set<string>(),
  approve: vi.fn((u: string) => { trust.approved.add(u); }),
  isAllowed: vi.fn((_s: { url: string }) => false),
}));
vi.mock('../view-state.js', () => view);
vi.mock('../services/service-trust.js', async () => {
  const { isVetted } = await import('../services/service-hosts.js');
  trust.isAllowed.mockImplementation((s: { url: string; kind?: never }) => isVetted(s.url, s.kind) || trust.approved.has(s.url));
  return trust;
});

const VETTED_URL = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Crude_Oil_Trunk_Pipelines_1/FeatureServer';
const svc = (over: Partial<LinkedService> = {}): LinkedService => ({
  id: 'a1', kind: 'geojson', url: 'https://example.org/data.geojson', host: 'example.org', title: 'Example data',
  style: { kind: 'fill', color: '#112233', opacity: 0.8 }, visible: true, credit: 'example.org', ...over,
});

async function setup() {
  vi.resetModules();
  for (const f of Object.values(view)) f.mockClear();
  trust.approve.mockClear();
  trust.approved.clear();
  document.body.innerHTML = '<div id="linkedServicesBody" hidden></div>';
  const { state } = await import('../state.js');
  state.services = [];
  return state;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const flush = () => new Promise(r => setTimeout(r, 0));
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('services dialog: library', () => {
  beforeEach(async () => { await setup(); });

  it('search narrows the cards and reports no match', async () => {
    const { openServices } = await import('./ui-services.js');
    openServices();
    await vi.waitFor(() => expect(document.querySelectorAll('[data-svc-add]').length).toBeGreaterThan(10));
    const all = document.querySelectorAll('[data-svc-add]').length;
    type($('#svcSearch') as HTMLInputElement, 'pipelines');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-svc-add]').length).toBeLessThan(all));
    expect(document.querySelectorAll('[data-svc-add]').length).toBeGreaterThan(0);
    type($('#svcSearch') as HTMLInputElement, 'zzzz-nothing');
    await vi.waitFor(() => expect($('#svcCards').textContent).toContain('zzzz-nothing'));
    expect(document.querySelectorAll('[data-svc-add]').length).toBe(0);
  });

  it('adding a card calls addService with its libraryId and no warning', async () => {
    const { openServices } = await import('./ui-services.js');
    openServices();
    await vi.waitFor(() => expect(document.querySelector('[data-svc-add]')).toBeTruthy());
    const btn = document.querySelector<HTMLElement>('[data-svc-add]')!;
    btn.click();
    expect(view.addService).toHaveBeenCalledTimes(1);
    expect((view.addService.mock.calls[0][0] as LinkedService).libraryId).toBe(btn.dataset.svcAdd);
    expect(trust.approve).not.toHaveBeenCalled();
  });

  it('shows the refusal from addService inline', async () => {
    view.addService.mockReturnValueOnce('A view links at most 5 services.');
    const { openServices } = await import('./ui-services.js');
    openServices();
    await vi.waitFor(() => expect(document.querySelector('[data-svc-add]')).toBeTruthy());
    document.querySelector<HTMLElement>('[data-svc-add]')!.click();
    expect($('#svcError').textContent).toBe('A view links at most 5 services.');
    expect($('#svcError').hidden).toBe(false);
  });
});

describe('services dialog: library cards', () => {
  beforeEach(async () => { await setup(); });
  interface Lib { id: string; host: string; description: string; credit: string; licence: string; source: string }

  it('show title, category · publisher and Add; the rest waits in a closed Details', async () => {
    const LIB = (await import('../../src/registry/service-library.json')).default as unknown as Lib[];
    const { openServices } = await import('./ui-services.js');
    openServices();
    await vi.waitFor(() => expect(document.querySelector('[data-svc-add]')).toBeTruthy());
    const cardOf = (id: string) => $(`[data-svc-add="${id}"]`).closest('.svc-card-lib')!;
    const e = LIB[0];
    const card = cardOf(e.id);
    expect(card.querySelector('.svc-meta')!.textContent).toBe(`Energy · ${e.credit}`);
    const details = card.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Details');
    for (const f of [e.description, e.licence]) expect(details.textContent).toContain(f);
    expect(card.textContent!.replace(details.textContent!, '')).not.toContain(e.licence);

    const linked = LIB.find(x => x.source !== 'UNKNOWN');
    if (linked) {
      const a = cardOf(linked.id).querySelector<HTMLAnchorElement>('details a')!;
      expect(a.href).toBe(new URL(linked.source).href);
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
    const unknown = LIB.find(x => x.source === 'UNKNOWN');
    if (unknown) expect(cardOf(unknown.id).querySelector('a')).toBeNull();
  });

  it('sourceLink makes a new-tab link only for a credential-free https URL', async () => {
    const { sourceLink } = await import('./services-dom.js');
    const a = sourceLink('https://www.sciencebase.gov/catalog/item/abc', 'Source')!;
    expect(a.getAttribute('href')).toBe('https://www.sciencebase.gov/catalog/item/abc');
    expect(a.textContent).toBe('Source \u2197');
    for (const bad of ['UNKNOWN', 'http://example.org/', 'javascript:alert(1)', 'https://u:p@example.org/'])
      expect(sourceLink(bad, 'Source')).toBeNull();
  });
});

describe('services dialog: paste a URL', () => {
  beforeEach(async () => { await setup(); });
  const open = async () => {
    const { openServices } = await import('./ui-services.js');
    openServices('paste');
    return $('#svcUrl') as HTMLInputElement;
  };

  it('names the detected kind and host, or the refusal', async () => {
    const url = await open();
    type(url, VETTED_URL + '/0');
    expect($('#svcDetected').textContent).toContain('ArcGIS feature layer');
    expect($('#svcDetected').textContent).toContain('services2.arcgis.com');
    type(url, 'http://example.org/x.geojson');
    expect($('#svcDetected').textContent).toContain('https');
    expect($('#svcAddPasted').hidden).toBe(true);
  });

  it('a vetted URL adds with no warning', async () => {
    const url = await open();
    type(url, VETTED_URL + '/0');
    $('#svcDrawAs').closest('label')!.querySelector('select')!.value = 'line';
    $('#svcAddPasted').click();
    await flush();
    expect($('#svcWarn').hidden).toBe(true);
    expect(view.addService).toHaveBeenCalledTimes(1);
    expect(trust.approve).not.toHaveBeenCalled();
  });

  it('an unvetted URL warns first; only Add anyway approves and adds', async () => {
    const url = await open();
    type(url, 'https://example.org/data.geojson');
    ($('#svcDrawAs') as HTMLSelectElement).value = 'fill';
    $('#svcAddPasted').click();
    await flush();
    expect($('#svcWarn').hidden).toBe(false);
    expect($('#svcWarnText').textContent).toContain('example.org is not on the vetted list');
    expect(view.addService).not.toHaveBeenCalled();
    expect(trust.approve).not.toHaveBeenCalled();
    $('#svcWarnCancel').click();
    expect($('#svcWarn').hidden).toBe(true);
    expect(view.addService).not.toHaveBeenCalled();

    $('#svcAddPasted').click();
    $('#svcAddAnyway').click();
    await flush();
    expect(trust.approve).toHaveBeenCalledWith('https://example.org/data.geojson');
    expect(view.addService).toHaveBeenCalledTimes(1);
    const added = view.addService.mock.calls[0][0] as LinkedService;
    expect(added).toMatchObject({ kind: 'geojson', host: 'example.org', title: 'example.org', visible: true });
    expect(added.style.kind).toBe('fill');
  });

  it('List layers on an unvetted host fetches nothing until the visitor confirms', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"layers":[{"id":3,"name":"Three"}]}'));
    const url = await open();
    type(url, 'https://example.org/arcgis/rest/services/Foo/FeatureServer');
    $('#svcFindLayers').click();
    await flush();
    expect(fetched).not.toHaveBeenCalled();
    expect($('#svcWarn').hidden).toBe(false);
    expect(trust.approve).not.toHaveBeenCalled();
    $('#svcAddAnyway').click();
    await flush();
    expect(trust.approve).toHaveBeenCalledWith('https://example.org/arcgis/rest/services/Foo/FeatureServer');
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(String(fetched.mock.calls[0][0])).toContain('?f=json');
    expect($('#svcWarn').hidden).toBe(true);
    fetched.mockRestore();
  });

  it('List layers on a vetted host fetches directly', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"layers":[]}'));
    const url = await open();
    type(url, VETTED_URL);
    $('#svcFindLayers').click();
    await flush();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect($('#svcWarn').hidden).toBe(true);
    fetched.mockRestore();
  });

  it('a failed add leaves the URL unapproved', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const url = await open();
    type(url, VETTED_URL + '/0');
    $('#svcAddPasted').click();
    await flush();
    expect(view.addService).not.toHaveBeenCalled();
    expect(trust.approve).not.toHaveBeenCalled();
    expect(trust.approved.size).toBe(0);
    fetched.mockRestore();
  });

  it('a layered service needs a layer', async () => {
    const url = await open();
    type(url, VETTED_URL);
    $('#svcAddPasted').click();
    await flush();
    expect($('#svcError').textContent).not.toBe('');
    expect(view.addService).not.toHaveBeenCalled();
  });
});

describe('linked rows in My Data', () => {
  it('shows the unvetted badge from isVetted, and status as plain text', async () => {
    const state = await setup();
    const { id: vettedId } = { id: 'v1' };
    state.services = [
      svc(),
      svc({ id: vettedId, kind: 'arcgis-feature', url: VETTED_URL, host: 'services2.arcgis.com', layer: '0', title: 'Crude' }),
    ];
    const { renderLinkedServices } = await import('./ui-linked-services.js');
    renderLinkedServices();
    const rows = document.querySelectorAll('.svc-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.svc-badge')).toBeTruthy();
    expect(rows[1].querySelector('.svc-badge')).toBeNull();

    const { setServiceStatus } = await import('../services/service-load.js');
    setServiceStatus('a1', { state: 'error', message: '<img src=x onerror=alert(1)>' });
    const status = $('[data-svc-status="a1"]');
    expect(status.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(status.querySelector('img')).toBeNull();
  });

  it('toggle and remove commit through setServices', async () => {
    const state = await setup();
    state.services = [svc()];
    view.pendingServices.mockReturnValue([]);
    const { renderLinkedServices } = await import('./ui-linked-services.js');
    renderLinkedServices();
    $('[data-svc-act="toggle"]').click();
    expect((view.setServices.mock.calls[0][0] as LinkedService[])[0].visible).toBe(false);
    $('[data-svc-act="remove"]').click();
    expect(view.setServices.mock.calls[1][0]).toEqual([]);
  });

  it('a pending row and the card call Load and Skip', async () => {
    const state = await setup();
    const s = svc();
    state.services = [s];
    view.pendingServices.mockReturnValue([s]);
    const { renderLinkedServices } = await import('./ui-linked-services.js');
    renderLinkedServices();
    expect(document.querySelector('[data-svc-act="toggle"]')).toBeNull();
    expect($('#servicesCard').textContent).toContain('example.org');
    $('.svc-row [data-svc-act="load"]').click();
    expect(view.approveAndLoad).toHaveBeenCalledWith(s.url);
    $('.svc-row [data-svc-act="skip"]').click();
    expect(view.skipService).toHaveBeenCalledWith('a1');
    $('#servicesCard [data-card-act="skip"]').click();
    expect(view.skipService).toHaveBeenCalledTimes(2);
    view.pendingServices.mockReturnValue([]);
  });
});
