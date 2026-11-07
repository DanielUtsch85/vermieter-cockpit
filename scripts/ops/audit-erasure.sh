#!/usr/bin/env bash
# Deletion request (Art. 17 DSGVO) against the history of one Party; docs/development/betrieb.md §12, api-design.md §58U.
#
#   scripts/ops/audit-erasure.sh <mreRealmId> <partyId>            # Probelauf (Standard): listet, schreibt nichts
#   scripts/ops/audit-erasure.sh <mreRealmId> <partyId> --apply    # pseudonymisiert, was nach der Aufbewahrung fällig ist
#
# Lists every AMENDED AuditRecord of the Party with its creation year, the end of its retention (31.12. of the creation
# year + 10, Europe/Berlin), pseudonymised_at and the paths that would change. --apply replaces the personal values of
# the records whose retention has ended by the marker [entfernt:v1], by the same code as the daily job; a record within
# retention is listed and kept (§ 147 AO). The Party's current values are not touched. The request itself (who, when,
# what) is filed outside this repository and outside the DE database; this script prints ids and dates only.
#
# Runs `node dist/audit-erasure.js` inside the running de-backend container (it reads DATABASE_URL there).
# Configuration (environment variables, all optional): COMPOSE_DIR, COMPOSE_CMD as in backup.sh; DE_BACKEND_SERVICE
# (default: de-backend). No secret is needed.
set -euo pipefail

usage() {
  echo "Aufruf: $0 <mreRealmId> <partyId> [--dry-run|--apply]" >&2
  exit 2
}
[ $# -ge 2 ] && [ $# -le 3 ] || usage
realm=$1
party=$2
mode=${3:---dry-run}
[[ $realm =~ ^[0-9a-f]{24}$ ]] || {
  echo "mreRealmId ist keine MRE-Objekt-Id (24 Hex-Zeichen): $realm" >&2
  exit 2
}
[[ $party =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
  echo "partyId ist keine UUID: $party" >&2
  exit 2
}
case $mode in --dry-run | --apply) ;; *) usage ;; esac

script_dir=$(cd "$(dirname "$0")" && pwd)
COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$script_dir/../.." && pwd)}
COMPOSE_CMD=${COMPOSE_CMD:-docker compose}
DE_BACKEND_SERVICE=${DE_BACKEND_SERVICE:-de-backend}

# shellcheck disable=SC2086 # COMPOSE_CMD is a command with arguments on purpose.
(cd "$COMPOSE_DIR" && $COMPOSE_CMD exec -T "$DE_BACKEND_SERVICE" node dist/audit-erasure.js "$realm" "$party" "$mode")
