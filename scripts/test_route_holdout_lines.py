"""Tests for route_holdout_lines.py: the built-line filters, corridor groups, strata and split.

Needs numpy/shapely/pyproj (venv); skips under `python3 -S`. Acceptance runs
`venv/bin/python -m unittest scripts/test_route_holdout_lines.py -v`. Synthetic lines only; no data/.
"""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import numpy as np
    from pyproj import Transformer
    from shapely.geometry import LineString, MultiLineString
    import route_holdout_lines as H
    HAVE = True
except ImportError:  # pragma: no cover
    HAVE = False

INV = Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True) if HAVE else None
X0, Y0 = 100_000.0, 1_000_000.0  # EPSG:5070 metres


def chain(x, y, km, amp=300.0, step=1000.0):
    """Zig-zag chain heading east, ~1 vertex per km, as EPSG:5070 points."""
    n = int(km * 1000 / step)
    return [(x + i * step, y + (amp if i % 2 else 0.0)) for i in range(n + 1)]


def ll(pts):
    return [INV.transform(px, py) for px, py in pts]


def row(rid, pts, **kw):
    r = {"id": rid, "type": "AC; OVERHEAD", "status": "IN SERVICE", "voltage": 230.0, "val_method": "IMAGERY",
         "states": "|TX|", "geom": LineString(ll(pts))}
    r.update(kw)
    return r


def subs_at(*pts):
    return np.array(pts, dtype=float)


def ends_subs(pts):
    return [pts[0], pts[-1]]


def flat_built(x, y):
    return np.full(len(x), 11, dtype=np.uint8)  # share 0.10


@unittest.skipUnless(HAVE, "needs numpy/shapely/pyproj (venv/bin/python)")
class FilterTests(unittest.TestCase):
    def run_filter(self, rows, subs, vm=True):
        cands, drops = H.filter_lines(rows, subs_at(*subs), vm)
        return {c["id"] for c in cands}, drops

    def test_good_line_kept(self):
        p = chain(X0, Y0, 20)
        ids, drops = self.run_filter([row("g", p)], ends_subs(p))
        self.assertEqual(ids, {"g"})
        self.assertEqual(sum(drops.values()), 0)

    def test_end_1200m_from_substation_dropped(self):
        p = chain(X0, Y0, 20)
        far = (p[-1][0] + 1200.0, p[-1][1])
        ids, drops = self.run_filter([row("e", p)], [p[0], far])
        self.assertEqual(ids, set())
        self.assertEqual(drops["end_substation"], 1)

    def test_end_900m_from_substation_kept(self):
        p = chain(X0, Y0, 20)
        near = (p[-1][0] + 900.0, p[-1][1])
        ids, _ = self.run_filter([row("e", p)], [p[0], near])
        self.assertEqual(ids, {"e"})

    def test_9km_line_dropped(self):
        p = chain(X0, Y0, 9)
        ids, drops = self.run_filter([row("s", p)], ends_subs(p))
        self.assertEqual(ids, set())
        self.assertEqual(drops["length"], 1)

    def test_type_filter(self):
        p = chain(X0, Y0, 20)
        rows = [row(t, p, type=t) for t in ("AC; UNDERGROUND", "DC; OVERHEAD", "OVERHEAD", "NOT AVAILABLE", None)]
        ids, drops = self.run_filter(rows, ends_subs(p))
        self.assertEqual(ids, set())
        self.assertEqual(drops["type"], 5)

    def test_status_voltage_val_method(self):
        p = chain(X0, Y0, 20)
        rows = [row("st", p, status="UNDER CONSTRUCTION"), row("sent", p, voltage=-999999.0),
                row("nan", p, voltage=float("nan")), row("lo", p, voltage=69.0), row("hi", p, voltage=765.0),
                row("vm", p, val_method="OTHER"), row("ok", p, val_method="Imagery/other")]
        ids, drops = self.run_filter(rows, ends_subs(p))
        self.assertEqual(ids, {"ok"})
        self.assertEqual((drops["status"], drops["voltage_missing"], drops["voltage_range"], drops["val_method"]),
                         (1, 2, 2, 1))

    def test_val_method_unavailable_not_applied(self):
        p = chain(X0, Y0, 20)
        ids, drops = self.run_filter([row("x", p, val_method=None)], ends_subs(p), vm=False)
        self.assertEqual(ids, {"x"})

    def test_two_vertex_20km_dropped_for_density(self):
        p = [(X0, Y0), (X0 + 20000.0, Y0 + 3000.0)]
        ids, drops = self.run_filter([row("d", p)], ends_subs(p))
        self.assertEqual(ids, set())
        self.assertEqual(drops["sparse"], 1)

    def test_near_straight_dropped(self):
        p = [(X0 + i * 1000.0, Y0) for i in range(21)]
        ids, drops = self.run_filter([row("st", p)], ends_subs(p))
        self.assertEqual(ids, set())
        self.assertEqual(drops["straight"], 1)

    def test_multipart_chain_assembled(self):
        p = chain(X0, Y0, 20)
        a, b = ll(p[:11]), ll(p[10:])
        r = row("m", p, geom=MultiLineString([b, a]))  # parts out of order
        ids, _ = self.run_filter([r], ends_subs(p))
        self.assertEqual(ids, {"m"})
        c, _ = H.filter_lines([r], subs_at(*ends_subs(p)), True)
        self.assertEqual(len(c[0]["line"].coords), len(p))

    def test_disjoint_parts_not_one_chain(self):
        p = chain(X0, Y0, 20)
        r = row("m", p, geom=MultiLineString([ll(p[:5]), ll(p[8:])]))
        ids, drops = self.run_filter([r], ends_subs(p))
        self.assertEqual(ids, set())
        self.assertEqual(drops["not_one_chain"], 1)

    def test_region_rule(self):
        p = chain(X0, Y0, 20)
        rows = [row("tx", p), row("span", p, states="|TX|NM|"), row("ak", p, states="|AK|"), row("none", p, states="|none|")]
        ids, drops = self.run_filter(rows, ends_subs(p))
        self.assertEqual(ids, {"tx"})
        self.assertEqual(drops["region"], 3)

    def test_line_classes_match_registry(self):
        ts = (Path(__file__).resolve().parent.parent / "src/registry/route-presets.ts").read_text()
        for kv, name in H.LINE_CLASSES:
            self.assertRegex(ts, rf"\n  {name}: \{{[^}}]*?kv: \{{ value: {kv},")
        self.assertEqual(H.line_type_of(300), "ac230")
        self.assertEqual(H.line_type_of(345), "ac345")
        self.assertEqual(H.line_type_of(500), "ac500")


@unittest.skipUnless(HAVE, "needs numpy/shapely/pyproj (venv/bin/python)")
class GroupTests(unittest.TestCase):
    def pair_ids(self):
        """Consecutive ids whose group split differs (opposite parity of both id and sha digit)."""
        for n in range(1000, 2000):
            a, b = str(n), str(n + 1)
            if H.split_of(a) != H.split_of(b):
                return a, b
        self.fail("no id pair")

    def test_parallel_lines_grouped_and_one_sampled_no_group_split(self):
        a, b = self.pair_ids()
        pa = chain(X0, Y0, 20)
        pb = [(x, y + 300.0) for x, y in pa]  # 300 m apart
        pc = chain(X0, Y0 + 50_000.0, 20)      # far away, own group
        rows = [row(a, pa), row(b, pb), row("9999", pc)]
        subs = ends_subs(pa) + ends_subs(pb) + ends_subs(pc)
        res = H.build(rows, subs_at(*subs), flat_built, True, per_stratum=25)
        groups = {c["id"]: c["group"] for c in res["candidates"]}
        self.assertEqual(groups[a], groups[b])
        self.assertEqual(groups[a], a)
        self.assertNotEqual(groups[a], groups["9999"])
        self.assertEqual(sorted({groups[a], groups["9999"]}), sorted({l["group"] for l in res["lines"]}))
        self.assertEqual(len(res["lines"]), 2)  # one of the pair
        by_group = {}
        for c in res["candidates"]:
            by_group.setdefault(c["group"], set()).add(c["split"])
        self.assertTrue(all(len(s) == 1 for s in by_group.values()))
        self.assertEqual({c["split"] for c in res["candidates"] if c["group"] == a}, {H.split_of(a)})
        self.assertNotEqual(H.split_of(a), H.split_of(b))  # the split by line id would differ

    def test_far_lines_not_grouped(self):
        pa = chain(X0, Y0, 20)
        pb = [(x, y + 5000.0) for x, y in pa]
        res = H.build([row("1", pa), row("2", pb)], subs_at(*(ends_subs(pa) + ends_subs(pb))), flat_built, True)
        self.assertEqual(len(res["lines"]), 2)

    def test_stratum_counts_exact_and_shortfall(self):
        pool = []
        for r in H.REGIONS:
            for i in range(7 if r != "East" else 2):
                pool.append({"region": r, "density": i / 7.0, "group": f"{r}{i}"})
        chosen, edges, counts, short = H.stratify(pool, per_stratum=2)
        self.assertEqual(len(chosen), sum(counts.values()))
        for k, v in counts.items():
            self.assertLessEqual(v, 2)
        for c in pool:
            self.assertIn(c["tercile"], (0, 1, 2))
        self.assertEqual(counts["East|0"] + counts["East|1"] + counts["East|2"], 2)
        self.assertEqual(sum(short.values()), 12 * 2 - len(chosen))
        # West: 7 densities in 0..6/7 -> every tercile holds >= 2
        self.assertTrue(all(counts[f"West|{t}"] == 2 for t in range(3)))

    def test_deterministic_outputs(self):
        rows, subs = [], []
        for i in range(12):
            p = chain(X0, Y0 + i * 20_000.0, 20)
            rows.append(row(str(500 + i), p, states="|WA|" if i % 2 else "|OH|"))
            subs += ends_subs(p)
        outs = []
        for _ in range(2):
            res = H.build(rows, subs_at(*subs), flat_built, True, per_stratum=3)
            fx, geo = H.outputs(res, True)
            outs.append((json.dumps(fx, sort_keys=True), geo))
        self.assertEqual(outs[0], outs[1])
        fx = json.loads(outs[0][0])
        self.assertEqual(fx["counts"]["total"], len(fx["lines"]))
        self.assertTrue(all(l["split"] in ("CAL", "HOLD") for l in fx["lines"]))
        self.assertEqual(len(fx["geometrySha256"]), 64)


if __name__ == "__main__":
    unittest.main()
