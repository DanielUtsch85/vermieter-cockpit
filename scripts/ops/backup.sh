#!/usr/bin/env bash
# Daily backup of the DE database (PostgreSQL) and the MRE database (MongoDB); docs/development/betrieb.md, issue #281.
#
#   scripts/ops/backup.sh            # from cron, see betrieb.md §2
#
# Writes BACKUP_DIR/daily/<date>/ with de-<stamp>.dump (pg_dump -Fc), mre-<stamp>.archive.gz (mongodump --archive --gzip),
# MANIFEST and SHA256SUMS; verifies each dump; keeps weekly and monthly copies; prunes; optionally copies BACKUP_DIR to a
# second location. No secret is read or written here: the database user and name come from the environment or the .env
# next to docker-compose.yml, and the dumps run inside the containers over their local socket.
#
# Configuration (environment variables, all optional):
#   COMPOSE_DIR        directory of docker-compose.yml and .env      (default: the repository root of this script)
#   COMPOSE_CMD        compose command                               (default: "docker compose")
#   BACKUP_DIR         target directory, OUTSIDE the Docker volumes  (default: /var/backups/vermieter-cockpit)
#   BACKUP_TARGETS     what to dump: "de mre", "de" or "mre"         (default: "de mre")
#   DE_PG_SERVICE      compose service of the DE database            (default: de-postgres)
#   DE_DB_USER         DE database user                              (default: from .env, else "de")
#   DE_DB_NAME         DE database name                              (default: from .env, else "de")
#   MRE_MONGO_SERVICE  compose service of the MRE database           (default: mongo)
#   MRE_MONGO_DB       MRE database name                             (default: mredb)
#   KEEP_DAILY / KEEP_WEEKLY / KEEP_MONTHLY   retention              (default: 14 / 8 / 12)
#   WEEKLY_DAY         ISO weekday of the weekly copy, 1 = Monday    (default: 7, Sunday)
#   BACKUP_COPY_CMD    shell command for the copy to a second location, run with sh -c after a successful backup;
#                      BACKUP_DIR is exported to it, e.g. 'rsync -a --delete "$BACKUP_DIR/" nas:/srv/vc-backup/'
#                      or 'rclone sync "$BACKUP_DIR" offsite:vc-backup' (default: none, no copy)
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$script_dir/../.." && pwd)}
COMPOSE_CMD=${COMPOSE_CMD:-docker compose}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/vermieter-cockpit}
BACKUP_TARGETS=${BACKUP_TARGETS:-de mre}
DE_PG_SERVICE=${DE_PG_SERVICE:-de-postgres}
MRE_MONGO_SERVICE=${MRE_MONGO_SERVICE:-mongo}
MRE_MONGO_DB=${MRE_MONGO_DB:-mredb}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}
WEEKLY_DAY=${WEEKLY_DAY:-7}
BACKUP_COPY_CMD=${BACKUP_COPY_CMD:-}

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() {
  log "FEHLER: $*"
  exit 1
}

# Reads one variable from the .env without sourcing it (the file holds secrets and need not be valid shell).
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

for n in "$KEEP_DAILY" "$KEEP_WEEKLY" "$KEEP_MONTHLY" "$WEEKLY_DAY"; do
  case $n in '' | *[!0-9]*) fail "Aufbewahrung und WEEKLY_DAY müssen ganze Zahlen sein: '$n'" ;; esac
done
case " $BACKUP_TARGETS " in *" de "* | *" mre "*) ;; *) fail "BACKUP_TARGETS enthält weder de noch mre: '$BACKUP_TARGETS'" ;; esac

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"
# One run at a time; mkdir is atomic.
lock="$BACKUP_DIR/.lock"
mkdir "$lock" 2>/dev/null || fail "eine andere Sicherung läuft ($lock); nach einem Absturz das Verzeichnis entfernen"
work=""
cleanup() {
  local status=$?
  [ -z "$work" ] || rm -rf "$work"
  rmdir "$lock" 2>/dev/null || true
  # Cron mails stderr: an aborted run always ends with this line.
  [ "$status" -eq 0 ] || log "abgebrochen mit Status $status (Ursache in der Meldung davor); unfertige Dateien sind entfernt"
}
trap cleanup EXIT

stamp=$(date -u +%Y%m%dT%H%M%SZ)
day=$(date -u +%Y-%m-%d)
work=$(mktemp -d "$BACKUP_DIR/.work-$stamp-XXXXXX")
started=$(date +%s)

if [[ " $BACKUP_TARGETS " == *" de "* ]]; then
  de_file="de-$stamp.dump"
  log "DE: pg_dump $DE_DB_NAME aus $DE_PG_SERVICE"
  compose exec -T "$DE_PG_SERVICE" pg_dump -U "$DE_DB_USER" -d "$DE_DB_NAME" -Fc --no-owner --no-privileges >"$work/$de_file"
  [ -s "$work/$de_file" ] || fail "DE-Dump ist leer"
  # Verification: the archive's table of contents must be readable and list kysely_migration (the migration state).
  toc=$(compose exec -T "$DE_PG_SERVICE" pg_restore --list <"$work/$de_file") || fail "DE-Dump nicht lesbar (pg_restore --list)"
  grep -q 'TABLE DATA public kysely_migration ' <<<"$toc" || fail "DE-Dump enthält keine Daten von kysely_migration"
  log "DE: $(grep -c ' TABLE DATA ' <<<"$toc") Tabellen im Dump, $(wc -c <"$work/$de_file") Bytes"
fi

if [[ " $BACKUP_TARGETS " == *" mre "* ]]; then
  mre_file="mre-$stamp.archive.gz"
  log "MRE: mongodump $MRE_MONGO_DB aus $MRE_MONGO_SERVICE"
  compose exec -T "$MRE_MONGO_SERVICE" mongodump --quiet --db="$MRE_MONGO_DB" --archive --gzip >"$work/$mre_file"
  [ -s "$work/$mre_file" ] || fail "MRE-Dump ist leer"
  gzip -t "$work/$mre_file" || fail "MRE-Dump ist kein gültiges gzip"
  # Verification: a dry run reads the whole archive without writing anything.
  compose exec -T "$MRE_MONGO_SERVICE" mongorestore --quiet --archive --gzip --dryRun <"$work/$mre_file" ||
    fail "MRE-Dump nicht lesbar (mongorestore --dryRun)"
  log "MRE: $(wc -c <"$work/$mre_file") Bytes"
fi

{
  echo "created_utc=$stamp"
  echo "host=$(hostname)"
  echo "targets=$BACKUP_TARGETS"
  echo "de_db=$DE_DB_NAME"
  echo "mre_db=$MRE_MONGO_DB"
  echo "git_commit=$(git -C "$COMPOSE_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  mre_version=$(env_value MRE_VERSION)
  echo "mre_version=${mre_version:-Standard aus docker-compose.yml}"
} >"$work/MANIFEST"
(cd "$work" && shopt -s nullglob && sha256sum -- *.dump *.archive.gz MANIFEST >SHA256SUMS)
(cd "$work" && sha256sum -c --quiet SHA256SUMS) || fail "Prüfsummen stimmen nicht"

# Publish atomically: a directory under daily/ is always complete. A second run on the same day gets its own suffix.
target="$BACKUP_DIR/daily/$day"
[ ! -e "$target" ] || target="$BACKUP_DIR/daily/$day-$stamp"
mv "$work" "$target"
work=""
log "fertig: $target ($(($(date +%s) - started)) s)"

# Weekly and monthly copies are hard links (no extra space while the daily copy exists).
if [ "$(date -u +%u)" = "$WEEKLY_DAY" ]; then
  week=$(date -u +%G-W%V)
  [ -e "$BACKUP_DIR/weekly/$week" ] || cp -al "$target" "$BACKUP_DIR/weekly/$week"
fi
if [ "$(date -u +%d)" = "01" ]; then
  month=$(date -u +%Y-%m)
  [ -e "$BACKUP_DIR/monthly/$month" ] || cp -al "$target" "$BACKUP_DIR/monthly/$month"
fi

# Retention: keep the newest N directories of each kind (names sort by date).
prune() {
  local dir=$1 keep=$2
  find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print | sort -r | tail -n +"$((keep + 1))" |
    while IFS= read -r old; do
      log "entferne $old"
      rm -rf -- "$old"
    done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"
prune "$BACKUP_DIR/monthly" "$KEEP_MONTHLY"

if [ -n "$BACKUP_COPY_CMD" ]; then
  log "Kopie an zweiten Ort: $BACKUP_COPY_CMD"
  BACKUP_DIR="$BACKUP_DIR" sh -c "$BACKUP_COPY_CMD" || fail "Kopie an zweiten Ort fehlgeschlagen; die lokale Sicherung ist vollständig"
fi
