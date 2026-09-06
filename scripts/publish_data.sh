#!/usr/bin/env bash
# publish_data.sh — publish a build to its two prod hosts:
#
#   built layers  → orphan `data-static` branch, served via raw.githubusercontent
#                   (assets/constants.ts DATA_ORIGIN). PMTiles needs ranged GETs
#                   with a CORS header, which is what raw gives us.
#   download packs → a rolling GitHub Release (assets/constants.ts
#                   RELEASES_ORIGIN). A download is a plain navigation, so it
#                   needs no CORS header — which lifts the branch's 100 MiB
#                   per-file ceiling to 2 GB per asset and keeps ~0.8 GB of ZIPs
#                   out of the git object store entirely.
#
# Kept OFF the `data` branch, which the live-feed workflows force-push hourly and
# would clobber.
#
# Uses a throwaway git index so nothing touches your `main` working tree or
# index: it hashes the files straight from disk, builds a parentless (orphan)
# commit, and force-pushes it. No history growth, no local branch, no file
# copies.
#
# Only the layers assets/constants.ts actually fetches are published. The
# per-continent join inputs (osm_generators_eu.pmtiles and friends) stay local:
# `make global-tiles` folds them into the world archives the frontend names, so
# shipping them too would add ~0.5 GB of unread bytes to every push.
#
# Requires a PUBLIC repo for raw's anon CORS to work.
#
# ponytail: leaves dangling blobs in .git after each run (temp index is deleted
# while its blobs stay); `git gc --prune=now` reclaims them if it ever matters.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

test -n "$(ls -A data/layers 2>/dev/null)"   || { echo "ERROR: data/layers empty — run 'make tiles' first."; exit 1; }
test -n "$(ls -A data/releases 2>/dev/null)" || { echo "ERROR: data/releases empty — run 'make releases' first."; exit 1; }

RELEASE_TAG="${RELEASE_TAG:-data-latest}"
# 4.5 GiB, under GitHub's 5 GB soft limit — see headroom_preflight.
SIZE_CEILING_KB="${SIZE_CEILING_KB:-4718592}"

GIT_INDEX_FILE="$(mktemp)"; export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

gb() { awk -v k="$1" 'BEGIN { printf "%.2f GB", k/1048576 }'; }

# GitHub hard-rejects any file > 100 MiB. Skip oversized layers so the push
# succeeds; a skipped layer breaks its map layer, so this should never fire —
# it is a backstop, not a strategy. Download packs no longer come through here.
drop_oversized() {
  while IFS= read -r big; do
    echo "WARNING: skipping $big ($(du -h "$big" | cut -f1)) — exceeds GitHub 100 MiB limit; host it elsewhere"
    git rm --cached --quiet -- "$big"
  done < <(git ls-files --cached | while IFS= read -r f; do
             [ -f "$f" ] && [ "$(stat -c%s "$f")" -gt 104857600 ] && echo "$f"
           done)
}

# A force-push deletes nothing. The previous tree's blobs become unreachable and
# keep counting against the repository until GitHub's own maintenance reclaims
# them — on a schedule we do not control, and which cannot be triggered from
# here; only GitHub Support can run GC on demand. So crossing the 5 GB soft
# limit is not something a later publish can undo, and a blocked push means no
# way to ship a fix. Estimate the cost first and refuse if it would not fit.
#
# The estimate is exact about the part that matters: git stores by content hash,
# so a file already on the branch byte-for-byte adds nothing no matter how many
# times it is republished. Only genuinely new blobs are counted. Cross-branch
# reuse (main, `data`) is ignored, which only makes the estimate conservative.
headroom_preflight() {
  local slug current_kb added_kb projected_kb
  if [ -n "${SKIP_SIZE_CHECK:-}" ]; then
    echo "Headroom check skipped (SKIP_SIZE_CHECK set)."
    return 0
  fi
  slug="$(git config --get remote.origin.url | sed -E 's#.*github\.com[:/]##; s#\.git$##')"
  if ! current_kb="$(gh api "repos/$slug" --jq .size 2>/dev/null)"; then
    echo "ERROR: could not read repository size from the GitHub API." >&2
    echo "       Install and authenticate 'gh', or check headroom by hand and re-run" >&2
    echo "       with SKIP_SIZE_CHECK=1." >&2
    exit 1
  fi
  git fetch -q origin data-static 2>/dev/null || true
  added_kb="$(
    comm -23 \
      <(git ls-files --cached -s | awk '{print $2}' | sort -u) \
      <(git ls-tree -r FETCH_HEAD 2>/dev/null | awk '{print $3}' | sort -u) \
    | git cat-file --batch-check='%(objectsize)' 2>/dev/null \
    | awk '{ s += $1 } END { print int(s/1024) + 0 }'
  )"
  projected_kb=$((current_kb + added_kb))
  printf 'Headroom: repo %s + new objects %s = %s of %s\n' \
    "$(gb "$current_kb")" "$(gb "$added_kb")" "$(gb "$projected_kb")" "$(gb "$SIZE_CEILING_KB")"
  if [ "$projected_kb" -gt "$SIZE_CEILING_KB" ]; then
    echo "ERROR: this publish would leave the repository at $(gb "$projected_kb"), past the" >&2
    echo "       $(gb "$SIZE_CEILING_KB") ceiling. Unreachable objects are reclaimed only by GitHub" >&2
    echo "       Support running GC, so publishing again cannot undo it." >&2
    echo "       Move data off the branch first (docs/hosting-plan.md) or request GC." >&2
    exit 1
  fi
}

stamp="$(date -u +%FT%TZ)"

# ── Layers → data-static ────────────────────────────────────────────────────
# One commit: with the packs on a Release, the tree is ~1.2 GB, comfortably
# inside GitHub's ~2 GB per-push ceiling.
git read-tree --empty
python3 scripts/validate_build.py --list-expected | while IFS= read -r f; do
  [ -f "$f" ] && echo "$f"
done | xargs -r git add -f --
drop_oversized
headroom_preflight
tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -m "data-static: layers — $stamp")"
git push -f origin "$commit:refs/heads/data-static"
echo "Pushed $(git rev-parse --short "$commit") → origin/data-static"

# ── Download packs → rolling GitHub Release ─────────────────────────────────
# --clobber replaces assets in place so the tag, and therefore every download
# URL baked into the deployed bundle, stays stable. An asset over GitHub's 2 GB
# limit makes `gh` fail loudly here rather than going missing from the UI.
gh release view "$RELEASE_TAG" >/dev/null 2>&1 || gh release create "$RELEASE_TAG" \
  --title "Download packs" \
  --notes "Per-layer download packs served by the layer panel. Rolling tag: assets are replaced in place so the URLs stay stable."
gh release upload "$RELEASE_TAG" data/releases/*.zip --clobber
echo "Uploaded $(ls data/releases/*.zip | wc -l) packs → release $RELEASE_TAG"
