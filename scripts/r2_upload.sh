#!/usr/bin/env bash
# r2_upload.sh — the one uploader to an R2 bucket: used by the live-feed and
# moratorium CI jobs and by seed_r2.sh. Copies files with fixed headers; never
# syncs, never deletes (`rclone copy --checksum` skips unchanged objects).
#
# Usage: scripts/r2_upload.sh --bucket NAME --cache-control VALUE --root DIR [--dry-run] PATH...
#   PATH       files or directories (recursed) relative to DIR; object key = path relative to DIR
#   --dry-run  print the planned groups, keys and commands; needs no rclone or keys
#
# Keys: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY from the environment.
# Content-Type by extension: .gz and .i16 application/octet-stream (never a
# Content-Encoding), .webp, .png, .geojson application/geo+json, .json application/json.
# `*.tmp` files (an interrupted atomic write) are skipped with a warning; any other
# extension refuses the whole run before anything is uploaded.
# Upload order: binaries, then .geojson, then .json last (weather_live/meta.json
# names the files the rest must already hold).
# Deps: bash, find, sort; rclone for a real run.
set -euo pipefail

usage() { echo "usage: scripts/r2_upload.sh --bucket NAME --cache-control VALUE --root DIR [--dry-run] PATH..." >&2; exit 2; }

bucket=""; cc=""; root=""; dry=0; paths=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) [ $# -ge 2 ] || usage; bucket="$2"; shift 2 ;;
    --cache-control) [ $# -ge 2 ] || usage; cc="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || usage; root="$2"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) paths+=("$1"); shift ;;
  esac
done
[ -n "$bucket" ] && [ -n "$cc" ] && [ -n "$root" ] && [ ${#paths[@]} -gt 0 ] || usage
[ -d "$root" ] || { echo "ERROR: --root $root is not a directory" >&2; exit 2; }

# files, as keys relative to root
keys=()
for p in "${paths[@]}"; do
  if [ -d "$root/$p" ]; then
    while IFS= read -r -d '' f; do keys+=("${f#./}"); done \
      < <(cd "$root" && find "./${p#./}" -type f -print0 | sort -z)
  elif [ -f "$root/$p" ]; then
    keys+=("${p#./}")
  else
    echo "ERROR: $p not found under $root" >&2; exit 1
  fi
done
[ ${#keys[@]} -gt 0 ] || { echo "ERROR: no files to upload" >&2; exit 1; }

# extension → Content-Type, in upload order
groups=(
  "gz|application/octet-stream" "i16|application/octet-stream"
  "webp|image/webp" "png|image/png"
  "geojson|application/geo+json" "json|application/json"
)
unknown=(); kept=()
for k in "${keys[@]}"; do
  case "$k" in
    *.tmp) echo "WARNING: skipping $k" >&2; continue ;;
    *.gz|*.i16|*.webp|*.png|*.geojson|*.json) ;;
    *) unknown+=("$k") ;;
  esac
  kept+=("$k")
done
if [ ${#unknown[@]} -gt 0 ]; then
  echo "ERROR: ${#unknown[@]} files have no Content-Type rule:" >&2
  printf '  %s\n' "${unknown[@]}" >&2
  exit 1
fi
keys=("${kept[@]}")
[ ${#keys[@]} -gt 0 ] || { echo "ERROR: no files to upload" >&2; exit 1; }

if [ "$dry" -eq 0 ]; then
  for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || { echo "ERROR: $v is not set" >&2; exit 1; }
  done
  command -v rclone >/dev/null || { echo "ERROR: rclone not found" >&2; exit 1; }
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_R2_NO_HEAD=true  # R2 answers 501 to the HEAD ?versionId= rclone sends after a PUT; Content-MD5 still checks each upload
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
fi

list="$(mktemp "${TMPDIR:-/tmp}/r2-upload.XXXXXX")"
trap 'rm -f "$list"' EXIT
echo "Dest: r2:$bucket, Cache-Control: $cc, ${#keys[@]} files"
for g in "${groups[@]}"; do
  ext="${g%%|*}"; ct="${g#*|}"
  : > "$list"
  n=0
  for k in "${keys[@]}"; do
    case "$k" in *."$ext") printf '%s\n' "$k" >> "$list"; n=$((n + 1)) ;; esac
  done
  [ "$n" -gt 0 ] || continue
  echo "  .$ext: $n files -> $ct"
  if [ "$dry" -eq 1 ]; then
    sed 's/^/    key /' "$list"
    printf '  rclone copy --checksum --files-from LIST --header-upload %q --header-upload %q %q r2:%s\n' \
      "Content-Type: $ct" "Cache-Control: $cc" "$root" "$bucket"
  else
    rclone copy --checksum --files-from "$list" \
      --header-upload "Content-Type: $ct" --header-upload "Cache-Control: $cc" \
      "$root" "r2:$bucket"
  fi
done
if [ "$dry" -eq 1 ]; then echo "Dry run: nothing uploaded."; else echo "Uploaded ${#keys[@]} files to r2:$bucket."; fi
