#!/usr/bin/env bash
# Issue #396 (backlog VC-X-82; docs/development/betrieb.md §11.7): the MRE pdfgenerator overlay in deploy/mre-pdfgenerator
# replaces two files of the pinned image with patched copies. This check keeps the copies honest: taking
# realm-396.patch back out of them gives exactly the original files of MRE 479d0ad (their SHA-256 in originals.sha256,
# which the Dockerfile also checks against the base image at build time), so the copies differ from MRE only by the
# reviewed hunks of the patch. A copy edited without the patch, a patch edited without the copy, or a file the patch
# touches that the Dockerfile does not copy (or the other way round) makes the check red.
# Reads only the repository files; needs bash, GNU patch and sha256sum, no docker and no network.
set -euo pipefail

dir=deploy/mre-pdfgenerator
patch_file=$dir/realm-396.patch
sums=$dir/originals.sha256
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
  echo "MRE overlay check failed: $*" >&2
  exit 1
}

# The files the patch touches, the files with an original checksum and the files the Dockerfile copies: one list.
patched=$(sed -nE 's#^\+\+\+ b/([^[:space:]]+).*#\1#p' "$patch_file" | sort)
summed=$(awk '{ print $2 }' "$sums" | sort)
copied=$(sed -nE 's#^COPY[[:space:]].*[[:space:]](services/[^[:space:]]+)[[:space:]]+services/[^[:space:]]+$#\1#p' "$dir/Dockerfile" | sort)
[ -n "$patched" ] || fail "$patch_file touches no file"
[ "$patched" = "$summed" ] || fail "$patch_file touches [$(echo $patched)], $sums lists [$(echo $summed)]"
[ "$patched" = "$copied" ] || fail "$patch_file touches [$(echo $patched)], the Dockerfile copies [$(echo $copied)]"
while IFS= read -r file; do
  cmp -s <(sed -nE "s#^COPY[[:space:]].*[[:space:]]$file[[:space:]]+(.*)\$#\\1#p" "$dir/Dockerfile") <(echo "$file") ||
    fail "the Dockerfile copies $file to another path than its own"
done <<<"$copied"

# Take the patch back out of the copies; the result must be the originals, byte for byte.
while IFS= read -r file; do
  mkdir -p "$work/$(dirname "$file")"
  cp "$dir/$file" "$work/$file"
done <<<"$patched"
patch --quiet --batch --fuzz=0 --no-backup-if-mismatch -R -p1 -d "$work" <"$patch_file" ||
  fail "$patch_file does not come back out of the copies cleanly; regenerate it from the originals (betrieb.md §11.7)"
(cd "$work" && sha256sum --quiet -c -) <"$sums" ||
  fail "the copies without $patch_file are not the originals of $sums: they differ from MRE by more than the patch"

echo "MRE pdfgenerator overlay: $(echo $patched) = originals of $sums + $patch_file: OK"
