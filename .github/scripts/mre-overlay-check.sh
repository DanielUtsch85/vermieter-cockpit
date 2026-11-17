#!/usr/bin/env bash
# Issue #396 (backlog VC-X-82; docs/development/betrieb.md §11.7): the MRE pdfgenerator overlay in deploy/mre-pdfgenerator
# replaces two files of the pinned image with patched copies. This check keeps the overlay honest:
#   1. The files realm-396.patch touches and the files originals.sha256 lists are the same list.
#   2. The Dockerfile is pinned as a whole. After joining `\` continuations and dropping comments and blank lines, it
#      holds exactly these instructions and nothing else: one `FROM ghcr.io/microrealestate/microrealestate/pdfgenerator:…`
#      (its commit and digest are image-pin-check.sh's job), the line
#      `RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 sha256sum -c /tmp/originals.sha256`
#      (the build fails when the base image does not hold the originals), and per file of the patch exactly one
#      `COPY [--chown=…] [--chmod=…] <file> <file>` with the same source and target. Any other instruction (RUN, ADD, a
#      further COPY, COPY --from, ENV, ARG, USER, WORKDIR, CMD, ENTRYPOINT, LABEL, …) and any parser directive
#      (`# syntax=`, `# escape=`, `# check=`) make the check red.
#   3. Taking realm-396.patch back out of the copies gives exactly the original files of MRE 479d0ad (their SHA-256 in
#      originals.sha256), so the copies differ from MRE only by the reviewed hunks of the patch.
# Reads only the repository files; needs bash, awk, GNU patch and sha256sum, no docker and no network.
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

# The files the patch touches and the files with an original checksum: one list.
patched=$(sed -nE 's#^\+\+\+ b/([^[:space:]]+).*#\1#p' "$patch_file" | sort)
summed=$(awk '{ print $2 }' "$sums" | sort)
[ -n "$patched" ] || fail "$patch_file touches no file"
[ "$patched" = "$summed" ] || fail "$patch_file touches [$(echo $patched)], $sums lists [$(echo $summed)]"

# The Dockerfile as instructions: CR stripped, `\` continuations joined (comment and blank lines inside one are skipped,
# as Docker does), comments and blank lines dropped, whitespace collapsed. A parser directive is refused outright.
dockerfile=$dir/Dockerfile
if grep -Eiq '^[[:space:]]*#[[:space:]]*(syntax|escape|check)[[:space:]]*=' "$dockerfile"; then
  fail "$dockerfile carries a parser directive (# syntax=, # escape= or # check=)"
fi
instructions=$(awk '
  { sub(/\r$/, "") }
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  {
    line = $0
    if (line ~ /\\[[:space:]]*$/) { sub(/\\[[:space:]]*$/, "", line); buf = buf line " "; next }
    buf = buf line
    gsub(/[[:space:]]+/, " ", buf); sub(/^ /, "", buf); sub(/ $/, "", buf)
    print buf; buf = ""
  }
  END { if (buf != "") { gsub(/[[:space:]]+/, " ", buf); sub(/^ /, "", buf); sub(/ $/, "", buf); print buf } }
' "$dockerfile")
check_line='RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 sha256sum -c /tmp/originals.sha256'
froms=0
checks=0
copied=
while IFS= read -r instruction; do
  if [[ "$instruction" =~ ^FROM\ ghcr\.io/microrealestate/microrealestate/pdfgenerator:[^[:space:]]+$ ]]; then
    froms=$((froms + 1))
  elif [ "$instruction" = "$check_line" ]; then
    checks=$((checks + 1))
  elif [[ "$instruction" =~ ^COPY((\ --(chown|chmod)=[^[:space:]]+)*)\ ([^[:space:]]+)\ ([^[:space:]]+)$ ]]; then
    source=${BASH_REMATCH[4]}
    target=${BASH_REMATCH[5]}
    [ "$source" = "$target" ] || fail "$dockerfile copies $source to another path ($target)"
    grep -qxF -- "$source" <<<"$patched" || fail "$dockerfile copies $source, which $patch_file does not touch"
    copied+="$source"$'\n'
  else
    fail "$dockerfile has an instruction the overlay does not allow: $instruction"
  fi
done <<<"$instructions"
[ "$froms" = 1 ] || fail "$dockerfile needs exactly one FROM of the pinned MRE pdfgenerator image, has $froms"
[ "$checks" = 1 ] || fail "$dockerfile needs exactly one line '$check_line', has $checks"
copied=$(printf '%s' "$copied" | sort)
[ "$patched" = "$copied" ] ||
  fail "$patch_file touches [$(echo $patched)], $dockerfile copies [$(echo $copied)] (each file exactly once)"

# Take the patch back out of the copies; the result must be the originals, byte for byte.
while IFS= read -r file; do
  mkdir -p "$work/$(dirname "$file")"
  cp "$dir/$file" "$work/$file"
done <<<"$patched"
patch --quiet --batch --fuzz=0 --no-backup-if-mismatch -R -p1 -d "$work" <"$patch_file" ||
  fail "$patch_file does not come back out of the copies cleanly; regenerate it from the originals (betrieb.md §11.7)"
(cd "$work" && sha256sum --quiet -c -) <"$sums" ||
  fail "the copies without $patch_file are not the originals of $sums: they differ from MRE by more than the patch"

echo "MRE pdfgenerator overlay: Dockerfile = FROM + checksum check + COPY of $(echo $patched); copies = originals of $sums + $patch_file: OK"
