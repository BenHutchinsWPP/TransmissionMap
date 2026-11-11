#!/usr/bin/env bash
# Release check: the pinned ROUTE_ID's entry objects and a cube tile (Range) answer on the data host.
# Read-only. Usage: bash scripts/check_route_live.sh   (exit 1 on any non-200/206)
set -u
cd "$(dirname "$0")/.."
id=$(sed -n 's/^export const ROUTE_ID = "\([0-9a-f]*\)";.*/\1/p' assets/constants.ts)
[ -n "$id" ] || { echo "ERROR: no ROUTE_ID in assets/constants.ts" >&2; exit 1; }
base="https://data.wpptx.org/data/route/$id"
bad=0
chk() { # path expected [curl args...]
  local p=$1 want=$2; shift 2
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "$@" "$base/$p")
  if [ "$code" = "$want" ]; then echo "ok   $code $p"; else echo "FAIL $code $p" >&2; bad=1; fi
}
for k in 250m/grid.json report/screening/manifest.json LICENSE.txt; do chk "$k" 200; done
tile=$(curl -s "$base/250m/grid.json" | python3 -c 'import json,sys; g=json.load(sys.stdin); c,r=g["super_tiles_present"][0]; print(g["pd_files"]["pattern"].format(col=c,row=r))' 2>/dev/null)
[ -n "$tile" ] || { echo "FAIL no cube tile named by grid.json" >&2; exit 1; }
chk "250m/$tile" 206 -H 'Range: bytes=0-1023'
exit $bad
