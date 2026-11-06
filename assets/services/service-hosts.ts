// assets/services/service-hosts.ts — is a service URL from a vetted source?
// `isVetted(url)` reads src/registry/service-hosts.json, a JSON array of strings:
//   "host.example.gov"                       — every service on that exact host
//   "host.example.com/path/to/prefix"        — only paths under that prefix
// Hosts match exactly (lower-case, as `new URL` parses them; no suffix or
// substring match). A prefix matches the normalised path case-insensitively at a
// segment boundary (`/abc` covers `/abc` and `/abc/…`, not `/abcd`). On shared
// hosts (services*.arcgis.com) an entry names one service root, or the org
// prefix of an org that is the agency itself. A URL with a user name/password,
// a port, a tab or line break anywhere, or a percent-encoded `.`, `/` or `\` in
// its path (as typed or as parsed), is never vetted; nor is one normaliseServiceUrl refuses.
// The list is provenance and UX (no warning on add), not a security boundary.
// Deps: service-spec.ts (normaliseServiceUrl), service-hosts.json; pure.
import VETTED from '../../src/registry/service-hosts.json';
import { normaliseServiceUrl, type ServiceKind } from './service-spec.js';

const ENTRIES = (VETTED as string[]).map(e => {
  const i = e.indexOf('/');
  return i < 0
    ? { host: e.toLowerCase(), prefix: '' }
    : { host: e.slice(0, i).toLowerCase(), prefix: e.slice(i).replace(/\/+$/, '').toLowerCase() };
});

/** `kind` is the caller's hint, as for parseServiceUrl (a library entry knows its kind). */
export function isVetted(url: string, kind?: ServiceKind): boolean {
  if (typeof url !== 'string' || /[\t\n\r]/.test(url)) return false;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return false;
  if (/%2e|%2f|%5c/i.test(u.pathname) || /%2e|%2f|%5c/i.test(url.trim().split(/[?#]/)[0])) return false;
  const n = normaliseServiceUrl(url, kind);
  if (!n.ok) return false;
  const norm = new URL(n.result.url);
  const host = norm.hostname.toLowerCase();
  const path = norm.pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}').toLowerCase();
  return ENTRIES.some(e => e.host === host
    && (e.prefix === '' || path === e.prefix || path.startsWith(e.prefix + '/')));
}
