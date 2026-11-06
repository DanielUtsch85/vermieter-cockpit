#!/usr/bin/env bash
# Issue #281 item 1 (docs/development/betrieb.md): runs scripts/ops/backup.sh against the compose stack after
# compose-auth-smoke.sh has written data, then restores both dumps into side databases of the same containers and
# compares them with the originals: exact row counts of every DE table (kysely_migration included) and document counts of
# every MRE collection. The MRE files (pdfgenerator volumes) are backed up with a seeded synthetic file, which is deleted
# and restored from the tar. Last, backup-check.sh passes on the fresh backup and alerts on a too strict age limit, and
# backup.sh refuses KEEP_DAILY=0. A side database is not a fresh machine; the restore on a fresh machine is recorded by
# hand in betrieb.md "Restore geübt".
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
backup_dir=$(mktemp -d)
check_db=de_restore_check
check_mongo=mredb_restore_check
files_root=/usr/app/services/pdfgenerator
seed=uploads/backup-smoke/beleg-synthetisch.pdf
trap 'rm -rf "$backup_dir"' EXIT

pg() { docker compose exec -T de-postgres psql -U de -v ON_ERROR_STOP=1 -tA "$@"; }
row_counts() {
  pg -d "$1" -F ' ' -c "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',
    table_schema, table_name), false, true, '')))[1]::text::bigint FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
}

# 0. A synthetic upload in the pdfgenerator volume.
docker compose exec -T pdfgenerator sh -c "mkdir -p $files_root/uploads/backup-smoke && echo synthetisch-$$ >$files_root/$seed"

# 1. Backup of both databases and the MRE files, with the script's own verification (pg_restore --list, gzip -t, mongorestore --dryRun).
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

# 4. MRE files: the seeded upload is in the tar; deleted in the volume, it comes back from the tar unchanged.
tar -tzf "$day_dir"/mre-files-*.tar.gz | grep -qx "$seed"
docker compose exec -T pdfgenerator rm "$files_root/$seed"
gunzip -c "$day_dir"/mre-files-*.tar.gz | docker compose exec -T pdfgenerator tar -C "$files_root" -xf -
test "$(docker compose exec -T pdfgenerator cat "$files_root/$seed")" = "synthetisch-$$"
docker compose exec -T pdfgenerator rm -r "$files_root/uploads/backup-smoke"

# 5. Monitoring: quiet on the fresh backup, an alert (exit 1) when the age limit is 0 hours.
BACKUP_DIR="$backup_dir" "$root/scripts/ops/backup-check.sh"
sleep 1
if BACKUP_DIR="$backup_dir" BACKUP_MAX_AGE_HOURS=0 "$root/scripts/ops/backup-check.sh" 2>/dev/null; then
  echo "backup-check did not alert on a backup older than its limit" >&2
  exit 1
fi
# 6. Retention guard: KEEP_DAILY=0 would delete the run just written; refused before anything is created.
if BACKUP_DIR="$backup_dir/keep-zero" KEEP_DAILY=0 "$root/scripts/ops/backup.sh" 2>/dev/null; then
  echo "backup.sh did not refuse KEEP_DAILY=0" >&2
  exit 1
fi
test ! -e "$backup_dir/keep-zero"
echo "backup and restore smoke: ok"
