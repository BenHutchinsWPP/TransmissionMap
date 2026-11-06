"""Bounded building-fetch integrity and dissolved footprint coverage checks."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_route_buildings as B
import route_grid as G

GIS = importlib.util.find_spec("numpy") is not None and importlib.util.find_spec("osgeo") is not None
X, Y = G.X0+1000, G.Y0-2000
BOUNDS = [X, Y, X+750, Y+750]


def ring(x, y, w, h):
    return [[x,y], [x+w,y], [x+w,y+h], [x,y+h], [x,y]]


class Service:
    def __init__(self, count=300, fault=None):
        self.ids = list(range(1, count+1))
        self.fault, self.calls, self.metadata_calls = fault, [], 0

    def __call__(self, url, params):
        self.calls.append((url, params))
        if not url.endswith("/query"):
            self.metadata_calls += 1
            return {"objectIdField": "OBJECTID", "geometryType": "esriGeometryPolygon", "serviceItemId": "test",
                    "currentVersion": 12, "editingInfo": {"lastEditDate": 2 if self.fault == "edit" and self.metadata_calls > 1 else 1}}
        if params.get("returnIdsOnly"):
            return {"objectIds": self.ids}
        wanted = list(map(int, params["objectIds"].split(",")))
        actual = wanted[:-1] if self.fault == "missing" else wanted
        if self.fault == "duplicate" and len(actual) > 1:
            actual = actual[:-1]+[actual[0]]
        return {"geometryType": "esriGeometryPolygon", "spatialReference": {"wkid": 5070},
                "exceededTransferLimit": self.fault == "truncated",
                "features": [{"attributes": {"OBJECTID": i, "OCC_CLS": "Commercial"},
                              "geometry": {"rings": [ring(X+10,Y+10,10,10)]}} for i in actual]}


class FetchTests(unittest.TestCase):
    def test_long_queries_use_form_post_and_short_queries_keep_get(self):
        calls = []
        def open_url(target, timeout):
            calls.append((target,timeout))
            return io.BytesIO(b'{"ok":true}')
        params = {"f":"json", "objectIds":",".join(map(str,range(1000)))}
        with patch.object(B.urllib.request,"urlopen",side_effect=open_url):
            self.assertEqual(B.request(B.SOURCE+"/query",params), {"ok":True})
            B.request(B.SOURCE,{"f":"json"})
        long, timeout = calls[0]
        self.assertEqual(long.full_url,B.SOURCE+"/query")
        self.assertEqual(long.get_method(),"POST")
        self.assertEqual(long.get_header("Content-type"),"application/x-www-form-urlencoded")
        self.assertEqual(B.urllib.parse.parse_qs(long.data.decode()), {k:[v] for k,v in params.items()})
        self.assertEqual(timeout,60)
        self.assertEqual(calls[1][0],B.SOURCE+"?f=json")

    def test_ids_are_batched_and_cached_only_for_same_request_and_edits(self):
        with tempfile.TemporaryDirectory() as d:
            service = Service()
            m = B.fetch_snapshot(BOUNDS, d, service)
            self.assertTrue(m["complete"])
            self.assertEqual(m["object_ids"], service.ids)
            self.assertTrue(B.validate_snapshot(m, d).exists())
            queries = len([p for _,p in service.calls if p.get("objectIds")])
            self.assertEqual(queries, 2)
            B.fetch_snapshot(BOUNDS, d, service)
            self.assertEqual(len([p for _,p in service.calls if p.get("objectIds")]), 2)
            B.fetch_snapshot([X+250,Y,X+1000,Y+750], d, service)
            self.assertEqual(len([p for _,p in service.calls if p.get("objectIds")]), 4)
            old = Path(d, "manifest.json").read_bytes()
            with self.assertRaises(ValueError):
                B.fetch_snapshot(BOUNDS, d, Service(fault="missing"))
            self.assertEqual(Path(d, "manifest.json").read_bytes(), old)

    def test_service_failures_never_mark_complete(self):
        for fault in ("missing", "duplicate", "truncated", "edit"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as d:
                with self.assertRaises(ValueError):
                    B.fetch_snapshot(BOUNDS, d, Service(fault=fault))
                self.assertFalse(Path(d, "manifest.json").exists())

    def test_corrupt_feature_cache_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            m = B.fetch_snapshot(BOUNDS, d, Service(1))
            path = Path(d, m["features"])
            path.write_text("{}")
            with self.assertRaisesRegex(ValueError, "hash"):
                B.validate_snapshot(m, d)
            m2 = B.fetch_snapshot(BOUNDS, d, Service(1))
            self.assertNotEqual(m2["features"], m["features"])
            B.validate_snapshot(m2, d)

    def test_incomplete_manifest_wrong_source_and_unsafe_path_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            m = B.fetch_snapshot(BOUNDS, d, Service(0))
            for patch in ({"complete": False}, {"features": "../features.json"}, {"identity": {"source": "https://other"}}):
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    B.validate_snapshot({**m, **patch}, d)

    def test_region_and_feature_caps(self):
        with self.assertRaises(ValueError):
            B.check_bounds([X,Y,X+G.CELL*1001,Y+G.CELL*1001])
        with tempfile.TemporaryDirectory() as d:
            service = Service(0); service.ids = list(range(B.MAX_FEATURES+1))
            with self.assertRaises(ValueError):
                B.fetch_snapshot(BOUNDS, d, service)

    def test_image_year_handles_arcgis_milliseconds_and_strings(self):
        self.assertEqual(B.image_year(1704067200000), "2024")
        self.assertEqual(B.image_year("2024/09/05 00:00:00+00"), "2024")
        self.assertEqual(B.image_year(None), "Unknown")
        self.assertEqual(B.image_year("not a date"), "Unknown")

    def test_every_failed_promotion_swap_restores_previous_generation(self):
        names = ("built.tif", "nonres.tif", "bldgunk.tif", "buildings_meta.json")
        for fail_at in range(1,9):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as d:
                out, stage = Path(d,"output"), Path(d,"stage")
                out.mkdir(); stage.mkdir()
                for name in names:
                    (out/name).write_text("old:"+name)
                    (stage/name).write_text("new:"+name)
                calls = 0
                def replace(src, dst):
                    nonlocal calls
                    calls += 1
                    if calls == fail_at:
                        raise OSError("injected swap failure")
                    os.replace(src,dst)
                with self.assertRaises(OSError):
                    B.promote_files(stage,out,names,replace)
                self.assertEqual([(out/n).read_text() for n in names], ["old:"+n for n in names])

    def test_interrupt_after_swap_restores_old_and_removes_new_only_files(self):
        names = ("built.tif", "nonres.tif", "bldgunk.tif", "buildings_meta.json")
        for old in (True,False):
            with self.subTest(old=old), tempfile.TemporaryDirectory() as d:
                out, stage = Path(d,"output"), Path(d,"stage")
                out.mkdir(); stage.mkdir()
                for name in names:
                    if old:
                        (out/name).write_text("old:"+name)
                    (stage/name).write_text("new:"+name)
                calls = 0
                def replace(src,dst):
                    nonlocal calls
                    calls += 1
                    os.replace(src,dst)
                    if calls == (5 if old else 2):
                        raise KeyboardInterrupt("injected after completed swap")
                with self.assertRaises(KeyboardInterrupt):
                    B.promote_files(stage,out,names,replace)
                if old:
                    self.assertEqual([(out/n).read_text() for n in names], ["old:"+n for n in names])
                else:
                    self.assertFalse(any((out/n).exists() for n in names))


@unittest.skipUnless(GIS, "GDAL/numpy not installed")
class GeometryTests(unittest.TestCase):
    def input(self, folder, features):
        p = Path(folder, "buildings.geojson")
        p.write_text(json.dumps({"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "EPSG:5070"}}, "features": features}))
        return p

    def feature(self, coords, cls="Commercial", kind="Polygon"):
        return {"type": "Feature", "properties": {"OCC_CLS": cls, "IMAGE_DATE": "2024/01/01"},
                "geometry": {"type": kind, "coordinates": coords}}

    def test_dissolved_holes_multipart_unknown_and_empty_observed_cell(self):
        import numpy as np
        features = [
            self.feature([ring(X+10,Y+10,100,100), ring(X+30,Y+30,20,20)]),
            self.feature([ring(X+10,Y+10,100,100)]),
            self.feature([[ring(X+240,Y+10,20,20)], [ring(X+510,Y+10,20,20)]], None, "MultiPolygon"),
            self.feature([ring(X+10,Y+260,.01,.01)], "Unexpected"),
        ]
        with tempfile.TemporaryDirectory() as d:
            arrays, checks = B.build_arrays(self.input(d, features), BOUNDS, np.ones((3,3), bool))
        # Last array row is the southern row. Overlapping polygons union to 10000m², not 19600.
        self.assertEqual(int(arrays["built"][2,0]), G.footprint_encode(10200/62500))
        self.assertEqual(int(arrays["nonres"][2,0]), G.footprint_encode(10000/62500))
        self.assertGreater(int(arrays["bldgunk"][2,1]), 1)
        self.assertGreater(int(arrays["bldgunk"][2,2]), 1)
        self.assertEqual(int(arrays["bldgunk"][1,0]), 2)
        self.assertEqual(int(arrays["built"][0,0]), 1)
        self.assertEqual(checks["features"], 4)
        for name in B.NAMES:
            np.testing.assert_array_equal(arrays[name] > 0, np.ones((3,3), bool))

    def test_fetched_esrijson_snapshot_builds_with_class_attributes(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as d:
            manifest = B.fetch_snapshot(BOUNDS, d, Service(1))
            arrays, checks = B.build_arrays(B.validate_snapshot(manifest,d), BOUNDS, np.ones((3,3),bool))
        self.assertEqual(checks["classes"], {"Commercial":1})
        self.assertEqual(int(arrays["nonres"][2,0]), 2)

    def test_hole_is_not_filled_and_residential_not_nonres(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as d:
            p = self.input(d, [self.feature([ring(X+10,Y+10,100,100), ring(X+30,Y+30,20,20)], "Residential")])
            arrays, _ = B.build_arrays(p, BOUNDS, np.ones((3,3), bool))
        self.assertEqual(int(arrays["built"][2,0]), G.footprint_encode(9600/62500))
        self.assertEqual(int(arrays["nonres"][2,0]), 1)

    def test_agriculture_is_known_nonresidential_and_unclassified_stays_separate(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as d:
            p = self.input(d, [self.feature([ring(X+10,Y+10,100,100)], "Agriculture"),
                               self.feature([ring(X+260,Y+10,100,100)], "Unclassified")])
            arrays, _ = B.build_arrays(p, BOUNDS, np.ones((3,3),bool))
        self.assertGreater(int(arrays["nonres"][2,0]),1)
        self.assertEqual(int(arrays["bldgunk"][2,0]),1)
        self.assertEqual(int(arrays["nonres"][2,1]),1)
        self.assertGreater(int(arrays["bldgunk"][2,1]),1)

    def test_empty_complete_input_marks_observed_without_footprints(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as d:
            arrays, checks = B.build_arrays(self.input(d, []), BOUNDS, np.ones((3,3), bool))
        self.assertEqual(checks["features"], 0)
        self.assertTrue(all((a == 1).all() for a in arrays.values()))

    def test_invalid_polygon_repair_and_nonfinite_refusal(self):
        import numpy as np
        from osgeo import ogr
        bad = [[X+10,Y+10],[X+110,Y+110],[X+10,Y+110],[X+110,Y+10],[X+10,Y+10]]
        with tempfile.TemporaryDirectory() as d:
            arrays, checks = B.build_arrays(self.input(d, [self.feature([bad])]), BOUNDS, np.ones((3,3),bool))
        self.assertEqual(checks["repaired_geometries"], 1)
        self.assertGreater(int(arrays["built"][2,0]), 1)
        g = ogr.Geometry(ogr.wkbLinearRing)
        g.AddPoint(float("nan"), 1)
        self.assertFalse(B.finite_coordinates(g))

    def test_partial_edges_and_nonland_share_nodata_mask(self):
        import numpy as np
        bounds = [X+25,Y+25,X+750,Y+750]
        land = np.ones((3,3), bool); land[0,1] = False
        # Centroid lies outside the observed rectangle but the roof crosses a fully observed cell.
        features = [self.feature([ring(X-600,Y+260,900,20)])]
        with tempfile.TemporaryDirectory() as d:
            arrays, _ = B.build_arrays(self.input(d, features), bounds, land)
        expected = np.array([[False,False,True], [False,True,True], [False,False,False]])
        for a in arrays.values():
            np.testing.assert_array_equal(a > 0, expected)
        self.assertGreater(int(arrays["nonres"][1,1]), 1)

    def test_sparse_writer_keeps_other_cells_zero_and_writes_metadata(self):
        import numpy as np
        from osgeo import gdal, osr
        with tempfile.TemporaryDirectory() as d:
            state = Path(d, "state.tif")
            ds = gdal.GetDriverByName("GTiff").Create(str(state), G.COLS,G.ROWS,1,gdal.GDT_Byte,["TILED=YES","SPARSE_OK=YES"])
            srs = osr.SpatialReference(); srs.ImportFromEPSG(5070)
            ds.SetGeoTransform(G.transform()); ds.SetProjection(srs.ExportToWkt())
            c0,r0,_,_= B.check_bounds(BOUNDS)
            ds.GetRasterBand(1).WriteArray(np.ones((3,3),np.uint8),c0,r0); ds=None
            p = self.input(d,[self.feature([ring(X+10,Y+10,10,10)])])
            meta = B.build(p,BOUNDS,Path(d,"output"),state_path=state)
            self.assertEqual(meta["checks"]["observed_land_cells"],9)
            for name in B.NAMES:
                self.assertEqual(meta["files"][name+".tif"], B.sha256_file(Path(d,"output",name+".tif")))
                ds=gdal.Open(str(Path(d,"output",name+".tif")))
                self.assertEqual(int(ds.ReadAsArray(0,0,1,1)[0,0]),0)
                self.assertEqual(ds.GetGeoTransform(),G.transform())
                self.assertTrue(ds.ReadAsArray(c0,r0,3,3).all())
                ds=None
            before=Path(d,"output","buildings_meta.json").read_bytes()
            with self.assertRaises(ValueError):
                B.build(self.input(d,[self.feature([],kind="LineString")]),BOUNDS,Path(d,"output"),state_path=state)
            self.assertEqual(Path(d,"output","buildings_meta.json").read_bytes(),before)


if __name__ == "__main__":
    unittest.main()
