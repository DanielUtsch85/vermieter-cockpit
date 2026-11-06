#!/usr/bin/env bash
# Daily backup of the DE database (PostgreSQL), the MRE database (MongoDB) and the MRE files (uploads and generated PDFs
# of the pdfgenerator); docs/development/betrieb.md, issue #281.
#
#   scripts/ops/backup.sh            # from cron, see betrieb.md §2
#
# Writes BACKUP_DIR/daily/<date>/ with de-<stamp>.dump (pg_dump -Fc), mre-<stamp>.archive.gz (mongodump --archive --gzip),
# mre-files-<stamp>.tar.gz (tar of the two pdfgenerator volumes), MANIFEST and SHA256SUMS; verifies each file; keeps
# weekly and monthly copies; prunes; encrypts the run into BACKUP_DIR/outbox/ and copies it to a second location. No
# secret is read or written here: the database user and name come from the environment or the .env next to
# docker-compose.yml, the dumps run inside the containers over their local socket, and encryption uses a public key.
#
# Configuration (environment variables, all optional):
#   COMPOSE_DIR        directory of docker-compose.yml and .env      (default: the repository root of this script)
#   COMPOSE_CMD        compose command                               (default: "docker compose")
#   BACKUP_DIR         target directory, OUTSIDE the Docker volumes  (default: /var/backups/vermieter-cockpit)
#   BACKUP_TARGETS     any of "de", "mre", "mre-files"               (default: "de mre mre-files")
#   DE_PG_SERVICE      compose service of the DE database            (default: de-postgres)
#   DE_DB_USER         DE database user                              (default: from .env, else "de")
#   DE_DB_NAME         DE database name                              (default: from .env, else "de")
#   MRE_MONGO_SERVICE  compose service of the MRE database           (default: mongo)
#   MRE_MONGO_DB       MRE database name                             (default: mredb)
#   MRE_FILES_SERVICE  compose service holding the MRE files         (default: pdfgenerator)
#   MRE_FILES_ROOT     their parent directory in that container      (default: /usr/app/services/pdfgenerator)
#   MRE_FILES_DIRS     the directories below it                      (default: "uploads pdf_documents")
#   KEEP_DAILY / KEEP_WEEKLY / KEEP_MONTHLY   retention              (default: 14 / 8 / 12)
#   WEEKLY_DAY         ISO weekday of the weekly copy, 1 = Monday    (default: 7, Sunday)
#   BACKUP_ENCRYPT_CMD filter (stdin to stdout) that encrypts a run for the second location, e.g.
#                      'age -R /etc/vermieter-cockpit/backup-recipients.txt' (public keys only; default: none)
#   BACKUP_ENCRYPT_SUFFIX  file suffix of the encrypted run         (default: .age)
#   BACKUP_COPY_CMD    shell command for the copy to a second location, run with sh -c after a successful backup;
#                      BACKUP_DIR and BACKUP_OUTBOX (the encrypted runs) are exported to it, e.g.
#                      'rclone copy --immutable "$BACKUP_OUTBOX" offsite:vc-backup' (default: none, no copy).
#                      Refused unless BACKUP_ENCRYPT_CMD is set or BACKUP_COPY_ENCRYPTS=1 (the copy tool encrypts
#                      itself, e.g. restic): the dumps hold personal data and leave the machine only encrypted.
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
COMPOSE_DIR=${COMPOSE_DIR:-$(cd "$script_dir/../.." && pwd)}
COMPOSE_CMD=${COMPOSE_CMD:-docker compose}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/vermieter-cockpit}
BACKUP_TARGETS=${BACKUP_TARGETS:-de mre mre-files}
DE_PG_SERVICE=${DE_PG_SERVICE:-de-postgres}
MRE_MONGO_SERVICE=${MRE_MONGO_SERVICE:-mongo}
MRE_MONGO_DB=${MRE_MONGO_DB:-mredb}
MRE_FILES_SERVICE=${MRE_FILES_SERVICE:-pdfgenerator}
MRE_FILES_ROOT=${MRE_FILES_ROOT:-/usr/app/services/pdfgenerator}
MRE_FILES_DIRS=${MRE_FILES_DIRS:-uploads pdf_documents}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}
WEEKLY_DAY=${WEEKLY_DAY:-7}
BACKUP_COPY_CMD=${BACKUP_COPY_CMD:-}
BACKUP_ENCRYPT_CMD=${BACKUP_ENCRYPT_CMD:-}
BACKUP_ENCRYPT_SUFFIX=${BACKUP_ENCRYPT_SUFFIX:-.age}
BACKUP_COPY_ENCRYPTS=${BACKUP_COPY_ENCRYPTS:-0}

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
[ -n "${BACKUP_TARGETS// /}" ] || fail "BACKUP_TARGETS ist leer"
for t in $BACKUP_TARGETS; do
  case $t in de | mre | mre-files) ;; *) fail "unbekanntes Ziel in BACKUP_TARGETS: '$t' (erlaubt: de, mre, mre-files)" ;; esac
done

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly" "$BACKUP_DIR/outbox"
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

if [[ " $BACKUP_TARGETS " == *" mre-files "* ]]; then
  files_file="mre-files-$stamp.tar.gz"
  log "MRE-Dateien: tar $MRE_FILES_DIRS aus $MRE_FILES_SERVICE:$MRE_FILES_ROOT"
  # shellcheck disable=SC2086 # MRE_FILES_DIRS is a list of directory names on purpose.
  compose exec -T "$MRE_FILES_SERVICE" tar -C "$MRE_FILES_ROOT" -cf - $MRE_FILES_DIRS | gzip >"$work/$files_file"
  # Verification: the archive lists completely and holds every directory.
  listing=$(tar -tzf "$work/$files_file") || fail "MRE-Dateien: Archiv nicht lesbar (tar -t)"
  for d in $MRE_FILES_DIRS; do
    grep -q "^$d/\?\$" <<<"$listing" || fail "MRE-Dateien: $d fehlt im Archiv"
  done
  log "MRE-Dateien: $(grep -vc '/$' <<<"$listing") Einträge ohne Verzeichnisse, $(wc -c <"$work/$files_file") Bytes"
fi

{
  echo "created_utc=$stamp"
  echo "host=$(hostname)"
  echo "targets=$BACKUP_TARGETS"
  echo "de_db=$DE_DB_NAME"
  echo "mre_db=$MRE_MONGO_DB"
  echo "mre_files=$MRE_FILES_SERVICE:$MRE_FILES_ROOT ($MRE_FILES_DIRS)"
  echo "git_commit=$(git -C "$COMPOSE_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  mre_version=$(env_value MRE_VERSION)
  echo "mre_version=${mre_version:-Standard aus docker-compose.yml}"
} >"$work/MANIFEST"
(cd "$work" && shopt -s nullglob && sha256sum -- *.dump *.archive.gz *.tar.gz MANIFEST >SHA256SUMS)
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

# Encryption for the second location: the whole run as one tar through BACKUP_ENCRYPT_CMD, with its own checksum. The
# outbox keeps the newest KEEP_DAILY runs; the second location keeps what it received (append-only, its own retention).
outbox="$BACKUP_DIR/outbox"
if [ -n "$BACKUP_ENCRYPT_CMD" ]; then
  # Named by the run's UTC stamp, which sorts by time (the directory name of a second run per day does not).
  sealed="vermieter-cockpit-$stamp.tar$BACKUP_ENCRYPT_SUFFIX"
  log "Verschlüsselung: $sealed"
  tar -C "$(dirname "$target")" -cf - "$(basename "$target")" | sh -c "$BACKUP_ENCRYPT_CMD" >"$outbox/.$sealed.tmp" ||
    fail "Verschlüsselung fehlgeschlagen; die lokale Sicherung ist vollständig"
  [ -s "$outbox/.$sealed.tmp" ] || fail "Verschlüsselung ergab eine leere Datei"
  mv "$outbox/.$sealed.tmp" "$outbox/$sealed"
  (cd "$outbox" && sha256sum -- "$sealed" >"$sealed.sha256")
  find "$outbox" -mindepth 1 -maxdepth 1 -type f -name "*.tar$BACKUP_ENCRYPT_SUFFIX" -print | sort -r |
    tail -n +"$((KEEP_DAILY + 1))" | while IFS= read -r old; do
    log "entferne $old"
    rm -f -- "$old" "$old.sha256"
  done
fi

if [ -n "$BACKUP_COPY_CMD" ]; then
  if [ -z "$BACKUP_ENCRYPT_CMD" ] && [ "$BACKUP_COPY_ENCRYPTS" != "1" ]; then
    fail "BACKUP_COPY_CMD ohne BACKUP_ENCRYPT_CMD: unverschlüsselt verlässt keine Sicherung den Rechner (betrieb.md §3)"
  fi
  log "Kopie an zweiten Ort: $BACKUP_COPY_CMD"
  BACKUP_DIR="$BACKUP_DIR" BACKUP_OUTBOX="$outbox" sh -c "$BACKUP_COPY_CMD" ||
    fail "Kopie an zweiten Ort fehlgeschlagen; die lokale Sicherung ist vollständig"
fi
