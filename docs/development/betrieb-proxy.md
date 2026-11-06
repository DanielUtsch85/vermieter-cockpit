# Betrieb: Reverse-Proxy, VPN und Secrets

**Geltung:** erste produktive Installation (Issue #281, Punkt 4). Backup und Wiederherstellung stehen getrennt in `docs/development/betrieb.md` (Issue #281, Punkt 1).
**Dateien:** `deploy/caddy/Caddyfile`, `docker-compose.proxy.yml`, `.env.example`. `docker-compose.yml` bleibt unverändert und ist weiterhin der Stack, den CI startet.

## 1. Überblick

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

## 2. Zugriff nur über VPN

Die Installation ist nur über ein VPN erreichbar. Es gibt keine öffentlichen Ports, keine Portweiterleitung am Router und keinen Eintrag im öffentlichen DNS.

- **VPN:** WireGuard oder Tailscale (ein auf WireGuard aufbauender Dienst), allgemein beschrieben: Der Host bekommt eine feste Adresse im VPN, zum Beispiel `10.8.0.1` bei WireGuard oder eine `100.x.y.z` bei Tailscale. Jedes Gerät, das die Oberfläche benutzt, ist Peer im selben VPN. Wer nicht im VPN ist, erreicht den Host nicht.
- **Bindung:** `docker-compose.proxy.yml` veröffentlicht nur Port `443`, und nur auf `PROXY_BIND_ADDRESS`, der VPN-Adresse des Hosts. Ohne Angabe gilt `127.0.0.1`, dann ist der Proxy nur vom Host selbst erreichbar. Nie `0.0.0.0` und nie eine öffentliche Adresse eintragen. Die Bindung ist der eigentliche Schutz: Docker umgeht Host-Firewalls wie `ufw` bei veröffentlichten Ports.
- **Startreihenfolge:** Die VPN-Schnittstelle muss vor Docker existieren, sonst kann Docker nicht an die Adresse binden und der Caddy-Container startet nicht. Den VPN-Dienst also vor Docker starten (bei systemd zum Beispiel `After=` und `Wants=` für den VPN-Dienst in einem Drop-in für `docker.service`).
- **Port 80:** wird nicht veröffentlicht. Caddy leitet HTTP intern auf HTTPS um, aber von außen ist nur `443` erreichbar.
- **Loopback-Ports:** Die Ports `127.0.0.1:8080` (Gateway) und `127.0.0.1:8090` (DE) aus `docker-compose.yml` bleiben für Prüfungen auf dem Host selbst. Sie sind nicht über das Netz erreichbar.
- **Name:** `COCKPIT_HOSTNAME` (Default `cockpit.internal`) ist ein interner Name, der nur im VPN aufgelöst wird: über den DNS des VPN (bei Tailscale MagicDNS oder Split-DNS) oder über einen Eintrag in der `hosts`-Datei jedes Geräts. Der Browser muss genau diesen Namen aufrufen, denn er ist auch die Cookie-Domain des Refresh-Tokens (Abschnitt 4).

## 3. TLS

Der Caddyfile nutzt `tls internal` mit dem Namen `cockpit.internal` (Entscheidung des Projektinhabers, 2026-11-06). Caddy stellt das Zertifikat aus seiner eigenen lokalen CA aus, ohne ACME und ohne öffentliche CA, denn der Name ist von außen nicht erreichbar.

- Das Volume `caddy-data` bleibt erhalten. Ein neues Volume bedeutet eine neue CA, und jedes Gerät müsste die neue Wurzel wieder installieren. `docker compose down -v` löscht es.
- HTTPS ist Pflicht, nicht Zierde: Der Authenticator setzt den Refresh-Token nur mit `secure`, wenn `APP_PROTOCOL=https` ist (Abschnitt 4).
- **Tailscale-Zertifikat:** ein `*.ts.net`-Name mit einem Zertifikat aus `tailscale cert` statt der lokalen CA ist als VC-X-58 geplant, nicht jetzt (Entscheidung des Projektinhabers, 2026-11-06). Dann würde im Caddyfile `tls internal` durch `tls <cert> <key>` ersetzt.

### 3.1 Die lokale CA auf jedem Gerät installieren

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

## 4. MRE-Sitzung hinter dem Proxy

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

## 5. Secrets

`docker-compose.yml` setzt für jedes Secret einen bekannten Entwicklungs-Default ein, wenn die Variable fehlt. Alle sind schon heute über `${VAR:-default}` überschreibbar; `docker-compose.yml` musste dafür nicht geändert werden.

```sh
cp .env.example .env && chmod 600 .env
# jeden Platzhalter CHANGE_ME_… durch einen eigenen Wert ersetzen, z. B.:
openssl rand -hex 32
```

Überschrieben werden müssen in der produktiven Installation ausnahmslos: `DE_DB_PASSWORD`, `REDIS_PASSWORD`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `RESET_TOKEN_SECRET`, `APPCREDZ_TOKEN_SECRET`, `CIPHER_KEY`, `CIPHER_IV_KEY`. `.env.example` erklärt jede Variable. `.env` steht in `.gitignore` und wird nie committet.

Regeln:

- **Vor dem ersten Start setzen.** Postgres übernimmt `DE_DB_PASSWORD` nur beim ersten Initialisieren des Volumes. `CIPHER_KEY` und `CIPHER_IV_KEY` dürfen sich nicht mehr ändern, sobald MRE Daten verschlüsselt hat; sie gehören zum Backup (`betrieb.md`). Eine Änderung von `ACCESS_TOKEN_SECRET` oder `REFRESH_TOKEN_SECRET` beendet alle Sitzungen.
- **Hex-Werte verwenden.** `DE_DB_PASSWORD` steht ungeschützt in `DATABASE_URL`; Zeichen wie `@`, `:` oder `/` brechen die URL.
- **Kontrolle:** `docker compose -f docker-compose.yml -f docker-compose.proxy.yml config | grep -E '_secret|_password|cipher_'` darf keinen der Entwicklungs-Defaults mehr zeigen.
- `MONGO_URL` enthält keine Zugangsdaten, denn MongoDB läuft im gepinnten Stack ohne Authentifizierung. Erreichbar ist es nur im internen Docker-Netz `net`, ohne veröffentlichten Port. Als VC-X-59 im Backlog; keine Go-live-Voraussetzung, solange das Netz intern und nur per VPN erreichbar ist (Entscheidung des Projektinhabers, 2026-11-06).

## 6. Start und Prüfung

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

## 7. AfA-Erfassung: `DEPRECIATION_RECORDING_ENABLED` bleibt ungesetzt

Die produktive Installation läuft mit ausgeschaltetem Erfassungsschalter. `DEPRECIATION_RECORDING_ENABLED` wird nicht gesetzt, weder in `.env` noch in einer Compose-Datei. `docker-compose.yml` reicht die Variable nicht an den Container `de-backend` durch; ein Eintrag in `.env` allein hätte deshalb keine Wirkung.

So liest das Backend den Schalter (`services/de-backend/src/config.ts`, `configSchema`): `z.enum(['true', 'false']).default('false')`, einmal beim Start. Ungesetzt heißt aus. Jeder andere Wert, auch `""`, `TRUE`, `1` oder `yes`, bricht den Start mit `Invalid configuration: DEPRECIATION_RECORDING_ENABLED` ab (`config.test.ts`). `main.ts` gibt den Wert an den Plan und an das Erfassen weiter und protokolliert beim Start `depreciation schedule recording: disabled`.

Wäre er auf `true` gesetzt (und an den Container durchgereicht):

- `POST /api/v1/depreciation-assets/{id}/schedule-versions` würde Planversionen tatsächlich erfassen. Heute wirft `recordScheduleVersion` vor jedem Datenzugriff `RecordingNotEnabledError` (`services/de-backend/src/application/depreciation-schedule-versions.ts`, `if (!deps.recordingEnabled)`), also `409 CONFLICT` mit `details.reason: "RECORDING_NOT_ENABLED"` (api-design §60 „The recording switch“). Eingeschränkt bliebe es nur durch die freigegebene Stufe `DEPRECIATION_RECORDING_STAGE` (Default `1`, §60A; Jahre darüber `409 STAGE_NOT_RELEASED`).
- Der Planabruf meldete `recordingEnabled: true`.
- **Das erste produktive Einschalten ist der verbindliche Freeze-Punkt der AfA-Regelversionen** (`config.ts`; api-design §60, entschieden am 2026-10-31, dritter Satz). Ein späteres Ausschalten hebt ihn nicht auf.

Einschalten darf man ihn nur nach api-design §60 „Turning it on“ und dem Freigabeprotokoll `docs/development/freigabe-afa-erfassung.md`: Antworten des Steuerberaters eingearbeitet, offene Tests von VC-X-35, dokumentierte Entscheidung des Projektinhabers. Der Go-live (Issue #281) setzt das ausdrücklich nicht voraus. CI prüft den ausgeschalteten Default gegen den echten Stack (`.github/scripts/compose-auth-smoke.sh`, Abschnitt VC-8-04: `409 RECORDING_NOT_ENABLED`).

## 8. Bewusst offen

- **VC-X-09 (Images per Digest):** offen. `caddy:2.8` ist wie `postgres:16`, `mongo:7` und `redis:7.4-bookworm` per Tag gepinnt, nicht per `@sha256:…`. Caddy gehört bei der Umsetzung von VC-X-09 in dieselbe Liste.
- **VC-X-10 (Logging, Rate-Limit):** offen. Der Proxy schreibt kein Access-Log und begrenzt keine Rate. Ein Rate-Limit für `/api/v1` kommt erst, wenn der Dienst über das VPN hinaus erreichbar wird (Issue #281, Punkt 4; §47.1). Solange nur VPN-Peers zugreifen, bleibt es weg.
