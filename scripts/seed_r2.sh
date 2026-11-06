#!/usr/bin/env bash
# seed_r2.sh — copy the published live feeds or the moratorium layer from their
# git data branches to their R2 buckets, from this machine.
#
#   live         origin/data  data/layers/**          → live-wpptx-org (keys = the same paths)
#   moratoriums  origin/data-moratoriums  dc_moratoriums.geojson → moratoriums-wpptx-org (bucket root)
#
# Headers (docs/hosting-plan.md § Cache rules): live objects
# `public, max-age=0, s-maxage=60`, the moratorium layer `public, max-age=300`;
# Content-Type, upload order and `rclone copy --checksum` (never syncs, never
# deletes) are r2_upload.sh's.
#
# Keys: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY from the repo-root
# .env.r2.live or .env.r2.moratoriums (one bucket-scoped token each; KEY=value lines,
# optional `export `, parsed and never sourced). The environment is not read, so the
# data keys of .env.r2 can never reach these buckets.
#
# Deps: git, scripts/r2_upload.sh
# Usage: scripts/seed_r2.sh live|moratoriums [--dry-run]
#   --dry-run  list what would be uploaded and the commands; needs no rclone or keys
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-}"; mode="${2:-}"
case "$target" in
  live)        REF=origin/data;             BUCKET=live-wpptx-org;        HOST=live.wpptx.org
               CC="public, max-age=0, s-maxage=60" ;;
  moratoriums) REF=origin/data-moratoriums; BUCKET=moratoriums-wpptx-org; HOST=moratoriums.wpptx.org
               CC="public, max-age=300" ;;
  *) echo "usage: scripts/seed_r2.sh live|moratoriums [--dry-run]" >&2; exit 2 ;;
esac
case "$mode" in ""|--dry-run) ;; *) echo "unknown option: $mode" >&2; exit 2 ;; esac
ENV_FILE=".env.r2.$target"

git fetch -q origin "${REF#origin/}"
src="$(mktemp -d "${TMPDIR:-/tmp}/seed-r2-$target.XXXXXX")"
trap 'rm -rf "$src"' EXIT
if [ "$target" = live ]; then
  git archive "$REF" data/layers | tar -x -C "$src"
else
  git show "$REF:dc_moratoriums.geojson" > "$src/dc_moratoriums.geojson"
fi
echo "Source: $REF @ $(git rev-parse --short "$REF") ($(git log -1 --format=%ci "$REF"))"
echo "Dest:   r2:$BUCKET (https://$HOST/), Cache-Control: $CC"
echo "Files:  $(find "$src" -type f | wc -l), $(du -sb "$src" | cut -f1) bytes"

upload=(scripts/r2_upload.sh --bucket "$BUCKET" --cache-control "$CC" --root "$src")
if [ "$mode" = --dry-run ]; then
  if [ "$target" = live ]; then "${upload[@]}" --dry-run data/layers | grep -v '^    key '
  else "${upload[@]}" --dry-run dc_moratoriums.geojson | grep -v '^    key '; fi
  exit 0
fi

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found. See local/r2-deploy.md § 3." >&2; exit 1; }
R2_ACCOUNT_ID=""; R2_ACCESS_KEY_ID=""; R2_SECRET_ACCESS_KEY=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
  case "$line" in R2_ACCOUNT_ID=*|R2_ACCESS_KEY_ID=*|R2_SECRET_ACCESS_KEY=*) ;; *) continue ;; esac
  k="${line%%=*}"; v="${line#*=}"; v="${v%"${v##*[![:space:]]}"}"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  printf -v "$k" '%s' "$v"
done < "$ENV_FILE"
for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [ -n "${!k}" ] || { echo "ERROR: $k missing from $ENV_FILE" >&2; exit 1; }
done
export R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
if [ "$target" = live ]; then "${upload[@]}" data/layers; else "${upload[@]}" dc_moratoriums.geojson; fi
