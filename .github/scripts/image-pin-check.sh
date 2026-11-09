#!/usr/bin/env bash
# VC-X-09 (docs/development/betrieb.md §11): every container image is pinned by digest (`tag@sha256:…`) and every
# GitHub Action by commit SHA with its version as a comment (`owner/action@<40 hex> # vX.Y.Z`). Reads only the
# repository files; needs no docker and no network.
set -euo pipefail

fail=0
# Exactly 64 hex characters, then `}` (end of the ${MRE_VERSION:-…} default), a quote, whitespace or the end.
digest="@sha256:[0-9a-f]{64}([}\"'[:space:]]|\$)"

# `image:` lines in the compose files and the workflows (job services); the MRE images carry the digest in the
# default of ${MRE_VERSION:-<commit>@sha256:…}. A digest only in a trailing comment does not count.
while IFS= read -r line; do
  ref=${line%%#*}
  if ! grep -Eq "$digest" <<<"$ref"; then
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

# postgres:16 drift (Entscheidung des Projektinhabers, 2026-11-09, zu #299 Frage 2): CI tests against the same
# PostgreSQL image that runs in production. Dependabot updates the compose file but not the job service in ci.yml.
# A quoted image ("postgres:16@sha256:…" or 'postgres:…') is the same reference: the quotes are stripped before comparing.
pg_ref() { grep -hoE "image:\s*[\"']?postgres:[^[:space:]#\"']+" "$1" | head -n1 | sed -E "s/^image:\s*[\"']?//"; }
pg_compose=$(pg_ref docker-compose.yml)
pg_ci=$(pg_ref .github/workflows/ci.yml)
if [ -z "$pg_compose" ] || [ -z "$pg_ci" ]; then
  echo "postgres image not found in docker-compose.yml or .github/workflows/ci.yml" >&2
  fail=1
elif [ "$pg_compose" != "$pg_ci" ]; then
  echo "postgres image differs: docker-compose.yml has $pg_compose, .github/workflows/ci.yml has $pg_ci; update .github/workflows/ci.yml to the image in docker-compose.yml" >&2
  fail=1
fi

[ "$fail" = 0 ] || exit 1
echo "images pinned by digest, actions by commit SHA, postgres in CI as in compose: OK"
