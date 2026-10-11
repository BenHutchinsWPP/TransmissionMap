#!/usr/bin/env python3
"""Print per-zoom tile counts and byte totals for a PMTiles archive.

Reads only the header + directories (no tile payloads), so it is cheap even on
multi-hundred-MB archives. Used to size the global builds and pick per-layer
minzoom cutoffs. `entries()` — the directory walk — is shared with
region_report.py, which reads per-tile sizes from it.

    python3 scripts/pmtiles_stats.py data/layers/osm_substations_points.pmtiles
"""
import collections
import gzip
import struct
import sys
from pathlib import Path


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if not c & 0x80:
            return r, i
        s += 7


def _parse_dir(b):
    n, i = _varint(b, 0)
    ids = [0] * n
    last = 0
    for k in range(n):
        d, i = _varint(b, i)
        last += d
        ids[k] = last
    runs = [0] * n
    for k in range(n):
        runs[k], i = _varint(b, i)
    lens = [0] * n
    for k in range(n):
        lens[k], i = _varint(b, i)
    offs = [0] * n
    for k in range(n):
        v, i = _varint(b, i)
        offs[k] = (offs[k - 1] + lens[k - 1]) if v == 0 and k > 0 else v - 1
    return list(zip(ids, runs, lens, offs))


def _zoom_of(tile_id):
    z = base = 0
    while True:
        count = 1 << (2 * z)
        if tile_id < base + count:
            return z
        base += count
        z += 1


def entries(path):
    """Yield (zoom, byte length, run length) per tile entry, walking root + leaf directories."""
    with open(path, "rb") as f:
        head = f.read(127)
        if head[:7] != b"PMTiles":
            raise SystemExit(f"{path}: not a PMTiles archive")
        g = lambda o: struct.unpack_from("<Q", head, o)[0]
        root_off, root_len, leaf_off = g(8), g(16), g(40)

        def walk(dir_entries):
            for tid, run, length, off in dir_entries:
                if run == 0:
                    f.seek(leaf_off + off)
                    yield from walk(_parse_dir(gzip.decompress(f.read(length))))
                else:
                    yield _zoom_of(tid), length, run

        f.seek(root_off)
        yield from walk(_parse_dir(gzip.decompress(f.read(root_len))))


def stats(path):
    """Per zoom: stored bytes (one per entry), tile count, largest tile."""
    by_zoom = collections.Counter()
    tiles = collections.Counter()
    largest = collections.defaultdict(int)
    for z, length, run in entries(path):
        by_zoom[z] += length
        tiles[z] += run
        largest[z] = max(largest[z], length)
    return by_zoom, tiles, largest


def main(argv):
    for path in argv:
        by_zoom, tiles, largest = stats(path)
        total = sum(by_zoom.values())
        size = Path(path).stat().st_size
        print(f"\n{path}  —  {size / 2**20:.1f} MiB on disk, {sum(tiles.values())} tiles")
        print(f"{'z':>3} {'tiles':>9} {'MiB':>9} {'% ':>6} {'max KiB':>9} {'avg KiB':>9}")
        for z in sorted(by_zoom):
            print(
                f"{z:>3} {tiles[z]:>9} {by_zoom[z] / 2**20:9.2f} "
                f"{100 * by_zoom[z] / total:5.1f}% {largest[z] / 1024:9.1f} "
                f"{by_zoom[z] / tiles[z] / 1024:9.2f}"
            )


if __name__ == "__main__":
    # Transmission ships per continent; NA is the representative default.
    main(sys.argv[1:] or [str(Path("data/layers/osm_transmission_lines_na.pmtiles"))])
