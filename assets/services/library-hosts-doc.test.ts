// The pure renderer behind scripts/check_service_library.mjs: the docs/library-hosts.md it writes
// keeps the table and the whole-host vetted list derived from service-hosts.json.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import HOSTS from '../../src/registry/service-hosts.json';
import LIBRARY from '../../src/registry/service-library.json';
import { renderLibraryHosts } from '../../scripts/library_hosts_doc.mjs';

const render = (hosts: string[], results = LIBRARY.map(() => ({ ok: true, note: '' }))) =>
  renderLibraryHosts({ lib: LIBRARY, results, hosts, today: '2026-01-01', origin: 'https://example.org' }) as string;

describe('renderLibraryHosts', () => {
  it('reproduces the committed whole-host section', () => {
    const doc = readFileSync(new URL('../../docs/library-hosts.md', import.meta.url), 'utf8');
    const section = (s: string) => s.slice(s.indexOf('## Whole-host vetted hosts'));
    expect(section(render(HOSTS))).toBe(section(doc));
  });

  it('lists only entries without a path prefix, sorted', () => {
    const out = render(['b.example', 'a.example', 'c.example/org/1', 'd.example/']);
    expect(out).toContain('a.example, b.example.\n');
    expect(out).not.toContain('c.example');
  });

  it('marks a failing entry on its host row', () => {
    const results = LIBRARY.map((_, i) => ({ ok: i !== 0, note: 'HTTP 500' }));
    expect(render(HOSTS, results)).toContain(`FAIL — ${LIBRARY[0].id}: HTTP 500`);
  });
});
