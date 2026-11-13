// columns-worker.ts's handleDecode (the pure half, called directly): a reply carries the codes
// buffer in the transfer list, equals decodeColumn's, and a corrupt chunk answers {ok: false}
// with nothing of the input in it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parquetMetadata } from 'hyparquet';
import { decodeColumn, groupRange } from './columns-decode.js';
import { handleDecode } from './columns-worker.js';

const b = readFileSync(fileURLToPath(new URL('./fixtures/decode/multipage.parquet', import.meta.url)));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const md = parquetMetadata(ab);

function msg(column: string, mutate?: (u: Uint8Array) => void) {
  const { start, end } = groupRange(md, 1, [column]);
  const bytes = ab.slice(start, end);
  mutate?.(new Uint8Array(bytes));
  return { id: 7, schema: md.schema, rowGroup: md.row_groups[1], column, bytes, start };
}

describe('handleDecode', () => {
  it('posts the column with the codes buffer transferred', async () => {
    const posts: { m: Record<string, unknown>; t?: ArrayBuffer[] }[] = [];
    const m = msg('name');
    await handleDecode(m, (x, t) => posts.push({ m: x as Record<string, unknown>, t }));
    expect(posts).toHaveLength(1);
    const { m: reply, t } = posts[0];
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(true);
    const col = reply.col as Awaited<ReturnType<typeof decodeColumn>>;
    expect(t).toEqual([col.codes.buffer]);
    expect(t).not.toContain(m.bytes);
    expect(col).toEqual(await decodeColumn(m));
  });

  it('answers {ok: false} and nothing else on a corrupt chunk', async () => {
    const posts: unknown[] = [];
    await handleDecode(msg('name', u => u.fill(0xff)), m => posts.push(m));
    expect(posts).toEqual([{ id: 7, ok: false }]);
  });

  it('answers {ok: false} for bytes that do not cover the chunk', async () => {
    const posts: unknown[] = [];
    const m = msg('name');
    await handleDecode({ ...m, bytes: m.bytes.slice(0, 10) }, x => posts.push(x));
    expect(posts).toEqual([{ id: 7, ok: false }]);
  });
});
