#!/usr/bin/env bash
# install_rclone.sh — install one pinned rclone release for CI (linux amd64).
# The zip is checked against a SHA-256 written here; a mismatch aborts.
#
# Usage: scripts/install_rclone.sh [DIR]
#   DIR  install directory (default $RUNNER_TEMP/bin, else ./bin); added to
#        $GITHUB_PATH when that is set
# Deps: bash, curl, unzip, sha256sum
set -euo pipefail

VERSION=v1.75.2
SHA256=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702

dir="${1:-${RUNNER_TEMP:-.}/bin}"
mkdir -p "$dir"
tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rclone.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
zip="rclone-$VERSION-linux-amd64.zip"
curl -fsSL --retry 3 -o "$tmp/$zip" "https://downloads.rclone.org/$VERSION/$zip"
echo "$SHA256  $tmp/$zip" | sha256sum -c - >/dev/null || { echo "ERROR: $zip does not match its pinned SHA-256" >&2; exit 1; }
unzip -q -o -j "$tmp/$zip" "rclone-$VERSION-linux-amd64/rclone" -d "$dir"
chmod +x "$dir/rclone"
[ -z "${GITHUB_PATH:-}" ] || (cd "$dir" && pwd) >> "$GITHUB_PATH"
"$dir/rclone" version | sed -n 1p
