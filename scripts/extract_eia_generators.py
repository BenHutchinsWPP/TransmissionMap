#!/usr/bin/env python3
"""
extract_eia_generators.py — Download and filter EIA Form 860 generators → CSV

Downloads EIA Form 860 if not present, joins plant and generator tables,
and writes a clean CSV for use as a standalone map layer.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EIA FORM 860 — ANNUAL ELECTRIC GENERATOR REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Source:   U.S. Energy Information Administration (EIA)
URL:      https://www.eia.gov/electricity/data/eia860/
License:  Public domain

Files used (early-release builds append _Early_Release to the stem):
  2___Plant_Y{year}.xlsx      — Plant Code, Plant Name, Latitude, Longitude,
                                State, NERC Region, Balancing Authority Code,
                                Utility Name, Sector Name
  3_1_Generator_Y{year}.xlsx  — Operable sheet: Plant Code, Generator ID,
                                Technology, Energy Source 1, Nameplate Capacity
                                (MW), Status, Operating Year, Planned Retirement
                                Year. Proposed sheet: same cols, with Effective
                                Year (planned online year) used as the op_year.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Usage:
  python scripts/extract_eia_generators.py
  python scripts/extract_eia_generators.py --year 2025 --file-suffix _Early_Release
  python scripts/extract_eia_generators.py -o data/build/generator_eia.csv
"""

import argparse
import logging
import os
import sys
import urllib.request
import zipfile
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract_eia_generators")

try:
    import pandas as pd
except ImportError:
    sys.stderr.write("ERROR: pandas missing. Run: source venv/bin/activate\n")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EIA860_URL = "https://www.eia.gov/electricity/data/eia860/xls/eia860{year}.zip"
EIA860_DIR = Path("data/raw/eia")


# ---------------------------------------------------------------------------
# EIA download + load
# ---------------------------------------------------------------------------
def _ensure_eia(eia_dir: Path, year: int = 2024, suffix: str = "") -> None:
    plant_file = eia_dir / f"2___Plant_Y{year}{suffix}.xlsx"
    gen_file   = eia_dir / f"3_1_Generator_Y{year}{suffix}.xlsx"
    if plant_file.exists() and gen_file.exists():
        log.debug("EIA 860 files already present — skipping download.")
        return

    eia_dir.mkdir(parents=True, exist_ok=True)
    zip_path = eia_dir / f"eia860{year}.zip"
    url = EIA860_URL.format(year=year)
    log.info("Downloading EIA Form 860 (%d) from:\n  %s", year, url)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as resp, open(zip_path, "wb") as fout:
            total = 0
            while True:
                chunk = resp.read(1 << 17)
                if not chunk:
                    break
                fout.write(chunk)
                total += len(chunk)
        log.info("  Downloaded %.1f MB", total / 1e6)
    except Exception as e:
        log.error("Download failed: %s", e)
        sys.exit(1)

    log.info("Extracting ZIP → %s ...", eia_dir)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(eia_dir)
    zip_path.unlink(missing_ok=True)
    log.info("  Extraction complete.")


def _load_plant(eia_dir: Path, year: int, suffix: str = "", header: int = 1) -> "pd.DataFrame":
    path = eia_dir / f"2___Plant_Y{year}{suffix}.xlsx"
    log.info("Loading EIA Plant table: %s ...", path.name)
    df = pd.read_excel(path, sheet_name="Plant", header=header, dtype={"Plant Code": int})
    df = df.rename(columns={
        "Plant Code":               "plant_code",
        "Plant Name":               "plant_name",
        "Latitude":                 "lat",
        "Longitude":                "lon",
        "State":                    "state",
        "NERC Region":              "nerc_region",
        "Balancing Authority Code": "ba_code",
        "Utility Name":             "utility_name",
        "Sector Name":              "sector_name",
    })
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df = df.dropna(subset=["lat", "lon", "plant_code"])

    # Concat up to 3 pipeline name columns into a single '; '-separated field.
    # EIA uses "Other - Please explain in pipeline notes below." as a placeholder;
    # drop it and fall back to Pipeline Notes for those rows.
    _OTHER = "Other - Please explain in pipeline notes below."
    pipe_cols = ["Natural Gas Pipeline Name 1", "Natural Gas Pipeline Name 2", "Natural Gas Pipeline Name 3"]
    present = [c for c in pipe_cols if c in df.columns]
    if present:
        def _build_pipelines(row: "pd.Series") -> str:
            names = [v.strip() for v in row[present] if pd.notna(v) and str(v).strip() and str(v).strip() != _OTHER]
            if not names and "Pipeline Notes" in row.index and pd.notna(row["Pipeline Notes"]):
                return str(row["Pipeline Notes"]).strip()
            return "; ".join(names)

        notes_col = "Pipeline Notes" if "Pipeline Notes" in df.columns else None
        cols_for_apply = present + ([notes_col] if notes_col else [])
        df["pipelines"] = (
            df[cols_for_apply]
            .apply(_build_pipelines, axis=1)
            .replace("", pd.NA)
        )
    else:
        df["pipelines"] = pd.NA

    log.info("  Plants loaded: %d", len(df))
    return df[["plant_code", "plant_name", "lat", "lon",
               "state", "nerc_region", "ba_code", "utility_name",
               "sector_name", "pipelines"]].reset_index(drop=True)


def _load_generators(eia_dir: Path, year: int, suffix: str = "", header: int = 1) -> "pd.DataFrame":
    path = eia_dir / f"3_1_Generator_Y{year}{suffix}.xlsx"
    log.info("Loading EIA Operable generator table: %s ...", path.name)
    df = pd.read_excel(path, sheet_name="Operable", header=header,
                       dtype={"Plant Code": float, "Generator ID": str})
    df = df.rename(columns={
        "Plant Code":              "plant_code",
        "Generator ID":            "generator_id",
        "Technology":              "technology",
        "Energy Source 1":         "energy_source",
        "Nameplate Capacity (MW)": "nameplate_mw",
        "Status":                  "status",
        "Operating Year":          "op_year",
        "Prime Mover":             "prime_mover",
        "Planned Retirement Year": "retirement_year",
    })
    df["plant_code"]    = pd.to_numeric(df["plant_code"],    errors="coerce").astype("Int64")
    df["nameplate_mw"]  = pd.to_numeric(df["nameplate_mw"],  errors="coerce")
    df["op_year"]       = pd.to_numeric(df["op_year"],       errors="coerce").astype("Int64")
    df["retirement_year"] = pd.to_numeric(df["retirement_year"], errors="coerce").astype("Int64")
    df = df.dropna(subset=["plant_code", "generator_id"])

    # Keep only operating and standby units
    df = df[df["status"].isin({"OP", "SB"})]

    # Generators with a future planned retirement year → "retirement"; others → "existing"
    df["gen_status"] = "existing"
    df.loc[df["retirement_year"].notna() & (df["retirement_year"] >= year), "gen_status"] = "retirement"

    log.info("  Operable generators loaded: %d  (%d retirement, %d existing)",
             len(df), (df["gen_status"] == "retirement").sum(), (df["gen_status"] == "existing").sum())
    return df[["plant_code", "generator_id", "technology", "energy_source",
               "nameplate_mw", "status", "op_year", "prime_mover",
               "retirement_year", "gen_status"]].reset_index(drop=True)


def _load_proposed(eia_dir: Path, year: int, suffix: str = "", header: int = 1) -> "pd.DataFrame":
    path = eia_dir / f"3_1_Generator_Y{year}{suffix}.xlsx"
    log.info("Loading EIA Proposed generator table: %s ...", path.name)
    df = pd.read_excel(path, sheet_name="Proposed", header=header,
                       dtype={"Plant Code": float, "Generator ID": str})
    df = df.rename(columns={
        "Plant Code":              "plant_code",
        "Generator ID":            "generator_id",
        "Technology":              "technology",
        "Energy Source 1":         "energy_source",
        "Nameplate Capacity (MW)": "nameplate_mw",
        "Status":                  "status",
        "Effective Year":          "op_year",
        "Prime Mover":             "prime_mover",
    })
    df["plant_code"]   = pd.to_numeric(df["plant_code"],   errors="coerce").astype("Int64")
    df["nameplate_mw"] = pd.to_numeric(df["nameplate_mw"], errors="coerce")
    # Proposed units: op_year = planned online year (EIA "Effective Year"), not the
    # report year ("Current Year"). This is the unit's expected commercial-operation date.
    df["op_year"]      = pd.to_numeric(df["op_year"],      errors="coerce").astype("Int64")
    df = df.dropna(subset=["plant_code", "generator_id"])
    df["retirement_year"] = pd.NA
    df["gen_status"] = "proposed"
    log.info("  Proposed generators loaded: %d", len(df))
    return df[["plant_code", "generator_id", "technology", "energy_source",
               "nameplate_mw", "status", "op_year", "prime_mover",
               "retirement_year", "gen_status"]].reset_index(drop=True)


def _load_retired(eia_dir: Path, year: int, suffix: str = "", header: int = 1) -> "pd.DataFrame":
    path = eia_dir / f"3_1_Generator_Y{year}{suffix}.xlsx"
    log.info("Loading EIA Retired generator table: %s ...", path.name)
    df = pd.read_excel(path, sheet_name="Retired and Canceled", header=header,
                       dtype={"Plant Code": float, "Generator ID": str})
    df = df.rename(columns={
        "Plant Code":              "plant_code",
        "Generator ID":            "generator_id",
        "Technology":              "technology",
        "Energy Source 1":         "energy_source",
        "Nameplate Capacity (MW)": "nameplate_mw",
        "Status":                  "status",
        "Operating Year":          "op_year",
        "Prime Mover":             "prime_mover",
        "Retirement Year":         "retirement_year",
    })
    df["plant_code"]      = pd.to_numeric(df["plant_code"],      errors="coerce").astype("Int64")
    df["nameplate_mw"]    = pd.to_numeric(df["nameplate_mw"],    errors="coerce")
    df["op_year"]         = pd.to_numeric(df["op_year"],         errors="coerce").astype("Int64")
    df["retirement_year"] = pd.to_numeric(df["retirement_year"], errors="coerce").astype("Int64")
    df = df.dropna(subset=["plant_code", "generator_id"])
    # Exclude canceled (never operated) — keep only units that were actually retired
    df = df[df["status"] == "RE"]
    df["gen_status"] = "retired"
    log.info("  Retired generators loaded: %d", len(df))
    return df[["plant_code", "generator_id", "technology", "energy_source",
               "nameplate_mw", "status", "op_year", "prime_mover",
               "retirement_year", "gen_status"]].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Build output
# ---------------------------------------------------------------------------
def build_output(plant_df: "pd.DataFrame", gen_df: "pd.DataFrame") -> "pd.DataFrame":
    merged = gen_df.merge(plant_df, on="plant_code", how="left")

    # mw_range bucket
    _mw = pd.to_numeric(merged["nameplate_mw"], errors="coerce")
    _cats = pd.cut(
        _mw.where(_mw > 0),
        bins=[0, 5, 10, 20, 100, 500, 1000, float("inf")],
        labels=["<5", "5-10", "10-20", "20-100", "100-500", "500-1000", "1000+"],
        right=False,
    )
    merged["mw_range"] = _cats.cat.add_categories("unknown").fillna("unknown").astype(str)

    col_order = [
        "plant_code", "plant_name", "lat", "lon", "state", "nerc_region", "ba_code",
        "generator_id", "technology", "energy_source", "nameplate_mw", "mw_range",
        "status", "op_year", "prime_mover", "retirement_year", "gen_status",
        "utility_name", "sector_name", "pipelines",
    ]
    return merged[[c for c in col_order if c in merged.columns]]


def write_csv(df: "pd.DataFrame", out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(str(out_path), index=False)
    log.info("OUTPUT: %s  (%d records)", out_path, len(df))
    mw = pd.to_numeric(df["nameplate_mw"], errors="coerce")
    log.info("  ≥ 100 MW : %d  |  mw_range breakdown:", (mw >= 100).sum())
    for rng, cnt in df["mw_range"].value_counts().items():
        log.info("    %-12s %d", rng, cnt)
    if "gen_status" in df.columns:
        log.info("  gen_status breakdown:")
        for status, cnt in df["gen_status"].value_counts().items():
            log.info("    %-12s %d", status, cnt)
    if "energy_source" in df.columns:
        log.info("  Top energy sources:")
        for src, cnt in df["energy_source"].value_counts().head(8).items():
            log.info("    %-6s %d", src, cnt)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Download and filter EIA Form 860 generators → CSV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument(
        "-o", "--output",
        default="data/build/generator_eia.csv",
        help="Output CSV path (default: data/build/generator_eia.csv)",
    )
    ap.add_argument(
        "-E", "--eia-dir",
        default="data/raw/eia",
        help="Directory containing (or to download) EIA 860 files (default: data/raw/eia)",
    )
    ap.add_argument(
        "--year", type=int, default=2024,
        help="EIA 860 form year (default: 2024)",
    )
    ap.add_argument(
        "--file-suffix", default="",
        help="Filename suffix after the year, e.g. _Early_Release (default: '')",
    )
    ap.add_argument(
        "--header-row", type=int, default=1,
        help="0-based header row index in each sheet (default: 1; early release: 2)",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    os.chdir(Path(__file__).parent.parent)

    eia_dir = Path(args.eia_dir)
    suffix  = args.file_suffix
    header  = args.header_row

    _ensure_eia(eia_dir, args.year, suffix)
    plant_df    = _load_plant(eia_dir, args.year, suffix, header)
    gen_df      = _load_generators(eia_dir, args.year, suffix, header)
    proposed_df = _load_proposed(eia_dir, args.year, suffix, header)
    retired_df  = _load_retired(eia_dir, args.year, suffix, header)

    combined = pd.concat([gen_df, proposed_df, retired_df], ignore_index=True)
    df = build_output(plant_df, combined)
    write_csv(df, Path(args.output))


if __name__ == "__main__":
    main()
