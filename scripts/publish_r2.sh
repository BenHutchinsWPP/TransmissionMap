#!/usr/bin/env bash
# publish_r2.sh — publish the static data to the R2 bucket data-wpptx-org
# (served as data.wpptx.org). Object keys are the repo-relative paths.
#
# What it uploads: the data/layers files `validate_build.py --list-expected`
# names (what assets/constants.ts fetches), the data/releases/*.zip packs and the
# data/analysis files its index.json names (index.json, columns/, each dataset
# directory). Any other file under data/analysis aborts the run, listed.
#
# How: `rclone copy --checksum`, one run per header set (--files-from), so each
# object gets the Content-Type and Cache-Control of docs/roadmap/r2-hosting.plan.md
# § Cache rules: .pmtiles/.parquet/.gz are application/octet-stream and never get
# a Content-Encoding; content-hashed names (*.<sha8>.parquet) are immutable for a
# year; fixed names are `public, max-age=3600, s-maxage=2592000`. Objects go first,
# manifests (index.json, manifest.json) last. It never syncs and never deletes:
# deployed bundles keep reading superseded objects.
#
# Before any upload, geoparquet_common.check_analysis runs over the data/analysis
# and data/layers being uploaded and any problem aborts the run. A fixed-name
# object that is about to change is first copied server-side to prev/<stamp>/;
# if that comparison cannot be completed, nothing is uploaded. After a publish
# the changed fixed-name URLs are printed: that is the Cloudflare cache purge
# list (the script itself does not purge and needs no zone token).
#
# Keys: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY from the
# environment, else from the repo-root .env.r2 (local/r2-deploy.md; KEY=value
# lines, optional `export `, parsed and never sourced). The rclone remote `r2`
# is built from them through RCLONE_CONFIG_R2_* variables.
#
# Usage:
#   scripts/publish_r2.sh --dry-run            plan and commands; needs no rclone or keys
#   scripts/publish_r2.sh                      upload
#   scripts/publish_r2.sh --rollback STAMP     first save the current fixed names to a new
#                                              prev/<stamp>/, then copy prev/<STAMP>/ back
#                                              (files first, manifests last; STAMP required)
#   scripts/publish_r2.sh --prune-list         read-only report of bucket objects that no
#                                              manifest names (the layers list, the release
#                                              manifest, every index.json here and under prev/);
#                                              refuses when a manifest is missing. Deleting is
#                                              a manual act: this script never deletes.
#
# Deps: rclone (not for --dry-run), python3, scripts/validate_build.py,
# scripts/geoparquet_common.py.
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="data-wpptx-org"
DEST="r2:$BUCKET"
PUBLIC_URL="https://data.wpptx.org"
CC_IMMUTABLE="public, max-age=31536000, immutable"
CC_FIXED="public, max-age=3600, s-maxage=2592000"
PY="python3"; [ -x venv/bin/python ] && PY="venv/bin/python"

mode="publish"; stamp_arg=""
case "${1:-}" in
  "") ;;
  --dry-run) mode="dry-run" ;;
  --rollback)
    mode="rollback"; stamp_arg="${2:-}"
    [[ "$stamp_arg" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
      echo "ERROR: --rollback needs the STAMP of a prev/<stamp>/ directory (e.g. 20261106T120000Z)." >&2; exit 2; } ;;
  --prune-list) mode="prune-list" ;;
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  *) echo "ERROR: unknown argument '$1' (see --help)" >&2; exit 2 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

trim() {  # trim "$1" of surrounding whitespace
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# ── Keys ─────────────────────────────────────────────────────────────────────
load_keys() {
  local line k v
  if [ -f .env.r2 ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="$(trim "${line%$'\r'}")"
      case "$line" in export[[:space:]]*) line="$(trim "${line#export}")" ;; esac
      case "$line" in *=*) ;; *) continue ;; esac
      k="$(trim "${line%%=*}")"; v="$(trim "${line#*=}")"
      case "$k" in
        R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)
          v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
          [ -n "${!k:-}" ] || printf -v "$k" '%s' "$v" ;;
      esac
    done < .env.r2
  fi
  for k in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    if [ -z "${!k:-}" ]; then
      echo "ERROR: $k is not set (environment or .env.r2). See local/r2-deploy.md § 3." >&2
      exit 1
    fi
  done
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_R2_NO_HEAD=true  # R2 answers 501 to the HEAD ?versionId= rclone sends after a PUT; Content-MD5 still checks each upload
}

need_rclone() {
  command -v rclone >/dev/null || { echo "ERROR: rclone not found. Install it: sudo apt install rclone" >&2; exit 1; }
}

if [ "$mode" != "dry-run" ]; then
  load_keys
  need_rclone
fi

purge_list() {  # $1 = file of keys → the URLs to purge
  echo "Cloudflare cache purge list (Caching ▸ Configuration ▸ Custom Purge ▸ URL; the script does not purge):"
  sed "s|^|  $PUBLIC_URL/|" "$1"
}

# ── Rollback ─────────────────────────────────────────────────────────────────
if [ "$mode" = "rollback" ]; then
  stamp="$stamp_arg"
  rclone lsf -R --files-only "$DEST/prev/$stamp" | LC_ALL=C sort > "$work/restore.list"
  [ -s "$work/restore.list" ] || { echo "ERROR: prev/$stamp/ is empty or missing; nothing restored." >&2; exit 1; }
  rclone lsf -R --files-only "$DEST" > "$work/remote.all"
  grep -v '^prev/' "$work/remote.all" | LC_ALL=C sort > "$work/remote.list" || [ $? -eq 1 ]
  LC_ALL=C comm -12 "$work/restore.list" "$work/remote.list" > "$work/current.list"
  newstamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [ "$newstamp" != "$stamp" ] || { echo "ERROR: that is this second's stamp; retry." >&2; exit 1; }
  if [ -s "$work/current.list" ]; then
    echo "Saving $(wc -l < "$work/current.list") current objects to prev/$newstamp/"
    rclone copy --files-from "$work/current.list" "$DEST" "$DEST/prev/$newstamp"
  fi
  grep -Ev '(^|/)(index|manifest)\.json$' "$work/restore.list" > "$work/restore-files.list" || [ $? -eq 1 ]
  grep -E '(^|/)(index|manifest)\.json$' "$work/restore.list" > "$work/restore-manifests.list" || [ $? -eq 1 ]
  echo "Rolling back prev/$stamp/ → $BUCKET"
  for l in restore-files restore-manifests; do
    if [ -s "$work/$l.list" ]; then
      rclone copy --files-from "$work/$l.list" "$DEST/prev/$stamp" "$DEST"
    fi
  done
  echo "Done; the state before the rollback is in prev/$newstamp/."
  purge_list "$work/restore.list"
  exit 0
fi

# ── What the manifests name ──────────────────────────────────────────────────
"$PY" scripts/validate_build.py --list-expected > "$work/expected.list"
[ -s "$work/expected.list" ] || { echo "ERROR: validate_build.py --list-expected named nothing." >&2; exit 1; }

# ── Prune report (read-only) ─────────────────────────────────────────────────
if [ "$mode" = "prune-list" ]; then
  for f in scripts/release_manifest.yaml data/analysis/index.json; do
    [ -f "$f" ] || { echo "ERROR: $f is missing; cannot tell what to keep, so nothing is listed." >&2; exit 1; }
  done
  rclone lsf -R --files-only "$DEST" > "$work/remote.all"
  grep -v '^prev/' "$work/remote.all" | LC_ALL=C sort > "$work/remote.list" || [ $? -eq 1 ]
  idx=(data/analysis/index.json)
  n=0
  while IFS= read -r k; do
    n=$((n + 1))
    rclone cat "$DEST/$k" > "$work/prev-index-$n.json"
    idx+=("$work/prev-index-$n.json")
  done < <(grep -E '^prev/[^/]+/data/analysis/index\.json$' "$work/remote.all" || [ $? -eq 1 ])
  "$PY" - "$work/expected.list" scripts/release_manifest.yaml "${idx[@]}" > "$work/keep.raw" <<'EOF'
import json, posixpath, re, sys

CODES = ["na", "eu", "as", "sa", "af", "oc", "ca", "an"]  # build_releases.py CONTINENT_CODES
expected, release_yaml, *indexes = sys.argv[1:]
keep = set(open(expected).read().split())

layer = None
attrs = {}
layers = {}
in_layers = False
for raw in open(release_yaml, encoding="utf-8"):
    line = raw.rstrip("\n")
    if re.match(r"^layers:\s*$", line):
        in_layers = True
        continue
    if not in_layers or not line.strip() or line.lstrip().startswith("#"):
        continue
    m = re.match(r"^  ([A-Za-z0-9_.-]+):\s*(#.*)?$", line)
    if m:
        layer = m.group(1)
        layers[layer] = attrs = {}
        continue
    m = re.match(r"^    ([A-Za-z0-9_]+):\s*([^#\s]*)", line)
    if m and layer:
        attrs[m.group(1)] = m.group(2)
for lid, a in layers.items():
    if a.get("skip") == "true":
        continue
    ids = [f"{lid}-{c}" for c in CODES] if a.get("continental") == "true" else [lid]
    shp = not (a.get("csv_only") == "true" or "tif" in a or a.get("geojson_only") == "true")
    for i in ids:  # a pack the manifest might build: over-keeping only shortens the report
        keep.add(f"data/releases/{i}.zip")
        if shp:
            keep.add(f"data/releases/{i}-shp.zip")

def under(d, name):
    return posixpath.normpath("data/analysis/" + d + "/" + name)

for path in indexes:
    idx = json.load(open(path, encoding="utf-8"))
    keep.add("data/analysis/index.json")
    for ds, m in idx.get("datasets", {}).items():
        d = m.get("path", ds + "/")
        names = [m["idx"]["name"], *[e["name"] for e in m["geo"]]]
        if m.get("chains"):
            names.append(m["chains"]["name"])
        for n in [*names, "_manifest.json"]:
            keep.add(under(d, n))
    for ds, m in idx.get("columns", {}).items():
        keep.add(under(m.get("path", "columns/"), m["file"]["name"]))
print("\n".join(sorted(keep)))
EOF
  LC_ALL=C sort -u "$work/keep.raw" > "$work/keep.list"
  LC_ALL=C comm -23 "$work/remote.list" "$work/keep.list" > "$work/prune.list"
  echo "Objects in $BUCKET that no manifest names (prev/ excluded; read-only, nothing is deleted): $(wc -l < "$work/prune.list")"
  cat "$work/prune.list"
  exit 0
fi

# ── The current set ──────────────────────────────────────────────────────────
: > "$work/all.list"
while IFS= read -r f; do
  if [ -f "$f" ]; then echo "$f" >> "$work/all.list"; else echo "missing (skipped): $f" >&2; fi
done < "$work/expected.list"
[ -d data/releases ] && find data/releases -maxdepth 1 -type f -name '*.zip' | LC_ALL=C sort >> "$work/all.list"
[ -d data/analysis ] && find data/analysis -type f | LC_ALL=C sort >> "$work/all.list"
[ -s "$work/all.list" ] || { echo "ERROR: nothing to publish — check validate_build.py --list-expected." >&2; exit 1; }

# ── Check what is about to be uploaded ───────────────────────────────────────
if ! "$PY" - <<'EOF'
import json, sys
from pathlib import Path
sys.path.insert(0, "scripts")
from geoparquet_common import check_analysis
root = Path("data/analysis")
problems = check_analysis("data/analysis", "data/layers")
if root.is_dir():
    index = root / "index.json"
    dirs = {"columns"}
    if index.exists():
        for ds, m in json.loads(index.read_text(encoding="utf-8")).get("datasets", {}).items():
            dirs.add(Path(m.get("path", ds + "/")).parts[0])
    for f in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = f.relative_to(root)
        if rel.name == "index.json" and len(rel.parts) == 1 and index.exists():
            continue
        if len(rel.parts) < 2 or rel.parts[0] not in dirs:
            problems.append(f"{rel} is outside index.json's dataset directories and columns/, so no check covers it")
for p in problems:
    print("ERROR: data/analysis:", p, file=sys.stderr)
sys.exit(1 if problems else 0)
EOF
then
  echo "ERROR: data/analysis check failed; nothing uploaded." >&2
  exit 1
fi

# ── Group by header set ──────────────────────────────────────────────────────
content_type() {
  case "$1" in
    *.pmtiles|*.parquet|*.gz) echo "application/octet-stream" ;;
    *.json) echo "application/json" ;;
    *.geojson) echo "application/geo+json" ;;
    *.zip) echo "application/zip" ;;
    *.csv) echo "text/csv" ;;
    *) echo "application/octet-stream" ;;
  esac
}

declare -A gfiles=()
: > "$work/fixed.list"
while IFS= read -r f; do
  base="${f##*/}"
  case "$base" in index.json|manifest.json) phase="2-manifests" ;; *) phase="1-objects" ;; esac
  if [[ "$base" =~ \.[0-9a-f]{8}\.parquet$ ]]; then cc="$CC_IMMUTABLE"; else cc="$CC_FIXED"; fi
  key="$phase|$(content_type "$base")|$cc"
  gfiles[$key]+="$f"$'\n'
  if [ "$cc" = "$CC_FIXED" ]; then echo "$f" >> "$work/fixed.list"; fi
done < "$work/all.list"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
cmds=()   # one shell-quoted command per entry
lines=()
n=0; total=0
echo "Plan: copy to $DEST (rclone copy --checksum; never sync, never delete)"
while IFS= read -r key; do
  n=$((n + 1))
  IFS='|' read -r phase ctype cc <<< "$key"
  list="$work/group-$n.list"
  printf '%s' "${gfiles[$key]}" > "$list"
  bytes=0; count=0
  while IFS= read -r f; do
    s="$(stat -c %s "$f")"; bytes=$((bytes + s)); count=$((count + 1))
    lines+=("    $f  $s")
  done < "$list"
  total=$((total + bytes))
  echo
  echo "Group $n (${phase#*-}): $count files, $bytes bytes"
  echo "  Content-Type: $ctype"
  echo "  Cache-Control: $cc"
  printf '%s\n' "${lines[@]}"
  lines=()
  cmds+=("$(printf '%q ' rclone copy --checksum --files-from "$list" \
    --header-upload "Content-Type: $ctype" --header-upload "Cache-Control: $cc" . "$DEST")")
done < <(printf '%s\n' "${!gfiles[@]}" | LC_ALL=C sort)
echo
echo "Total: $(wc -l < "$work/all.list") files, $total bytes in $n groups"

backup_check=(rclone check --checksum --one-way --files-from "$work/fixed.list" --combined "$work/combined.list" . "$DEST")
backup_copy=(rclone copy --files-from "$work/differ.list" "$DEST" "$DEST/prev/$stamp")

if [ "$mode" = "dry-run" ]; then
  echo
  echo "Commands (rclone remote from the environment; keys redacted):"
  echo "  RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true RCLONE_CONFIG_R2_NO_HEAD=true"
  echo "  RCLONE_CONFIG_R2_ENDPOINT=https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com"
  echo "  RCLONE_CONFIG_R2_ACCESS_KEY_ID=<redacted> RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<redacted>"
  if [ -s "$work/fixed.list" ]; then
    echo "  $(printf '%q ' "${backup_check[@]}")   # must finish with no '!' line and one line per fixed name, or nothing is uploaded"
    echo "  $(printf '%q ' "${backup_copy[@]}")   # only when a fixed name differs"
  fi
  printf '  %s\n' "${cmds[@]}"
  exit 0
fi

# ── Compare the fixed names with the bucket ──────────────────────────────────
: > "$work/changed.list"
if [ -s "$work/fixed.list" ]; then
  # rclone check exits 1 when files differ and also on errors: the combined report
  # must be complete (every fixed name, no '!') before anything is overwritten.
  rc=0
  "${backup_check[@]}" >/dev/null 2>"$work/check.err" || rc=$?
  ok=1
  [ "$rc" -le 1 ] && [ -f "$work/combined.list" ] || ok=0
  if [ "$ok" = 1 ]; then
    if grep -q '^! ' "$work/combined.list"; then ok=0; fi
    cut -c3- "$work/combined.list" | LC_ALL=C sort -u > "$work/seen.list"
    LC_ALL=C sort -u "$work/fixed.list" > "$work/want.list"
    [ -z "$(LC_ALL=C comm -13 "$work/seen.list" "$work/want.list")" ] || ok=0
  fi
  if [ "$ok" != 1 ]; then
    echo "ERROR: could not compare the fixed names with $BUCKET (rclone check exit $rc); nothing uploaded." >&2
    sed -n '1,5p' "$work/check.err" >&2
    exit 1
  fi
  { grep '^\* ' "$work/combined.list" || [ $? -eq 1 ]; } | cut -c3- | LC_ALL=C sort > "$work/differ.list"
  { grep -E '^[*-] ' "$work/combined.list" || [ $? -eq 1 ]; } | cut -c3- | LC_ALL=C sort > "$work/changed.list"
  if [ -s "$work/differ.list" ]; then
    echo "Saving $(wc -l < "$work/differ.list") changing fixed-name objects to prev/$stamp/"
    "${backup_copy[@]}"
  fi
fi

# ── Upload ───────────────────────────────────────────────────────────────────
for c in "${cmds[@]}"; do
  eval "$c"
done
echo "Published $(wc -l < "$work/all.list") files to $BUCKET."
if [ -s "$work/changed.list" ]; then
  purge_list "$work/changed.list"
else
  echo "No fixed-name object changed; nothing to purge."
fi
