// @vitest-environment jsdom
// My Data's linked-service rows load when the view holds a service and follow
// every url:write, so a chat or console add shows its row at once.
import { describe, it, expect, vi } from 'vitest';

const rows = vi.hoisted(() => ({ renderLinkedServices: vi.fn() }));
vi.mock('./ui-linked-services.js', () => rows);

describe('wireMyData: linked service rows', () => {
  it('re-renders on url:write once a service is in the view', async () => {
    const { state } = await import('../state.js');
    const { emit } = await import('../state-bus.js');
    const { wireMyData } = await import('./ui-mydata.js');
    state.services = [];
    wireMyData();
    emit('url:write');
    await new Promise(r => setTimeout(r, 0));
    expect(rows.renderLinkedServices).not.toHaveBeenCalled();
    state.services = [{ id: 'a1' } as never];
    emit('url:write');
    await vi.waitFor(() => expect(rows.renderLinkedServices).toHaveBeenCalledTimes(1));
  });
});
