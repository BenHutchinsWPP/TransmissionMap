#!/usr/bin/env bash
# Rebuild the moratorium layer from the inputs in a work dir, as of a date.
#   rebuild.sh --work W [--dataset D] [--build B] [--as-of YYYY-MM-DD]
# build.py -> build_research.py -> build_state.py -> sync.py -> build_layer.py
#
# WORK/inputs/   research/, additions.csv, state_additions.csv, territories/, county_names.csv, upstream.sha
# WORK/upstream  Moratorium Nation clone at inputs/upstream.sha      WORK/census  Census cartographic zips
# DATASET        published outputs: moratoriums.csv, events.csv, dc_moratoriums.geojson (default WORK/dataset)
# BUILD          intermediates and logs/ (default WORK/build)
# --as-of defaults to today's UTC date. PYTHON overrides the interpreter (default python3).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${DCM_WORK:-}" DATASET="" BUILD="" AS_OF="$(date -u +%F)"
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="$2"; shift 2 ;;
    --dataset) DATASET="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --as-of) AS_OF="$2"; shift 2 ;;
    *) echo "usage: rebuild.sh --work W [--dataset D] [--build B] [--as-of YYYY-MM-DD]" >&2; exit 2 ;;
  esac
done
[ -n "$WORK" ] || { echo "rebuild.sh: --work (or DCM_WORK) is required" >&2; exit 2; }
WORK="$(cd "$WORK" && pwd)"
DATASET="${DATASET:-$WORK/dataset}"; BUILD="${BUILD:-$WORK/build}"
mkdir -p "$DATASET" "$BUILD/logs"
DATASET="$(cd "$DATASET" && pwd)"; BUILD="$(cd "$BUILD" && pwd)"
PY="${PYTHON:-python3}"
DIRS=(--work "$WORK" --dataset "$DATASET" --build "$BUILD")

for s in build build_research build_state; do
  "$PY" -W ignore "$HERE/$s.py" "${DIRS[@]}" > "$BUILD/logs/$s.log" 2>&1 || { tail -20 "$BUILD/logs/$s.log"; exit 1; }
done
grep -v sys.prefix "$BUILD/logs/build_research.log" || true
"$PY" -W ignore "$HERE/sync.py" "${DIRS[@]}" --as-of "$AS_OF" 2>&1 | { grep -v sys.prefix || true; }
"$PY" -W ignore "$HERE/build_layer.py" "${DIRS[@]}" --as-of "$AS_OF" 2>&1 | { grep -v sys.prefix || true; }
