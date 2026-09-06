#!/usr/bin/env bash
# publish_data.sh — push built layers + release ZIPs to the orphan `data-static`
# branch, served in prod via raw.githubusercontent.com (see assets/constants.ts
# DATA_ORIGIN). Kept OFF the `data` branch, which the wildfire workflow
# force-pushes hourly and would clobber.
#
# Uses a throwaway git index so nothing touches your `main` working tree or
# index: it hashes the files straight from disk, builds parentless (orphan)
# commits, and force-pushes them. No history growth, no local branch, no file
# copies.
#
# Only the layers assets/constants.ts actually fetches are published. The
# per-continent join inputs (osm_generators_eu.pmtiles and friends) stay local:
# `make global-tiles` folds them into the world archives the frontend names, so
# shipping them too would add ~0.5 GB of unread bytes to every push. Transmission
# is the exception — its eight continental archives ARE what the frontend loads,
# so constants.ts names them and they publish like any other layer.
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

# GitHub hard-rejects any file > 100 MiB. Skip oversized packs so the push
# succeeds; they must be hosted elsewhere. The UI download link for a skipped
# pack will 404 until it is — a known limit for very large SHP packs.
drop_oversized() {
  while IFS= read -r big; do
    echo "WARNING: skipping $big ($(du -h "$big" | cut -f1)) — exceeds GitHub 100 MiB limit; host it elsewhere"
    git rm --cached --quiet -- "$big"
  done < <(git ls-files --cached | while IFS= read -r f; do
             [ -f "$f" ] && [ "$(stat -c%s "$f")" -gt 104857600 ] && echo "$f"
           done)
}

commit_and_push() {  # $1 = parent commit (may be empty), $2 = message; echoes the new sha
  local tree parent_arg=() commit
  tree="$(git write-tree)"
  [ -n "$1" ] && parent_arg=(-p "$1")
  commit="$(git commit-tree "$tree" "${parent_arg[@]}" -m "$2")"
  git push -f origin "$commit:refs/heads/data-static" >&2
  echo "$commit"
}

stamp="$(date -u +%FT%TZ)"

# Staged in two commits so neither pack approaches GitHub's ~2 GB per-push
# ceiling on a first publish. Later publishes send only changed blobs, so they
# are small either way; the second commit carries the complete tree.
git read-tree --empty
python3 scripts/validate_build.py --list-expected | while IFS= read -r f; do
  [ -f "$f" ] && echo "$f"
done | xargs -r git add -f --
drop_oversized
layers_commit="$(commit_and_push "" "data-static: layers — $stamp")"
echo "Pushed layers $(git rev-parse --short "$layers_commit")"

git add -f data/releases
drop_oversized
full_commit="$(commit_and_push "$layers_commit" "data-static: release packs — $stamp")"

echo "Pushed $(git rev-parse --short "$full_commit") → origin/data-static"
