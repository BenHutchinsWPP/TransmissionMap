// Pure rendering of docs/library-hosts.md for check_service_library.mjs (no network, no file access).
// `results[i]` is { ok, note } for `lib[i]`; `hosts` is src/registry/service-hosts.json (entries with a
// path are exact service roots or org prefixes, the rest vet a whole host).

const WRAP = 110;

function wrap(items) {
  const lines = [];
  let line = '';
  items.forEach((h, i) => {
    const word = h + (i === items.length - 1 ? '.' : ',');
    if (line && line.length + 1 + word.length > WRAP) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  });
  if (line) lines.push(line);
  return lines.join('\n');
}

export function renderLibraryHosts({ lib, results, hosts, today, origin }) {
  const byHost = new Map();
  lib.forEach((e, i) => {
    const h = byHost.get(e.host) ?? { entries: [], bad: [] };
    h.entries.push(e.id);
    if (!results[i].ok) h.bad.push(`${e.id}: ${results[i].note}`);
    byHost.set(e.host, h);
  });
  const rows = [...byHost].sort(([a], [b]) => a.localeCompare(b)).map(([host, h]) =>
    `| ${host} | ${h.entries.join(', ')} | ${today} | ${h.bad.length ? 'FAIL — ' + h.bad.join('; ') : 'ok'} |`);
  const whole = hosts.filter(h => !h.includes('/')).sort((a, b) => a.localeCompare(b));
  return `# Service library hosts

Written by \`node scripts/check_service_library.mjs\`: each library entry is re-probed (layer metadata, a map
export, a capabilities document, a tile or a GeoJSON head, by kind) with \`Origin: ${origin}\`, and the
response must allow that origin (CORS).

| Host | Entries | Last checked | Status |
|---|---|---|---|
${rows.join('\n')}

## Whole-host vetted hosts

These entries in \`src/registry/service-hosts.json\` vet every service on the host, not only the library
entries above (the other entries name a path prefix or an exact service root):

${wrap(whole)}
`;
}
