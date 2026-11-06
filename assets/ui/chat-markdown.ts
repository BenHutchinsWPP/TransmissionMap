// ─── Chat markdown: a model's reply as DOM nodes (chat chunk) ────────────────
// Role: renderMarkdown(text) → a DocumentFragment of paragraphs, line breaks,
//       headings (# to ###, shown as bold blocks), **bold**, *italic* / _italic_,
//       `code`, fenced code blocks, bullet and numbered lists (one nested level)
//       and [text](https://…) links (https only, rel noopener noreferrer, new tab).
//       Everything is built with createElement and textContent; the model's text
//       is never parsed as HTML, and anything not recognised stays literal text.
// Deps: none (pure; needs a DOM `document`). Used by ui-chat.ts for bot messages
//       (live and restored); eslint holds it to the chat's text-only rule.

const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s()]+)\)|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/g;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function httpsUrl(s: string): string | null {
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}

function inline(parent: ParentNode, text: string): void {
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index!;
    if (i > at) parent.append(text.slice(at, i));
    at = i + m[0].length;
    if (m[1] !== undefined) {
      const c = document.createElement('code');
      c.textContent = m[1];
      parent.append(c);
    } else if (m[2] !== undefined) {
      const href = httpsUrl(m[3]);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(a, m[2]);
        parent.append(a);
      } else parent.append(m[0]);
    } else {
      const e = document.createElement(m[4] !== undefined ? 'strong' : 'em');
      inline(e, m[4] ?? m[5] ?? m[6]);
      parent.append(e);
    }
  }
  if (at < text.length) parent.append(text.slice(at));
}

export function renderMarkdown(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      const pre = document.createElement('pre');
      const c = document.createElement('code');
      c.textContent = code.join('\n');
      pre.append(c);
      out.append(pre);
      continue;
    }
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) {
      const d = document.createElement('div');
      d.className = 'chat-md-h';
      const s = document.createElement('strong');
      inline(s, h[1]);
      d.append(s);
      out.append(d);
      i++;
      continue;
    }
    if (ITEM.test(line)) {
      let top = null as HTMLElement | null;
      let sub = null as HTMLElement | null;
      let last = null as HTMLElement | null;
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (!m) break;
        const tag = /\d/.test(m[2][0]) ? 'ol' : 'ul';
        const nested = m[1].length >= 2 && last !== null;
        let list: HTMLElement | null = nested ? sub : top;
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          if (nested) { last!.append(list); sub = list; } else { out.append(list); top = list; sub = null; }
        }
        const li = document.createElement('li');
        inline(li, m[3]);
        list.append(li);
        if (!nested) { last = li; sub = null; }
      }
      continue;
    }
    const p = document.createElement('p');
    for (let first = true; i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s)/.test(lines[i]) && !ITEM.test(lines[i]); i++, first = false) {
      if (!first) p.append(document.createElement('br'));
      inline(p, lines[i]);
    }
    out.append(p);
  }
  return out;
}
