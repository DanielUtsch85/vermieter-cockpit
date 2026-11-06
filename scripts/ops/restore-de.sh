#!/usr/bin/env bash
# Restore of the DE database from a dump of scripts/ops/backup.sh onto a fresh installation; docs/development/betrieb.md §6.
#
#   scripts/ops/restore-de.sh /path/to/daily/<date>/de-<stamp>.dump
#
# Checks the dump against the SHA256SUMS next to it, refuses a DE database that already holds tables (a restore goes into
# an empty database only), copies the dump into the database container and restores it in one transaction. de-backend
# must be stopped; start it afterwards, it then applies no migration ("none pending") if the code matches the dump.
#
# Configuration (environment variables, all optional): COMPOSE_DIR, COMPOSE_CMD, DE_PG_SERVICE, DE_DB_USER, DE_DB_NAME as
# in backup.sh. No secret is needed: pg_restore runs inside the container over its local socket.
set -euo pipefail

[ $# -eq 1 ] || {
  echo "Aufruf: $0 <de-….dump>" >&2
  exit 2
}
dump=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -f "$dump" ] || {
  echo "Dump nicht gefunden: $dump" >&2
  exit 2
}

script_dir=$(cd "$(dirname "$0")" && pwd)
COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$script_dir/../.." && pwd)}
COMPOSE_CMD=${COMPOSE_CMD:-docker compose}
DE_PG_SERVICE=${DE_PG_SERVICE:-de-postgres}

log() { printf '%s restore-de: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() {
  log "FEHLER: $*"
  exit 1
}
env_value() {
  local file="$COMPOSE_DIR/.env"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
DE_DB_USER=${DE_DB_USER:-$(env_value DE_DB_USER)}
DE_DB_USER=${DE_DB_USER:-de}
DE_DB_NAME=${DE_DB_NAME:-$(env_value DE_DB_NAME)}
DE_DB_NAME=${DE_DB_NAME:-de}

# shellcheck disable=SC2086 # COMPOSE_CMD is a command with arguments on purpose.
compose() { (cd "$COMPOSE_DIR" && $COMPOSE_CMD "$@"); }
psql_de() { compose exec -T "$DE_PG_SERVICE" psql -U "$DE_DB_USER" -d "$DE_DB_NAME" -v ON_ERROR_STOP=1 -tA "$@"; }

# Exact row count of every table in public, one "table count" line each (also used in betrieb.md §7).
ROW_COUNTS_SQL="SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', \
table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables \
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"

started=$(date +%s)

# 1. Checksum.
sums="$(dirname "$dump")/SHA256SUMS"
if [ -f "$sums" ]; then
  (cd "$(dirname "$dump")" && grep " $(basename "$dump")\$" SHA256SUMS | sha256sum -c --quiet -) ||
    fail "Prüfsumme stimmt nicht: $dump"
  log "Prüfsumme in Ordnung"
else
  fail "keine SHA256SUMS neben dem Dump; ohne Prüfsumme wird nicht wiederhergestellt"
fi

# 2. Target database must be empty (fresh installation).
tables=$(psql_de -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
[ "$tables" = "0" ] || fail "Datenbank $DE_DB_NAME enthält schon $tables Tabellen; Restore nur in eine leere Datenbank"

# 3. Restore inside the container: the file is copied in, so pg_restore reads a seekable file.
inside="/tmp/restore-$(basename "$dump")"
compose cp "$dump" "$DE_PG_SERVICE:$inside"
log "pg_restore nach $DE_DB_NAME"
restore_status=0
compose exec -T "$DE_PG_SERVICE" pg_restore -U "$DE_DB_USER" -d "$DE_DB_NAME" --exit-on-error --single-transaction \
  --no-owner --no-privileges "$inside" || restore_status=$?
compose exec -T "$DE_PG_SERVICE" rm -f "$inside" || true
[ "$restore_status" -eq 0 ] || fail "pg_restore fehlgeschlagen (Status $restore_status); die Transaktion ist zurückgerollt"

# 4. Short report: migration state and row counts per table (betrieb.md §7 compares them with the source).
log "kysely_migration: $(psql_de -c "SELECT count(*) || ' Migrationen, letzte ' || max(name) FROM public.kysely_migration")"
psql_de -F ' ' -c "$ROW_COUNTS_SQL" >&2
log "fertig in $(($(date +%s) - started)) s; jetzt de-backend starten und betrieb.md §7 prüfen"
