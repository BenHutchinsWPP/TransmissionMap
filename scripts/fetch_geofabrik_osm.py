#!/usr/bin/env python3
"""
fetch_geofabrik_osm.py — Download and manage continental OSM extracts from Geofabrik.

Geofabrik (https://download.geofabrik.de/) provides daily/regular continental
extracts in .osm.pbf format. This script downloads, verifies md5 checksums, and
optionally filters energy infrastructure tags using osmium-tool into compact
regional .osm.pbf files.

Regions supported:
  - north-america      (https://download.geofabrik.de/north-america-latest.osm.pbf)
  - europe             (https://download.geofabrik.de/europe-latest.osm.pbf)
  - asia               (https://download.geofabrik.de/asia-latest.osm.pbf)
  - south-america      (https://download.geofabrik.de/south-america-latest.osm.pbf)
  - africa             (https://download.geofabrik.de/africa-latest.osm.pbf)
  - oceania            (https://download.geofabrik.de/australia-oceania-latest.osm.pbf)
  - central-america    (https://download.geofabrik.de/central-america-latest.osm.pbf)
  - antarctica         (https://download.geofabrik.de/antarctica-latest.osm.pbf)

Usage:
  python scripts/fetch_geofabrik_osm.py --list
  python scripts/fetch_geofabrik_osm.py --region europe --dry-run
  python scripts/fetch_geofabrik_osm.py --region north-america
  python scripts/fetch_geofabrik_osm.py --region all --filter-tags
"""

import argparse
import hashlib
import logging
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from typing import Dict, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fetch_geofabrik_osm")

GEOFABRIK_BASE = "https://download.geofabrik.de"

# Canonical Geofabrik continental extract catalogue (ordered sequentially)
CONTINENTAL_EXTRACTS: Dict[str, Dict[str, str]] = {
    "antarctica": {
        "url": f"{GEOFABRIK_BASE}/antarctica-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/antarctica-latest.osm.pbf.md5",
        "approx_size": "0.05 GB",
        "description": "Antarctica research stations & infrastructure",
    },
    "central-america": {
        "url": f"{GEOFABRIK_BASE}/central-america-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/central-america-latest.osm.pbf.md5",
        "approx_size": "0.9 GB",
        "description": "Central America (Guatemala, Panama, Costa Rica, Caribbean)",
    },
    "oceania": {
        "url": f"{GEOFABRIK_BASE}/australia-oceania-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/australia-oceania-latest.osm.pbf.md5",
        "approx_size": "1.8 GB",
        "description": "Australia & Oceania (Australia, NZ, Pacific Islands)",
    },
    "south-america": {
        "url": f"{GEOFABRIK_BASE}/south-america-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/south-america-latest.osm.pbf.md5",
        "approx_size": "3.8 GB",
        "description": "South America (Brazil, Argentina, Colombia, Chile, etc.)",
    },
    "africa": {
        "url": f"{GEOFABRIK_BASE}/africa-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/africa-latest.osm.pbf.md5",
        "approx_size": "6.5 GB",
        "description": "Africa (All African nations and islands)",
    },
    "north-america": {
        "url": f"{GEOFABRIK_BASE}/north-america-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/north-america-latest.osm.pbf.md5",
        "approx_size": "13 GB",
        "description": "North America (USA, Canada, Greenland, Mexico)",
    },
    "asia": {
        "url": f"{GEOFABRIK_BASE}/asia-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/asia-latest.osm.pbf.md5",
        "approx_size": "14 GB",
        "description": "Asia (China, India, Japan, Southeast Asia, Middle East)",
    },
    "europe": {
        "url": f"{GEOFABRIK_BASE}/europe-latest.osm.pbf",
        "md5_url": f"{GEOFABRIK_BASE}/europe-latest.osm.pbf.md5",
        "approx_size": "28 GB",
        "description": "Europe (EU, UK, Western Russia, Balkans, Scandinavia)",
    },
}

# Tag filter query for energy infrastructure extraction
ENERGY_TAG_EXPRESSIONS = [
    "nwr/power=line",
    "nwr/power=minor_line",
    "nwr/power=cable",
    "nwr/power=substation",
    "nwr/power=plant",
    "nwr/power=generator",
    "nwr/power=transformer",
    "nwr/power=switch",
    "nwr/power=pole",
    "nwr/power=tower",
    "nwr/man_made=pipeline",
    "nwr/pipeline=*",
    "nwr/building=data_centre",
    "nwr/building=data_center",
    "nwr/telecom=data_center",
    "nwr/telecom=data_centre",
]


def list_continents():
    print("\nGeofabrik Continental OSM Extracts:")
    print(f"{'Region':<18} {'Size':<10} {'Description':<50}")
    print("-" * 80)
    for region, info in CONTINENTAL_EXTRACTS.items():
        print(f"{region:<18} {info['approx_size']:<10} {info['description']:<50}")
    print("\nDownload base URL: https://download.geofabrik.de/\n")


def compute_md5(filepath: str, chunk_size: int = 65536) -> str:
    md5 = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            md5.update(chunk)
    return md5.hexdigest()


def fetch_md5(md5_url: str) -> Optional[str]:
    try:
        req = urllib.request.Request(md5_url, headers={"User-Agent": "TransmissionMap/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8").strip()
            return content.split()[0]
    except Exception as e:
        log.warning(f"Could not retrieve remote MD5 from {md5_url}: {e}")
        return None


def get_remote_file_size(url: str) -> int:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "TransmissionMap/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return int(resp.headers.get("Content-Length", 0))
    except Exception:
        return 0


def download_file(url: str, dest_path: str, max_retries: int = 50, dry_run: bool = False):
    if dry_run:
        log.info(f"[dry-run] Would download {url} -> {dest_path}")
        return

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    expected_size = get_remote_file_size(url)

    if os.path.exists(dest_path):
        current_size = os.path.getsize(dest_path)
        if expected_size > 0 and current_size == expected_size:
            log.info(f"File already fully downloaded ({current_size / (1024*1024*1024):.2f} GB): {dest_path}")
            return
        elif expected_size > 0 and current_size > expected_size:
            log.warning(f"Local file larger than expected ({current_size} > {expected_size}); redownloading...")
            os.remove(dest_path)
        elif current_size > 0:
            log.info(f"Resuming download of {dest_path} ({current_size / (1024*1024*1024):.2f} GB / {expected_size / (1024*1024*1024):.2f} GB)...")

    log.info(f"Downloading {url} -> {dest_path}")

    # Use curl with resume support and retry loop for dropped connections
    if shutil.which("curl"):
        for attempt in range(1, max_retries + 1):
            cmd = [
                "curl", "-L", "-C", "-",
                "--retry", "5",
                "--retry-delay", "5",
                "-A", "TransmissionMap/1.0 (local data pipeline)",
                "-o", dest_path,
                url,
            ]
            res = subprocess.run(cmd)
            if res.returncode == 0:
                break
            # Common curl transient error codes: 18 (partial file), 28 (timeout), 56 (recv error)
            log.warning(f"curl exited with code {res.returncode} (attempt {attempt}/{max_retries}); resuming in 5s...")
            time.sleep(5)
    else:
        temp_path = dest_path + ".part"
        req = urllib.request.Request(url, headers={"User-Agent": "TransmissionMap/1.0 (local data pipeline)"})
        with urllib.request.urlopen(req) as resp, open(temp_path, "wb") as out:
            total_size = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1024 * 1024
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    percent = (downloaded / total_size) * 100
                    mb_down = downloaded / (1024 * 1024)
                    mb_tot = total_size / (1024 * 1024)
                    print(f"\r  {mb_down:.1f}/{mb_tot:.1f} MB ({percent:.1f}%)", end="", flush=True)
        print()
        os.rename(temp_path, dest_path)

    log.info(f"Saved {dest_path}")


def filter_energy_tags(input_pbf: str, output_pbf: str, dry_run: bool = False, force: bool = False):
    if not shutil.which("osmium"):
        log.warning("osmium tool not found in PATH; skipping tag filter step.")
        return

    if dry_run:
        log.info(f"[dry-run] Would run osmium tags-filter on {input_pbf} -> {output_pbf}")
        return

    if not force and os.path.exists(output_pbf) and os.path.getsize(output_pbf) > 1024:
        log.info(f"Filtered extract already exists: {output_pbf}")
        return

    cmd = [
        "osmium", "tags-filter", input_pbf,
        *ENERGY_TAG_EXPRESSIONS,
        "-o", output_pbf,
        "--overwrite",
    ]
    log.info(f"Filtering energy infrastructure tags: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    log.info(f"Created filtered extract: {output_pbf}")


def process_region(region: str, out_dir: str, filter_tags: bool, dry_run: bool, verify: bool, force: bool = False):
    if region not in CONTINENTAL_EXTRACTS:
        log.error(f"Unknown region '{region}'. Use --list to see available regions.")
        return False

    info = CONTINENTAL_EXTRACTS[region]
    filename = os.path.basename(info["url"])
    target_path = os.path.join(out_dir, filename)

    if not os.path.exists(target_path):
        download_file(info["url"], target_path, dry_run=dry_run)
    else:
        log.info(f"Using existing raw extract: {target_path} ({os.path.getsize(target_path) / (1024*1024*1024):.2f} GB)")

    if verify and os.path.exists(target_path) and not dry_run:
        log.info(f"Verifying checksum for {target_path}...")
        local_md5 = compute_md5(target_path)
        remote_md5 = fetch_md5(info["md5_url"])
        if remote_md5:
            if local_md5.lower() == remote_md5.lower():
                log.info(f"✓ MD5 checksum verified: {local_md5}")
            else:
                log.error(f"✗ MD5 mismatch! Local: {local_md5} vs Remote: {remote_md5}")
                return False

    if filter_tags and (os.path.exists(target_path) or dry_run):
        stem = filename.replace(".osm.pbf", "")
        filtered_path = os.path.join(out_dir, f"{stem}_filtered.osm.pbf")
        filter_energy_tags(target_path, filtered_path, dry_run=dry_run, force=force)

    return True


def main():
    parser = argparse.ArgumentParser(description="Download and filter Geofabrik continental OSM extracts.")
    parser.add_argument("--region", type=str, help="Continent region code (e.g. europe, asia, north-america, all)")
    parser.add_argument("--list", action="store_true", help="List all available continental extracts")
    parser.add_argument("--out-dir", type=str, default="data/raw/osm", help="Directory to save raw .osm.pbf files")
    parser.add_argument("--filter-tags", action="store_true", help="Run osmium tags-filter after download")
    parser.add_argument("--verify", action="store_true", help="Verify MD5 checksum against remote")
    parser.add_argument("--dry-run", action="store_true", help="Print download plan without downloading")
    parser.add_argument("--force", action="store_true", help="Force re-filtering even if filtered extract exists")

    args = parser.parse_args()

    if args.list:
        list_continents()
        return

    if not args.region:
        parser.print_help()
        sys.exit(1)

    regions = list(CONTINENTAL_EXTRACTS.keys()) if args.region.lower() == "all" else [args.region.lower()]

    for r in regions:
        success = process_region(r, args.out_dir, args.filter_tags, args.dry_run, args.verify, force=args.force)
        if not success:
            sys.exit(1)


if __name__ == "__main__":
    main()
