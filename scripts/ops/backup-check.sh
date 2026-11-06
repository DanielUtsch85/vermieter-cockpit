#!/usr/bin/env bash
# Monitoring of scripts/ops/backup.sh; docs/development/betrieb.md §2a, issue #281.
#
#   scripts/ops/backup-check.sh      # from cron, some hours after the backup, see betrieb.md §2a
#
# Alerts when the newest backup under BACKUP_DIR/daily/ is missing, older than BACKUP_MAX_AGE_HOURS (by the created_utc
# of its MANIFEST), or fails its SHA256SUMS. An alert is one line on stderr and exit status 1, so cron mails it; with
# BACKUP_ALERT_CMD set, that command also runs (sh -c, the message in BACKUP_ALERT_MESSAGE and on stdin). Silent and exit
# status 0 when all is well. Reads no secret.
#
# Configuration (environment variables, all optional):
#   BACKUP_DIR            as in backup.sh                      (default: /var/backups/vermieter-cockpit)
#   BACKUP_MAX_AGE_HOURS  maximum age of the newest backup     (default: 26)
#   BACKUP_ALERT_CMD      extra alert channel, e.g. 'curl -fsS -d @- https://ntfy.example/vc-backup' (default: none)
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/backups/vermieter-cockpit}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-26}
BACKUP_ALERT_CMD=${BACKUP_ALERT_CMD:-}

alert() {
  local message
  message="Sicherung Vermieter Cockpit auf $(hostname): $*"
  printf '%s backup-check: ALARM: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$message" >&2
  if [ -n "$BACKUP_ALERT_CMD" ]; then
    printf '%s\n' "$message" | BACKUP_ALERT_MESSAGE="$message" sh -c "$BACKUP_ALERT_CMD" ||
      printf 'backup-check: BACKUP_ALERT_CMD fehlgeschlagen\n' >&2
  fi
  exit 1
}

case $BACKUP_MAX_AGE_HOURS in '' | *[!0-9]*) alert "BACKUP_MAX_AGE_HOURS ist keine ganze Zahl: '$BACKUP_MAX_AGE_HOURS'" ;; esac
[ -d "$BACKUP_DIR/daily" ] || alert "kein Verzeichnis $BACKUP_DIR/daily, also keine Sicherung"

newest=$(find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print | sort -r | head -n 1)
[ -n "$newest" ] || alert "keine Sicherung unter $BACKUP_DIR/daily"
[ -f "$newest/MANIFEST" ] || alert "$newest hat kein MANIFEST"

created=$(sed -n 's/^created_utc=//p' "$newest/MANIFEST")
# 20261106T072059Z -> 2026-11-06T07:20:59Z
iso=$(sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3T\4:\5:\6Z/' <<<"$created")
created_epoch=$(date -u -d "$iso" +%s 2>/dev/null) || alert "$newest/MANIFEST: created_utc unlesbar: '$created'"
age=$(($(date -u +%s) - created_epoch))
[ "$age" -le $((BACKUP_MAX_AGE_HOURS * 3600)) ] ||
  alert "jüngste Sicherung $(basename "$newest") ist $((age / 3600)) h alt (Grenze $BACKUP_MAX_AGE_HOURS h)"

(cd "$newest" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1) || alert "$newest: Prüfsummen stimmen nicht"
