#!/usr/bin/env bash
# VC-X-09 (docs/development/betrieb.md §11): every container image is pinned by digest (`tag@sha256:…`) and every
# GitHub Action by commit SHA with its version as a comment (`owner/action@<40 hex> # vX.Y.Z`). Reads only the
# repository files; needs no docker and no network.
set -euo pipefail

fail=0
digest='@sha256:[0-9a-f]{64}'

# `image:` lines in the compose files and the workflows (job services); the MRE images carry the digest in the
# default of ${MRE_VERSION:-<commit>@sha256:…}.
while IFS= read -r line; do
  if ! grep -Eq "$digest" <<<"$line"; then
    echo "image not pinned by digest: $line" >&2
    fail=1
  fi
done < <(grep -HnE '^\s*image:' docker-compose*.yml .github/workflows/*.yml)

# Dockerfile FROM lines (a FROM of an earlier build stage has no registry image and is skipped).
while IFS= read -r line; do
  ref=$(sed -E 's/^[^:]+:[0-9]+:\s*FROM\s+(--platform=\S+\s+)?(\S+).*/\2/I' <<<"$line")
  file=${line%%:*}
  if grep -Eiq "^\s*FROM\s.*\sAS\s+$ref\s*$" "$file"; then
    continue
  fi
  if ! grep -Eq "$digest" <<<"$ref"; then
    echo "base image not pinned by digest: $line" >&2
    fail=1
  fi
done < <(find . -name 'Dockerfile*' -not -path './node_modules/*' -not -path './.git/*' -exec grep -HniE '^\s*FROM\s' {} +)

# Actions: a full commit SHA and the release it stands for.
while IFS= read -r line; do
  if ! grep -Eq 'uses:\s*[^@[:space:]]+@[0-9a-f]{40}\s+#\s*v[0-9]+\.[0-9]+\.[0-9]+\s*$' <<<"$line"; then
    echo "action not pinned by commit SHA with a version comment: $line" >&2
    fail=1
  fi
done < <(grep -HnE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -vE 'uses:\s*\./')

[ "$fail" = 0 ] || exit 1
echo "images pinned by digest, actions by commit SHA: OK"
