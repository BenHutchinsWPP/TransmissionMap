"""Every FIELD_SCHEMA field is carried by its tileset.

src/registry/field-schema.ts declares the fields a view's `where` conditions
and the legend filters may name, per tile_manifest.yaml dataset id. A field
missing from that dataset's `select:` compiles into a filter that matches
nothing, so each one must appear there. The TypeScript is read with a small
scanner rather than a TS toolchain: top-level keys of FIELD_SCHEMA are dataset
ids, and the keys one level inside are field names.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_TS = ROOT / "src" / "registry" / "field-schema.ts"
TILE_MANIFEST = ROOT / "scripts" / "tile_manifest.yaml"


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


def manifest_selects() -> dict[str, list[str] | None]:
    import yaml
    manifest = yaml.safe_load(TILE_MANIFEST.read_text())
    return {e["id"]: e.get("select") for e in manifest["layers"]}


class FieldSchemaInTiles(unittest.TestCase):
    def test_scanner_reads_the_schema(self):
        fields = schema_fields()
        self.assertIn("eia_generators", fields)
        self.assertIn("nameplate_mw", fields["eia_generators"])
        self.assertEqual(fields["hifld_substations"], {"max_kv"})
        self.assertGreaterEqual(len(fields), 14)
        for dataset, names in fields.items():
            self.assertTrue(names, f"{dataset} yielded no fields (named constant?)")

    def test_every_schema_field_is_selected(self):
        try:
            import yaml  # noqa: F401
        except ImportError:  # the stdlib-only CI runners; `make test-pipeline` has it
            self.skipTest("PyYAML is not installed")
        selects = manifest_selects()
        for dataset, names in schema_fields().items():
            with self.subTest(dataset=dataset):
                self.assertIn(dataset, selects, "no tile_manifest.yaml entry")
                select = selects[dataset]
                self.assertIsNotNone(select, "entry has no select: list")
                self.assertEqual(sorted(names - set(select)), [],
                                 f"fields absent from {dataset} select:")


if __name__ == "__main__":
    unittest.main()
