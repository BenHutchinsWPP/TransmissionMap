#!/usr/bin/env bash
# publish_data.sh — push built layers + release ZIPs to the orphan `data-static`
# branch, served in prod via raw.githubusercontent.com (see assets/constants.ts
# DATA_ORIGIN). Kept OFF the `data` branch, which the wildfire workflow
# force-pushes hourly and would clobber.
#
# Uses a throwaway git index so nothing touches your `main` working tree or
# index: it hashes data/layers + data/releases straight from disk, builds one
# parentless (orphan) commit, and force-pushes it. No history growth, no local
# branch, no file copies.
#
# Requires a PUBLIC repo for raw's anon CORS to work.
#
# ponytail: leaves dangling blobs in .git after each run (temp index is deleted
# while its blobs stay); `git gc --prune=now` reclaims them if it ever matters.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

test -n "$(ls -A data/layers 2>/dev/null)"   || { echo "ERROR: data/layers empty — run 'make tiles' first."; exit 1; }
test -n "$(ls -A data/releases 2>/dev/null)" || { echo "ERROR: data/releases empty — run 'make releases' first."; exit 1; }

GIT_INDEX_FILE="$(mktemp)"; export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

git read-tree --empty
git add -f data/layers data/releases
tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -m "data-static: layers + release packs — $(date -u +%FT%TZ)")"
git push -f origin "$commit:refs/heads/data-static"

echo "Pushed $(git rev-parse --short "$commit") → origin/data-static"
