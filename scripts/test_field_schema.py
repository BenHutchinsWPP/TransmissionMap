"""Every FIELD_SCHEMA field is carried by its tileset.

src/registry/field-schema.ts declares the fields a view's `where` conditions
and the legend filters may name, per tile_manifest.yaml dataset id. A field
missing from that dataset's `select:` compiles into a filter that matches
nothing, so each one must appear there. The TypeScript is read with a small
scanner rather than a TS toolchain: top-level keys of FIELD_SCHEMA are dataset
ids, and the keys one level inside are field names.

Region fields (region_join.REGION_FIELDS) are checked both ways against what
the pipeline writes, read from code rather than the manifest `select:`:
  * world datasets — build_global_tiles.py's per-spec `fields` (RETILE,
    TILE_POLYGONS), LINE_FIELDS for transmission, GLOBAL_FIELDS for the
    CONCAT_GEOJSON point layers;
  * US datasets with a `select:` — the region fields that select keeps;
  * US datasets without one (and the built-elsewhere hydrothermal points) —
    their Makefile REGION_TAG_FILES entry, with its `--fields` case or the
    usa scope's fields;
  * mines — extract_mines.py's tag_features(…, "usa", …) call.
A tagged dataset with no schema entry fails, as does a schema region field the
pipeline does not write. Datasets without a `select:` may declare region fields
only. A built-elsewhere entry's `select:` records the properties its script
writes (BUILT_ELSEWHERE_SCRIPTS), and must equal them.
"""

import ast
import re
import unittest
from pathlib import Path

import build_global_tiles as bgt
import region_join

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_TS = ROOT / "src" / "registry" / "field-schema.ts"
TILE_MANIFEST = ROOT / "scripts" / "tile_manifest.yaml"
MAKEFILE = ROOT / "Makefile"
EXTRACT_MINES = ROOT / "scripts" / "extract_mines.py"
# Built-elsewhere dataset → the script whose `"properties": {…}` literal writes its features.
BUILT_ELSEWHERE_SCRIPTS = {
    "mines": EXTRACT_MINES,
    "dc_moratoriums": ROOT / "scripts" / "moratoriums" / "build_layer.py",
}
# Built-elsewhere datasets with no script: the served file is edited by hand.
HAND_MAINTAINED = {"wecc_paths"}
REGION = set(region_join.REGION_FIELDS)


def schema_fields() -> dict[str, set[str]]:
    src = SCHEMA_TS.read_text()
    start = src.index("export const FIELD_SCHEMA")
    body = src[src.index("{", start):]
    body = re.sub(r"'[^']*'|\"[^\"]*\"|//[^\n]*", "''", body)
    fields: dict[str, set[str]] = {}
    depth, dataset = 0, None
    for m in re.finditer(r"(\w+)\s*:|([{}])", body):
        if m.group(2) == "{":
            depth += 1
        elif m.group(2) == "}":
            depth -= 1
            if depth == 0:
                break
        elif depth == 1:
            dataset = m.group(1)
            fields[dataset] = set()
        elif depth == 2:
            fields[dataset].add(m.group(1))
    return fields


def load_manifest() -> dict:
    import yaml
    return yaml.safe_load(TILE_MANIFEST.read_text())


def world_region_fields() -> dict[str, set[str]]:
    """World dataset id → the region fields build_global_tiles.py tags it with."""
    out = {s["base"]: set(s["fields"]) for s in bgt.RETILE + bgt.TILE_POLYGONS}
    out[bgt.TRANSMISSION_BASE] = set(bgt.LINE_FIELDS)
    for base in bgt.CONCAT_GEOJSON:
        out[base] = set(bgt.GLOBAL_FIELDS)
    return out


def makefile_region_tags() -> dict[str, set[str]]:
    """Each REGION_TAG_FILES path (relative to data/build) → the fields
    `make region-tags` writes on it."""
    text = MAKEFILE.read_text().replace("\\\n", " ")
    files = re.search(r"^REGION_TAG_FILES\s*:=\s*(.+)$", text, re.M).group(1).split()
    recipe = text[text.index("\nregion-tags:"):]
    recipe = recipe[:recipe.index("\n\n")]
    custom = {}
    for pats, opts in re.findall(r"([\w./|]+)\)\s*opts=\"([^\"]*)\"", recipe):
        m = re.search(r"--fields (\S+)", opts)
        for p in pats.split("|"):
            if m:
                custom[p] = set(m.group(1).split(","))
    usa = set(region_join.SCOPES["usa"])
    return {f: custom.get(f, usa) for f in files}


def mines_region_fields() -> set[str]:
    call = re.search(r"tag_features\(([^,]+,\s*\"(\w+)\"[^)]*)\)", EXTRACT_MINES.read_text())
    scope = call.group(2)
    m = re.search(r"fields=\(?([^)]*)", call.group(1))
    return set(re.findall(r"\"(\w+)\"", m.group(1))) if m else set(region_join.SCOPES[scope])


def pipeline_region_fields(manifest: dict) -> dict[str, set[str]]:
    """Dataset id → the region fields the pipeline writes on what is served."""
    world = world_region_fields()
    tags = makefile_region_tags()
    by_stem = {Path(f).stem: f for f in tags}
    out: dict[str, set[str]] = {}
    for e in manifest["layers"]:
        ds, select = e["id"], e.get("select")
        if ds in world:
            out[ds] = world[ds]
        elif select is not None:
            if REGION & set(select):
                out[ds] = REGION & set(select)
        else:
            src = e.get("src", "").removeprefix("data/build/")
            if src in tags:
                out[ds] = tags[src]
    for e in manifest.get("built_elsewhere", []):
        ds = e["id"]
        if ds == "mines":
            out[ds] = mines_region_fields()
        elif ds in by_stem:
            out[ds] = tags[by_stem[ds]]
    return out


def written_properties(script: Path) -> list[str]:
    """The keys of the one `"properties": {…}` dict literal in `script`, read with ast."""
    found = [v for node in ast.walk(ast.parse(script.read_text())) if isinstance(node, ast.Dict)
             for k, v in zip(node.keys, node.values)
             if isinstance(k, ast.Constant) and k.value == "properties" and isinstance(v, ast.Dict)]
    assert len(found) == 1, f"{script.name}: {len(found)} \"properties\" dict literals"
    return [k.value for k in found[0].keys if isinstance(k, ast.Constant)]


def needs_yaml(test):
    try:
        import yaml  # noqa: F401
    except ImportError:  # the stdlib-only CI runners; `make test-pipeline` has it
        test.skipTest("PyYAML is not installed")


class FieldSchemaInTiles(unittest.TestCase):
    def test_scanner_reads_the_schema(self):
        fields = schema_fields()
        self.assertIn("eia_generators", fields)
        self.assertIn("nameplate_mw", fields["eia_generators"])
        self.assertEqual(fields["hifld_substations"],
                         {"max_kv", "min_kv", "states", "counties", "ba", "nerc", "retail"})
        self.assertEqual(fields["osm_transmission_lines"],
                         {"nominal_kv", "countries", "admin1", "counties", "ba", "nerc"})
        self.assertGreaterEqual(len(fields), 20)
        for dataset, names in fields.items():
            self.assertTrue(names, f"{dataset} yielded no fields (named constant?)")

    def test_the_pipeline_sources_are_read(self):
        self.assertEqual(makefile_region_tags()["transmission_hifld.gpkg"], {"states", "counties", "ba", "nerc"})
        self.assertEqual(makefile_region_tags()["generator_eia.csv"], set(region_join.SCOPES["usa"]))
        self.assertEqual(mines_region_fields(), set(region_join.SCOPES["usa"]))
        self.assertEqual(world_region_fields()["osm_datacenters"], set(bgt.GLOBAL_FIELDS))

    def test_every_non_region_field_is_selected(self):
        needs_yaml(self)
        manifest = load_manifest()
        selects = {e["id"]: e.get("select") for e in manifest["layers"] + manifest.get("built_elsewhere", [])}
        elsewhere = {e["id"] for e in manifest.get("built_elsewhere", [])}
        for dataset, names in schema_fields().items():
            with self.subTest(dataset=dataset):
                self.assertTrue(dataset in selects or dataset in elsewhere, "no tile_manifest.yaml entry")
                other = names - REGION
                select = selects.get(dataset)
                if select is None:
                    self.assertEqual(sorted(other), [],
                                     f"{dataset} has no select: list, so it may declare region fields only")
                else:
                    self.assertEqual(sorted(other - set(select)), [],
                                     f"fields absent from {dataset} select:")

    def test_built_elsewhere_select_is_what_the_script_writes(self):
        needs_yaml(self)
        self.assertEqual(written_properties(EXTRACT_MINES)[:3], ["mine_id", "name", "status"])
        for e in load_manifest().get("built_elsewhere", []):
            if "select" in e and e["id"] not in HAND_MAINTAINED:
                with self.subTest(dataset=e["id"]):
                    self.assertIn(e["id"], BUILT_ELSEWHERE_SCRIPTS, "no script to check its select: against")
                    self.assertEqual(e["select"], written_properties(BUILT_ELSEWHERE_SCRIPTS[e["id"]]))

    def test_region_fields_match_the_pipeline_both_ways(self):
        needs_yaml(self)
        written = pipeline_region_fields(load_manifest())
        schema = schema_fields()
        self.assertGreaterEqual(len(written), 18)
        for dataset in sorted(set(written) | set(schema)):
            with self.subTest(dataset=dataset):
                declared = schema.get(dataset, set()) & REGION
                if dataset in written:
                    self.assertIn(dataset, schema, "region-tagged dataset has no FIELD_SCHEMA entry")
                self.assertEqual(sorted(declared), sorted(written.get(dataset, set())),
                                 f"{dataset}: FIELD_SCHEMA region fields differ from what the pipeline writes")


if __name__ == "__main__":
    unittest.main()
