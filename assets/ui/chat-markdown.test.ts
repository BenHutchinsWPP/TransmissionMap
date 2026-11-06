// @vitest-environment jsdom
// renderMarkdown builds DOM from a model's text with no HTML parsing: each
// construct maps to its element, and markup, javascript: links and other
// schemes stay literal text.
// Deps: chat-markdown.js.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './chat-markdown.js';

const html = (md: string) => { const d = document.createElement('div'); d.append(renderMarkdown(md)); return d; };

describe('renderMarkdown', () => {
  it('makes paragraphs and line breaks', () => {
    expect(html('one\ntwo\n\nthree').innerHTML).toBe('<p>one<br>two</p><p>three</p>');
  });
  it('renders headings as bold blocks', () => {
    expect(html('## Title **x**').querySelector('.chat-md-h > strong')!.textContent).toBe('Title x');
  });
  it('renders bold, italic and inline code', () => {
    const d = html('**b** *i* _j_ `c <b>`');
    expect(d.querySelector('strong')!.textContent).toBe('b');
    expect([...d.querySelectorAll('em')].map(e => e.textContent)).toEqual(['i', 'j']);
    expect(d.querySelector('code')!.textContent).toBe('c <b>');
    expect(d.querySelector('b')).toBeNull();
  });
  it('keeps snake_case literal', () => {
    const d = html('a_b_c');
    expect(d.textContent).toBe('a_b_c');
    expect(d.querySelector('em')).toBeNull();
  });
  it('renders fenced code blocks verbatim', () => {
    const d = html('before\n```js\n**x**\n\n<i>y</i>\n```\nafter');
    expect(d.querySelector('pre > code')!.textContent).toBe('**x**\n\n<i>y</i>');
    expect(d.querySelector('pre strong')).toBeNull();
    expect(d.querySelectorAll('p').length).toBe(2);
  });
  it('renders bullet, numbered and nested lists', () => {
    const d = html('- a\n- b\n  - c\n  - d\n- e\n\n1. x\n2. y');
    const ul = d.querySelector('ul')!;
    expect(ul.children.length).toBe(3);
    expect(ul.children[1].querySelectorAll('ul > li').length).toBe(2);
    expect(d.querySelector('ol')!.children.length).toBe(2);
  });
  it('links https URLs only', () => {
    const a = html('[site](https://example.com/a?b=1)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
    for (const u of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', '//evil.com']) {
      const d = html(`[x](${u})`);
      expect(d.querySelector('a')).toBeNull();
      expect(d.textContent).toBe(`[x](${u})`);
    }
  });
  it('leaves hostile markup as text', () => {
    const d = html('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n- <img src=x onerror=1>');
    expect(d.querySelector('script, img')).toBeNull();
    expect(d.textContent).toContain('<script>alert(1)</script>');
    expect(d.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(d.querySelectorAll('[onerror]').length).toBe(0);
  });
});
