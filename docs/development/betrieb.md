# Betrieb: Sicherung und Wiederherstellung

**Status:** Anleitung und Skripte für Punkt 1 von #281 („Backup und Wiederherstellung, geübt“). Der DE-Restore ist einmal in einem Container geübt (Abschnitt 8); der Restore beider Datenbanken auf einem frischen Rechner steht noch aus und wird vom Projektinhaber eingetragen. `technology.md` §34 verlangt einen **getesteten** Restore, nicht nur einen dokumentierten.

**Grundlage:** `docker-compose.yml` (Dienste, Volumes, Datenbanknamen), `technology.md` §34. Nur synthetische Beispiele: diese Datei nennt keine Person, keinen Rechnernamen und keine Zugangsdaten einer echten Installation.

## 1. Was gesichert wird

| Teil | Dienst (Compose) | Datenbank | Volume | Werkzeug | Datei |
|---|---|---|---|---|---|
| DE (Vermieter Cockpit) | `de-postgres` (PostgreSQL 16) | `${DE_DB_NAME:-de}`, Benutzer `${DE_DB_USER:-de}` | `de-postgres-data` | `pg_dump -Fc` (custom format) | `de-<Zeitstempel>.dump` |
| MRE (MicroRealEstate) | `mongo` (MongoDB 7) | `mredb` (aus `MONGO_URL` der MRE-Dienste) | `mre-mongo-data` | `mongodump --archive --gzip` | `mre-<Zeitstempel>.archive.gz` |

Nicht in den Dumps, aber für eine Wiederherstellung nötig:

- **`.env`** mit allen Secrets (`DE_DB_PASSWORD`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `RESET_TOKEN_SECRET`, `APPCREDZ_TOKEN_SECRET`, `REDIS_PASSWORD`, `CIPHER_KEY`, `CIPHER_IV_KEY`, ggf. `MRE_VERSION`). Wird **getrennt** gesichert (Passwortmanager oder verschlüsselter Speicher), nie neben den Dumps und nie im Repository. **`CIPHER_KEY` und `CIPHER_IV_KEY` sind unverzichtbar:** MRE verschlüsselt damit Felder in MongoDB; ein MRE-Dump ohne diese beiden Werte ist nicht vollständig nutzbar.
- **Der Code-Stand:** die Datei `MANIFEST` jeder Sicherung nennt den Git-Commit der Installation und die MRE-Version. Der Restore läuft mit demselben oder einem neueren Commit; ein neuerer wendet beim Start nur die fehlenden Migrationen an.
- Redis wird nicht gesichert: dort liegen nur Sitzungen und Tokens des MRE-Authenticators, die nach einem Restore neu entstehen (alle Nutzer melden sich neu an).
- DE speichert keine Dokument-Binärdateien. Ob MRE in dieser Installation Dateien außerhalb von MongoDB ablegt (hochgeladene Dokumente), ist offen (Abschnitt 9).

## 2. Täglicher Cron

`scripts/ops/backup.sh` erstellt die Dumps **innerhalb der Container** über `docker compose exec -T` und schreibt sie über die Standardausgabe in ein Verzeichnis **außerhalb der Docker-Volumes** (Standard `/var/backups/vermieter-cockpit`). Es braucht kein Passwort: `pg_dump` verbindet sich im Container über den lokalen Socket (im offiziellen `postgres`-Image `trust` für lokale Verbindungen), MongoDB läuft im Compose-Netz ohne Authentifizierung und ist von außen nicht erreichbar.

Beispiel `/etc/cron.d/vermieter-cockpit` (der Benutzer `backup` ist Mitglied der Gruppe `docker`; die Installation liegt in `/opt/vermieter-cockpit`):

```cron
# Täglich 03:17 Uhr: DE- und MRE-Dump, Prüfung, Aufbewahrung, Kopie an den zweiten Ort.
17 3 * * * backup cd /opt/vermieter-cockpit && BACKUP_DIR=/srv/backup/vermieter-cockpit BACKUP_COPY_CMD='rsync -a --delete --exclude ".*" "$BACKUP_DIR/" sicherung@nas.example:/srv/vc-backup/' scripts/ops/backup.sh >>/var/log/vermieter-cockpit-backup.log 2>&1
```

Konfiguration über Umgebungsvariablen (alle optional; die vollständige Liste steht im Kopf des Skripts):

| Variable | Standard | Bedeutung |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/vermieter-cockpit` | Zielverzeichnis, außerhalb der Docker-Volumes |
| `COMPOSE_DIR` | Wurzel des Repositorys | Verzeichnis von `docker-compose.yml` und `.env` |
| `COMPOSE_CMD` | `docker compose` | Compose-Aufruf |
| `BACKUP_TARGETS` | `de mre` | was gesichert wird |
| `DE_PG_SERVICE`, `DE_DB_USER`, `DE_DB_NAME` | `de-postgres`, aus `.env`, sonst `de` | DE-Datenbank |
| `MRE_MONGO_SERVICE`, `MRE_MONGO_DB` | `mongo`, `mredb` | MRE-Datenbank |
| `KEEP_DAILY`, `KEEP_WEEKLY`, `KEEP_MONTHLY` | `14`, `8`, `12` | Aufbewahrung (Abschnitt 4) |
| `WEEKLY_DAY` | `7` (Sonntag) | Wochentag der Wochensicherung |
| `BACKUP_COPY_CMD` | leer | Kopie an den zweiten Ort (Abschnitt 3) |

Ablauf eines Laufs:

1. Sperre `BACKUP_DIR/.lock` (nur ein Lauf gleichzeitig; nach einem Absturz von Hand entfernen).
2. DE: `pg_dump -U <user> -d <db> -Fc --no-owner --no-privileges` in ein Arbeitsverzeichnis `BACKUP_DIR/.work-…`.
3. MRE: `mongodump --db=mredb --archive --gzip` in dasselbe Arbeitsverzeichnis.
4. Prüfung jedes Dumps (Abschnitt 5), dann `MANIFEST` (Zeitpunkt, Rechner, Git-Commit, MRE-Version) und `SHA256SUMS`.
5. Das Arbeitsverzeichnis wird in einem Schritt zu `daily/JJJJ-MM-TT` umbenannt: ein Verzeichnis unter `daily/` ist immer vollständig. Ein abgebrochener Lauf hinterlässt nichts außer seiner Meldung.
6. Wochen- und Monatskopie, Aufbewahrung, Kopie an den zweiten Ort.

Jeder Fehler beendet das Skript mit Status ungleich 0 und einer Meldung „FEHLER“ oder „abgebrochen“ auf stderr; Cron verschickt diese Ausgabe per Mail, wenn `MAILTO` gesetzt ist. Das Log sollte zusätzlich wöchentlich angesehen werden.

## 3. Kopie an einen zweiten Ort

Eine Sicherung auf demselben Rechner schützt nicht gegen Plattenausfall, Diebstahl oder Verschlüsselungstrojaner. Nach jedem erfolgreichen Lauf führt das Skript `BACKUP_COPY_CMD` mit `sh -c` aus; `BACKUP_DIR` ist dabei gesetzt. Allgemein:

- **rsync** auf einen zweiten Rechner oder ein NAS über SSH: `rsync -a --delete --exclude ".*" "$BACKUP_DIR/" <ziel>:<pfad>/`. `--delete` spiegelt die Aufbewahrung; `--exclude ".*"` lässt Sperre und Arbeitsverzeichnisse weg.
- **rclone** zu einem Cloud-Speicher: `rclone sync --exclude ".*/**" "$BACKUP_DIR" <remote>:<pfad>`. Für Speicher außer Haus ein verschlüsseltes Remote (`rclone crypt`) verwenden: die Dumps enthalten personenbezogene Daten (Mieter, Kontoverbindungen).

Der zweite Ort sollte für den Sicherungsbenutzer **nur anhängend** beschreibbar sein oder eigene Versionen halten (Snapshots des NAS, Objektversionierung), damit ein kompromittierter Rechner die Kopien nicht löschen kann. Schlägt die Kopie fehl, bleibt die lokale Sicherung vollständig; das Skript endet trotzdem mit Fehler, damit es auffällt.

## 4. Aufbewahrung

| Art | Wann | Behalten | Verzeichnis |
|---|---|---|---|
| täglich | jeder Lauf | die letzten **14** | `daily/JJJJ-MM-TT` |
| wöchentlich | Lauf am Sonntag (`WEEKLY_DAY`) | die letzten **8** | `weekly/JJJJ-Www` (ISO-Woche) |
| monatlich | Lauf am 1. des Monats | die letzten **12** | `monthly/JJJJ-MM` |

Wochen- und Monatskopien sind harte Links auf die Tagessicherung und belegen keinen zusätzlichen Platz, solange die Tagessicherung existiert. Damit reicht die Sicherung rund ein Jahr zurück. Gelöscht wird nach Name, also nach Datum: je Art bleiben die neuesten N Verzeichnisse. Ein zweiter Lauf am selben Tag erhält das Verzeichnis `daily/JJJJ-MM-TT-<Zeitstempel>` und zählt als eigene Tagessicherung. Die Zahlen sind ein Vorschlag (#281); wer sie ändert, setzt die drei Variablen und trägt das hier ein.

## 5. Prüfung jeder Sicherung

Das Skript prüft jeden Dump, bevor er veröffentlicht wird:

- **DE:** Datei nicht leer; `pg_restore --list` liest das Inhaltsverzeichnis des Archivs vollständig, und es enthält die Daten von `public.kysely_migration` (den Migrationsstand).
- **MRE:** Datei nicht leer; `gzip -t`; `mongorestore --archive --gzip --dryRun` liest das ganze Archiv, ohne etwas zu schreiben.
- **Beide:** `SHA256SUMS` über Dumps und `MANIFEST`, direkt nach dem Schreiben gegengeprüft. Am zweiten Ort und vor jedem Restore: `cd <sicherung> && sha256sum -c SHA256SUMS`.

Diese Prüfungen zeigen, dass ein Dump lesbar ist, nicht, dass er sich vollständig wiederherstellen lässt. Das zeigt nur ein Restore (Abschnitte 6 bis 8). Zusätzlich läuft in CI im Job `compose-smoke` das Skript `.github/scripts/compose-backup-smoke.sh`: Sicherung des Compose-Stacks nach dem Auth-Smoke, Restore beider Dumps in Nebendatenbanken derselben Container (`de_restore_check`, `mredb_restore_check`), Vergleich der Zeilenzahlen jeder DE-Tabelle und der Dokumentzahlen jeder MRE-Sammlung. Das ersetzt den Restore auf einem frischen Rechner nicht.

## 6. Wiederherstellung auf einem frischen Rechner

Voraussetzungen: Docker mit Compose v2, Git, Zugriff auf den zweiten Ort und auf die gesicherte `.env`.

1. **Code holen:** Repository nach `/opt/vermieter-cockpit` klonen und den Commit aus `MANIFEST` (`git_commit=`) auschecken, oder einen neueren.
2. **Secrets einspielen:** die gesicherte `.env` nach `/opt/vermieter-cockpit/.env` kopieren, Rechte `600`. Ohne die alten `CIPHER_KEY`/`CIPHER_IV_KEY` sind MRE-Daten nicht lesbar; ohne die alten Token-Secrets melden sich alle neu an (unschädlich).
3. **Sicherung holen und prüfen:** die gewünschte Sicherung (in der Regel die jüngste unter `daily/`) vom zweiten Ort nach z. B. `/srv/restore/` kopieren, dann `cd /srv/restore/<datum> && sha256sum -c SHA256SUMS`.
4. **Nur die Datenbanken starten:** `docker compose up -d --wait de-postgres mongo`. `de-postgres` legt dabei die leere Datenbank `${DE_DB_NAME:-de}` an. `de-backend` und die MRE-Dienste laufen noch **nicht**, damit niemand schreibt und `de-backend` nicht vorab migriert.
5. **DE wiederherstellen:** `scripts/ops/restore-de.sh /srv/restore/<datum>/de-<stempel>.dump`. Das Skript prüft die Prüfsumme, verweigert eine Datenbank, die schon Tabellen enthält, kopiert den Dump in den Container und spielt ihn mit `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges` ein; bei einem Fehler wird alles zurückgerollt. Zum Schluss nennt es die Zahl der Migrationen und die Zeilenzahl jeder Tabelle. Von Hand entspricht das:

   ```sh
   docker compose cp de-<stempel>.dump de-postgres:/tmp/de.dump
   docker compose exec -T de-postgres pg_restore -U de -d de --exit-on-error --single-transaction --no-owner --no-privileges /tmp/de.dump
   docker compose exec -T de-postgres rm /tmp/de.dump
   ```

6. **MRE wiederherstellen:**

   ```sh
   docker compose exec -T mongo mongorestore --archive --gzip --drop --nsInclude='mredb.*' < /srv/restore/<datum>/mre-<stempel>.archive.gz
   ```

   `--drop` ersetzt vorhandene Sammlungen; auf dem frischen Rechner ist `mredb` ohnehin leer.
7. **Alles starten:** `docker compose up -d --build --wait`. `de-backend` meldet im Log `database migrations applied: none pending` (gleicher Commit) oder die Namen der nachgezogenen Migrationen (neuerer Commit).
8. **Prüfen** (Abschnitt 7), dann den Cron (Abschnitt 2) auf dem neuen Rechner einrichten und den Eintrag in Abschnitt 8 ergänzen.

## 7. Prüfung nach dem Restore

- **Zeilenzahlen DE:** die Ausgabe von `restore-de.sh` mit der Quelle vergleichen. Ist die Quelle nicht mehr erreichbar, gegen die Zahlen der letzten Prüfung oder das Inhaltsverzeichnis des Dumps (`pg_restore --list`). Mindestens `kysely_migration` (Zahl und letzte Migration gleich), `ledger_transaction`, `transaction_split`, `audit_record`, `property_reference`, `party`, `ownership`, `loan`, `security_deposit`.
- **Dokumente MRE:** `docker compose exec -T mongo mongosh --quiet mredb --eval 'db.getCollectionNames().sort().forEach((n) => print(n, db.getCollection(n).countDocuments()))'` und mit der Quelle vergleichen; jede Sammlung gleich, mindestens `realms` (Organisationen), Objekte und Mieter.
- **Gesundheit:** `curl -fsS http://localhost:8090/health/live`, `curl -fsS http://localhost:8090/health/ready` (beide `{"status":"ok"}`), `curl -fsS http://localhost:8080/health` (MRE-Gateway).
- **Ein Lesezugriff je Bereich**, angemeldet als ein Nutzer der Installation (über die Oberfläche oder mit Token und `organizationid`): Kassenbuch (`GET /api/v1/transactions`), Objekte (`GET /api/v1/property-references`), Darlehen, Kaution, WEG, Steuerjahr-Ansicht eines Objekts, Mietabgleich eines Monats; in MRE die Mieterliste. Jede Antwort `200` mit den erwarteten Einträgen, keine `500`.
- **Unveränderlichkeit greift:** eine bestätigte Buchung lässt sich weiterhin nicht ändern (die Trigger aus ADR-037 sind Teil des Dumps).
- `DEPRECIATION_RECORDING_ENABLED` ist nach dem Restore so gesetzt wie vorher (für den Go-live: ungesetzt, also aus).

## 8. Restore geübt

| Datum | Umgebung | Umfang | Dauer | Ergebnis | Durchgeführt von |
|---|---|---|---|---|---|
| 2026-11-06 | **Container-Probe**, kein frischer Rechner: PostgreSQL 16.15 im Entwicklungscontainer, ohne Docker; die Skripte liefen mit einem Ersatz für `docker compose`, der die Befehle gegen die lokale Datenbank ausführt | nur DE; synthetische Daten | Sicherung 0,5 s, Restore 2,5 s (Dump 4,9 MB) | Zeilenzahlen aller 224 Tabellen gleich, `kysely_migration` gleich, Start auf der wiederhergestellten Datenbank ohne ausstehende Migration | Claude Code (für #281) |
| | **Frischer Rechner**, Docker Compose | DE und MRE | | | Projektinhaber |

**Probe vom 2026-11-06 im Einzelnen:**

- **Quelle:** Datenbank `de_backup_src`, mit den Migrationen des Repositorys auf den Stand von `main` (23e313e, 72 Migrationen) gebracht; darin vier synthetische Zeilen im Schema `public` (ein Objekt, eine Person, ein Konto, eine Buchung) und die Daten dreier Abnahmetests (`phase-3`, `phase-5`, `phase-8-acceptance.e2e.test.ts`) in ihren eigenen Schemas, die für die Probe nicht gelöscht wurden. Zusammen 224 Tabellen in vier Schemas, 1 096 Zeilen in 73 nicht leeren Tabellen, darunter bestätigte und korrigierte Buchungen mit Splits, Darlehen, Kautionen, Anschaffungen und AuditRecords.
- **Sicherung:** `scripts/ops/backup.sh` mit `BACKUP_TARGETS=de`, also `pg_dump -Fc --no-owner --no-privileges` über die Standardausgabe; Prüfung mit `pg_restore --list`, `SHA256SUMS`, Kopie an einen zweiten Ort mit rsync.
- **Restore:** `scripts/ops/restore-de.sh` vom zweiten Ort in die leere Datenbank `de_backup_dst`.
- **Vergleich:** exakte Zeilenzahl (`count(*)`) jeder der 224 Tabellen: gleich. `kysely_migration` in allen vier Schemas je 72 Zeilen, Prüfsumme über Name und Zeitpunkt gleich. Zahl der Trigger (616), Constraints (2 820) und Indizes (792) gleich; MD5 über den vollständigen Inhalt einer `ledger_transaction`- und einer `audit_record`-Tabelle gleich.
- **Danach:** `migrateToLatest` auf `de_backup_dst` wendet nichts an; `de-backend` startet auf der wiederhergestellten Datenbank mit `database migrations applied: none pending`, `/health/live` und `/health/ready` antworten `200`; eine Änderung einer bestätigten Buchung wird vom Trigger abgewiesen („is immutable (ADR-037)“). Wiederherstellungsreihenfolge: Daten vor Triggern und Fremdschlüsseln (Abschnitt „post-data“ von `pg_dump`), daher feuern die Einfüge-Trigger beim Restore nicht.
- **Nicht geübt:** MongoDB läuft in diesem Container nicht; der MRE-Teil (`mongodump`, `mongorestore`) ist hier nicht ausgeführt worden. Er läuft in CI gegen den Compose-Stack (Abschnitt 5) und beim Restore auf dem frischen Rechner (zweite Zeile). Ebenso nicht geübt: `docker compose exec` und `docker compose cp` selbst.
- Die Probedatenbanken wurden danach gelöscht.

## 9. Offene Punkte

- **Zweiter Ort:** welcher (NAS, zweiter Rechner, Cloud-Speicher) und ob dort verschlüsselt und nur anhängend gespeichert wird.
- **MRE-Dateien:** ob die MRE-Installation hochgeladene Dokumente oder erzeugte PDFs außerhalb von MongoDB ablegt; dann gehören sie in die Sicherung. `docker-compose.yml` sieht dafür kein Volume vor.
- **Aufbewahrung** 14/8/12 bestätigen oder ändern; die Dumps enthalten personenbezogene Daten, die Aufbewahrung gehört zur Entscheidung VC-X-24.
- **Überwachung:** reicht die Cron-Mail, oder soll ein Lauf ohne Erfolg (z. B. älter als 26 Stunden) aktiv gemeldet werden?
