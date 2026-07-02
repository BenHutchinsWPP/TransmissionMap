# =============================================================================
# TransmissionMap — single entry point.
#
# Quick start (host with osmium + gdal + tippecanoe installed):
#   make install      # create venv, install Python deps
#   make pipeline     # OSM PBF → SHPs/CSVs in data/build/
#   make tiles        # data/build/* → data/{transmission,substations,...}/* PMTiles
#   make web          # serve the static site on http://localhost:8000
# =============================================================================

# Tweak by setting on the command line: `make pipeline PYTHON=python3.12`
PYTHON      ?= python3
VENV        ?= venv
# Windows venvs put the interpreter in Scripts/; Unix uses bin/.
# $(OS) is "Windows_NT" under Git Bash/cmd and empty on Linux/macOS/WSL.
ifeq ($(OS),Windows_NT)
  PY        := $(VENV)/Scripts/python.exe
else
  PY        := $(VENV)/bin/python
endif
SCRIPTS     := scripts
RAW_OSM     := data/raw/osm
BUILD       := data/build
PORT        ?= 8000

# Files used to detect that a stage has run; let `make` skip work intelligently.
PBF_GLOB    := $(RAW_OSM)/*.osm.pbf
HIFLD_DIR   := data/raw/hifld
EIA_DIR     := data/raw/eia

.PHONY: help install pipeline land regions natgas wind solar geo hydro-pts popden mines wildfire-dev smoke-dev validate tiles releases publish-data web clean clean-build distclean check

help:
	@echo "TransmissionMap targets:"
	@echo "  make install     create venv + install Python deps + verify system tools"
	@echo "  make pipeline    OSM PBF → SHP/CSV in $(BUILD)/"
	@echo "  make land        build PAD-US + Tribal land layers → $(BUILD)/{padus,tribal_lands}.gpkg (no OSM needed)"
	@echo "  make regions     build NERC/BA/Retail region layers → $(BUILD)/ (manual parquet input)"
	@echo "  make natgas      build HIFLD natural gas pipelines + points → $(BUILD)/ (manual parquet input)"
	@echo "  make wind        build NREL/NLR Wind Resource raster → data/layers/nlr_wind_100m.pmtiles + COG in data/build/"
	@echo "  make solar       build Global Solar Atlas PVOUT raster → data/layers/gsa_solar_pvout.pmtiles + COG in data/build/"
	@echo "  make geo         build IHFC heat flow raster → data/layers/ihfc_geo_heatflow.pmtiles + COG in data/build/"
	@echo "  make hydro-pts   build NREL/DOE hydrothermal points → data/layers/nrel_hydrothermal_pts.geojson.gz"
	@echo "  make popden      build WorldPop 2020 population density → data/layers/worldpop_pop_density.pmtiles + COG in data/build/"
	@echo "  make validate    sanity-check build inputs (rows/CRS) + data/layers outputs vs constants.ts + tile/release manifest agreement"
	@echo "  make tiles       $(BUILD)/ → PMTiles + GeoJSON + ZIPs for the web app"
	@echo "  make releases    build per-layer download ZIPs → data/releases/"
	@echo "  make publish-data force-push data/layers + data/releases → orphan 'data-static' branch (raw host; needs public repo)"
	@echo "  make web         serve the static site on http://localhost:$(PORT)"
	@echo "  make clean-build remove $(BUILD)/ (keep data/layers + data/releases)"
	@echo "  make clean       remove $(BUILD)/ AND data/layers + data/releases"
	@echo "  make distclean   clean + remove venv"
	@echo "  make check       verify external tools (osmium, ogr2ogr, tippecanoe, pandoc, pmtiles, zip)"

# ── Install ─────────────────────────────────────────────────────────────────
# Combines system-tool install (apt/dnf/brew) with venv + pip.  Idempotent.
install: $(VENV)/.installed

$(VENV)/.installed: requirements.txt
	@echo "── Installing system tools (osmium-tool, gdal-bin) ──"
	@if command -v apt-get >/dev/null 2>&1; then \
	    sudo apt-get install -y -qq osmium-tool gdal-bin libgdal-dev pandoc 2>/dev/null || \
	        echo "  ⚠ apt install failed (try manually)"; \
	elif command -v dnf >/dev/null 2>&1; then \
	    sudo dnf install -y -q osmium-tool gdal gdal-devel pandoc 2>/dev/null || \
	        echo "  ⚠ dnf install failed"; \
	elif command -v brew >/dev/null 2>&1; then \
	    brew install osmium-tool gdal pandoc 2>/dev/null || \
	        echo "  ⚠ brew install failed"; \
	else \
	    echo "  ⚠ Unknown package manager — install osmium-tool + gdal-bin + pandoc manually."; \
	fi
	@echo ""
	@echo "── Creating virtualenv ($(VENV)) ──"
	@$(PYTHON) -m venv $(VENV)
	@$(PY) -m pip install --upgrade pip -q
	@$(PY) -m pip install -r requirements.txt -q
	@mkdir -p $(RAW_OSM) $(HIFLD_DIR) $(EIA_DIR) $(BUILD)
	@touch $(RAW_OSM)/.gitkeep
	@touch $@
	@echo ""
	@echo "Done. Next: place a .osm.pbf in $(RAW_OSM)/ and run 'make pipeline'."

check:
	@for t in osmium ogr2ogr tippecanoe pandoc pmtiles zip; do \
	    if command -v $$t >/dev/null 2>&1; then \
	        echo "  ✓ $$t"; \
	    else \
	        echo "  ✗ $$t  MISSING"; \
	    fi; \
	done

# ── Pipeline: PBF → SHP/CSV in data/build/ ─────────────────────────────────
# Each step writes its primary output to $(BUILD).  The final SHP renames
# (power_line_lines_processed → transmission_lines, etc.) happen at the end.
pipeline:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@if ! ls $(PBF_GLOB) >/dev/null 2>&1; then \
	    echo "ERROR: no .osm.pbf in $(RAW_OSM)/."; \
	    echo "Download from https://download.geofabrik.de/ and drop it there."; \
	    exit 1; \
	fi
	@mkdir -p $(BUILD)
	@echo "=== 1/9  OSM extraction (power lines + pipelines) ==="
	@$(PY) $(SCRIPTS)/extract_osm_lines.py --all-na
	@echo "=== 2/9  Enrich OSM tags (other_tags → columns) ==="
	@$(PY) $(SCRIPTS)/enrich_osm_tags.py $(BUILD)
	@echo "=== 3/9  OSM substations ==="
	@$(PY) $(SCRIPTS)/extract_osm_substations.py
	@echo "=== 4/9  OSM generators ==="
	@$(PY) $(SCRIPTS)/extract_osm_generators.py
	@echo "=== 4b/9 OSM data centers ==="
	@$(PY) $(SCRIPTS)/extract_osm_datacenters.py
	@echo "=== 5/9  OSM plants (with polygon hulls) ==="
	@$(PY) $(SCRIPTS)/extract_osm_plants.py --poly-shp $(BUILD)/plant_polygons.gpkg
	@echo "=== 6/9  HIFLD substations ==="
	@$(PY) $(SCRIPTS)/extract_hifld_substations.py
	@echo "=== 7/9  EIA generators ==="
	@$(PY) $(SCRIPTS)/extract_eia_generators.py --year 2025 --file-suffix _Early_Release --header-row 2
	@echo "=== 8/9  HIFLD transmission lines ==="
	@$(PY) $(SCRIPTS)/extract_hifld_lines.py
	@echo "=== 9/9  Land layers (Census TIGER Tribal + USGS PAD-US) ==="
	@$(PY) $(SCRIPTS)/extract_tribal_lands.py || \
	    echo "  [skip] tribal lands — place input at data/raw/aiannh/tl_2025_us_aiannh.zip (see script header)"
	@$(PY) $(SCRIPTS)/extract_padus.py || \
	    echo "  [skip] PAD-US — place input at data/raw/padus/PADUS4_1Geodatabase.gdb (see script header)"
	@$(PY) $(SCRIPTS)/extract_crithab.py || \
	    echo "  [skip] crithab — place input at data/raw/crithab/crithab_all_layers.zip (see script header)"
	@echo "=== Natural gas pipelines (HIFLD) ==="
	@$(PY) $(SCRIPTS)/extract_hifld_natgas.py || \
	    echo "  [skip] natgas — place parquet at data/raw/hifld/natgas/ (see script header)"
	@echo "=== Petroleum pipelines (EIA) ==="
	@$(PY) $(SCRIPTS)/extract_petroleum_pipelines.py || \
	    echo "  [skip] petroleum pipelines — EIA download failed (see script header)"
	@echo "=== Region boundaries (HIFLD) ==="
	@$(PY) $(SCRIPTS)/extract_regions.py || \
	    echo "  [skip] regions — place parquet at data/raw/hifld/regions/ (see script header)"
	@echo "=== Planned transmission (Our Grid Future) ==="
	@$(PY) $(SCRIPTS)/extract_ogf.py || \
	    echo "  [skip] OGF — place ZIP at data/raw/ogf/OurGridFuture_PlannedTransmissionProjects_Jun2026.zip (see script header)"
	@echo "── Renaming intermediate SHPs → final snake_case names ──"
	@$(MAKE) _rename
	@echo ""
	@echo "Done. Outputs in $(BUILD)/:"
	@ls -lh $(BUILD)/ 2>/dev/null | awk 'NR>1 {print "  " $$NF "  (" $$5 ")"}'

# Helper: copy a GeoPackage from one stem to another.
# Usage: $(call cp_shp,src_stem,dst_stem)
define cp_shp
@[ -f "$(BUILD)/$(1).gpkg" ] && cp "$(BUILD)/$(1).gpkg" "$(BUILD)/$(2).gpkg" \
    && echo "  $(1).gpkg -> $(2).gpkg" || true
endef

_rename:
	$(call cp_shp,power_line_lines_processed,transmission_lines)
	$(call cp_shp,pipeline_lines_processed,pipeline_routes)
	@if [ -f $(BUILD)/pipeline_feature_points_processed.csv ]; then \
	    cp $(BUILD)/pipeline_feature_points_processed.csv $(BUILD)/pipeline_points.csv; \
	    echo "  pipeline_feature_points_processed.csv -> pipeline_points.csv"; \
	elif [ -f $(BUILD)/pipeline_feature_points.csv ]; then \
	    cp $(BUILD)/pipeline_feature_points.csv $(BUILD)/pipeline_points.csv; \
	    echo "  pipeline_feature_points.csv -> pipeline_points.csv"; \
	fi

# ── Land layers only (independent of OSM PBF; inputs in data/raw/padus + aiannh)
land:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@mkdir -p $(BUILD)
	@$(PY) $(SCRIPTS)/extract_tribal_lands.py
	@$(PY) $(SCRIPTS)/extract_padus.py
	@$(PY) $(SCRIPTS)/extract_crithab.py || \
	    echo "  [skip] crithab — place input at data/raw/crithab/crithab_all_layers.zip (see script header)"

# ── Region boundary layers (NERC, Balancing Authorities, Retail Territories) ───
# Inputs: data/raw/hifld/regions/*.parquet (download from SeerAI/HIFLD)
regions:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@mkdir -p $(BUILD)
	@$(PY) $(SCRIPTS)/extract_regions.py

# ── Natural gas pipelines + points (HIFLD) ─────────────────────────────────
# Inputs: data/raw/hifld/natgas/*.parquet (manual download — see script header)
natgas:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@mkdir -p $(BUILD)
	@$(PY) $(SCRIPTS)/extract_hifld_natgas.py

# ── Wind resource raster (NREL/NLR WIND Toolkit, 100 m) ────────────────────
# Self-contained raster pipeline (gdal + pmtiles, no venv): the three regional
# zips in data/raw/wind/ → data/layers/nlr_wind_100m.pmtiles + data/build/nlr_wind_100m.tif
# See docs/data-sources.md for the Wayback URLs of the source zips.
wind:
	@bash $(SCRIPTS)/build_wind_resource.sh

# ── Solar resource raster (Global Solar Atlas PVOUT) ───────────────────────
# Self-contained raster pipeline (gdal + pmtiles, no venv). Auto-downloads the
# global GSA PVOUT zip to data/raw/solar/ → data/layers/gsa_solar_pvout.pmtiles +
# data/build/gsa_solar_pvout.tif. License CC BY 4.0 (attribution required).
solar:
	@bash $(SCRIPTS)/build_solar_resource.sh

# ── Geothermal resource raster (IHFC Global Heat Flow Database 2024) ───────
# Self-contained raster pipeline (gdal + pmtiles, no venv). Auto-downloads the
# IHFC 2024 zip (~18 MB) → IDW grid → data/layers/ihfc_geo_heatflow.pmtiles +
# data/build/ihfc_geo_heatflow.tif. License CC BY 4.0 (attribution required).
# NOTE: gdal_grid IDW step takes ~5-15 minutes for 33K NA points.
geo:
	@bash $(SCRIPTS)/build_geothermal_resource.sh

# ── Hydrothermal systems point layer (NREL/DOE GDR) ─────────────────────────
# Self-contained pipeline (ogr2ogr + python3, no venv). Auto-downloads 952 KB zip
# from gdr.openei.org → 1,214 circle points → data/layers/nrel_hydrothermal_pts.geojson.gz.
# Public domain (federal work, 17 U.S.C. § 105).
hydro-pts:
	@bash $(SCRIPTS)/build_hydrothermal_pts.sh

# ── Population density raster (WorldPop 2020, 1 km) ─────────────────────────
# Self-contained raster pipeline (gdal + pmtiles, no venv). Auto-downloads three
# ~50-70 MB GeoTIFFs (USA, CAN, MEX) from WorldPop → log-scale color → PMTiles +
# hover LUT + COG download. License CC BY 4.0 (attribution required).
popden:
	@bash $(SCRIPTS)/build_population_density.sh

# ── Large active/retired mines (MSHA, filtered) ─────────────────────────────
# Extract → filtered GeoJSON (peak employment >= 50), then gzip for serving.
# Inputs: unzip Mines.zip + MinesProdQuarterly.zip into data/raw/mines/ from
# https://arlweb.msha.gov/opengovernmentdata/ogimsha.asp
mines:
	@$(PY) $(SCRIPTS)/extract_mines.py
	@gzip -9 -f data/layers/mines.geojson
	@echo "[done] data/layers/mines.geojson.gz"

whp:
	@bash $(SCRIPTS)/build_wildfire_hazard.sh

# ── Active wildfire live layer (local dev) ───────────────────────────────────
# Merges local VIIRS CSVs + live NIFC perimeters/incidents + live NOAA HMS smoke
# → data/layers/wildfire_live.geojson (single file, all _types).
# Reads every CSV in tmp/wildfire-data/ (USA + Canada + Central_America country
# files); script dedups across them. In production this runs hourly via
# .github/workflows/wildfire-data.yml.
wildfire-dev:
	@$(PY) $(SCRIPTS)/firms_csv_to_geojson.py \
		tmp/wildfire-data/*.csv \
		-o data/layers/wildfire_live.geojson

smoke-dev:
	@echo "smoke-dev merged into wildfire-dev. Run 'make wildfire-dev' instead."

# ── Seismic hazard raster (USGS NSHM 2018, PGA 2% in 50yr) ──────────────────
# Self-contained raster pipeline (gdal + pmtiles, no venv). Reads the USGS NSHM
# CSV grid in data/raw/usgs/ → gdal_grid nearest → baked color PMTiles + hover
# LUT + COG download. Public domain (US Government work).
seismic:
	@bash $(SCRIPTS)/build_seismic_hazard.sh

# ── Validate: build inputs + layer outputs ──────────────────────────────────
# Run after `make pipeline` (checks data/build/ shapefiles) and again after
# `make tiles` (checks data/layers/ outputs match constants.ts; flags orphans).
validate:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@$(PY) $(SCRIPTS)/validate_build.py

# ── Tiles: data/build/ → data/layers/ ──────────────────────────────────────
tiles: validate
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@$(PY) $(SCRIPTS)/build_tiles.py

# ── Release ZIPs ───────────────────────────────────────────────────────────
releases:
	@if [ ! -d "$(VENV)" ]; then echo "ERROR: venv missing. Run 'make install' first."; exit 1; fi
	@$(PY) $(SCRIPTS)/build_releases.py

# ── Publish built data to the raw-hosted 'data-static' branch ───────────────
publish-data:
	@bash $(SCRIPTS)/publish_data.sh

# ── Serve static site ──────────────────────────────────────────────────────
web:
	@npx serve -l $(PORT)

# ── Cleanup ────────────────────────────────────────────────────────────────
clean-build:
	@rm -rf $(BUILD)

clean: clean-build
	@rm -rf data/layers/* data/releases/* data/downloads

distclean: clean
	@rm -rf $(VENV)
