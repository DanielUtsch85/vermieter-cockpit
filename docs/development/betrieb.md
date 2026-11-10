# Betrieb: Sicherung, Wiederherstellung, Reverse-Proxy, VPN und Secrets

**Status:** Anleitung und Skripte für Punkt 1 von #281 („Backup und Wiederherstellung, geübt“). Der DE-Restore ist einmal in einem Container geübt (Abschnitt 8); der Restore auf einem frischen Rechner steht noch aus und wird vom Projektinhaber auf dem Produktivrechner durchgeführt und eingetragen. Die Fragen aus #286 sind entschieden (Abschnitt 10) (Entscheidung des Projektinhabers, 2026-11-06). `technology.md` §34 verlangt einen **getesteten** Restore, nicht nur einen dokumentierten.

**Grundlage:** `docker-compose.yml` (Dienste, Volumes, Datenbanknamen), `technology.md` §34. Nur synthetische Beispiele: diese Datei nennt keine Person, keinen Rechnernamen und keine Zugangsdaten einer echten Installation.

**Gliederung:** ein Betriebsdokument für #281 (Entscheidung des Projektinhabers, 2026-11-06): Abschnitte 1 bis 8 Sicherung und Wiederherstellung (Punkt 1), Abschnitt 9 Reverse-Proxy, VPN und Secrets (Punkt 4), Abschnitt 10 Entscheidungen zu #286, Abschnitt 11 Pinning und Aktualisierung der Images und Actions (VC-X-09), mit Dependabot (11.6).

## 1. Was gesichert wird

| Teil | Dienst (Compose) | Datenbank | Volume | Werkzeug | Datei |
|---|---|---|---|---|---|
| DE (Vermieter Cockpit) | `de-postgres` (PostgreSQL 16) | `${DE_DB_NAME:-de}`, Benutzer `${DE_DB_USER:-de}` | `de-postgres-data` | `pg_dump -Fc` (custom format) | `de-<Zeitstempel>.dump` |
| MRE (MicroRealEstate) | `mongo` (MongoDB 7) | `mredb` (aus `MONGO_URL` der MRE-Dienste) | `mre-mongo-data` | `mongodump --archive --gzip` | `mre-<Zeitstempel>.archive.gz` |
| MRE-Dateien | `pdfgenerator` | – (Dateien) | `mre-pdf-uploads` → `/usr/app/services/pdfgenerator/uploads`, `mre-pdf-data` → `/usr/app/services/pdfgenerator/pdf_documents` | `tar` im Container | `mre-files-<Zeitstempel>.tar.gz` |

**MRE-Dateien (Befund vom 2026-11-06):** Der gepinnte `pdfgenerator` (`MRE_VERSION` 479d0ad, Image auf `node:20.17-alpine`, `WORKDIR /usr/app`) legt hochgeladene Dokumente mit multer `diskStorage` unter `UPLOADS_DIRECTORY` ab, Standard `/usr/app/services/pdfgenerator/uploads` (je Organisation ein Unterordner); erzeugte PDFs schreibt er nach `PDF_DIRECTORY`, Standard `/usr/app/services/pdfgenerator/pdf_documents` (`services/pdfgenerator/src/index.js` Zeilen 36 bis 44, `src/utils/uploadmiddelware.js`, `src/pdf.js`). Ohne Volume liegen beide auf der Schicht des Containers und gehen bei jedem Neuerstellen verloren; das Upstream-Compose hat dieselbe Lücke (Backlog VC-X-60). `docker-compose.yml` hängt deshalb zwei benannte Volumes an (Entscheidung des Projektinhabers, 2026-11-06). Erzeugte PDFs entstehen bei jedem Abruf neu aus den Daten in MongoDB; gesichert werden sie trotzdem, sie sind klein.

**Abweichung von der Entscheidung, zur Bestätigung:** Die Entscheidung nennt `data/` als zweites Verzeichnis. `/usr/app/services/pdfgenerator/data` enthält aber keinen Datenbestand, sondern Code des Images (`data/index.js`, `data/invoice/index.js`, `data/rentcall*/index.js`, die Datenquellen der Vorlagen, geladen über `DATA_DIRECTORY` in `src/datapicker.js`). Ein Volume darüber würde diesen Code beim ersten Start einfrieren und bei jedem MRE-Update veralten lassen. `mre-pdf-data` hängt deshalb an `pdf_documents/`, dem Ort der erzeugten PDFs.

**Umstellung einer bestehenden Installation:** Beim ersten `docker compose up` mit den Volumes wird `pdfgenerator` neu erstellt, und was bis dahin in seinen Verzeichnissen lag, ist weg. Vorher sichern: `docker compose cp pdfgenerator:/usr/app/services/pdfgenerator/uploads ./uploads-vorher`, danach mit `docker compose cp ./uploads-vorher/. pdfgenerator:/usr/app/services/pdfgenerator/uploads/` zurückspielen. Neue benannte Volumes übernehmen beim ersten Einhängen Inhalt und Eigentümer (UID 1000) des Image-Verzeichnisses.

Nicht in den Dumps, aber für eine Wiederherstellung nötig:

- **`.env`** mit allen Secrets (`DE_DB_PASSWORD`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `RESET_TOKEN_SECRET`, `APPCREDZ_TOKEN_SECRET`, `REDIS_PASSWORD`, `CIPHER_KEY`, `CIPHER_IV_KEY`, ggf. `MRE_VERSION`). Wird **getrennt** gesichert (Passwortmanager oder verschlüsselter Speicher), nie neben den Dumps und nie im Repository. **`CIPHER_KEY` und `CIPHER_IV_KEY` sind unverzichtbar:** MRE verschlüsselt damit Felder in MongoDB; ein MRE-Dump ohne diese beiden Werte ist nicht vollständig nutzbar.
- **Der Code-Stand:** die Datei `MANIFEST` jeder Sicherung nennt den Git-Commit der Installation und die MRE-Version. Der Restore läuft mit demselben oder einem neueren Commit; ein neuerer wendet beim Start nur die fehlenden Migrationen an.
- Redis wird nicht gesichert: dort liegen nur Sitzungen und Tokens des MRE-Authenticators, die nach einem Restore neu entstehen (alle Nutzer melden sich neu an).
- DE speichert keine Dokument-Binärdateien.
- Ist für eine Organisation in MRE ein Backblaze-B2-Speicher eingetragen, lädt der `pdfgenerator` Uploads zusätzlich dorthin; dieser Speicher wird von hier nicht gesichert.

## 2. Täglicher Cron

`scripts/ops/backup.sh` erstellt die Dumps und das Datei-Archiv **innerhalb der Container** über `docker compose exec -T` und schreibt sie über die Standardausgabe in ein Verzeichnis **außerhalb der Docker-Volumes** (Standard `/var/backups/vermieter-cockpit`). Es braucht kein Passwort: `pg_dump` verbindet sich im Container über den lokalen Socket (im offiziellen `postgres`-Image `trust` für lokale Verbindungen), MongoDB läuft im Compose-Netz ohne Authentifizierung und ist von außen nicht erreichbar.

Beispiel `/etc/cron.d/vermieter-cockpit` (der Benutzer `backup` ist Mitglied der Gruppe `docker`; die Installation liegt in `/opt/vermieter-cockpit`):

```cron
MAILTO=betrieb@example.org
# Täglich 03:17 Uhr: DE- und MRE-Dump, MRE-Dateien, Prüfung, Aufbewahrung, Verschlüsselung, Kopie an den zweiten Ort.
17 3 * * * backup cd /opt/vermieter-cockpit && BACKUP_DIR=/srv/backup/vermieter-cockpit BACKUP_ENCRYPT_CMD='age -R /etc/vermieter-cockpit/backup-recipients.txt' BACKUP_COPY_CMD='rclone copy --immutable "$BACKUP_OUTBOX" offsite:vc-backup' scripts/ops/backup.sh >>/var/log/vermieter-cockpit-backup.log 2>&1
# Täglich 09:47 Uhr: Überwachung (Abschnitt 2a).
47 9 * * * backup BACKUP_DIR=/srv/backup/vermieter-cockpit /opt/vermieter-cockpit/scripts/ops/backup-check.sh
```

Konfiguration über Umgebungsvariablen (alle optional; die vollständige Liste steht im Kopf des Skripts):

| Variable | Standard | Bedeutung |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/vermieter-cockpit` | Zielverzeichnis, außerhalb der Docker-Volumes |
| `COMPOSE_DIR` | Wurzel des Repositorys | Verzeichnis von `docker-compose.yml` und `.env` |
| `COMPOSE_CMD` | `docker compose` | Compose-Aufruf |
| `BACKUP_TARGETS` | `de mre mre-files` | was gesichert wird |
| `DE_PG_SERVICE`, `DE_DB_USER`, `DE_DB_NAME` | `de-postgres`, aus `.env`, sonst `de` | DE-Datenbank |
| `MRE_MONGO_SERVICE`, `MRE_MONGO_DB` | `mongo`, `mredb` | MRE-Datenbank |
| `MRE_FILES_SERVICE`, `MRE_FILES_ROOT`, `MRE_FILES_DIRS` | `pdfgenerator`, `/usr/app/services/pdfgenerator`, `uploads pdf_documents` | MRE-Dateien |
| `KEEP_DAILY`, `KEEP_WEEKLY`, `KEEP_MONTHLY` | `14`, `8`, `12` | Aufbewahrung (Abschnitt 4); je mindestens `1` |
| `WEEKLY_DAY` | `7` (Sonntag) | Wochentag der Wochensicherung |
| `BACKUP_ENCRYPT_CMD`, `BACKUP_ENCRYPT_SUFFIX` | leer, `.age` | Verschlüsselung vor der Kopie (Abschnitt 3) |
| `BACKUP_COPY_CMD` | leer | Kopie an den zweiten Ort (Abschnitt 3); ohne Verschlüsselung verweigert |
| `BACKUP_COPY_ENCRYPTS` | `0` | `1` nur, wenn das Kopierwerkzeug selbst verschlüsselt (restic) |

Ablauf eines Laufs:

1. Sperre `BACKUP_DIR/.lock` (nur ein Lauf gleichzeitig; nach einem Absturz von Hand entfernen).
2. DE: `pg_dump -U <user> -d <db> -Fc --no-owner --no-privileges` in ein Arbeitsverzeichnis `BACKUP_DIR/.work-…`.
3. MRE: `mongodump --db=mredb --archive --gzip` in dasselbe Arbeitsverzeichnis.
4. MRE-Dateien: `tar -C /usr/app/services/pdfgenerator -cf - uploads pdf_documents` im Container, auf dem Host mit `gzip` gepackt.
5. Prüfung jeder Datei (Abschnitt 5), dann `MANIFEST` (Zeitpunkt, Rechner, Git-Commit, MRE-Version, Datei-Verzeichnisse) und `SHA256SUMS`.
6. Das Arbeitsverzeichnis wird in einem Schritt zu `daily/JJJJ-MM-TT` umbenannt: ein Verzeichnis unter `daily/` ist immer vollständig. Ein abgebrochener Lauf hinterlässt nichts außer seiner Meldung.
7. Wochen- und Monatskopie, Aufbewahrung.
8. Verschlüsselung des Laufs nach `outbox/`, dann Kopie an den zweiten Ort (Abschnitt 3).

Jeder Fehler beendet das Skript mit Status ungleich 0 und einer Meldung „FEHLER“ oder „abgebrochen“ auf stderr; Cron verschickt diese Ausgabe per Mail, wenn `MAILTO` gesetzt ist.

## 2a. Überwachung

Eine Sicherung, die still ausbleibt, ist der häufigste Ausfall; ein Fehler-Mail fehlt dann gerade, weil der Lauf nie startet. Deshalb meldet ein eigener Cron-Eintrag aktiv (Entscheidung des Projektinhabers, 2026-11-06): `scripts/ops/backup-check.sh` prüft die jüngste Sicherung unter `daily/` und schlägt Alarm, wenn

- keine Sicherung da ist (oder `daily/` fehlt),
- sie älter als `BACKUP_MAX_AGE_HOURS` ist (Standard **26 Stunden**, gemessen an `created_utc` im `MANIFEST`), oder
- ihre `SHA256SUMS` nicht stimmen.

Ein Alarm ist eine Zeile auf stderr und Status 1; Cron verschickt sie per Mail an `MAILTO` (Standardweg). Mit `BACKUP_ALERT_CMD` läuft zusätzlich ein Befehl (`sh -c`, die Meldung in `BACKUP_ALERT_MESSAGE` und auf stdin), z. B. `curl -fsS -d @- https://ntfy.example/vc-backup`. Ohne Befund schreibt das Skript nichts und endet mit 0, Cron schickt dann keine Mail. Der Check liest keine Secrets und braucht kein Docker; er sollte einige Stunden nach der Sicherung laufen (im Beispiel 09:47 Uhr).

## 3. Kopie an einen zweiten Ort

Eine Sicherung auf demselben Rechner schützt nicht gegen Plattenausfall, Diebstahl oder Verschlüsselungstrojaner. Den Anbieter des zweiten Orts wählt der Projektinhaber; diese Anleitung beschreibt nur den Weg dorthin (Entscheidung des Projektinhabers, 2026-11-06).

**Pflichtschritt: verschlüsseln vor dem Kopieren.** Die Dumps enthalten personenbezogene Daten (Mieter, Kontoverbindungen) und verlassen den Rechner nur verschlüsselt. `backup.sh` verweigert `BACKUP_COPY_CMD`, solange weder `BACKUP_ENCRYPT_CMD` gesetzt ist noch `BACKUP_COPY_ENCRYPTS=1` (für ein Kopierwerkzeug, das selbst verschlüsselt).

- **age (Standardweg):** einmalig auf einem anderen Gerät `age-keygen -o backup-key.txt`; den **privaten** Schlüssel nur im Passwortmanager oder offline aufbewahren, nie auf dem Server und nie im Repository. Auf den Server kommt nur der öffentliche Schlüssel (`age-keygen -y backup-key.txt`) in `/etc/vermieter-cockpit/backup-recipients.txt`; mehrere Zeilen sind mehrere Empfänger (z. B. ein Ersatzschlüssel). Mit `BACKUP_ENCRYPT_CMD='age -R /etc/vermieter-cockpit/backup-recipients.txt'` packt das Skript jeden Lauf als ein `tar` und verschlüsselt ihn nach `BACKUP_DIR/outbox/vermieter-cockpit-<stempel>.tar.age`, daneben `….sha256` über die verschlüsselte Datei. Der Server selbst kann die Kopien nicht entschlüsseln.
- **restic:** verschlüsselt selbst (Repository-Passwort aus einer Datei außerhalb des Repositorys, `RESTIC_PASSWORD_FILE`); dann `BACKUP_COPY_ENCRYPTS=1` und z. B. `BACKUP_COPY_CMD='restic backup --exclude ".*" --exclude outbox "$BACKUP_DIR"'`.

**Kopie:** Nach Verschlüsselung führt das Skript `BACKUP_COPY_CMD` mit `sh -c` aus; `BACKUP_DIR` und `BACKUP_OUTBOX` sind gesetzt. Kopiert wird nur `BACKUP_OUTBOX`, und nur hinzu, nie mit Löschen:

- **rclone** zu einem Objektspeicher: `rclone copy --immutable "$BACKUP_OUTBOX" <remote>:<pfad>`.
- **rsync** auf ein NAS über SSH: `rsync -a --ignore-existing "$BACKUP_OUTBOX/" <ziel>:<pfad>/`.

**Anforderungen an das Ziel:** Versionierung oder Objektsperre (Object Lock, NAS-Snapshots), und der Zugang des Servers darf nur hinzufügen, nicht löschen oder überschreiben, damit ein kompromittierter Rechner die Kopien nicht zerstören kann. Die Aufbewahrung am Ziel regelt dessen Lebenszyklus-Regel (Abschnitt 4), nicht das Skript. Lokal behält `outbox/` die letzten `KEEP_DAILY` Läufe. Schlägt Verschlüsselung oder Kopie fehl, bleibt die lokale Sicherung vollständig; das Skript endet trotzdem mit Fehler, damit es auffällt.

## 4. Aufbewahrung

| Art | Wann | Behalten | Verzeichnis |
|---|---|---|---|
| täglich | jeder Lauf | die letzten **14** | `daily/JJJJ-MM-TT` |
| wöchentlich | Lauf am Sonntag (`WEEKLY_DAY`) | die letzten **8** | `weekly/JJJJ-Www` (ISO-Woche) |
| monatlich | Lauf am 1. des Monats | die letzten **12** | `monthly/JJJJ-MM` |

Wochen- und Monatskopien sind harte Links auf die Tagessicherung und belegen keinen zusätzlichen Platz, solange die Tagessicherung existiert. Damit reicht die Sicherung rund ein Jahr zurück; am zweiten Ort gilt dieselbe Grenze über dessen Lebenszyklus-Regel (Löschen nach 365 Tagen, wo die Objektsperre es erlaubt). Gelöscht wird nach Name, also nach Datum: je Art bleiben die neuesten N Verzeichnisse. Ein zweiter Lauf am selben Tag erhält das Verzeichnis `daily/JJJJ-MM-TT-<Zeitstempel>` und zählt als eigene Tagessicherung. Die Zahlen 14/8/12 sind bestätigt (Entscheidung des Projektinhabers, 2026-11-06). VC-X-24 (Pseudonymisierung im Audit, Abschnitt 12) betrifft die Live-Daten: Ein Dump hält die Werte so, wie sie an seinem Tag standen; ein ersetzter Wert hat damit spätestens rund ein Jahr nach dem Lauf jede Kopie verlassen (365 Tage am zweiten Ort). Sicherungen älter als ein Jahr sind gelöscht, das ist mit beidem vereinbar. Ein Restore einer älteren Kopie bringt lesbare fällige Werte zurück; der Lauf beim Start ersetzt sie vor der ersten Antwort (Abschnitt 7). Wer die Zahlen ändert, setzt die drei Variablen und trägt das hier ein. Jede muss mindestens 1 sein: bei 0 bricht `backup.sh` mit „FEHLER“ ab, bevor es etwas schreibt, denn `KEEP_DAILY=0` löschte die eben geschriebene Sicherung und ihre Datei in `outbox/` gleich wieder.

## 5. Prüfung jeder Sicherung

Das Skript prüft jeden Dump, bevor er veröffentlicht wird:

- **DE:** Datei nicht leer; `pg_restore --list` liest das Inhaltsverzeichnis des Archivs vollständig, und es enthält die Daten von `public.kysely_migration` (den Migrationsstand).
- **MRE:** Datei nicht leer; `gzip -t`; `mongorestore --archive --gzip --dryRun` liest das ganze Archiv, ohne etwas zu schreiben.
- **MRE-Dateien:** `tar -tzf` listet das Archiv vollständig, und jedes Verzeichnis aus `MRE_FILES_DIRS` steht darin.
- **Alle:** `SHA256SUMS` über Dumps, Datei-Archiv und `MANIFEST`, direkt nach dem Schreiben gegengeprüft. Am zweiten Ort und vor jedem Restore: `cd <sicherung> && sha256sum -c SHA256SUMS`.

Diese Prüfungen zeigen, dass ein Dump lesbar ist, nicht, dass er sich vollständig wiederherstellen lässt. Das zeigt nur ein Restore (Abschnitte 6 bis 8). Zusätzlich läuft in CI im Job `compose-smoke` das Skript `.github/scripts/compose-backup-smoke.sh`: Sicherung des Compose-Stacks nach dem Auth-Smoke, Restore beider Dumps in Nebendatenbanken derselben Container (`de_restore_check`, `mredb_restore_check`), Vergleich der Zeilenzahlen jeder DE-Tabelle und der Dokumentzahlen jeder MRE-Sammlung; eine synthetische Datei im Upload-Volume wird gesichert, gelöscht und aus dem `tar` zurückgeholt; `backup-check.sh` schweigt bei der frischen Sicherung und meldet bei einer Grenze von 0 Stunden; `backup.sh` verweigert `KEEP_DAILY=0`, ohne etwas anzulegen. Das ersetzt den Restore auf einem frischen Rechner nicht.

## 6. Wiederherstellung auf einem frischen Rechner

Voraussetzungen: Docker mit Compose v2, Git, Zugriff auf den zweiten Ort und auf die gesicherte `.env`.

1. **Code holen:** Repository nach `/opt/vermieter-cockpit` klonen und den Commit aus `MANIFEST` (`git_commit=`) auschecken, oder einen neueren.
2. **Secrets einspielen:** die gesicherte `.env` nach `/opt/vermieter-cockpit/.env` kopieren, Rechte `600`. Ohne die alten `CIPHER_KEY`/`CIPHER_IV_KEY` sind MRE-Daten nicht lesbar; ohne die alten Token-Secrets melden sich alle neu an (unschädlich).
3. **Sicherung holen, entschlüsseln und prüfen:** den gewünschten Lauf (in der Regel den jüngsten) vom zweiten Ort holen, z. B. nach `/srv/restore/`, dann

   ```sh
   cd /srv/restore && sha256sum -c vermieter-cockpit-<stempel>.tar.age.sha256
   age -d -i backup-key.txt vermieter-cockpit-<stempel>.tar.age | tar -xf -
   cd <datum> && sha256sum -c SHA256SUMS
   ```

   Den privaten Schlüssel nur für diesen Schritt auf den Rechner holen und danach löschen. Mit restic entsprechend `restic restore latest --target /srv/restore`.
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
7. **MRE-Dateien wiederherstellen:** `pdfgenerator` allein starten, das Archiv in seine Volumes entpacken:

   ```sh
   docker compose up -d --no-deps pdfgenerator
   gunzip -c /srv/restore/<datum>/mre-files-<stempel>.tar.gz | docker compose exec -T pdfgenerator tar -C /usr/app/services/pdfgenerator -xf -
   ```

   Das `tar` läuft im Container als UID 1000, also mit dem Eigentümer, unter dem der Dienst die Dateien liest.
8. **Alles starten:** `docker compose up -d --build --wait`. `de-backend` meldet im Log `database migrations applied: none pending` (gleicher Commit) oder die Namen der nachgezogenen Migrationen (neuerer Commit).
9. **Prüfen** (Abschnitt 7), dann Sicherung und Überwachung (Abschnitte 2 und 2a) auf dem neuen Rechner einrichten und den Eintrag in Abschnitt 8 ergänzen.

## 7. Prüfung nach dem Restore

- **Zeilenzahlen DE:** die Ausgabe von `restore-de.sh` mit der Quelle vergleichen. Ist die Quelle nicht mehr erreichbar, gegen die Zahlen der letzten Prüfung oder das Inhaltsverzeichnis des Dumps (`pg_restore --list`). Mindestens `kysely_migration` (Zahl und letzte Migration gleich), `ledger_transaction`, `transaction_split`, `audit_record`, `property_reference`, `party`, `ownership`, `loan`, `security_deposit`.
- **Dokumente MRE:** `docker compose exec -T mongo mongosh --quiet mredb --eval 'db.getCollectionNames().sort().forEach((n) => print(n, db.getCollection(n).countDocuments()))'` und mit der Quelle vergleichen; jede Sammlung gleich, mindestens `realms` (Organisationen), Objekte und Mieter.
- **MRE-Dateien:** `docker compose exec -T pdfgenerator find /usr/app/services/pdfgenerator/uploads -type f | wc -l` gleich der Zahl der Upload-Dateien im Archiv (`tar -tzf mre-files-….tar.gz | grep '^uploads/' | grep -vc '/$'`); ein hochgeladenes Dokument in MRE öffnen.
- **Gesundheit:** `curl -fsS http://localhost:8090/health/live`, `curl -fsS http://localhost:8090/health/ready` (beide `{"status":"ok"}`), `curl -fsS http://localhost:8080/health` (MRE-Gateway).
- **Ein Lesezugriff je Bereich**, angemeldet als ein Nutzer der Installation (über die Oberfläche oder mit Token und `organizationid`): Kassenbuch (`GET /api/v1/transactions`), Objekte (`GET /api/v1/property-references`), Darlehen, Kaution, WEG, Steuerjahr-Ansicht eines Objekts, Mietabgleich eines Monats; in MRE die Mieterliste. Jede Antwort `200` mit den erwarteten Einträgen, keine `500`.
- **Unveränderlichkeit greift:** eine bestätigte Buchung lässt sich weiterhin nicht ändern (die Trigger aus ADR-037 sind Teil des Dumps).
- **Pseudonymisierung gelaufen (VC-X-24):** im Log des ersten Starts nach dem Restore steht vor `de-backend listening` die Zeile `audit pseudonymisation: <n> record(s) pseudonymised (retention 10 years, created before <Datum>)`; bei `audit pseudonymisation failed` den Fehler beheben und neu starten. Danach jede Löschung auf Antrag aus den Unterlagen des Betreibers wiederholen, die jünger ist als die Kopie (Abschnitt 12). Die Wächter auf `audit_record` (Migration 0076) sind Teil des Dumps und entstehen erst nach den Daten (Abschnitt „post-data“), daher weist der Restore pseudonymisierte Datensätze nicht ab.
- `DEPRECIATION_RECORDING_ENABLED` ist nach dem Restore so gesetzt wie vorher (für den Go-live: ungesetzt, also aus).

## 8. Restore geübt

| Datum | Umgebung | Umfang | Dauer | Ergebnis | Durchgeführt von |
|---|---|---|---|---|---|
| 2026-11-06 | **Container-Probe**, kein frischer Rechner: PostgreSQL 16.15 im Entwicklungscontainer, ohne Docker; die Skripte liefen mit einem Ersatz für `docker compose`, der die Befehle gegen die lokale Datenbank ausführt | nur DE; synthetische Daten | Sicherung 0,5 s, Restore 2,5 s (Dump 4,9 MB) | Zeilenzahlen aller 224 Tabellen gleich, `kysely_migration` gleich, Start auf der wiederhergestellten Datenbank ohne ausstehende Migration | Claude Code (für #281) |
| | **Frischer Rechner** (der Produktivrechner, bevor er Daten trägt), Docker Compose | DE, MRE und MRE-Dateien | | | Projektinhaber |

**Restore auf dem frischen Rechner:** Den führt der Projektinhaber selbst auf dem Produktivrechner durch, bevor dieser Daten trägt: VPN einrichten, Stack starten, die Probe-Dumps aus #286 einspielen, DE und MRE prüfen (Abschnitt 7), Eintrag in die leere Zeile oben. Damit ist die Probe zugleich die Abnahme des Rechners (Entscheidung des Projektinhabers, 2026-11-06). Aus der Entwicklungsumgebung geht das nicht: dort gibt es keinen Docker-Daemon.

**Probe vom 2026-11-06 im Einzelnen:**

- **Quelle:** Datenbank `de_backup_src`, mit den Migrationen des Repositorys auf den Stand von `main` (23e313e, 72 Migrationen) gebracht; darin vier synthetische Zeilen im Schema `public` (ein Objekt, eine Person, ein Konto, eine Buchung) und die Daten dreier Abnahmetests (`phase-3`, `phase-5`, `phase-8-acceptance.e2e.test.ts`) in ihren eigenen Schemas, die für die Probe nicht gelöscht wurden. Zusammen 224 Tabellen in vier Schemas, 1 096 Zeilen in 73 nicht leeren Tabellen, darunter bestätigte und korrigierte Buchungen mit Splits, Darlehen, Kautionen, Anschaffungen und AuditRecords.
- **Sicherung:** `scripts/ops/backup.sh` mit `BACKUP_TARGETS=de`, also `pg_dump -Fc --no-owner --no-privileges` über die Standardausgabe; Prüfung mit `pg_restore --list`, `SHA256SUMS`, Kopie an einen zweiten Ort mit rsync.
- **Restore:** `scripts/ops/restore-de.sh` vom zweiten Ort in die leere Datenbank `de_backup_dst`.
- **Vergleich:** exakte Zeilenzahl (`count(*)`) jeder der 224 Tabellen: gleich. `kysely_migration` in allen vier Schemas je 72 Zeilen, Prüfsumme über Name und Zeitpunkt gleich. Zahl der Trigger (616), Constraints (2 820) und Indizes (792) gleich; MD5 über den vollständigen Inhalt einer `ledger_transaction`- und einer `audit_record`-Tabelle gleich.
- **Danach:** `migrateToLatest` auf `de_backup_dst` wendet nichts an; `de-backend` startet auf der wiederhergestellten Datenbank mit `database migrations applied: none pending`, `/health/live` und `/health/ready` antworten `200`; eine Änderung einer bestätigten Buchung wird vom Trigger abgewiesen („is immutable (ADR-037)“). Wiederherstellungsreihenfolge: Daten vor Triggern und Fremdschlüsseln (Abschnitt „post-data“ von `pg_dump`), daher feuern die Einfüge-Trigger beim Restore nicht.
- **Nicht geübt:** MongoDB läuft in diesem Container nicht; der MRE-Teil (`mongodump`, `mongorestore`) ist hier nicht ausgeführt worden. Er läuft in CI gegen den Compose-Stack (Abschnitt 5) und beim Restore auf dem frischen Rechner (zweite Zeile). Ebenso nicht geübt: `docker compose exec` und `docker compose cp` selbst.
- Die Probedatenbanken wurden danach gelöscht.

## 9. Reverse-Proxy, VPN und Secrets

**Geltung:** erste produktive Installation (Issue #281, Punkt 4). Backup und Wiederherstellung stehen in den Abschnitten 1 bis 8 (Issue #281, Punkt 1).
**Dateien:** `deploy/caddy/Caddyfile`, `docker-compose.proxy.yml`, `.env.example`. `docker-compose.yml` bleibt unverändert und ist weiterhin der Stack, den CI startet.

### 9.1 Überblick

Eine einzige Origin für MRE, DE und die Oberfläche, wie in `docs/architecture/mre-integration.md` §47.2 festgelegt. Der Refresh-Token von MRE ist ein Cookie mit `httpOnly` und `sameSite: strict`; nur eine Seite auf derselben Origin kann die Sitzung erneuern. CORS ist deshalb nicht nötig, und DE bietet es nicht an.

| Pfad | Ziel | Präfix |
|---|---|---|
| `/api/v1`, `/api/v1/*` | DE-Backend (`de-backend:8090`) | bleibt; DE hängt seine API selbst unter `/api/v1` ein (`services/de-backend/src/api/app.ts`, `app.use('/api/v1', api)`) |
| `/cockpit`, `/cockpit/*` | Oberfläche (`webapps/cockpit`, `ui-guide.md` §7.1) | bleibt; die Oberfläche wird mit dem Basispfad `/cockpit` gebaut |
| `/api/v2/*` und alles andere (`/`, `/tenantapi`, `/health`) | MRE-Gateway (`gateway:8080`) | bleibt |

Zum MRE-Gateway: Es erwartet die vollen Pfade und entfernt seine Präfixe selbst. Im gepinnten Stand `479d0ad` (`services/gateway/src/index.ts`, `exposeServices`) leitet es `/api/v2/authenticator` an den Authenticator (Präfix entfernt), `/api/v2/documents` und `/api/v2/templates` an den PDF-Generator, `/api/v2` an die API und `/tenantapi` an die Mieter-API. Das DE-Backend ruft das Gateway intern genauso auf (`MRE_API_URL: http://gateway:8080/api/v2`). Der Proxy reicht den Pfad deshalb unverändert durch.

Weitere Punkte:

- `/health/live` und `/health/ready` von DE werden nicht über den Proxy geroutet. Sie bleiben auf dem Loopback-Port `127.0.0.1:8090` des Hosts, wie in `docker-compose.yml`. `/health` über den Proxy ist der Health-Check des MRE-Gateways.
- `/api/reset` des Gateways gibt es nur außerhalb von `NODE_ENV=production`. Der Stack setzt `production`, die Route existiert also nicht.
- Das Gateway läuft mit `EXPOSE_FRONTENDS: 'false'`. Unter `/` antwortet daher nur das Gateway selbst, ohne MRE-Landlord-Oberfläche.
- Bis die Oberfläche als Dienst läuft, antwortet `/cockpit` mit `502`. Ihr Ziel steht in `COCKPIT_UI_UPSTREAM` (Default `cockpit-ui:80`).

### 9.2 Zugriff nur über VPN

Die Installation ist nur über ein VPN erreichbar. Es gibt keine öffentlichen Ports, keine Portweiterleitung am Router und keinen Eintrag im öffentlichen DNS.

- **VPN:** WireGuard oder Tailscale (ein auf WireGuard aufbauender Dienst), allgemein beschrieben: Der Host bekommt eine feste Adresse im VPN, zum Beispiel `10.8.0.1` bei WireGuard oder eine `100.x.y.z` bei Tailscale. Jedes Gerät, das die Oberfläche benutzt, ist Peer im selben VPN. Wer nicht im VPN ist, erreicht den Host nicht.
- **Bindung:** `docker-compose.proxy.yml` veröffentlicht nur Port `443`, und nur auf `PROXY_BIND_ADDRESS`, der VPN-Adresse des Hosts. Ohne Angabe gilt `127.0.0.1`, dann ist der Proxy nur vom Host selbst erreichbar. Nie `0.0.0.0` und nie eine öffentliche Adresse eintragen. Die Bindung ist der eigentliche Schutz: Docker umgeht Host-Firewalls wie `ufw` bei veröffentlichten Ports.
- **Startreihenfolge:** Die VPN-Schnittstelle muss vor Docker existieren, sonst kann Docker nicht an die Adresse binden und der Caddy-Container startet nicht. Den VPN-Dienst also vor Docker starten (bei systemd zum Beispiel `After=` und `Wants=` für den VPN-Dienst in einem Drop-in für `docker.service`).
- **Port 80:** wird nicht veröffentlicht. Caddy leitet HTTP intern auf HTTPS um, aber von außen ist nur `443` erreichbar.
- **Loopback-Ports:** Die Ports `127.0.0.1:8080` (Gateway) und `127.0.0.1:8090` (DE) aus `docker-compose.yml` bleiben für Prüfungen auf dem Host selbst. Sie sind nicht über das Netz erreichbar.
- **Name:** `COCKPIT_HOSTNAME` (Default `cockpit.internal`) ist ein interner Name, der nur im VPN aufgelöst wird: über den DNS des VPN (bei Tailscale MagicDNS oder Split-DNS) oder über einen Eintrag in der `hosts`-Datei jedes Geräts. Der Browser muss genau diesen Namen aufrufen, denn er ist auch die Cookie-Domain des Refresh-Tokens (Abschnitt 9.4).

### 9.3 TLS

Der Caddyfile nutzt `tls internal` mit dem Namen `cockpit.internal` (Entscheidung des Projektinhabers, 2026-11-06). Caddy stellt das Zertifikat aus seiner eigenen lokalen CA aus, ohne ACME und ohne öffentliche CA, denn der Name ist von außen nicht erreichbar.

- Das Volume `caddy-data` bleibt erhalten. Ein neues Volume bedeutet eine neue CA, und jedes Gerät müsste die neue Wurzel wieder installieren. `docker compose down -v` löscht es.
- HTTPS ist Pflicht, nicht Zierde: Der Authenticator setzt den Refresh-Token nur mit `secure`, wenn `APP_PROTOCOL=https` ist (Abschnitt 9.4).
- **Tailscale-Zertifikat:** ein `*.ts.net`-Name mit einem Zertifikat aus `tailscale cert` statt der lokalen CA ist als VC-X-58 geplant, nicht jetzt (Entscheidung des Projektinhabers, 2026-11-06). Dann würde im Caddyfile `tls internal` durch `tls <cert> <key>` ersetzt.

#### 9.3.1 Die lokale CA auf jedem Gerät installieren

Die Entscheidung des Projektinhabers vom 2026-11-06 legt fest: Die lokale CA von Caddy wird auf jedem Gerät installiert, das die Oberfläche benutzt. Ohne sie zeigt der Browser eine Zertifikatswarnung, und Apps verweigern die Verbindung. Installiert wird nur das Root-Zertifikat, nie der private Schlüssel daneben (`root.key`).

- **Wo es liegt:** im Volume `caddy-data` unter `/data/caddy/pki/authorities/local/root.crt`. Caddy legt die CA beim ersten Start an. Sie gilt rund zehn Jahre (3600 Tage); das Zwischenzertifikat und die Serverzertifikate erneuert Caddy selbst, die Geräte merken davon nichts.
- **Exportieren** (auf dem Host, im Projektverzeichnis):

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.proxy.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
  openssl x509 -in caddy-root.crt -noout -subject -fingerprint -sha256   # Fingerprint notieren
  ```

  Die Datei über einen vertrauenswürdigen Weg auf die Geräte bringen, zum Beispiel per USB-Stick oder per `scp` im VPN. Vor dem Installieren den SHA-256-Fingerprint auf dem Gerät mit dem notierten vergleichen.
- **Windows:** Doppelklick auf `caddy-root.crt`, dann „Zertifikat installieren“, „Lokaler Computer“, Speicher „Vertrauenswürdige Stammzertifizierungsstellen“. Alternativ als Administrator: `certutil -addstore -f Root caddy-root.crt`. Chrome und Edge nutzen diesen Speicher; Firefox nur, wenn `security.enterprise_roots.enabled` an ist, sonst das Zertifikat in Firefox unter Einstellungen, Zertifikate, Importieren eintragen.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root.crt`. Alternativ in der Schlüsselbundverwaltung importieren und bei „Vertrauen“ „Immer vertrauen“ wählen.
- **iOS und iPadOS:** die Datei per AirDrop oder Mail öffnen; dann Einstellungen, „Profil geladen“, Installieren. Danach unter Einstellungen, Allgemein, Info, Zertifikatsvertrauenseinstellungen das volle Vertrauen für das Root-Zertifikat einschalten. Ohne diesen zweiten Schritt vertraut Safari ihm nicht.
- **Android:** Einstellungen, Sicherheit (je nach Hersteller unter „Weitere Sicherheitseinstellungen“ oder „Verschlüsselung und Anmeldedaten“), „Zertifikat installieren“, „CA-Zertifikat“. Chrome vertraut Nutzer-CAs; viele andere Apps tun das seit Android 7 nicht, für die Oberfläche im Browser reicht es.
- **Linux:** Debian und Ubuntu: `sudo cp caddy-root.crt /usr/local/share/ca-certificates/caddy-root.crt && sudo update-ca-certificates`. Fedora: nach `/etc/pki/ca-trust/source/anchors/` kopieren, dann `sudo update-ca-trust`. Chrome und Firefox haben unter Linux oft einen eigenen Speicher: dort zusätzlich importieren (Einstellungen, Zertifikate).
- **Prüfen:** `https://cockpit.internal/health` öffnet sich ohne Warnung.
- **Neue CA:** Wird das Volume `caddy-data` gelöscht, entsteht beim nächsten Start eine neue CA. Dann die alte Wurzel auf allen Geräten entfernen und die neue wie oben installieren.

### 9.4 MRE-Sitzung hinter dem Proxy

`docker-compose.proxy.yml` überschreibt dazu Umgebungsvariablen der MRE-Dienste, ohne `docker-compose.yml` zu ändern:

- **Authenticator:** `APP_DOMAIN` wird `COCKPIT_HOSTNAME` und `APP_PROTOCOL` wird `https`. Im gepinnten Stand (`services/authenticator/src/index.js`) setzt der Authenticator das Cookie `refreshToken` mit `domain: APP_DOMAIN` und `secure: APP_PROTOCOL === 'https'`. Mit dem Entwicklungswert `localhost` würde der Browser das Cookie auf `cockpit.internal` verwerfen, und der Refresh nach 30 s schlüge fehl.
- **Authenticator:** `SIGNUP` kommt aus `MRE_SIGNUP`, Default `false`; die Selbstregistrierung ist zu (Entscheidung des Projektinhabers, 2026-11-06). Für das erste Vermieterkonto gilt dieser Ablauf:
  1. In `.env` einmalig `MRE_SIGNUP=true` setzen.
  2. Den Authenticator neu erstellen: `docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d authenticator`. Compose erkennt die geänderte Umgebung und erstellt den Container neu. Ein `restart` reicht nicht, er übernimmt keine neuen Variablen.
  3. Das Konto über die Anmeldung anlegen.
  4. `MRE_SIGNUP=false` zurücksetzen und den Authenticator mit demselben Befehl erneut neu erstellen.
  5. Prüfen: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cockpit.internal/api/v2/authenticator/landlord/signup` antwortet `404`. Ohne `SIGNUP` legt der gepinnte Authenticator die Route gar nicht an (`services/authenticator/src/routes/landlord.js`, `if (SIGNUP)`).
- **Gateway:** `CORS_ENABLED: 'false'`, denn es gibt nur eine Origin (§47.2). `APP_DOMAIN` wird `COCKPIT_HOSTNAME`; das Gateway braucht den Wert nur für CORS.
- **Emailer:** `LANDLORD_APP_URL` und `TENANT_APP_URL` zeigen auf den internen Namen. Der Versand bleibt aus (`ALLOW_SENDING_EMAILS: 'false'`).

### 9.5 Secrets

`docker-compose.yml` setzt für jedes Secret einen bekannten Entwicklungs-Default ein, wenn die Variable fehlt. Alle sind schon heute über `${VAR:-default}` überschreibbar; `docker-compose.yml` musste dafür nicht geändert werden.

```sh
cp .env.example .env && chmod 600 .env
# jeden Platzhalter CHANGE_ME_… durch einen eigenen Wert ersetzen, z. B.:
openssl rand -hex 32
```

Überschrieben werden müssen in der produktiven Installation ausnahmslos: `DE_DB_PASSWORD`, `REDIS_PASSWORD`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `RESET_TOKEN_SECRET`, `APPCREDZ_TOKEN_SECRET`, `CIPHER_KEY`, `CIPHER_IV_KEY`. `.env.example` erklärt jede Variable. `.env` steht in `.gitignore` und wird nie committet.

Regeln:

- **Vor dem ersten Start setzen.** Postgres übernimmt `DE_DB_PASSWORD` nur beim ersten Initialisieren des Volumes. `CIPHER_KEY` und `CIPHER_IV_KEY` dürfen sich nicht mehr ändern, sobald MRE Daten verschlüsselt hat; sie gehören zum Backup (Abschnitt 1). Eine Änderung von `ACCESS_TOKEN_SECRET` oder `REFRESH_TOKEN_SECRET` beendet alle Sitzungen.
- **Hex-Werte verwenden.** `DE_DB_PASSWORD` steht ungeschützt in `DATABASE_URL`; Zeichen wie `@`, `:` oder `/` brechen die URL.
- **Kontrolle:** `docker compose -f docker-compose.yml -f docker-compose.proxy.yml config | grep -E '_secret|_password|cipher_'` darf keinen der Entwicklungs-Defaults mehr zeigen.
- `MONGO_URL` enthält keine Zugangsdaten, denn MongoDB läuft im gepinnten Stack ohne Authentifizierung. Erreichbar ist es nur im internen Docker-Netz `net`, ohne veröffentlichten Port. Als VC-X-59 im Backlog; keine Go-live-Voraussetzung, solange das Netz intern und nur per VPN erreichbar ist (Entscheidung des Projektinhabers, 2026-11-06).

### 9.6 Start und Prüfung

```sh
docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build --wait
```

Prüfung von einem Gerät im VPN (Root-Zertifikat installiert):

```sh
curl -fsS https://cockpit.internal/health                     # MRE-Gateway: OK
curl -s -o /dev/null -w '%{http_code}\n' https://cockpit.internal/api/v1/health   # DE ohne Token: 401
```

Von außerhalb des VPN darf weder `443` noch ein anderer Port der Installation antworten.

CI prüft im Job `compose-smoke` mit `.github/scripts/compose-proxy-check.sh` (Entscheidung des Projektinhabers, 2026-11-06), dass:

- das Override zusammen mit `docker-compose.yml` rendert;
- Caddy auf keiner Wildcard-Adresse veröffentlicht;
- `SIGNUP` standardmäßig `false` ist;
- der Caddyfile im Caddy-Image des Overrides gültig ist (`caddy validate`).

### 9.7 AfA-Erfassung: `DEPRECIATION_RECORDING_ENABLED` bleibt ungesetzt

Die produktive Installation läuft mit ausgeschaltetem Erfassungsschalter. `DEPRECIATION_RECORDING_ENABLED` wird nicht gesetzt, weder in `.env` noch in einer Compose-Datei. `docker-compose.yml` reicht die Variable nicht an den Container `de-backend` durch; ein Eintrag in `.env` allein hätte deshalb keine Wirkung.

So liest das Backend den Schalter (`services/de-backend/src/config.ts`, `configSchema`): `z.enum(['true', 'false']).default('false')`, einmal beim Start. Ungesetzt heißt aus. Jeder andere Wert, auch `""`, `TRUE`, `1` oder `yes`, bricht den Start mit `Invalid configuration: DEPRECIATION_RECORDING_ENABLED` ab (`config.test.ts`). `main.ts` gibt den Wert an den Plan und an das Erfassen weiter und protokolliert beim Start `depreciation schedule recording: disabled`.

Wäre er auf `true` gesetzt (und an den Container durchgereicht):

- `POST /api/v1/depreciation-assets/{id}/schedule-versions` würde Planversionen tatsächlich erfassen. Heute wirft `recordScheduleVersion` vor jedem Datenzugriff `RecordingNotEnabledError` (`services/de-backend/src/application/depreciation-schedule-versions.ts`, `if (!deps.recordingEnabled)`), also `409 CONFLICT` mit `details.reason: "RECORDING_NOT_ENABLED"` (api-design §60 „The recording switch“). Eingeschränkt bliebe es nur durch die freigegebene Stufe `DEPRECIATION_RECORDING_STAGE` (Default `1`, §60A; Jahre darüber `409 STAGE_NOT_RELEASED`).
- Der Planabruf meldete `recordingEnabled: true`.
- **Das erste produktive Einschalten ist der verbindliche Freeze-Punkt der AfA-Regelversionen** (`config.ts`; api-design §60, entschieden am 2026-10-31, dritter Satz). Ein späteres Ausschalten hebt ihn nicht auf.

Einschalten darf man ihn nur nach api-design §60 „Turning it on“ und dem Freigabeprotokoll `docs/development/freigabe-afa-erfassung.md`: Antworten des Steuerberaters eingearbeitet, offene Tests von VC-X-35, dokumentierte Entscheidung des Projektinhabers. Der Go-live (Issue #281) setzt das ausdrücklich nicht voraus. CI prüft den ausgeschalteten Default gegen den echten Stack (`.github/scripts/compose-auth-smoke.sh`, Abschnitt VC-8-04: `409 RECORDING_NOT_ENABLED`).

### 9.8 Bewusst offen

- **VC-X-09 (Images per Digest):** umgesetzt. `caddy:2.11.9` ist wie alle anderen Images per `tag@sha256:…` gepinnt (Abschnitt 11); vorher `caddy:2.8`, hochgezogen nach der Entscheidung des Projektinhabers, 2026-11-07, zu #291 Frage 2.
- **VC-X-10 (Logging, Rate-Limit):** offen. Der Proxy schreibt kein Access-Log und begrenzt keine Rate. Ein Rate-Limit für `/api/v1` kommt erst, wenn der Dienst über das VPN hinaus erreichbar wird (Issue #281, Punkt 4; §47.1). Solange nur VPN-Peers zugreifen, bleibt es weg.

## 10. Entscheidungen

Die Fragen aus #286, entschieden am 2026-11-06 (Entscheidung des Projektinhabers, 2026-11-06):

1. **Zweiter Ort:** vor dem Kopieren verschlüsseln (`age` oder `restic`), weil die Dumps personenbezogene Daten enthalten; Ziel mit Versionierung oder Objektsperre, Schreibzugang nur anhängend. Den Anbieter wählt der Projektinhaber; die Anleitung bleibt bei `BACKUP_COPY_CMD` und beschreibt die Verschlüsselung als Pflichtschritt davor. Umgesetzt in Abschnitt 3.
2. **MRE-Dateien:** ja, zwei Volumes am `pdfgenerator`, `mre-pdf-uploads` und `mre-pdf-data`, gesichert als `tar` mit in `MANIFEST` und `SHA256SUMS`, mit Restore-Schritt; Backlog-Zeile VC-X-60 mit dem Hinweis, dass Upstream dieselbe Lücke hat. Umgesetzt in den Abschnitten 1, 2, 5 und 6, mit der Abweichung `pdf_documents/` statt `data/` (Abschnitt 1, zur Bestätigung).
3. **Aufbewahrung 14/8/12:** bestätigt; VC-X-24 betrifft die Live-Daten, Sicherungen älter als ein Jahr sind weg (Abschnitt 4); die Pseudonymisierung und die Löschung auf Antrag stehen in Abschnitt 12.
4. **Überwachung:** aktiv melden, Cron-Check gegen 26 Stunden über `BACKUP_ALERT_CMD`, Standard Cron-Mail (Abschnitt 2a).
5. **Restore auf frischem Rechner:** beim Projektinhaber, auf dem Produktivrechner vor dem ersten Datenbestand (Abschnitt 8).

## 11. Images und Actions: Pinning und Aktualisierung (VC-X-09)

### 11.1 Was gepinnt ist

Jedes Container-Image steht als `tag@sha256:…`, jede GitHub Action als `owner/action@<Commit-SHA> # vX.Y.Z`. Das Tag und der Versionskommentar dienen nur der Lesbarkeit: Docker zieht bei `tag@sha256:…` ausschließlich den Digest und ignoriert das Tag, GitHub führt genau den genannten Commit aus. Ein neu veröffentlichtes `postgres:16` oder ein verschobenes `v7`-Tag ändert damit nichts, bis der Pin bewusst geändert wird.

| Stelle | Image / Action |
| --- | --- |
| `docker-compose.yml` | `postgres:16`, `redis:7.4-bookworm`, `mongo:7`, die sechs MRE-Images (`gateway`, `authenticator`, `api`, `tenantapi`, `pdfgenerator`, `emailer`) |
| `docker-compose.proxy.yml` | `caddy:2.11.9` |
| `services/de-backend/Dockerfile` | `node:24-bookworm-slim` (beide Stufen, derselbe Digest) |
| `.github/workflows/ci.yml` | Service-Container `postgres:16` (derselbe Digest wie in `docker-compose.yml`), `actions/checkout`, `actions/setup-node` |

Gepinnt wird der Digest des **Multi-Arch-Index** (`application/vnd.oci.image.index.v1+json`), nicht der einer einzelnen Plattform; so passt derselbe Pin auf amd64 und arm64. Die MRE-Images veröffentlicht Upstream nur für eine Plattform: Ihr Digest ist der des einzigen Manifests (`application/vnd.docker.distribution.manifest.v2+json`).

CI prüft im Job `build-test` mit `.github/scripts/image-pin-check.sh`, dass jede `image:`-Zeile der Compose-Dateien und Workflows und jede `FROM`-Zeile eines Dockerfiles einen Digest trägt und jede Action per Commit-SHA mit Versionskommentar eingebunden ist. Ein neues Image oder eine neue Action ohne Pin macht CI rot.

### 11.2 MRE-Images und `MRE_VERSION`

Die MRE-Images tragen als Tag den gepinnten Commit aus ADR-036 (`mre-integration.md` §55). Damit `MRE_VERSION` als Override erhalten bleibt, steckt der Digest **im Default** der Variablen:

```yaml
image: ghcr.io/microrealestate/microrealestate/gateway:${MRE_VERSION:-479d0ad…@sha256:1f48…}
```

- **`MRE_VERSION` ungesetzt** (Normalfall, auch in CI): Commit-Tag und Digest, je Dienst ein eigener Digest.
- **`MRE_VERSION` gesetzt:** nur dieses Tag, ohne Digest. Das ist gewollt: Ein fremdes Tag mit dem alten Digest würde Docker stillschweigend auf den alten Digest auflösen, also den alten Stand starten. Ein gesetztes `MRE_VERSION` dient deshalb nur zum Ausprobieren eines anderen MRE-Stands (Abschnitt 11.3); die produktive Installation lässt es ungesetzt.

Verworfen: sechs eigene Digest-Variablen neben `MRE_VERSION` (vergisst man eine, läuft ein Dienst auf dem alten Stand) und das Entfernen von `MRE_VERSION` (bricht den dokumentierten Override und `scripts/ops/backup.sh`, das den Wert ins `MANIFEST` schreibt).

### 11.3 Neuen Digest nachschlagen

Mit Docker (Buildx), ohne das Image zu ziehen:

```sh
docker buildx imagetools inspect postgres:16 --format '{{json .Manifest}}' | jq -r '.mediaType + " " + .digest'
docker buildx imagetools inspect ghcr.io/microrealestate/microrealestate/gateway:<MRE-Commit> --format '{{json .Manifest}}' | jq -r '.mediaType + " " + .digest'
```

Ohne Docker über die Registry-API (anonymes Token, `HEAD` auf das Manifest, Header `Docker-Content-Digest`):

```sh
accept='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
# Docker Hub (offizielle Images liegen unter library/)
token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull" | jq -r .token)
curl -fsSI -H "Authorization: Bearer $token" -H "Accept: $accept" https://registry-1.docker.io/v2/library/postgres/manifests/16 | grep -i docker-content-digest
# ghcr.io
token=$(curl -fsS "https://ghcr.io/token?scope=repository:microrealestate/microrealestate/gateway:pull" | jq -r .token)
curl -fsSI -H "Authorization: Bearer $token" -H "Accept: $accept" https://ghcr.io/v2/microrealestate/microrealestate/gateway/manifests/<MRE-Commit> | grep -i docker-content-digest
```

Ist `mediaType` ein einzelnes Manifest, obwohl das Image mehrere Plattformen hat, war der `Accept`-Header unvollständig: Den Digest eines Plattform-Manifests nicht übernehmen.

Für eine Action den Commit des Release-Tags:

```sh
git ls-remote --tags https://github.com/actions/checkout | grep -E 'refs/tags/v7\.[0-9]+\.[0-9]+(\^\{\})?$' | sort -V -k2
```

Bei einem annotierten Tag zählt die Zeile mit `^{}` (der Commit), nicht das Tag-Objekt. Vor einem Wechsel der Hauptversion die Release-Notes (README „What's new“ / „Breaking changes“, `CHANGELOG.md`) gegen die im Workflow benutzten Eingaben prüfen.

Für einen anderen MRE-Stand zuerst ohne Digest ausprobieren: `MRE_VERSION=<neuer Commit>` in `.env`, `docker compose up -d --wait`, dann der MRE-Contract-Test (`mre-integration.md` §21.1, §55).

### 11.4 Pin ändern

- **Basis-Images** (`postgres`, `redis`, `mongo`, `caddy`, `node`): Digest an jeder Stelle aus 11.1 ersetzen, das Tag nur ändern, wenn bewusst eine andere Version gewählt wird. `postgres:16` steht in `docker-compose.yml` und in `ci.yml` und bekommt an beiden Stellen denselben Digest; `node:24-bookworm-slim` in beiden Stufen des Dockerfiles. Eine neue Hauptversion von Postgres oder MongoDB ist kein Digest-Update, sondern eine Datenmigration (Dump und Restore, Abschnitte 1 und 6).
- **MRE:** Commit und alle sechs Digests im Default von `docker-compose.yml` gemeinsam ändern, dazu `.env.example` und die Referenz in ADR-036 / `mre-integration.md` nach dem Upgrade-Verfahren aus §55.
- **Actions:** SHA und Versionskommentar gemeinsam ändern, an jeder `uses:`-Zeile derselben Action.
- Ein Pin-Update ist ein eigener PR, im Titel „Pin“ oder „Bump“, im Text altes und neues Digest bzw. alte und neue SHA.

### 11.5 Prüfung

Lokal:

```sh
.github/scripts/image-pin-check.sh
docker compose config -q
docker compose -f docker-compose.yml -f docker-compose.proxy.yml config -q
docker compose pull            # zieht genau die gepinnten Digests; ein falscher Digest scheitert hier
```

In CI: `build-test` (Pin-Prüfung, Tests gegen den Postgres-Service-Container) und `compose-smoke` (zieht alle gepinnten Images, startet den Stack, MRE-Contract-Test, Auth-, Backup- und Proxy-Prüfung inklusive `caddy validate` im gepinnten Caddy-Image). Erst wenn beide grün sind, ist der neue Pin geprüft. Auf dem Produktivrechner danach `docker compose -f docker-compose.yml -f docker-compose.proxy.yml pull` und `up -d --wait`, vorher eine Sicherung (Abschnitt 2).

### 11.6 Dependabot

Pin-Updates schlägt Dependabot vor, nicht Renovate (Entscheidung des Projektinhabers, 2026-11-07, zu #291 Frage 1): eingebaut, keine weitere App. Konfiguration in `.github/dependabot.yml`: wöchentlich (montags), je Ökosystem ein gebündelter PR für npm (Yarn, Wurzel mit den Workspaces), das Dockerfile (`services/de-backend`), die Compose-Dateien (`docker-compose.yml`, `docker-compose.proxy.yml`) und die GitHub Actions. prettier und typescript-eslint bilden eine eigene wöchentliche Gruppe `lint-format`, weil ihre Minor-Versionen umformatieren und neue Lint-Regeln bringen; für deren PRs gilt: Umformatierungen in einem eigenen Commit, neue Lint-Funde im zweiten, kein Verhalten geändert (Entscheidung des Projektinhabers, 2026-11-09: „So bleibt das npm-Bündel grün, und die Lint-Woche ist in fünf Minuten geprüft.“). Das npm-Bündel enthält nur Minor- und Patch-Updates; jede andere Hauptversion kommt als eigener PR, damit ein rotes Upgrade das Bündel nicht blockiert (Entscheidung des Projektinhabers, 2026-11-09, zu #303). Die Hauptversionen von TypeScript, Zod, Express (mit `@types/express`), Vitest und ESLint (mit `@eslint/js`) schlägt Dependabot nicht vor; sie sind geplante Arbeit mit eigener Backlog-Zeile (VC-X-07, VC-X-65, VC-X-66, VC-X-67, VC-X-68; ESLint 10 Entscheidung des Projektinhabers, 2026-11-09, zu #306/#307). Zod 4 ist umgestellt (VC-X-65); der Eintrag hält jetzt die nächste Hauptversion (Zod 5) zurück, die wieder geplante Arbeit ist. Express 5 ist umgestellt (VC-X-66, mit `@types/express` 5); die beiden Einträge halten jetzt die nächste Hauptversion (Express 6) zurück, ebenfalls geplante Arbeit. Vitest 5 ist umgestellt (VC-X-67, Backend und Oberfläche in derselben Version); der Eintrag hält jetzt die nächste Hauptversion (Vitest 6) zurück, ebenfalls geplante Arbeit. ESLint 10 ist umgestellt (VC-X-68, mit `@eslint/js` 10 und `typescript-eslint` 8.72); die beiden Einträge halten jetzt die nächste Hauptversion (ESLint 11) zurück, ebenfalls geplante Arbeit: zuerst ein `typescript-eslint` mit ihrer Unterstützung, dann die Konfiguration gegen die Migrationshinweise prüfen, keine Regel still verlieren, neue Funde aus `eslint:recommended` in einem eigenen Commit. Kysely ist 0.x: Nebenversionen sind ausgenommen, Patch-Updates kommen im Bündel (VC-X-07). Die Oberfläche (`webapps/cockpit`) liegt im selben npm-Eintrag, eine `yarn.lock` heißt ein Eintrag (Entscheidung des Projektinhabers, 2026-11-09: Dependabot-Eintrag für den Workspace); ihre Minor- und Patch-Updates kommen im Bündel. Hauptversionen von `react`, `react-dom`, `@types/react`, `@types/react-dom`, `tailwindcss` und `@tanstack/react-query` schlägt Dependabot nicht vor, weil der Stack dem gepinnten MRE-Landlord-Frontend folgt (`ui-guide.md` §7.1, `technology.md` §7.1); `vite` ist seit Vitest 5 eine Peer-Abhängigkeit von Vitest, Backend und Oberfläche pinnen dieselbe Version (Vite 8 seit VC-X-67); der Eintrag hält jetzt Vite 9 zurück, das mit einer Vitest-Hauptversion oder als eigene geplante Arbeit kommt. Kein Automerge: Ein Dependabot-PR läuft durch dieselbe CI wie jeder andere PR (`build-test` mit `image-pin-check.sh`, `compose-smoke` mit `caddy validate` im neuen Caddy-Image, das Direktiven-Änderungen fängt) und wird von Hand gemergt, wenn beide Jobs grün sind. Dependabot behält die Form der Pins bei (`tag@sha256:…` bekommt Tag und Digest neu, eine Action SHA und Versionskommentar); verliert ein Vorschlag einen Pin, macht `image-pin-check.sh` ihn rot, und er wird nicht gemergt. Ausgenommen sind die MRE-Images (Verfahren nach §55, Abschnitt 11.4) sowie Hauptversionen von `postgres`, `mongo` und `node` (Datenmigration bzw. `engines.node`) und Haupt- und Nebenversionen von `redis` (Teil des MRE-Stacks, das Tag `7.4-bookworm` zielt genau auf 7.4; Patch- und Digest-Updates kommen weiter). Den Service-Container `postgres:16` in `ci.yml` aktualisiert Dependabot nicht: Ändert ein PR den Digest in `docker-compose.yml`, im selben PR auch in `ci.yml` nachziehen (Abschnitt 11.4). `image-pin-check.sh` vergleicht beide Referenzen und wird rot, wenn sie abweichen; die Fehlermeldung nennt `ci.yml` als nachzuziehende Datei (Entscheidung des Projektinhabers, 2026-11-09, zu #299 Frage 2: „Sonst testet CI stillschweigend gegen eine andere PostgreSQL-Version als die, die produktiv läuft, und genau diese Drift soll der Check verhindern.“). Dockerfile und Compose bleiben zwei getrennte Dependabot-PRs; beide laufen montags, kommen also zusammen an und werden zusammen gemergt (Entscheidung des Projektinhabers, 2026-11-09, zu #299 Frage 1: „Zwei PRs für Dockerfile und Compose sind die ehrlichere Darstellung: Das Basisimage des Backends und die Dienst-Images des Stacks sind verschiedene Dinge mit verschiedenen Testwegen.“).

## 12. Personenbezogene Daten im Audit: Pseudonymisierung und Löschung auf Antrag (VC-X-24)

Grundlage: `api-design.md` §58U; Entscheidung des Projektinhabers, 2026-11-06.

### 12.1 Was der Dienst selbst tut

- **Zehn Jahre lesbar:** Ein `AMENDED`-AuditRecord hält die alten und neuen Werte einer Änderung. Zehn Jahre ab dem Ende seines Entstehungsjahres (Kalenderjahr in Europe/Berlin, § 147 Abs. 4 AO) bleiben sie, wie sie geschrieben wurden.
- **Danach ersetzt, nie gelöscht:** Ab dem 1. Januar des Jahres `Entstehungsjahr + 11`, 00:00 Uhr Berlin, ersetzt `de-backend` in diesen Datensätzen die sieben Felder der Partei (`displayName`, `firstName`, `lastName`, `legalName`, `registrationNumber`, `email`, `phone`, jeweils `from` und `to`) durch den festen Marker `[entfernt:v1]`; `null` bleibt `null`. Der Datensatz bleibt, mit Feldnamen und Zeitpunkt; er sagt weiter, welches Feld wann geändert wurde. Im Dokument heißt das „pseudonymisiert“; **es gibt keinen Schlüssel**, aus dem Marker lässt sich nichts zurückrechnen, der Personenbezug endet. Je ersetztem Datensatz schreibt der Dienst einen `AUDIT_PSEUDONYMISED`-Datensatz an derselben Partei (Pfade, Grundlage, Ende der Aufbewahrung; kein Wert).
- **Wann:** einmal beim Start, bevor der Dienst Anfragen annimmt, und einmal täglich. Je Lauf eine Log-Zeile `audit pseudonymisation: <n> record(s) pseudonymised (retention 10 years, created before <Datum>)`. Ein Fehler steht als `audit pseudonymisation failed: …` im Log, hält den Start nicht auf; der nächste Lauf versucht es wieder. Kein Cron, kein Secret, keine Einstellung.
- **Außerhalb:** die aktuellen Werte einer Partei (auch einer deaktivierten), Freitexte (`description`, `notes`, `sourceReferences`, `contractNumber`, Nachweise), andere Aktionen (`reason` von `VOIDED`/`DEACTIVATED`/`CORRECTED`, Notizen in `CREATED`) und `actor_id`. Wer in Freitexte Namen schreibt, tut es gegen die Anleitung.
- **Datenbank:** `audit_record` ist seit Migration 0076 unveränderlich: `DELETE` und `TRUNCATE` werden abgewiesen, `UPDATE` nur als diese Ersetzung. Der Wächter schützt vor einem Fehler im Dienst, nicht vor dem Datenbankeigentümer, der einen Trigger abschalten kann; eine eigene Datenbankrolle ohne `UPDATE`/`DELETE` ist eine eigene Backlog-Zeile (Betriebshärtung).

### 12.2 Löschung auf Antrag (Art. 17 DSGVO)

1. **Antrag ablegen:** wer, wann, was, und wie die Person identifiziert wurde, in den Unterlagen des Betreibers, **nicht** im Repository und nicht in der DE-Datenbank.
2. **Partei bestimmen:** die `partyId` in DE und den Realm (`mreRealmId`) mit der antragstellenden Person klären.
3. **Probelauf** (Standard, schreibt nichts):

   ```sh
   scripts/ops/audit-erasure.sh <mreRealmId> <partyId>
   ```

   Eine Zeile je `AMENDED`-Datensatz der Partei: Id, Zeitpunkt, Entstehungsjahr, Ende der Aufbewahrung, `pseudonymised_at`, Zustand und die Pfade, die ersetzt würden; am Ende eine Zusammenfassung mit dem spätesten Fristende. Nur Ids und Daten, kein Wert. Eine Partei eines anderen Realms wird nicht gefunden (Status 1).
4. **Aufbewahrungspflicht prüfen:** Innerhalb der zehn Jahre wird **nichts geändert**. Der Betreiber antwortet mit dem Fristende (`31.12.` des Entstehungsjahres + 10) unter Verweis auf § 147 AO und Art. 17 Abs. 3 lit. b DSGVO und schränkt die Verarbeitung ein (Art. 18 DSGVO): Version 1 hat keine Audit-Lesung, nichts zeigt die Historie an. Ob die Historie von E-Mail und Telefon überhaupt unter § 147 AO fällt oder auf Antrag früher entfernt werden darf, ist eine offene Frage an die Beratung (`docs/germany/beratungsfragen.md`, Frage 7); bis zur Antwort gilt diese vorsichtige Lesart.
5. **Anwenden:**

   ```sh
   scripts/ops/audit-erasure.sh <mreRealmId> <partyId> --apply
   ```

   Ersetzt die Werte der Datensätze, deren Aufbewahrung abgelaufen ist, mit demselben Code wie der tägliche Lauf (`basis: "ERASURE_REQUEST"`); mit dem täglichen Lauf ist das normalerweise nichts. Die aktuellen Werte der Partei ändert das Skript nicht; deckt der Antrag sie ab, ändert oder deaktiviert der Betreiber die Partei über die API.
6. **Ergebnis vermerken:** in den Unterlagen des Betreibers (Ids und Daten), damit es nach einem Restore wiederholt werden kann (Abschnitt 7).

Das Skript läuft gegen den laufenden Container (`docker compose exec -T de-backend node dist/audit-erasure.js …`, liest dort `DATABASE_URL`); `COMPOSE_DIR`, `COMPOSE_CMD` und `DE_BACKEND_SERVICE` wie in den anderen Skripten. Eine offene Festsetzungsfrist verlängert die zehn Jahre bis zur Antwort der Beratung nicht (`beratungsfragen.md`, Frage 6); eine Sperrflagge gibt es nicht.
