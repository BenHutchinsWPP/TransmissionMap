"""Smoke tests for fetch_wildfire_live.py's pure parsing/normalization helpers:
timestamp parsing, per-feed normalizers, the inline VIIRS CSV reader, the
hand-rolled DBF/SHP binary parsers (NOAA HMS smoke, no GDAL), and the
previous-features carry-forward loader. Includes regression guards for the
bad-row hardening in read_viirs_csvs (junk lat/lon, short rows, junk frp must
be skipped per-row, never crash the whole feed).
"""
import json
import os
import struct
import tempfile
import unittest
from datetime import datetime, timezone

from fetch_wildfire_live import (
    _epoch_ms_to_iso,
    _parse_acq_dt,
    _parse_julian_dt,
    _read_dbf,
    _read_shp,
    load_previous_features,
    normalize_cwfis_perimeter,
    normalize_incident,
    normalize_perimeter,
    read_viirs_csvs,
)


class TestEpochMsToIso(unittest.TestCase):
    def test_valid_ms(self):
        # 2026-07-16T12:00:00Z in epoch ms.
        ms = int(datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(_epoch_ms_to_iso(ms), "2026-07-16T12:00Z")

    def test_none_returns_none(self):
        self.assertIsNone(_epoch_ms_to_iso(None))


class TestParseJulianDt(unittest.TestCase):
    def test_valid(self):
        # 2026, day-of-year 177 (June 26), 1200Z.
        self.assertEqual(_parse_julian_dt("2026177 1200"), "2026-06-26T12:00Z")

    def test_garbage_returns_none(self):
        self.assertIsNone(_parse_julian_dt("not-a-date"))

    def test_too_short_returns_none(self):
        self.assertIsNone(_parse_julian_dt("12"))


class TestParseAcqDt(unittest.TestCase):
    def test_valid(self):
        dt = _parse_acq_dt("2026-07-16", "1230")
        self.assertEqual(dt, datetime(2026, 7, 16, 12, 30, tzinfo=timezone.utc))

    def test_garbage_returns_none(self):
        self.assertIsNone(_parse_acq_dt("garbage", "xx"))


class TestNormalizePerimeter(unittest.TestCase):
    def test_normalize(self):
        f = {
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
            "properties": {
                "attr_IncidentName": "Test Fire",
                "attr_POOState": "CA",
                "attr_FireCause": "Lightning",
                "attr_FireDiscoveryDateTime": 1752000000000,
                "attr_PercentContained": 50,
                "attr_IncidentSize": 1234.5,
                "poly_GISAcres": 1200.0,
                "poly_PolygonDateTime": 1752100000000,
                "attr_IrwinID": "abc-123",
            },
        }
        out = normalize_perimeter(f)
        self.assertEqual(out["properties"]["_type"], "perimeter")
        self.assertEqual(out["properties"]["country"], "US")
        self.assertEqual(out["properties"]["name"], "Test Fire")
        self.assertEqual(out["properties"]["state"], "CA")
        self.assertEqual(out["properties"]["cause"], "Lightning")
        self.assertEqual(out["properties"]["pct_contained"], 50)
        self.assertEqual(out["properties"]["acres"], 1234.5)
        self.assertEqual(out["properties"]["irwin_id"], "abc-123")
        self.assertEqual(out["geometry"], f["geometry"])


class TestNormalizeIncident(unittest.TestCase):
    def test_normalize(self):
        f = {
            "geometry": {"type": "Point", "coordinates": [-100.0, 40.0]},
            "properties": {
                "UniqueFireIdentifier": "fire-1",
                "IncidentName": "Some Fire",
                "IncidentTypeCategory": "WF",
                "POOState": "US-CA",
                "FireDiscoveryDateTime": 1752000000000,
                "ModifiedOnDateTime_dt": 1752100000000,
                "PercentContained": 10,
                "IncidentSize": 50.0,
            },
        }
        out = normalize_incident(f)
        self.assertEqual(out["properties"]["_type"], "incident")
        self.assertEqual(out["properties"]["fire_id"], "fire-1")
        self.assertEqual(out["properties"]["name"], "Some Fire")
        self.assertEqual(out["properties"]["type_cat"], "WF")
        self.assertEqual(out["properties"]["acres"], 50.0)


class TestNormalizeCwfisPerimeter(unittest.TestCase):
    def test_normalize_with_area(self):
        f = {
            "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
            "properties": {
                "area": 100.0,  # hectares
                "firstdate": "2026-07-15T00:00:00Z",
                "lastdate": "2026-07-16T00:00:00Z",
                "hcount": 5,
            },
        }
        out = normalize_cwfis_perimeter(f)
        self.assertEqual(out["properties"]["_type"], "perimeter")
        self.assertEqual(out["properties"]["country"], "CA")
        self.assertEqual(out["properties"]["acres"], 247.1)  # 100 ha * 2.471
        self.assertEqual(out["properties"]["gis_acres"], 247.1)
        self.assertEqual(out["properties"]["hotspot_count"], 5)
        self.assertIsNone(out["properties"]["name"])

    def test_normalize_missing_area(self):
        f = {"geometry": None, "properties": {"firstdate": None, "lastdate": None}}
        out = normalize_cwfis_perimeter(f)
        self.assertIsNone(out["properties"]["acres"])


class TestReadViirsCsvs(unittest.TestCase):
    def test_valid_rows_become_features(self):
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        csv_text = (
            "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n"
            "34.05,-118.25,2026-07-16,0100,n,12.3,N\n"
            "34.06,-118.26,2026-07-16,0200,h,20.0,N\n"
            "34.07,-118.27,2026-07-16,0300,l,5.0,N\n"  # low confidence: excluded
        )
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(len(feats), 2)
        self.assertEqual(feats[0]["geometry"]["coordinates"], [-118.25, 34.05])
        self.assertEqual(feats[0]["properties"]["_type"], "hotspot")
        self.assertEqual(feats[0]["properties"]["frp"], 12.3)

    def test_duplicate_row_deduped(self):
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        row = "34.05,-118.25,2026-07-16,0100,n,12.3,N\n"
        csv_text = "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n" + row + row
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(len(feats), 1)

    def test_stale_row_older_than_24h_excluded(self):
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        csv_text = (
            "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n"
            "34.05,-118.25,2026-07-14,0100,n,12.3,N\n"  # >24h before `now`
        )
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(feats, [])

    def test_junk_lat_lon_row_is_skipped(self):
        # A malformed lat/lon row must be skipped, not crash the whole parse.
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        csv_text = (
            "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n"
            "bad,bad,2026-07-16,0100,n,12.3,N\n"
            "34.05,-118.25,2026-07-16,0100,n,12.3,N\n"
        )
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(len(feats), 1)
        self.assertEqual(feats[0]["geometry"]["coordinates"], [-118.25, 34.05])

    def test_missing_trailing_columns_row_survives(self):
        # DictReader fills missing trailing columns with None (not "") — the
        # parser must tolerate that instead of raising on None.lower().
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        csv_text = (
            "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n"
            "34.05,-118.25,2026-07-16,0100\n"
        )
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(len(feats), 1)
        self.assertIsNone(feats[0]["properties"]["frp"])

    def test_junk_frp_becomes_none(self):
        now = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)
        csv_text = (
            "latitude,longitude,acq_date,acq_time,confidence,frp,satellite\n"
            "34.05,-118.25,2026-07-16,0100,n,garbage,N\n"
        )
        feats = read_viirs_csvs([csv_text], now)
        self.assertEqual(len(feats), 1)
        self.assertIsNone(feats[0]["properties"]["frp"])


def _build_dbf_fixture() -> bytes:
    """Two fields (NAME char(10), VAL char(5)), two records -- one exercising
    trailing-space stripping on both fields."""
    fields = [("NAME", 10), ("VAL", 5)]
    header_size = 32 + len(fields) * 32 + 1
    record_size = 1 + sum(sz for _, sz in fields)
    header = bytearray(32)
    header[4:8] = struct.pack("<I", 2)  # num_records
    header[8:10] = struct.pack("<H", header_size)
    header[10:12] = struct.pack("<H", record_size)

    field_descs = b""
    for name, size in fields:
        name_b = name.encode("ascii")[:11].ljust(11, b"\x00")
        field_descs += name_b + bytes([ord("C")]) + b"\x00" * 4 + bytes([size]) + b"\x00" * 15
    terminator = b"\x0d"

    rec1 = b" " + b"ALPHA".ljust(10) + b"100".ljust(5)
    rec2 = b" " + b"BETA".ljust(10) + b"7".ljust(5)  # trailing-space stripping
    return bytes(header) + field_descs + terminator + rec1 + rec2


def _build_shp_fixture() -> bytes:
    """One Polygon record (shape type 5): a closed 4-point square ring."""
    points = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]
    content = struct.pack("<i", 5)
    content += struct.pack("<4d", 0.0, 0.0, 1.0, 1.0)  # bbox
    content += struct.pack("<i", 1)  # num_parts
    content += struct.pack("<i", len(points))
    content += struct.pack("<1i", 0)  # parts
    for x, y in points:
        content += struct.pack("<dd", x, y)
    rec_hdr = struct.pack(">II", 1, len(content) // 2)
    file_header = b"\x00" * 100
    return file_header + rec_hdr + content


class TestReadDbf(unittest.TestCase):
    def test_parses_fields_and_strips_trailing_spaces(self):
        records = _read_dbf(_build_dbf_fixture())
        self.assertEqual(
            records,
            [{"NAME": "ALPHA", "VAL": "100"}, {"NAME": "BETA", "VAL": "7"}],
        )


class TestReadShp(unittest.TestCase):
    def test_parses_single_polygon_ring(self):
        rings_list = _read_shp(_build_shp_fixture())
        self.assertEqual(len(rings_list), 1)
        self.assertEqual(
            rings_list[0],
            [[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]],
        )


class TestLoadPreviousFeatures(unittest.TestCase):
    def test_missing_file_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "does_not_exist.geojson")
            self.assertEqual(load_previous_features(path, "perimeter"), [])

    def test_filters_by_feature_type_and_country(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "prev.geojson")
            fc = {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {"_type": "perimeter", "country": "US"}},
                    {"type": "Feature", "properties": {"_type": "perimeter", "country": "CA"}},
                    {"type": "Feature", "properties": {"_type": "incident"}},
                ],
            }
            with open(path, "w") as f:
                json.dump(fc, f)

            us_perims = load_previous_features(path, "perimeter", country="US")
            self.assertEqual(len(us_perims), 1)
            self.assertEqual(us_perims[0]["properties"]["country"], "US")

            all_perims = load_previous_features(path, "perimeter")
            self.assertEqual(len(all_perims), 2)

            incidents = load_previous_features(path, "incident")
            self.assertEqual(len(incidents), 1)


if __name__ == "__main__":
    unittest.main()
