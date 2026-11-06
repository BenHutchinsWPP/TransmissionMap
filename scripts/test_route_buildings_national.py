"""National footprint geometry, source completeness, bounded spools and staging."""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_route_buildings_national as N

GIS = all(importlib.util.find_spec(n) is not None for n in ("numpy", "shapely", "pyogrio", "rasterio", "geopandas"))


class SourceTests(unittest.TestCase):
    def test_incomplete_inventory_cannot_mark_national_coverage(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "structures_zips.json").write_text('{}')
            with self.assertRaisesRegex(ValueError, "48 contiguous"):
                N.source_inventory(root)

    def test_wrong_archive_size_and_path_are_rejected(self):
        with tempfile.TemporaryDirectory() as d, patch.object(N, "STATES", {"NV"}):
            root = Path(d)
            name = "NV_Structures_20250913.zip"
            entry = {"zip": name, "bytes": 2, "url": "https://fema-femadata.s3.us-east-1.amazonaws.com/Partners/ORNL/USA_Structures/NV/" + name,
                     "deliverable": "20250913", "last_modified": "2025-09-13"}
            (root / name).write_bytes(b"x")
            path = root / "structures_zips.json"
            path.write_text(json.dumps({"NV": entry}))
            with self.assertRaisesRegex(ValueError, "size"):
                N.source_inventory(root)
            entry["zip"] = "../NV.zip"
            path.write_text(json.dumps({"NV": entry}))
            with self.assertRaisesRegex(ValueError, "archive name"):
                N.source_inventory(root)

    def test_unsafe_zip_is_rejected_before_extracting(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "bad.zip"
            with zipfile.ZipFile(source, "w") as z:
                z.writestr("../outside", "bad")
            with self.assertRaisesRegex(ValueError, "unsafe"):
                N.extract_archive(source, root / "extract")
            self.assertFalse((root / "outside").exists())


@unittest.skipUnless(GIS, "national GIS dependencies absent")
class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        N.runtime()

    def setUp(self):
        self.x, self.y = N.G.X0, N.G.Y0

    def shares(self, geometries, groups, land=None):
        return N.cell_shares(N.np.asarray(geometries, dtype=object), N.np.asarray(groups, dtype=N.np.uint8), 0, 0,
                             N.np.ones((2, 2), bool) if land is None else land)

    def test_overlapping_archives_dissolve_per_cell_and_class(self):
        x, y, S = self.x, self.y, N.shapely
        a = S.box(x, y-125, x+125, y)
        b = S.box(x+62.5, y-125, x+187.5, y)
        result = self.shares([a, a, b], [1, 1, 2])
        self.assertEqual(result["built"].tolist(), [[39, 1], [1, 1]])
        self.assertEqual(result["nonres"].tolist(), [[26, 1], [1, 1]])
        self.assertEqual(result["bldgunk"].tolist(), [[26, 1], [1, 1]])

    def test_holes_tiny_roofs_and_unobserved_land(self):
        x, y, S = self.x, self.y, N.shapely
        roof = S.difference(S.box(x, y-250, x+250, y), S.box(x+62.5, y-187.5, x+187.5, y-62.5))
        tiny = S.box(x+249.99, y-50, x+250.01, y-49.99)
        land = N.np.array([[True, True], [False, True]])
        result = self.shares([roof, tiny], [1, 2], land)
        self.assertEqual(result["built"].tolist(), [[76, 2], [0, 1]])
        self.assertEqual(result["bldgunk"].tolist(), [[2, 2], [0, 1]])
        self.assertEqual(result["nonres"].tolist(), [[76, 1], [0, 1]])

    def test_geometry_repair_preserves_class_and_rejects_empty(self):
        x, y, S = self.x, self.y, N.shapely
        bow = S.Polygon([(x,y), (x+50,y-50), (x,y-50), (x+50,y), (x,y)])
        geoms, groups, repaired = N.polygon_parts(N.np.array([bow], dtype=object), N.np.array([2]))
        self.assertEqual(repaired, 1)
        self.assertTrue(N.np.all(S.is_valid(geoms)))
        self.assertTrue(N.np.all(groups == 2))
        self.assertAlmostEqual(S.area(geoms).sum(), 1250)
        with self.assertRaisesRegex(ValueError, "missing or empty"):
            N.polygon_parts(N.np.array([None], dtype=object), N.np.array([1]))

    def test_tile_border_and_duplicate_state_shards_preserve_exact_area(self):
        x = self.x + N.TILE * N.G.CELL
        y, S = self.y, N.shapely
        roof = S.box(x-125, y-125, x+125, y)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for _ in range(2):
                N.spool_batch(N.np.array([roof], dtype=object), N.np.array([1]), root)
            for c in (0, N.TILE):
                path = root / f"{c}_0.wkb.gz"
                geoms, groups = N.read_tile([(path, N.B.sha256_file(path))])
                land = N.np.ones((1, N.TILE), bool)
                arrays = N.cell_shares(geoms, groups, c, 0, land)
                expected = N.np.ones((1,N.TILE), dtype=N.np.uint8)
                expected[0, -1 if c == 0 else 0] = 26
                N.np.testing.assert_array_equal(arrays["nonres"], expected)

    def test_spool_truncation_hash_and_byte_budget(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "tile.gz"
            with gzip.open(path, "wb") as f:
                f.write(N.RECORD.pack(1, 10) + b"xx")
            digest = N.B.sha256_file(path)
            with self.assertRaisesRegex(ValueError, "truncated"):
                N.read_tile([(path,digest)])
            with self.assertRaisesRegex(ValueError, "hash"):
                N.read_tile([(path,"wrong")])
            with patch.object(N, "MAX_TILE_BYTES", 3), self.assertRaisesRegex(ValueError, "budget"):
                N.read_tile([(path,digest)])

    def test_national_build_and_resume_from_two_synthetic_state_archives(self):
        import geopandas as pd
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, work, output = root/"source", root/"work", root/"output"
            source.mkdir()
            x, y = self.x, self.y
            inventory = {}
            for st, cls in (("AA", "Commercial"), ("BB", "Not classified")):
                gdb = root / f"{st}.gdb"
                classes = [cls, "Agriculture"] if st == "AA" else [cls]
                roofs = [N.shapely.box(x,y-125,x+125,y)]
                if st == "AA":
                    roofs.append(N.shapely.box(x+250,y-125,x+375,y))
                frame = pd.GeoDataFrame({"OCC_CLS": classes, "IMAGE_DATE": ["2024-01-01"] * len(classes)},
                                        geometry=roofs, crs=N.G.CRS)
                N.pyogrio.write_dataframe(frame, gdb, layer="structures", driver="OpenFileGDB")
                archive = source / f"{st}_Structures_20250913.zip"
                with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
                    for p in gdb.iterdir():
                        z.write(p, str(Path(gdb.name)/p.name))
                inventory[st] = {"zip": archive.name, "bytes": archive.stat().st_size,
                                 "url": f"https://fema-femadata.s3.us-east-1.amazonaws.com/Partners/ORNL/USA_Structures/{st}/{archive.name}",
                                 "deliverable": "20250913", "last_modified": "2025-09-13"}
            (source/"structures_zips.json").write_text(json.dumps(inventory))
            state = root/"state.tif"
            with N.rasterio.open(state,"w",driver="GTiff",width=2,height=2,count=1,dtype="uint8",crs=N.G.CRS,
                                  transform=N.Affine.from_gdal(*N.G.transform())) as r:
                r.write(N.np.array([[32,32],[0,32]],dtype=N.np.uint8),1)
            with patch.object(N,"STATES",frozenset(inventory)), patch.object(N.G,"COLS",2), patch.object(N.G,"ROWS",2):
                meta = N.build(source,work,output,state)
                self.assertEqual(meta["checks"]["features"],3)
                self.assertEqual(meta["checks"]["observed_land_cells"],3)
                for name in N.B.NAMES:
                    with N.rasterio.open(output/(name+".tif")) as r:
                        self.assertEqual(r.read(1).tolist(), [[26,1 if name == "bldgunk" else 26],[0,1]])
                with patch.object(N,"extract_archive",side_effect=AssertionError("cache was not reused")):
                    again=N.build(source,work,output,state)
                self.assertEqual(meta["files"],again["files"])
                manifest = next(work.glob("AA-*/manifest.json"))
                cached = json.loads(manifest.read_text())
                shard = manifest.parent / next(iter(cached["files"]))
                shard.write_bytes(b"corrupted")
                with self.assertRaisesRegex(ValueError,"cached polygon shard"):
                    N.build(source,work,output,state)
                for name,digest in meta["files"].items():
                    self.assertEqual(N.B.sha256_file(output/name),digest)


if __name__ == "__main__":
    unittest.main()
