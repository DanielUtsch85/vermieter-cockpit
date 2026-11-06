#!/usr/bin/env bash
# Issue #281 item 1 (docs/development/betrieb.md): runs scripts/ops/backup.sh against the compose stack after
# compose-auth-smoke.sh has written data, then restores both dumps into side databases of the same containers and
# compares them with the originals: exact row counts of every DE table (kysely_migration included) and document counts of
# every MRE collection. A side database is not a fresh machine; the restore on a fresh machine is recorded by hand in
# betrieb.md "Restore geübt".
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
backup_dir=$(mktemp -d)
check_db=de_restore_check
check_mongo=mredb_restore_check
trap 'rm -rf "$backup_dir"' EXIT

pg() { docker compose exec -T de-postgres psql -U de -v ON_ERROR_STOP=1 -tA "$@"; }
row_counts() {
  pg -d "$1" -F ' ' -c "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
    table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
}

# 1. Backup of both databases, with the script's own verification (pg_restore --list, gzip -t, mongorestore --dryRun).
BACKUP_DIR="$backup_dir" "$root/scripts/ops/backup.sh"
day_dir=$(find "$backup_dir/daily" -mindepth 1 -maxdepth 1 -type d | head -n 1)
ls -l "$day_dir"
(cd "$day_dir" && sha256sum -c SHA256SUMS)

# 2. DE: restore into an empty side database with restore-de.sh and compare.
pg -d de -c "DROP DATABASE IF EXISTS $check_db" -c "CREATE DATABASE $check_db" >/dev/null
DE_DB_NAME=$check_db "$root/scripts/ops/restore-de.sh" "$day_dir"/de-*.dump
source_counts=$(row_counts de)
restored_counts=$(row_counts "$check_db")
echo "$source_counts"
diff <(echo "$source_counts") <(echo "$restored_counts")
test "$(echo "$source_counts" | awk '$1 == "kysely_migration" { print $2 }')" -gt 0
test "$(echo "$source_counts" | awk '$1 == "ledger_transaction" { print $2 }')" -gt 0
# A second restore into the now filled database is refused.
if DE_DB_NAME=$check_db "$root/scripts/ops/restore-de.sh" "$day_dir"/de-*.dump 2>/dev/null; then
  echo "restore into a non-empty database was not refused" >&2
  exit 1
fi
pg -d de -c "DROP DATABASE $check_db" >/dev/null

# 3. MRE: restore the archive under another database name and compare document counts per collection.
docker compose exec -T mongo mongorestore --quiet --archive --gzip --drop \
  --nsFrom='mredb.*' --nsTo="$check_mongo.*" <"$(ls "$day_dir"/mre-*.archive.gz)"
docker compose exec -T mongo mongosh --quiet --eval "
  const a = db.getSiblingDB('mredb'), b = db.getSiblingDB('$check_mongo');
  const names = a.getCollectionNames().sort();
  let bad = 0;
  for (const n of names) {
    const x = a.getCollection(n).countDocuments(), y = b.getCollection(n).countDocuments();
    print(n + ' ' + x + ' ' + y);
    if (x !== y) bad++;
  }
  if (names.length === 0 || a.getCollection('realms').countDocuments() === 0) bad++;
  if (JSON.stringify(names) !== JSON.stringify(b.getCollectionNames().sort())) bad++;
  b.dropDatabase();
  quit(bad === 0 ? 0 : 1);
"
echo "backup and restore smoke: ok"
