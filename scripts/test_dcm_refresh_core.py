"""Tests for the weekly moratorium refresh core (stdlib only)."""
import ast
import csv
import tempfile
import unittest
from datetime import date
from pathlib import Path

from moratoriums.refresh import config, queries, schema, textnorm, verify

RUN = date(2026, 10, 8)


class TextNorm(unittest.TestCase):
    def test_norm_jn(self):
        cases = {
            "City of St. Charles": "saintcharles",
            "Big Rapids Charter Township": "bigrapids",
            "Nashville-Davidson (Metro)": "nashvilledavidson",
            "Town of Foo": "foo",
            "Prince George's County": "princegeorges",
            "AT&T Village": "atandt",
        }
        for name, want in cases.items():
            self.assertEqual(textnorm.jn(name), want, name)
        self.assertEqual(textnorm.norm("St. Louis County"), "saintlouis")
        self.assertEqual(textnorm.jn("Louisville/Jefferson County metropolitan government"), "louisvillejefferson")

    def test_normalize_text(self):
        n = textnorm.normalize_text
        self.assertEqual(n("It’s a “ban” – now"), "it's a \"ban\" - now")
        self.assertEqual(n("a b  c"), "a b c")
        self.assertEqual(n("zero​width"), "zerowidth")
        self.assertEqual(n("morato­rium"), "moratorium")
        self.assertEqual(n("morato­\nrium"), "moratorium")
        self.assertEqual(n("morato-\nrium"), "moratorium")
        self.assertEqual(n("well-known"), "well-known")
        self.assertEqual(n("The  CITY\nCouncil"), "the city council")

    def test_match_key(self):
        k = textnorm.match_key
        self.assertEqual(k("well-known"), k("well-\nknown"))
        self.assertEqual(k("moratorium—which"), k("moratorium — which"))
        self.assertNotEqual(k("two-year"), k("one-year"))


class Verify(unittest.TestCase):
    PAGE = "The council voted to adopt a one-year morato-\nrium on new data   center applications."
    QUOTE = "voted to adopt a one-year moratorium on new data center applications"

    def test_quote(self):
        self.assertTrue(verify.quote_in_page(self.QUOTE.upper(), self.PAGE))
        self.assertFalse(verify.quote_in_page("voted to adopt a two-year moratorium on new data centers", self.PAGE))

    def test_quote_hyphenation_symmetry(self):
        q = verify.quote_in_page
        self.assertTrue(q("a well-known data center moratorium was adopted by council", "a well-\nknown data center moratorium was adopted by council"))
        self.assertTrue(q("the council passed a one-year moratorium on new data centers", "the council passed a one-\nyear moratorium on new data centers"))
        self.assertTrue(q("a moratorium—which applies to all new data centers", "a moratorium — which applies to all new data centers"))
        self.assertFalse(q("the council passed a two-year moratorium on new data centers", "the council passed a one-\nyear moratorium on new data centers"))

    def test_quote_cannot_be_stitched_from_prompt_windows(self):
        from moratoriums.refresh import fetch as F
        filler = lambda tag, n: " ".join(f"{tag}{i}" for i in range(n))
        text = filler("a", 3000) + " moratorium " + filler("b", 3000) + " data center " + filler("c", 3000)
        out = F.truncate_for_prompt(text)
        self.assertLess(len(out), len(text))
        i = out.index("\n")
        quote = out[i - 30:i] + " " + out[i + 1:i + 31]
        self.assertTrue(verify.quote_in_page(quote, out))
        self.assertFalse(verify.quote_in_page(quote, text))

    def test_quote_minimum(self):
        short = "voted to adopt a one-year moratorium"  # < 40 chars
        self.assertLess(len(short), 40)
        self.assertFalse(verify.quote_in_page(short, self.PAGE))
        self.assertTrue(verify.quote_in_page("x" * 40, "y" + "x" * 40))

    def test_dates(self):
        c = verify.check_dates
        self.assertEqual(c({"date_adopted": "2026-10-08", "date_expires": "2027-10"}, RUN), [])
        self.assertEqual(c({"date_adopted": "2026-10"}, RUN), [])
        self.assertTrue(c({"date_adopted": "2026-10-09"}, RUN))
        self.assertTrue(c({"date_adopted": "2014-12-31"}, RUN))
        self.assertTrue(c({"date_adopted": "10/07/2026"}, RUN))
        self.assertTrue(c({"date_adopted": "2026-02-30"}, RUN))
        self.assertTrue(c({"date_adopted": "2026-05-01", "date_expires": "2026-04-30"}, RUN))
        self.assertEqual(c({"date_adopted": "2026-05-01", "date_expires": "2026-05-01"}, RUN), [])
        self.assertEqual(c({}, RUN), [])

    def _index(self):
        names = {"39049": "Franklin", "39035": "Cuyahoga", "39061": "Hamilton"}
        rows = [
            {"id": "a", "level": "city", "name": "Washington Township", "state": "OH", "county_fips": "39049", "type": "temporary moratorium"},
            {"id": "b", "level": "city", "name": "Washington Township", "state": "OH", "county_fips": "39035", "type": "temporary moratorium"},
        ]
        return verify.build_index(rows, names)

    def cand(self, county, **kw):
        d = {"jurisdiction_name": "Washington Township", "jurisdiction_level": "city", "state": "OH", "county": county, "type": "temporary moratorium"}
        d.update(kw)
        return d

    def test_washington_collision(self):
        idx = self._index()
        self.assertEqual(len(idx), 2)
        self.assertEqual(verify.classify(self.cand("Franklin County"), idx), "match:a")
        self.assertEqual(verify.classify(self.cand("Cuyahoga"), idx), "match:b")
        self.assertEqual(verify.classify(self.cand("Hamilton"), idx), "new")
        self.assertEqual(verify.classify(self.cand("Franklin", type="permanent ban"), idx), "new")

    def test_dedupe_maps_match_build_research(self):
        tree = ast.parse((Path(__file__).parent / "moratoriums" / "build_research.py").read_text(encoding="utf-8"))
        found = {t.id: ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                 for t in n.targets if isinstance(t, ast.Name) and t.id in ("TYPE", "LEVEL")}
        self.assertEqual(found, {"TYPE": verify.TYPE, "LEVEL": verify.LEVEL})

    def test_type_and_level_mapped(self):
        idx = verify.build_index([{"id": "ic", "level": "town", "name": "Foo", "state": "OH", "county_fips": "39049", "type": "interconnection pause"}], {"39049": "Franklin"})
        cand = self.cand("Franklin", jurisdiction_name="Foo", jurisdiction_level="borough", type="service pause")
        self.assertEqual(verify.classify(cand, idx), "match:ic")
        self.assertEqual(verify.classify(self.cand("Franklin", jurisdiction_name="Foo", type="load cap"), idx), "match:ic")

    def test_state_agency_without_county_is_not_a_lead(self):
        c = self.cand("", jurisdiction_name="Public Utilities Commission", jurisdiction_level="state_agency")
        self.assertEqual(verify.classify(c, {}), "new")

    def test_adoption_year_must_agree(self):
        rows = [{"id": "a", "level": "city", "name": "Foo", "state": "OH", "county_fips": "39049", "type": "temporary moratorium", "date_adopted": "2024-03-01"}]
        idx = verify.build_index(rows, {"39049": "Franklin"})
        c = self.cand("Franklin", jurisdiction_name="Foo")
        self.assertEqual(verify.classify({**c, "date_adopted": "2026-05-01"}, idx), "new")
        self.assertEqual(verify.classify({**c, "date_adopted": "2024-11"}, idx), "match:a")
        self.assertEqual(verify.classify(c, idx), "match:a")  # blank candidate date

    def test_matching_ids_any_year_and_types(self):
        rows = [{"id": "a", "level": "city", "name": "Foo", "state": "OH", "county_fips": "39049", "type": "temporary moratorium", "date_adopted": "2024-03-01"},
                {"id": "b", "level": "city", "name": "Foo", "state": "OH", "county_fips": "39049", "type": "permit pause", "date_adopted": "2026-01-01"}]
        idx = verify.build_index(rows, {"39049": "Franklin"})
        c = {**self.cand("Franklin", jurisdiction_name="Foo"), "date_adopted": "2026-05-01"}
        self.assertEqual(verify.matching_ids(c, idx), [])
        self.assertEqual(verify.matching_ids(c, idx, any_year=True), ["a"])
        self.assertEqual(verify.matching_ids(c, idx, ("temporary moratorium", "permit pause"), any_year=True), ["a", "b"])
        self.assertIsNone(verify.matching_ids({**c, "county": ""}, idx))

    def test_month_only_expiry_is_end_of_month(self):
        self.assertEqual(verify._parse("2026-10"), date(2026, 10, 1))
        self.assertEqual(verify._parse("2026-10", end=True), date(2026, 10, 31))
        self.assertEqual(verify.check_dates({"date_adopted": "2026-05-20", "date_expires": "2026-05"}, RUN), [])

    def test_no_county_is_lead(self):
        self.assertTrue(verify.classify(self.cand(""), self._index()).startswith("lead:"))
        u = self.cand("", jurisdiction_level="utility")
        self.assertEqual(verify.classify(u, self._index()), "new")

    def test_key_level_class(self):
        a = verify.dedupe_key("OH", "Franklin", "Franklin", "county", "x")
        b = verify.dedupe_key("OH", "Franklin", "Franklin", "city", "x")
        self.assertNotEqual(a, b)

    def test_unique_id(self):
        ids = {"add-oh-x-2026", "add-oh-x-2026-2"}
        self.assertEqual(verify.unique_id("add-oh-y-2026", ids), "add-oh-y-2026")
        self.assertEqual(verify.unique_id("add-oh-x-2026", ids), "add-oh-x-2026-3")
        self.assertEqual(verify.unique_id("a", ["a"]), "a-2")

    def test_load_county_names(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "c.csv")
            p.write_text("county_fips,state,county_name\n39049,OH,Franklin\n", encoding="utf-8")
            self.assertEqual(verify.load_county_names(p), {"39049": "Franklin"})


def row(id, **kw):
    r = {"id": id, "name": id.upper(), "state": "OH", "level": "city", "status": "active", "date_expires": "", "last_verified": ""}
    r.update(kw)
    return r


class Planner(unittest.TestCase):
    def rows(self):
        return [
            row("p-new", status="pending", last_verified="2026-09-30"),
            row("p-old", status="pending", last_verified="2026-06-01"),
            row("p-never", status="pending"),
            row("exp-in", date_expires="2026-10-20", last_verified="2026-10-01"),
            row("exp-past", status="extended", date_expires="2026-09-30", last_verified="2026-10-01"),
            row("exp-far", date_expires="2027-01-01", last_verified="2026-10-01"),
            row("u1", level="utility", last_verified="2026-10-01"),
            row("r-new", last_verified="2026-10-05"),
            row("r-old", last_verified="2026-06-15"),
            row("done", status="expired"),
        ]

    def test_order_and_freshness(self):
        qs = queries.plan_queries(self.rows(), RUN, {}, config.Config())
        ids = [q.row_id for q in qs if q.row_id]
        self.assertEqual(ids, ["p-never", "p-old", "p-new", "exp-past", "exp-in", "u1", "r-old", "r-new"])
        self.assertEqual([q.kind for q in qs][:3], ["pending"] * 3)
        by = {q.row_id: q for q in qs}
        self.assertEqual(by["p-new"].freshness, "2026-09-30to2026-10-08")
        self.assertEqual(by["p-never"].freshness, "2026-07-10to2026-10-08")  # 90 days back
        self.assertEqual(by["p-old"].freshness, "2026-07-10to2026-10-08")  # older than 90 days
        self.assertEqual(by["p-new"].text, '"P-NEW" Ohio data center moratorium')
        self.assertEqual(by["u1"].text, '"U1" data center OR cryptocurrency load moratorium')
        disc = [q for q in qs if q.kind == "discovery"]
        self.assertEqual(len(disc), len(config.DISCOVERY_QUERIES))
        self.assertTrue(all(q.freshness == "pw" for q in disc))
        self.assertEqual(qs[-len(disc):], disc)
        self.assertNotIn("done", ids)
        self.assertNotIn("exp-far", ids)

    def test_caps_cut_from_bottom_and_deterministic(self):
        full = queries.plan_queries(self.rows(), RUN, {}, config.Config())
        cut = queries.plan_queries(self.rows(), RUN, {}, config.Config(max_requests=4))
        self.assertEqual(cut, full[:4])
        self.assertEqual(full, queries.plan_queries(list(reversed(self.rows())), RUN, {}, config.Config()))

    def test_rotating_share_limit(self):
        qs = queries.plan_queries(self.rows(), RUN, {}, config.Config(shares=(("pending", 3), ("expiring", 2), ("utility", 1), ("rotating", 1))))
        self.assertEqual([q.row_id for q in qs if q.kind == "rotating"], ["r-old"])

    def test_config_load(self):
        c = config.Config.load(env={"DCM_MAX_REQUESTS": "7"}, overrides={"max_pages": 3})
        self.assertEqual((c.max_requests, c.max_pages, c.max_escalation_calls), (7, 3, 40))
        d = config.Config()
        self.assertEqual((d.max_requests, d.max_requests_for_planning), (220, 200))
        self.assertFalse(hasattr(d, "cost"))
        self.assertEqual(config.PRICES[config.REVIEW_MODEL], {"input": 4.0, "output": 20.0, "cache_read": 0.2, "cache_write": 5.0})

    def test_config_model_env(self):
        c = config.Config.load(env={"DCM_TRIAGE_MODEL": " m-s ", "DCM_ESCALATION_MODEL": "", "DCM_REVIEW_MODEL": "m-r"})
        self.assertEqual((c.triage_model, c.escalation_model, c.review_model), ("m-s", config.ESCALATION_MODEL, "m-r"))

    def many(self, prefix, n, **kw):
        return [row(f"{prefix}{i:03d}", **kw) for i in range(n)]

    def kinds(self, qs):
        out = {}
        for q in qs:
            out[q.kind] = out.get(q.kind, 0) + 1
        return out

    def test_shares_and_carry(self):
        rows = (self.many("p", 100, status="pending") + self.many("u", 30, level="utility")
                + self.many("r", 60))
        k = self.kinds(queries.plan_queries(rows, RUN, {}, config.Config()))
        # expiring's unused 50 flows to utility (20 + 50 >= 30), then rotating (30 + 40 >= 60)
        self.assertEqual(k, {"pending": 80, "utility": 30, "rotating": 60, "discovery": 20})

    def test_utility_oversized_uses_carry(self):
        rows = self.many("p", 10, status="pending") + self.many("u", 200, level="utility") + self.many("r", 100)
        k = self.kinds(queries.plan_queries(rows, RUN, {}, config.Config()))
        # pending leaves 70, expiring 50 -> utility takes 20 + 120 = 140; rotating keeps only its own 30
        self.assertEqual((k["pending"], k["utility"], k["rotating"], k["discovery"]), (10, 140, 30, 20))

    def test_discovery_keeps_reserve_when_all_oversized(self):
        exp = self.many("e", 100, date_expires="2026-10-10")
        rows = (self.many("p", 100, status="pending") + exp
                + self.many("u", 100, level="utility") + self.many("r", 100))
        qs = queries.plan_queries(rows, RUN, {}, config.Config())
        self.assertEqual(self.kinds(qs), {"pending": 80, "expiring": 50, "utility": 20, "rotating": 30, "discovery": 20})
        self.assertEqual(len(qs), 200)

    def test_max_requests_small(self):
        rows = self.many("p", 100, status="pending")
        qs = queries.plan_queries(rows, RUN, {}, config.Config(max_requests=7))
        self.assertEqual(len(qs), 7)
        self.assertEqual({q.kind for q in qs}, {"pending"})

    def test_endpoints(self):
        qs = queries.plan_queries(self.rows(), RUN, {}, config.Config())
        for q in qs:
            self.assertEqual(q.endpoint, "web" if q.kind == "utility" else "news", q.id)

    def test_freshness_start_never_after_run_date(self):
        qs = queries.plan_queries([row("future", status="pending", last_verified="2026-10-20"),
                                   row("today", status="pending", last_verified="2026-10-08")], RUN, {}, config.Config())
        self.assertEqual({q.row_id: q.freshness for q in qs if q.row_id},
                         {"future": "2026-10-07to2026-10-08", "today": "2026-10-07to2026-10-08"})

    def test_county_name_in_followup_text(self):
        rows = [row("a", level="city", name="Washington Township", county_fips="39049", status="pending"),
                row("b", level="county", name="Franklin County", county_fips="39049", status="pending"),
                row("c", level="city", name="Nowhere", county_fips="", status="pending")]
        by = {q.row_id: q.text for q in queries.plan_queries(rows, RUN, {"39049": "Franklin"}, config.Config())}
        self.assertEqual(by["a"], '"Washington Township" Franklin County Ohio data center moratorium')
        self.assertEqual(by["b"], '"Franklin County" Ohio data center moratorium')
        self.assertEqual(by["c"], '"Nowhere" Ohio data center moratorium')

    def test_month_only_expiry_is_expiring(self):
        qs = queries.plan_queries([row("m", date_expires="2026-10"), row("far", date_expires="2027-02"),
                                   row("bad", date_expires="soon")], RUN, {}, config.Config())
        kinds = {q.row_id: q.kind for q in qs if q.row_id}
        self.assertEqual(kinds.get("m"), "expiring")
        self.assertNotIn("far", kinds)  # dated, so not open-ended either
        self.assertNotIn("bad", {q.row_id for q in qs if q.kind == "expiring"})


class Schema(unittest.TestCase):
    def test_headers(self):
        j = ",".join
        self.assertEqual(j(schema.MORATORIUMS), "id,jurisdiction_name,jurisdiction_level,state,county,type,sectors,status,date_adopted,date_expires,duration,summary,source_urls,source_quality,upstream_id,kind,notes")
        self.assertEqual(j(schema.BANS), "id,jurisdiction_name,jurisdiction_level,state,county,type,sectors,status,date_adopted,date_expires,duration,summary,source_urls,source_quality,in_upstream,notes")
        self.assertEqual(j(schema.UTILITIES), "id,jurisdiction_name,jurisdiction_level,state,service_area_counties,type,sectors,status,date_adopted,date_expires,duration,summary,source_urls,source_quality,in_upstream,notes,eia_id,ba_code")
        self.assertEqual(j(schema.UPDATES), "file,id,field,old,new,source_urls,source_quality,notes")
        self.assertEqual(j(schema.DATASET), "id,level,name,state,county_fips,place_geoid,lat,lon,type,scope,status,date_adopted,date_expires,duration_days,extended,summary,source_urls,upstream_id,verify,date_uncertain,last_verified,eia_id")

    def good(self, id="b", **kw):
        r = {"id": id, "jurisdiction_name": "X", "jurisdiction_level": "city", "state": "OH", "type": "permanent ban",
             "status": "active", "source_urls": "https://e.org", "source_quality": "primary", "kind": "new"}
        r.update(kw)
        return r

    def test_validate_row(self):
        self.assertEqual(schema.validate_row(self.good()), [])
        self.assertTrue(schema.validate_row(self.good(status="done")))
        self.assertTrue(schema.validate_row(self.good(type="ban")))
        self.assertTrue(schema.validate_row(self.good(source_quality="")))
        self.assertTrue(schema.validate_row(self.good(kind="other")))
        self.assertTrue(schema.validate_row(self.good(bogus="1")))
        self.assertEqual(schema.validate_row({"id": "u", "file": "f", "field": "status"}, "updates"), [])

    def test_writer_sorted_deterministic(self):
        rows = [self.good("b", summary='has, comma and "quote"'), self.good("a")]
        with tempfile.TemporaryDirectory() as d:
            p1, p2 = Path(d, "1.csv"), Path(d, "2.csv")
            schema.write_rows(p1, "moratoriums", rows)
            schema.write_rows(p2, "moratoriums", list(reversed(rows)))
            b = p1.read_bytes()
            self.assertEqual(b, p2.read_bytes())
            self.assertNotIn(b"\r", b)
            self.assertEqual(b.decode().splitlines()[0], ",".join(schema.MORATORIUMS))
            with open(p1, encoding="utf-8", newline="") as f:
                got = list(csv.DictReader(f))
            self.assertEqual([r["id"] for r in got], ["a", "b"])
            self.assertEqual(got[1]["summary"], 'has, comma and "quote"')
            with self.assertRaises(ValueError):
                schema.write_rows(p1, "moratoriums", [self.good(bogus="1")])


if __name__ == "__main__":
    unittest.main()
