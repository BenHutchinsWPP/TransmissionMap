import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../diag-log.js', () => ({ recordDiagEvent: vi.fn() }));

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  posted: { id: number }[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.all.push(this); }
  postMessage(m: { id: number }) { this.posted.push(m); }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

const req = { from: [0, 0], to: [1, 1], preset: 'tm-default', lineType: 'ac500' } as never;

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  vi.resetModules();
});

async function load() {
  const open = await import('./route-open.js');
  const diag = await import('../diag-log.js');
  vi.mocked(diag.recordDiagEvent).mockClear();
  return { ...open, recordDiagEvent: diag.recordDiagEvent };
}

describe('routeLine / cancelRoute', () => {
  it('forwards progress without resolving, then resolves on the outcome', async () => {
    const { routeLine } = await load();
    const steps: string[] = [];
    let done = false;
    const p = routeLine(req, (s) => steps.push(s)).then((o) => { done = true; return o; });
    const w = FakeWorker.all[0];
    const id = w.posted[0].id;
    w.emit({ id, progress: 'read' });
    w.emit({ id, progress: 'solve' });
    await Promise.resolve();
    expect(steps).toEqual(['read', 'solve']);
    expect(done).toBe(false);
    w.emit({ id, outcome: { ok: false, reason: 'x' } });
    expect(await p).toEqual({ ok: false, reason: 'x' });
  });

  it('cancels a pending call without recording a fault', async () => {
    const { routeLine, cancelRoute, recordDiagEvent } = await load();
    const p = routeLine(req);
    expect(cancelRoute()).toBe(true);
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(FakeWorker.all[0].terminate).toHaveBeenCalledOnce();
    expect(recordDiagEvent).not.toHaveBeenCalled();
    void routeLine(req);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('with nothing pending returns false and keeps the worker', async () => {
    const { routeLine, cancelRoute } = await load();
    const p = routeLine(req);
    const w = FakeWorker.all[0];
    w.emit({ id: w.posted[0].id, outcome: { ok: false, reason: 'x' } });
    await p;
    expect(cancelRoute()).toBe(false);
    expect(w.terminate).not.toHaveBeenCalled();
  });
});

describe('inspectCell', () => {
  const ireq = { lngLat: [-116, 43], preset: 'tm-default', lineType: 'ac500' } as never;

  it('posts an inspect message and resolves with its outcome', async () => {
    const { inspectCell } = await load();
    const p = inspectCell(ireq);
    const w = FakeWorker.all[0];
    const m = w.posted[0] as unknown as { id: number; inspect: unknown; req?: unknown; baseUrl: string };
    expect(m.inspect).toBe(ireq);
    expect(m.req).toBeUndefined();
    expect(m.baseUrl).toBe('http://localhost/data/route/250m/');
    w.emit({ id: m.id, outcome: { ok: true, result: { cell: [1, 2] } } });
    expect(await p).toEqual({ ok: true, result: { cell: [1, 2] } });
  });

  it('refuses after 10 s without failing the worker, and is not a solve for cancelRoute', async () => {
    vi.useFakeTimers();
    try {
      const { inspectCell, cancelRoute, recordDiagEvent } = await load();
      const p = inspectCell(ireq);
      expect(cancelRoute()).toBe(false);      // nothing but an inspect pending: the worker stays
      vi.advanceTimersByTime(10_001);
      expect(await p).toEqual({ ok: false, reason: 'no answer in 10 s' });
      expect(FakeWorker.all[0].terminate).not.toHaveBeenCalled();
      expect(recordDiagEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cancelled solve also refuses the pending inspects', async () => {
    const { routeLine, inspectCell, cancelRoute } = await load();
    const r = routeLine(req);
    const i = inspectCell(ireq);
    expect(cancelRoute()).toBe(true);
    expect(await r).toEqual({ ok: false, reason: 'cancelled' });
    expect(await i).toEqual({ ok: false, reason: 'cancelled' });
  });
});

describe('repaintWeight / dropWindow', () => {
  const rreq = { preset: 'tm-default', lineType: 'ac500', mode: 'cost' } as never;

  it('posts a repaint message and resolves with its outcome', async () => {
    const { repaintWeight } = await load();
    const p = repaintWeight(rreq);
    const w = FakeWorker.all[0];
    const m = w.posted[0] as unknown as { id: number; repaint: unknown; req?: unknown; inspect?: unknown; baseUrl: string };
    expect(m.repaint).toBe(rreq);
    expect(m.req).toBeUndefined();
    expect(m.inspect).toBeUndefined();
    w.emit({ id: m.id, outcome: { ok: false, reason: 'no cached window' } });
    expect(await p).toEqual({ ok: false, reason: 'no cached window' });
  });

  it('is not a solve for cancelRoute, and times out without failing the worker', async () => {
    vi.useFakeTimers();
    try {
      const { repaintWeight, cancelRoute } = await load();
      const p = repaintWeight(rreq);
      expect(cancelRoute()).toBe(false);
      vi.advanceTimersByTime(10_001);
      expect(await p).toEqual({ ok: false, reason: 'no answer in 10 s' });
      expect(FakeWorker.all[0].terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dropWindow posts {drop} to a running worker and starts none', async () => {
    const { dropWindow, repaintWeight } = await load();
    dropWindow();
    expect(FakeWorker.all).toHaveLength(0);
    void repaintWeight(rreq);
    dropWindow();
    expect(FakeWorker.all[0].posted[1]).toMatchObject({ drop: true });
  });
});

describe('exactCrossings', () => {
  const xreq = { polylines: [[[0, 0], [1000, 0]]], lengthsMi: [0.62] } as never;

  it('posts a crossings message, resolves with its outcome, and refuses after 40 s without failing the worker', async () => {
    vi.useFakeTimers();
    try {
      const { exactCrossings, cancelRoute } = await load();
      const p = exactCrossings(xreq);
      const w = FakeWorker.all[0];
      const m = w.posted[0] as unknown as { id: number; crossings: unknown; req?: unknown; baseUrl: string };
      expect(m.crossings).toBe(xreq);
      expect(m.req).toBeUndefined();
      expect(m.baseUrl).toBe('http://localhost/data/route/250m/');
      w.emit({ id: m.id, outcome: { ok: true, result: { routes: [], exact: [] } } });
      expect(await p).toEqual({ ok: true, result: { routes: [], exact: [] } });
      const late = exactCrossings(xreq);
      expect(cancelRoute()).toBe(false);
      vi.advanceTimersByTime(40_001);
      expect(await late).toEqual({ ok: false, reason: 'no answer in 40 s' });
      expect(w.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('repaintRows', () => {
  const rreq = { from: [0, 0], to: [1, 1], lineType: 'ac500', preset: 'tm-default', rows: [] } as never;

  it('posts a repaintRows message and resolves with its outcome', async () => {
    const { repaintRows } = await load();
    const p = repaintRows(rreq);
    const w = FakeWorker.all[0];
    const m = w.posted[0] as unknown as { id: number; repaintRows: unknown; repaint?: unknown; req?: unknown; baseUrl: string };
    expect(m.repaintRows).toBe(rreq);
    expect(m.repaint).toBeUndefined();
    expect(m.req).toBeUndefined();
    w.emit({ id: m.id, outcome: { ok: false, reason: 'no cached window' } });
    expect(await p).toEqual({ ok: false, reason: 'no cached window' });
  });

  it('times out without failing the worker, and is not a solve', async () => {
    vi.useFakeTimers();
    try {
      const { repaintRows, cancelRoute } = await load();
      const p = repaintRows(rreq);
      expect(cancelRoute()).toBe(false);
      vi.advanceTimersByTime(10_001);
      expect(await p).toEqual({ ok: false, reason: 'no answer in 10 s' });
      expect(FakeWorker.all[0].terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uploaded layers (registry)', () => {
  const g1 = [[[[-116, 43], [-115.9, 43], [-115.9, 43.1], [-116, 43]]]];
  const g2 = [[[[-117, 43], [-116.9, 43], [-116.9, 43.1], [-117, 43]]]];
  type Msg = { id?: number; upload?: { hash: string; geometry: unknown }; unupload?: string; req?: unknown };

  it('cancel → re-solve: the new worker gets every registered upload first, in registration order', async () => {
    const { registerUpload, routeLine, cancelRoute } = await load();
    registerUpload('aaaaaaaaaaaaaaaa', g1 as never);
    void routeLine(req);
    registerUpload('bbbbbbbbbbbbbbbb', g2 as never);
    const w1 = FakeWorker.all[0];
    expect((w1.posted as Msg[]).map((m) => m.upload?.hash ?? (m.req ? 'req' : '?'))).toEqual(['aaaaaaaaaaaaaaaa', 'req', 'bbbbbbbbbbbbbbbb']);
    expect(cancelRoute()).toBe(true);
    const second = routeLine({ ...(req as object), uploads: ['aaaaaaaaaaaaaaaa'] } as never);
    const w2 = FakeWorker.all[1];
    expect(w2).toBeDefined();
    const posted = w2.posted as Msg[];
    expect(posted[0]).toEqual({ upload: { hash: 'aaaaaaaaaaaaaaaa', geometry: g1 } });
    expect(posted[1]).toEqual({ upload: { hash: 'bbbbbbbbbbbbbbbb', geometry: g2 } });
    expect(posted[2].req).toMatchObject({ uploads: ['aaaaaaaaaaaaaaaa'] });
    expect(posted).toHaveLength(3);
    w2.emit({ id: posted[2].id, outcome: { ok: false, reason: 'x' } });
    expect(await second).toEqual({ ok: false, reason: 'x' });
  });

  it('a failed worker\'s successor and a side call\'s new worker get them too; unregister stops it', async () => {
    const { registerUpload, unregisterUpload, routeLine, inspectCell } = await load();
    registerUpload('aaaaaaaaaaaaaaaa', g1 as never);
    registerUpload('aaaaaaaaaaaaaaaa', g2 as never);   // a second register of one hash keeps the first
    void inspectCell({ lngLat: [-116, 43], preset: 'tm-default', lineType: 'ac500' } as never);
    const w1 = FakeWorker.all[0];
    expect((w1.posted as Msg[])[0]).toEqual({ upload: { hash: 'aaaaaaaaaaaaaaaa', geometry: g1 } });
    (w1.onerror as (e: { message: string }) => void)({ message: 'boom' });
    void routeLine(req);
    expect((FakeWorker.all[1].posted as Msg[])[0]).toEqual({ upload: { hash: 'aaaaaaaaaaaaaaaa', geometry: g1 } });
    unregisterUpload('aaaaaaaaaaaaaaaa');
    expect((FakeWorker.all[1].posted as Msg[]).at(-1)).toEqual({ unupload: 'aaaaaaaaaaaaaaaa' });
    (FakeWorker.all[1].onerror as (e: { message: string }) => void)({ message: 'boom' });
    void routeLine(req);
    const w3 = FakeWorker.all[2].posted as Msg[];
    expect(w3).toHaveLength(1);
    expect(w3[0].upload).toBeUndefined();
    expect(w3[0].req).toBeDefined();
  });

  it('register / unregister start no worker', async () => {
    const { registerUpload, unregisterUpload } = await load();
    registerUpload('aaaaaaaaaaaaaaaa', g1 as never);
    unregisterUpload('aaaaaaaaaaaaaaaa');
    unregisterUpload('aaaaaaaaaaaaaaaa');
    expect(FakeWorker.all).toHaveLength(0);
  });
});

describe('solver lock', () => {
  type Msg = { id?: number; upload?: { hash: string; geometry: unknown }; req?: unknown; drop?: boolean };
  const g1 = [[[[-116, 43], [-115.9, 43], [-115.9, 43.1], [-116, 43]]]];
  const answer = (w: FakeWorker) => { const m = (w.posted as Msg[]).at(-1)!; w.emit({ id: m.id, outcome: { ok: false, reason: 'x' } }); };

  it('while the batch holds the lock, every panel call is busy and a panel cancel cannot stop the batch', async () => {
    const o = await load();
    expect(o.acquireRoute('batch')).toBe(true);
    const batchSolve = o.routeLine(req, undefined, 'batch');
    expect(await o.routeLine(req)).toEqual({ ok: false, reason: 'busy' });
    expect(await o.inspectCell({} as never)).toEqual({ ok: false, reason: 'busy' });
    expect(await o.repaintWeight({} as never)).toEqual({ ok: false, reason: 'busy' });
    expect(await o.repaintRows({} as never)).toEqual({ ok: false, reason: 'busy' });
    expect(await o.exactCrossings({} as never)).toEqual({ ok: false, reason: 'busy' });
    o.dropWindow();
    expect(o.cancelRoute()).toBe(false);
    expect(o.recycleWorker()).toBe(false);
    const w = FakeWorker.all[0];
    expect(FakeWorker.all).toHaveLength(1);
    expect(w.posted).toHaveLength(1);            // only the batch's request: no panel message reached the worker
    expect(w.terminate).not.toHaveBeenCalled();
    expect(o.acquireRoute('panel')).toBe(false);
    answer(w);
    expect(await batchSolve).toEqual({ ok: false, reason: 'x' });
    o.releaseRoute('panel');                      // a non-holder's release changes nothing
    expect(await o.routeLine(req)).toEqual({ ok: false, reason: 'busy' });
    o.releaseRoute('batch');
    const p = o.routeLine(req);
    answer(w);
    expect(await p).toEqual({ ok: false, reason: 'x' });
  });

  it('a second acquire is refused, even for the same token, and the first release frees it', async () => {
    const o = await load();
    expect(o.acquireRoute('batch')).toBe(true);
    expect(o.acquireRoute('batch')).toBe(false);
    expect(o.acquireRoute('panel')).toBe(false);
    o.releaseRoute('batch');
    expect(o.acquireRoute('batch')).toBe(true);
  });

  it('unregisterUpload under a batch waits for the release; a recycle still re-posts it; a re-register cancels it', async () => {
    const o = await load();
    o.registerUpload('aaaaaaaaaaaaaaaa', g1 as never);
    o.registerUpload('bbbbbbbbbbbbbbbb', g1 as never);
    expect(o.acquireRoute('batch')).toBe(true);
    const first = o.routeLine(req, undefined, 'batch');
    const w1 = FakeWorker.all[0];
    o.unregisterUpload('aaaaaaaaaaaaaaaa');
    o.unregisterUpload('bbbbbbbbbbbbbbbb');
    o.registerUpload('bbbbbbbbbbbbbbbb', g1 as never);
    expect(o.hasUpload('aaaaaaaaaaaaaaaa')).toBe(true);
    expect((w1.posted as { unupload?: string }[]).some((m) => m.unupload)).toBe(false);
    answer(w1);
    await first;
    expect(o.recycleWorker('batch')).toBe(true);
    void o.routeLine(req, undefined, 'batch');
    const w2 = FakeWorker.all[1];
    expect((w2.posted as Msg[]).slice(0, 2).map((m) => m.upload?.hash)).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    o.releaseRoute('batch');
    expect(o.hasUpload('aaaaaaaaaaaaaaaa')).toBe(false);
    expect(o.hasUpload('bbbbbbbbbbbbbbbb')).toBe(true);
    expect((w2.posted as { unupload?: string }[]).filter((m) => m.unupload)).toEqual([{ unupload: 'aaaaaaaaaaaaaaaa' }]);
    w2.emit({ id: (w2.posted as Msg[]).find((m) => m.req)!.id, outcome: { ok: false, reason: 'x' } });
    expect(o.recycleWorker()).toBe(true);
    void o.routeLine(req);
    expect((FakeWorker.all[2].posted as Msg[]).filter((m) => m.upload).map((m) => m.upload!.hash)).toEqual(['bbbbbbbbbbbbbbbb']);
  });

  it('a batch cancel without the lock is refused and the panel solve runs on', async () => {
    const o = await load();
    const panel = o.routeLine(req);
    expect(o.cancelRoute('batch')).toBe(false);
    expect(o.acquireRoute('batch')).toBe(false);  // a panel solve is pending
    expect(await o.routeLine(req, undefined, 'batch')).toEqual({ ok: false, reason: 'busy' });
    expect(FakeWorker.all[0].terminate).not.toHaveBeenCalled();
    answer(FakeWorker.all[0]);
    expect(await panel).toEqual({ ok: false, reason: 'x' });
    expect(o.acquireRoute('batch')).toBe(true);
    const b = o.routeLine(req, undefined, 'batch');
    expect(o.cancelRoute('batch')).toBe(true);
    expect(await b).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('the 25-row recycle: the next worker gets the registered upload as its first message', async () => {
    const o = await load();
    o.registerUpload('aaaaaaaaaaaaaaaa', g1 as never);
    expect(o.acquireRoute('batch')).toBe(true);
    const first = o.routeLine(req, undefined, 'batch');
    const w1 = FakeWorker.all[0];
    expect(o.recycleWorker('batch')).toBe(false);  // a solve is pending
    answer(w1);
    await first;
    expect(o.recycleWorker('batch')).toBe(true);
    expect(w1.terminate).toHaveBeenCalledOnce();
    void o.routeLine({ ...(req as object), uploads: ['aaaaaaaaaaaaaaaa'] } as never, undefined, 'batch');
    const w2 = FakeWorker.all[1];
    expect(w2).toBeDefined();
    const posted = w2.posted as Msg[];
    expect(posted[0]).toEqual({ upload: { hash: 'aaaaaaaaaaaaaaaa', geometry: g1 } });
    expect(posted[1].req).toMatchObject({ uploads: ['aaaaaaaaaaaaaaaa'] });
  });
});
