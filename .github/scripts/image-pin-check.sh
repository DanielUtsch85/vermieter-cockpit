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

# One Caddy and one Node (Entscheidung des Projektinhabers, 2026-11-10, zu #319 F3 (a): the cockpit-ui service with the
# pinned Caddy image). The final stage of webapps/cockpit/Dockerfile is the Caddy of docker-compose.proxy.yml, and its
# build stage the Node of services/de-backend/Dockerfile; Dependabot proposes the compose file and the Dockerfiles in
# separate PRs, and the Dockerfile entry leaves caddy out (.github/dependabot.yml), so a Caddy bump of the proxy stays
# red here until the same PR moves webapps/cockpit/Dockerfile too (betrieb.md §11.4).
from_refs() { # file image -> the distinct references of that image in the file's FROM lines
  grep -hiE '^\s*FROM\s' "$1" | sed -E 's/^\s*FROM\s+(--platform=\S+\s+)?(\S+).*/\2/I' | { grep -E "^$2[:@]" || true; } | sort -u
}
caddy_proxy=$(grep -hoE "image:\s*[\"']?caddy:[^[:space:]#\"']+" docker-compose.proxy.yml | head -n1 | sed -E "s/^image:\s*[\"']?//" || true)
caddy_ui=$(from_refs webapps/cockpit/Dockerfile caddy)
if [ -z "$caddy_proxy" ] || [ -z "$caddy_ui" ]; then
  echo "caddy image not found in docker-compose.proxy.yml or as a FROM of webapps/cockpit/Dockerfile" >&2
  fail=1
elif [ "$caddy_proxy" != "$caddy_ui" ]; then
  echo "caddy image differs: docker-compose.proxy.yml has $caddy_proxy, webapps/cockpit/Dockerfile has $(tr '\n' ' ' <<<"$caddy_ui"); update webapps/cockpit/Dockerfile to the image in docker-compose.proxy.yml" >&2
  fail=1
fi
node_refs=$(cat services/de-backend/Dockerfile webapps/cockpit/Dockerfile | from_refs /dev/stdin node)
if [ "$(grep -c . <<<"$node_refs")" != 1 ]; then
  echo "node image differs between the FROM lines of services/de-backend/Dockerfile and webapps/cockpit/Dockerfile: $(tr '\n' ' ' <<<"$node_refs")" >&2
  fail=1
fi

# One MRE commit (issues #396 and #398, betrieb.md §11.7): the MRE overlays (deploy/mre-<service>/Dockerfile:
# pdfgenerator, api, tenantapi) start FROM the pinned image of their service, so their tags are the same MRE commit as
# the ${MRE_VERSION:-<commit>@sha256:…} default of every MRE image in docker-compose.yml. An MRE upgrade that moves the
# compose defaults but not an overlay (or the other way round) stays red here: the overlays' patched files fit only the
# commit they were made from (VC-X-06).
overlays=(deploy/mre-pdfgenerator deploy/mre-api deploy/mre-tenantapi)
mre_commits=$(
  {
    grep -hoE 'ghcr\.io/microrealestate/microrealestate/[a-z-]+:\$\{MRE_VERSION:-[0-9a-f]{40}@' docker-compose.yml |
      sed -E 's/.*:-([0-9a-f]{40})@$/\1/'
    for overlay in "${overlays[@]}"; do
      from_refs "$overlay/Dockerfile" "ghcr.io/microrealestate/microrealestate/${overlay#deploy/mre-}" |
        sed -nE 's/^[^:]+:([0-9a-f]{40})@sha256:.*/\1/p'
    done
  } | sort -u
)
for overlay in "${overlays[@]}"; do
  if ! grep -q "microrealestate/${overlay#deploy/mre-}:" "$overlay/Dockerfile" 2>/dev/null; then
    echo "$overlay/Dockerfile has no FROM of the pinned MRE ${overlay#deploy/mre-} image" >&2
    fail=1
  fi
done
if [ "$(grep -c . <<<"$mre_commits")" != 1 ]; then
  echo "MRE commit differs between docker-compose.yml and the overlays ${overlays[*]}: $(tr '\n' ' ' <<<"$mre_commits")" >&2
  fail=1
fi
# Every overlay directory is one of the list above, so none escapes the commit check.
for dir in deploy/mre-*/; do
  case " ${overlays[*]} " in *" ${dir%/} "*) ;; *)
    echo "${dir%/} is an MRE overlay not listed in .github/scripts/image-pin-check.sh" >&2
    fail=1
    ;;
  esac
done

[ "$fail" = 0 ] || exit 1
echo "images pinned by digest, actions by commit SHA, postgres in CI as in compose, one caddy, one node and one MRE commit: OK"
