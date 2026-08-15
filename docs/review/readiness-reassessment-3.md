# Bestätigungs-Review der Readiness — Vermieter Cockpit DE

**Bewertungsstand:** 2026-08-14  
**Prüfgegenstand:** gezielte Nur-Lesen-Prüfung des `needs_review`-Fixes nach drei vorherigen Bewertungen mit dem Verdikt `NICHT BEREIT` (`docs/review/readiness-assessment.md:6`; `docs/review/readiness-reassessment.md:6`; `docs/review/readiness-reassessment-2.md:6`).

## 1. VERDIKT: NICHT BEREIT

Gegenüber der dritten Bewertung ist der neue Importpfad fachlich deutlich vollständiger: Data Model, Importantwort und Workflow verwenden nun dieselbe Outcome-Menge; `needsReviewCount`, der `NEEDS_REVIEW`-Batchzustand, der `CREATE|SKIP`-Entscheid und die benötigten Tests sind beschrieben (`docs/architecture/data-model.md:1119-1137`; `docs/architecture/data-model.md:2956-2975`; `docs/architecture/api-design.md:757-796`; `docs/product/workflows.md:421-511`; `docs/development/backlog.md:56-60`). Der Slice bleibt dennoch nicht bereit: API und Workflow führen einen `reviewItemId`-adressierbaren Resolve- und List-Pfad ein, doch das Data Model modelliert keinen `ImportReviewItem` mit Identität, Pending/Resolved-Zustand oder gespeicherter Auflösung; es beschreibt nur namenlose „pending review items“ mit Nutzdaten (`docs/architecture/api-design.md:746-796`; `docs/product/workflows.md:471-483`; `docs/architecture/data-model.md:1099-1137`; `docs/architecture/data-model.md:2956-2975`). Zusätzlich fehlt dem gelisteten `GET …/review-items`-Endpoint ein Vertrag und weder Importantwort noch Datenmodell liefert eine `reviewItemId` zum Aufruf von `resolve` (`docs/architecture/api-design.md:746-782`; `docs/architecture/api-design.md:784-796`). Die Speicherung eines neuen Review-Items, seiner eindeutigen Identität und einer idempotenten Auflösung müsste daher erfunden werden; das ist eine Stop Condition für ein nicht modelliertes Domänenkonzept und einen retrybaren Cash-Write-Flow (`AGENTS.md:595-607`; `AGENTS.md:792-806`).

## 2. STATUS-TABELLE

| Punkt | Status | Verifizierte Evidenz |
|---|---|---|
| **P0.1 — Ergebnisraum** | **geschlossen** | Data Model und Importantwort nennen jeweils exakt `created` / `duplicate` / `needs_review` / `error` (`docs/architecture/data-model.md:1131-1137`; `docs/architecture/api-design.md:779-782`). Das Workflow-Diagramm deckt `duplicate`, `ambiguous` und `new` ab; der Ambiguitätsfall wird textlich als `needs_review` konkretisiert (`docs/product/workflows.md:421-483`; `docs/product/workflows.md:509-511`). Eine aktive Outcome-Liste ohne `needs_review` wurde in den geprüften Importdokumenten nicht gefunden. |
| **P0.2 — ImportBatch-Zähler und -Status** | **geschlossen** | `ImportBatch` enthält `needsReviewCount`; bei offenen Fällen ist der Batch nicht geschlossen und trägt einen die Ambiguität widerspiegelnden Status wie `NEEDS_REVIEW` (`docs/architecture/data-model.md:1119-1137`). API und Workflow geben Zähler beziehungsweise offenen Batchstatus konsistent wieder (`docs/architecture/api-design.md:779-782`; `docs/product/workflows.md:509-511`). |
| **P0.3 — Kein Cash vor menschlicher Entscheidung** | **geschlossen** | Ein `needs_review`-Datensatz erzeugt keine Transaction; nur `CREATE` erzeugt genau eine `IMPORTED`-Transaction, `SKIP` keine; automatisches Mergen und Duplizieren sind ausgeschlossen (`docs/architecture/data-model.md:2956-2975`; `docs/architecture/api-design.md:781-796`; `docs/product/workflows.md:433-448`; `docs/product/workflows.md:509-511`). |
| **P0.4 — Resolve-Vertrag** | **teilweise** | Der API-Text enthält für `POST …/resolve` Domain Owner, Realm-Auth, `CREATE|SKIP`, Output, Fehler, No-op-/409-Idempotenz und Seiteneffekte (`docs/architecture/api-design.md:784-796`). Der Pfad verlangt aber `reviewItemId`, während das Datenmodell die Review-Items weder als Entity/Child mit `id` noch mit Pending/Resolved-/Resolution-Zustand führt; die vorhandene Beschreibung nennt nur Inhalt und beabsichtigte Aktion (`docs/architecture/api-design.md:751-752`; `docs/architecture/api-design.md:787-796`; `docs/architecture/data-model.md:1099-1137`). Damit kann dieselbe Resolution nicht anhand kanonisch gespeicherter Item-Semantik nachgewiesen idempotent sein. |
| **P0.5 — Workflow und Pflichtfälle** | **teilweise** | Der dritte Workflow-Ast `ambiguous → needs_review → CREATE|SKIP` und die vier angeforderten Pflichtfälle sind vorhanden (`docs/product/workflows.md:421-483`; `docs/architecture/data-model.md:2964-2975`; `docs/development/backlog.md:56-60`). Weil ein Review-Item keine modellierte ID und keinen Auflösungszustand besitzt, sind die Resolve-Testfälle noch nicht gegen ein bestimmtes kanonisches Objekt formulierbar (`docs/architecture/data-model.md:1131-1137`; `docs/architecture/api-design.md:793-796`). |
| **P0.6 — Konsistenz zwischen Data/API/Workflow/Backlog** | **teilweise** | Cash-Semantik und No-Auto-Merge-Regel stimmen überein (`docs/architecture/data-model.md:2958-2975`; `docs/architecture/api-design.md:779-782`; `docs/product/workflows.md:487-511`; `docs/development/backlog.md:56-60`). Der API-Pfad nutzt `{reviewItemId}`, der Backlog dagegen `{id}`, und die vom Workflow gelistete Leseoperation hat keinen API-Vertrag (`docs/architecture/api-design.md:746-796`; `docs/product/workflows.md:471-483`; `docs/development/backlog.md:57`). |
| **P1.7 — Queryname** | **geschlossen** | Aktiv heißt die Query `getReviewableTransactions()` mit dem Filter `IMPORTED|UNREVIEWED`; `getUnreviewedTransactions()` erscheint nur als ausdrücklich abgelöster Name (`docs/product/workflows.md:471-483`). |

## 3. NEUE PROBLEME / REGRESSIONEN

### P0 — `ImportReviewItem` ist kein modelliertes, adressierbares Objekt

**Problem:** Die Resolve-Route ist über `{reviewItemId}` adressierbar und verspricht, dieselbe bereits entschiedene Auflösung als No-op wiederzuerkennen (`docs/architecture/api-design.md:751-752`; `docs/architecture/api-design.md:787-796`). Das Datenmodell kennt jedoch nur anonyme, auf einem Batch „retained“ Review-Items samt normalisierter Zeile, Grund und Konflikt-Transaction; eine ID, ein `PENDING|RESOLVED`-Status, der gespeicherte `CREATE|SKIP`-Entscheid, Entscheider/Zeitpunkt und die resultierende Transaction fehlen (`docs/architecture/data-model.md:1099-1137`; `docs/architecture/data-model.md:2961-2962`). Die API-Importantwort gibt bei `needs_review` nur Konflikt-Transactions an, aber keine `reviewItemId`, sodass der Resolve-Aufruf auch daraus nicht adressierbar ist (`docs/architecture/api-design.md:779-782`; `docs/architecture/api-design.md:784-796`).

**Konkreter Fix:** Unter `ImportBatch` einen expliziten Child-Record `ImportReviewItem` normieren: mindestens `id`/`reviewItemId`, `importBatchId`, Realm-Zuordnung, die normalisierte Quellzeile, Ambiguitätsgrund, `conflictingTransactionIds`, `status` (`PENDING|RESOLVED`), optionale `resolution` (`CREATE|SKIP`), Auflösungs-Akteur/-Zeitpunkt und bei `CREATE` `createdTransactionId`. Eine Eindeutigkeitsregel muss verhindern, dass derselbe ambige Quellzeilenfall bei Retry zwei Pending-Items erzeugt. Ergänze `reviewItemId` im `needs_review`-Response und einen vollständigen `GET /api/v1/imports/{importBatchId}/review-items`-Vertrag mit Realm-Auth, Output, Fehlern, read-only Seiteneffekt und Domain Owner; gleiche den Backlog-Pfad auf `{reviewItemId}` an (`docs/architecture/api-design.md:746-796`; `docs/architecture/api-design.md:1962-1974`; `AGENTS.md:595-607`).

### P1 — Route-Parameter im Backlog nicht kanonisch

**Problem:** Der Backlog spricht bei VC-1-06a von `{id}`, während die API explizit `{reviewItemId}` verwendet (`docs/development/backlog.md:57`; `docs/architecture/api-design.md:751-752`).

**Konkreter Fix:** Backlog und alle künftigen Query-/Testbezeichnungen auf `reviewItemId` vereinheitlichen. Dies ist allein kein Slice-Blocker, gehört aber in denselben Fix wie das neue Data-Model-Child.

### P2 — Bekannter ungültiger JSON-Platzhalter

Das Response-Envelope-Beispiel ist weiterhin kein valides JSON, weil nach dem `id`-Feld ein wertloser String steht (`docs/architecture/api-design.md:259-270`). Die FinancialAccount- und Import-Request-Beispiele des Slice sind davon getrennt (`docs/architecture/api-design.md:665-675`; `docs/architecture/api-design.md:763-778`). Das ist redaktionell, kein eigenständiger Slice-Blocker.

### Keine Rückschritte bei zuvor geschlossenen Punkten

- Das Money-Modell bleibt nichtnegativ plus verpflichtender `direction`; Split-Gleichheit bleibt exakt ohne Toleranz (`docs/architecture/data-model.md:889-899`; `docs/architecture/data-model.md:978-987`). Importierte Transactions treten weiterhin als `IMPORTED` ein (`docs/architecture/domain-model.md:611-629`; `docs/architecture/api-design.md:757-782`).
- FinancialAccount-DTO und die Idempotenz-/Fehlersemantik für Property-Link, FinancialAccount, manuelle Transaction und Confirm bleiben konsistent (`docs/architecture/api-design.md:530-538`; `docs/architecture/api-design.md:660-678`; `docs/architecture/api-design.md:733-742`; `docs/architecture/api-design.md:848-857`).
- `correct` bleibt gegateter Fast-follow außerhalb des Phase-1-Exit; DE-Property-Routen und das Git-Gate bleiben normiert (`docs/roadmap.md:50-62`; `docs/roadmap.md:161-167`; `docs/development/backlog.md:31-35`; `docs/development/backlog.md:63-67`; `docs/architecture/api-design.md:470-501`; `docs/architecture/api-design.md:861-880`).
- Die vier Autoritätslisten sind weiterhin zeichenidentisch; die MRE-Sonderautorität bleibt unter Constitution und Accepted ADRs (`docs/project-brief.md:16-28`; `AGENTS.md:40-54`; `README.md:192-204`; `docs/architecture/architecture-decisions.md:1788-1800`).

## 4. Sind damit alle inhaltlichen Slice-Blocker geschlossen?

**Nein.** Das neue `needs_review`-Verhalten ist zwar als Geschäftsregel geschlossen, sein persistierbares und über die API adressierbares Objekt fehlt. Das betrifft gerade den Pfad, der entscheiden soll, ob ein Cash Record entsteht, und darf nicht der Implementierung überlassen werden (`docs/architecture/data-model.md:1131-1137`; `docs/architecture/api-design.md:779-796`; `AGENTS.md:792-806`). Git-Init, Library-Wahlen, MRE-Auth-Spike und `germany`-`VERIFY` liegen danach beziehungsweise außerhalb des ersten Slice (`docs/roadmap.md:50-52`; `docs/architecture/technology-adrs.md:546-593`; `docs/architecture/mre-integration.md:933-939`; `docs/germany/verification-checklist.md:10-23`; `docs/germany/verification-checklist.md:107-109`). Der P2-JSON-Platzhalter bleibt redaktionell und blockiert den Slice nicht (`docs/architecture/api-design.md:259-270`).

## 5. KONKRET: Können Phase 0 und Phase 1 jetzt starten?

**Nein.** Das dokumentierte Git-Gate erlaubt `git init` erst nach vollständiger Dokumentations-Readiness; davor darf kein produktiver Phase-0-Code entstehen (`docs/roadmap.md:50-52`; `docs/development/backlog.md:31-41`). Phase 1 kann den Import-/Resolve-Slice nicht implementieren, solange `reviewItemId` und Auflösungszustand kein Teil des kanonischen Modells sind (`docs/architecture/data-model.md:1099-1137`; `docs/architecture/api-design.md:784-796`; `AGENTS.md:792-806`).

**Kleinster Freigabeschritt:** nur den P0-Fix aus §3 durchführen und anschließend unabhängig nachprüfen. Danach sind die ersten fünf Schritte: (1) `git init` und Spezifikations-Initial-Commit, (2) Phase-0-Library-Entscheidungen dokumentieren, (3) TypeScript-/Modul-Scaffold, (4) Money über `NUMERIC` mit Exaktheitstests, (5) MRE-Auth-Adapter plus Contract-Test gegen den gepinnten MRE-Stand (`docs/roadmap.md:41-52`; `docs/development/backlog.md:31-41`; `docs/architecture/mre-integration.md:933-939`). Phase 1 folgt nach bestandenem Phase-0-Exit (`docs/roadmap.md:52-62`).

## 6. KONFIDENZ + was NICHT verifiziert wurde

**Konfidenz: hoch (0,94).** Der verbleibende Befund folgt unmittelbar aus der Diskrepanz zwischen API-Pfad/Idempotenzversprechen und dem nicht vorhandenen kanonischen Review-Item-Modell, nicht aus MRE- oder Rechtsannahmen (`docs/architecture/api-design.md:746-796`; `docs/architecture/data-model.md:1099-1137`; `AGENTS.md:792-806`).

Nicht verifiziert wurden:

- **MRE-Laufzeit und Contract-Tests:** Auth-Propagation und der reale Upstream-Vertrag bleiben Phase-0-Spike bzw. Contract-Test (`docs/architecture/mre-integration.md:933-939`; `docs/development/backlog.md:36-39`; `docs/architecture/mre-integration.md:1094-1108`).
- **Library-Wahl, Build, Migrationen und Container:** Diese sind geplante Phase-0-Entscheidungen/Exit-Nachweise, kein geprüfter Ist-Zustand (`docs/architecture/technology-adrs.md:546-593`; `docs/development/backlog.md:31-41`).
- **Deutsches Recht/Steuerrecht:** `VERIFY` bleibt unbestätigt und darf nicht implementiert werden (`docs/germany/verification-checklist.md:10-23`; `docs/germany/verification-checklist.md:107-109`).
- **Historische Byte-Identität der drei Vorgängerreviews:** Ohne Versionshistorie ist kein vollständiger Vorher/Nachher-Diff beweisbar. Die aktuellen drei Dateien tragen weiterhin jeweils das frühere `NICHT BEREIT`-Verdikt (`docs/review/readiness-assessment.md:6`; `docs/review/readiness-reassessment.md:6`; `docs/review/readiness-reassessment-2.md:6`).

**Fix-Grenzen:** Diese Bestätigungs-Review hat ausschließlich diese neue Datei angelegt. Sie hat keinen Anwendungscode, Scaffold oder Konfiguration erzeugt, keine Spezifikation oder vorherige Review-Datei verändert, keine Library gewählt, keine `VERIFY`-/Rechtsregel geprüft und keinen Git-Befehl ausgeführt.
