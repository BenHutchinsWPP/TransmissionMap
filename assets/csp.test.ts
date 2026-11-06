// The production Content Security Policy (constants.ts CSP_HOSTS / CSP_POLICY,
// rendered into dist/index.html by vite.config.js): its hosts are exactly the
// fetched hosts docs/network-allowlist.md tables for IT, the policy carries
// only what a <meta> can enforce, and its https: source (services a visitor adds)
// widens fetches and images only — never scripts, eval or plain http.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

// The page's own hosts: 'self' in the policy, rows in the allowlist.
const PAGE_HOSTS = new Set(['www.wpptx.org', 'benhutchinswpp.github.io']);

// Hosts in the first column of the Required and Optional tables.
function allowlistHosts(): string[] {
  const doc = readFileSync('docs/network-allowlist.md', 'utf8');
  const tables = doc.slice(doc.indexOf('## Required'), doc.indexOf('## Click-through'));
  return [...tables.matchAll(/^\| `([a-z0-9.-]+)` \|/gm)].map(m => m[1]);
}

async function constantsWith(esriKey: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_ESRI_API_KEY', esriKey);
  return import('./constants.js');
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('CSP hosts', () => {
  it('match the allowlist tables (a keyed build, as deployed)', async () => {
    const { CSP_HOSTS } = await constantsWith('test-key');
    const hosts = CSP_HOSTS.map(o => new URL(o).hostname).sort();
    const doc = allowlistHosts().filter(h => !PAGE_HOSTS.has(h)).sort();
    expect(hosts).toEqual(doc);
  });

  it('are bare https origins, no wildcard', async () => {
    const { CSP_HOSTS } = await constantsWith('test-key');
    for (const h of CSP_HOSTS) expect(h).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });

  it('follow the aerial constant: a keyless build lists the keyless fallback the doc names', async () => {
    const { CSP_HOSTS } = await constantsWith('');
    expect(CSP_HOSTS).toContain('https://server.arcgisonline.com');
    expect(CSP_HOSTS).not.toContain('https://ibasemaps-api.arcgis.com');
    expect(readFileSync('docs/network-allowlist.md', 'utf8')).toContain('server.arcgisonline.com');
  });
});

describe('CSP policy', () => {
  const directives = async () => {
    const { CSP_POLICY } = await constantsWith('test-key');
    return new Map(CSP_POLICY.split('; ').map(d => {
      const [name, ...values] = d.split(' ');
      return [name, values] as const;
    }));
  };

  it('has no directive a <meta> policy ignores', async () => {
    const d = await directives();
    for (const name of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) expect(d.has(name)).toBe(false);
  });

  it('keeps scripts to the page itself: no inline, no eval', async () => {
    const d = await directives();
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
  });

  it('grants the blob: workers and images and the data: placeholder the bundle makes', async () => {
    const d = await directives();
    expect(d.get('worker-src')).toEqual(["'self'", 'blob:']);
    expect(d.get('img-src')).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
  });

  it('lets every https host connect and serve images, and still names the hosts the app reads', async () => {
    const { CSP_HOSTS, OPENROUTER_ORIGIN } = await constantsWith('test-key');
    const d = await directives();
    expect(d.get('connect-src')).toEqual(["'self'", 'data:', 'https:', ...CSP_HOSTS]);
    expect(d.get('img-src')).toEqual(["'self'", 'data:', 'blob:', 'https:', ...CSP_HOSTS.filter(h => h !== OPENROUTER_ORIGIN)]);
  });

  it('frames only the page itself', async () => {
    const d = await directives();
    expect(d.get('frame-src')).toEqual(["'self'"]);
  });

  it('never admits eval or plain http', async () => {
    const { CSP_POLICY } = await constantsWith('test-key');
    expect(CSP_POLICY).not.toContain("'unsafe-eval'");
    for (const values of (await directives()).values()) {
      for (const v of values) expect(v).not.toMatch(/^http:/);
    }
  });
});
