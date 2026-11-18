#!/usr/bin/env bash
# Issues #396 and #398 (backlog VC-X-82; docs/development/betrieb.md §11.7): the MRE overlays deploy/mre-<service>
# (pdfgenerator, api, tenantapi) replace a few files of the pinned images with patched copies. This check keeps every
# overlay honest:
#   1. The files its patches (*.patch, applied in name order) touch and the files originals.sha256 lists are the same list.
#   2. The Dockerfile is pinned as a whole. After joining `\` continuations and dropping comments and blank lines, it
#      holds exactly these instructions and nothing else: one `FROM ghcr.io/microrealestate/microrealestate/<service>:…`
#      (its commit and digest are image-pin-check.sh's job), one checksum line, either
#      `RUN --mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256 sha256sum -c /tmp/originals.sha256`
#      or, for a distroless image without a shell, the same mount with the fixed node one-liner below (the build fails
#      when the base image does not hold the originals), and per patched file exactly one
#      `COPY [--chown=…] [--chmod=…] <file> <file>` with the same source and target. Any other instruction (RUN, ADD, a
#      further COPY, COPY --from, ENV, ARG, USER, WORKDIR, CMD, ENTRYPOINT, LABEL, …) and any parser directive
#      (`# syntax=`, `# escape=`, `# check=`) make the check red.
#   3. Taking the patches back out of the copies (in reverse name order) gives exactly the original files of MRE 479d0ad
#      (their SHA-256 in originals.sha256), so the copies differ from MRE only by the reviewed hunks of the patches.
# Reads only the repository files; needs bash, awk, GNU patch and sha256sum, no docker and no network.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
  echo "MRE overlay check failed: $*" >&2
  exit 1
}

mount='--mount=type=bind,source=originals.sha256,target=/tmp/originals.sha256'
check_sh="RUN $mount sha256sum -c /tmp/originals.sha256"
check_node="RUN $mount [\"/nodejs/bin/node\", \"-e\", \"const fs = require('fs'), crypto = require('crypto'); let bad = 0; for (const line of fs.readFileSync('/tmp/originals.sha256', 'utf8').split(String.fromCharCode(10)).filter(Boolean)) { const [sum, file] = line.split(' ').filter(Boolean); const ok = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sum; console.log(file + ': ' + (ok ? 'OK' : 'FAILED')); if (!ok) bad = 1; } process.exit(bad);\"]"

overlays=0
for dir in deploy/mre-*/; do
  dir=${dir%/}
  service=${dir#deploy/mre-}
  overlays=$((overlays + 1))
  sums=$dir/originals.sha256
  mapfile -t patches < <(find "$dir" -maxdepth 1 -name '*.patch' | sort)
  [ "${#patches[@]}" -gt 0 ] || fail "$dir has no *.patch"
  [ -f "$sums" ] || fail "$dir has no originals.sha256"

  # The files the patches touch and the files with an original checksum: one list.
  patched=$(sed -nE 's#^\+\+\+ b/([^[:space:]]+).*#\1#p' "${patches[@]}" | sort -u)
  summed=$(awk '{ print $2 }' "$sums" | sort)
  [ -n "$patched" ] || fail "the patches of $dir touch no file"
  [ "$patched" = "$summed" ] || fail "the patches of $dir touch [$(echo $patched)], $sums lists [$(echo $summed)]"

  # The Dockerfile as instructions: CR stripped, `\` continuations joined (comment and blank lines inside one are
  # skipped, as Docker does), comments and blank lines dropped, whitespace collapsed. A parser directive is refused.
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
  froms=0
  checks=0
  copied=
  while IFS= read -r instruction; do
    if [[ "$instruction" =~ ^FROM\ ghcr\.io/microrealestate/microrealestate/([a-z-]+):[^[:space:]]+$ ]]; then
      [ "${BASH_REMATCH[1]}" = "$service" ] || fail "$dockerfile starts FROM the MRE ${BASH_REMATCH[1]} image, not $service"
      froms=$((froms + 1))
    elif [ "$instruction" = "$check_sh" ] || [ "$instruction" = "$check_node" ]; then
      checks=$((checks + 1))
    elif [[ "$instruction" =~ ^COPY((\ --(chown|chmod)=[^[:space:]]+)*)\ ([^[:space:]]+)\ ([^[:space:]]+)$ ]]; then
      source=${BASH_REMATCH[4]}
      target=${BASH_REMATCH[5]}
      [ "$source" = "$target" ] || fail "$dockerfile copies $source to another path ($target)"
      grep -qxF -- "$source" <<<"$patched" || fail "$dockerfile copies $source, which no patch of $dir touches"
      copied+="$source"$'\n'
    else
      fail "$dockerfile has an instruction the overlay does not allow: $instruction"
    fi
  done <<<"$instructions"
  [ "$froms" = 1 ] || fail "$dockerfile needs exactly one FROM of the pinned MRE $service image, has $froms"
  [ "$checks" = 1 ] || fail "$dockerfile needs exactly one checksum line ('$check_sh' or the node form), has $checks"
  copied=$(printf '%s' "$copied" | sort)
  [ "$patched" = "$copied" ] ||
    fail "the patches of $dir touch [$(echo $patched)], $dockerfile copies [$(echo $copied)] (each file exactly once)"

  # Take the patches back out of the copies, last one first; the result must be the originals, byte for byte.
  rm -rf "${work:?}/$service"
  mkdir -p "$work/$service"
  while IFS= read -r file; do
    mkdir -p "$work/$service/$(dirname "$file")"
    cp "$dir/$file" "$work/$service/$file"
  done <<<"$patched"
  for ((i = ${#patches[@]} - 1; i >= 0; i--)); do
    patch --quiet --batch --fuzz=0 --no-backup-if-mismatch -R -p1 -d "$work/$service" <"${patches[$i]}" ||
      fail "${patches[$i]} does not come back out of the copies cleanly; regenerate it from the originals (betrieb.md §11.7)"
  done
  (cd "$work/$service" && sha256sum --quiet -c -) <"$sums" ||
    fail "the copies of $dir without its patches are not the originals of $sums: they differ from MRE by more than the patches"

  echo "MRE $service overlay: Dockerfile = FROM + checksum check + COPY of $(echo $patched); copies = originals + $(basename -a "${patches[@]}" | tr '\n' ' ')OK"
done
[ "$overlays" -gt 0 ] || fail "no overlay under deploy/mre-*"
