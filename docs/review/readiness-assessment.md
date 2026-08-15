# Readiness Assessment — Vermieter Cockpit DE

**Bewertungsstand:** 2026-08-14  
**Prüfgegenstand:** produktiver Implementierungsstart für Roadmap Phase 0 und Phase 1; Phase 0 soll einen authentifizierten, leeren DE-Backend-Scaffold liefern, Phase 1 den MRE-Anker und das minimale Cash-Ledger (`docs/roadmap.md:37–60`).

## 1. VERDIKT: NICHT BEREIT

Phase 0 kann nur mit codefreien Gate-Arbeiten beginnen; produktiver Scaffold- und Phase-1-Code ist noch nicht freigegeben. Zwar sind die Architektur- und Technologiegrundlagen angenommen und die früheren ADR-Open-Punkte formal aufgelöst (`docs/architecture/architecture-decisions.md:1135–1584`), aber der erste Slice ist an implementierungsentscheidenden Stellen widersprüchlich oder unvollständig: Die Autoritätshierarchie ist nicht einheitlich (`docs/project-brief.md:14–23`; `docs/architecture/architecture-decisions.md:1784–1794`), die kanonische Terminologie wird in der Product Specification verletzt (`docs/product/product-specification.md:146–166`; `docs/product/product-specification.md:489–501`; `docs/glossary.md:1575–1594`), der Ledger lässt Vorzeichen- und Rundungssemantik offen (`docs/architecture/data-model.md:889–896`; `docs/architecture/data-model.md:974–980`), und Datenmodell/API verwenden für denselben FinancialAccount-Verweis verschiedene Feldnamen (`docs/architecture/data-model.md:859–868`; `docs/architecture/api-design.md:687–701`). Genau solche Konflikte und fehlenden Domänenfestlegungen lösen die Stop-Conditions aus (`AGENTS.md:793–816`).

## 2. EVIDENZ-TABELLE

| Kriterium | Ergebnis | Evidenz |
|---|---|---|
| **A — Konsistenz** | **nicht bestanden** | Brief und `AGENTS.md` ordnen Domain Model → Data Model → Glossar → API nach den ADRs ein (`docs/project-brief.md:14–23`; `AGENTS.md:38–47`), der ADR-Abschnitt schiebt dagegen Architecture Overview vor das Domain Model, Product Specification vor Implementierungsdoku und nennt Data Model, Glossar und API nicht (`docs/architecture/architecture-decisions.md:1784–1796`). Die Product Specification führt `units` und unqualifizierte `leases` als MRE-Verantwortung (`docs/product/product-specification.md:146–166`; `docs/product/product-specification.md:489–501`), obwohl der normative Lock `Unit` im MVP verbietet und `Lease Definition` verlangt (`docs/glossary.md:1575–1594`). Mehrere Revisionsverweise zeigen auf nicht vorhandene versionierte Dateien, etwa `domain-model-v0.3.md`, `data-model-v0.2.md`, `data-model-v0.3.md` und `glossary-v0.2.md` (`docs/architecture/domain-model.md:3–7`; `docs/architecture/data-model.md:3–7`; `docs/architecture/architecture-decisions.md:3–7`; `docs/glossary.md:3–7`). |
| **B — Entschiedenheit** | **bestanden** | ADR-026 sowie ADR-031–036 setzen modularen Monolithen, PostgreSQL, Node.js 20/TypeScript/Yarn, exaktes Money, MRE-Auth, DocumentStorage und separates Repo fest (`docs/project-brief.md:52–68`; `docs/architecture/architecture-decisions.md:1001–1019`; `docs/architecture/architecture-decisions.md:1135–1446`). ADR-037–042 sind `Accepted` (`docs/architecture/architecture-decisions.md:1450–1578`), und alle ADR-OPEN-001–010 tragen einen `Resolved by`-Status (`docs/architecture/architecture-decisions.md:1582–1754`). Es gibt damit keinen formal offenen Architektur-ADR, der Phase 0/1 blockiert (`docs/roadmap.md:155–168`). |
| **C — Umsetzbarkeit des ersten Schnitts** | **nicht bestanden** | Domäne, Datenmodell und API nennen PropertyReference, FinancialAccount, Transaction, ImportBatch und TransactionSplit (`docs/architecture/domain-model.md:536–771`; `docs/architecture/data-model.md:793–1123`; `docs/architecture/api-design.md:496–527`; `docs/architecture/api-design.md:628–798`). Der Vertrag ist trotzdem nicht implementierungsreif: Vorzeichenmodell und Rundungstoleranz sind offen (`docs/architecture/data-model.md:889–896`; `docs/architecture/data-model.md:974–980`), FinancialAccount-IDs heißen `accountId` versus `financialAccountId` (`docs/architecture/data-model.md:859–868`; `docs/architecture/api-design.md:689–701`), und die Import-Dublettenregel nennt nur mögliche Eingaben, während der exakte Algorithmus in die Implementierung verschoben wird (`docs/architecture/data-model.md:2910–2925`; `docs/product/workflows.md:474–487`). Das kollidiert mit der Stop-Condition gegen doppelte oder fabrizierte Cash Records (`AGENTS.md:793–808`). |
| **D — Leitplanken** | **teilweise bestanden** | Die `VERIFY`-Regeln sind ausdrücklich unbestätigt und dürfen nicht implementiert werden (`docs/germany/verification-checklist.md:10–23`; `docs/germany/verification-checklist.md:95–109`), liegen aber erst in Phasen 6–8; Phasen 0–5 werden auf Roadmap-Ebene als davon unberührt bezeichnet (`docs/roadmap.md:170–181`). PG-Schicht, Migration, Decimal-/Validation-Library und Test Runner sind keine offenen Architekturentscheidungen, müssen aber als Phase-0-Entscheidungen vor abhängigem Code dokumentiert werden (`docs/architecture/technology-adrs.md:546–593`; `docs/development/backlog.md:27–41`). Auth-Token-Propagation ist bewusst ein Scaffold-Spike gegen den gepinnten MRE-Stand (`docs/architecture/mre-integration.md:933–940`; `docs/architecture/api-design.md:2178–2197`). |
| **E — Prozessreife** | **teilweise bestanden** | Scaffold und Exit-Kriterien sind konkret geplant (`docs/development/backlog.md:27–41`), Coding-Guidelines definieren Modulgrenzen, Money, Migrationen, Invarianten und Tests (`docs/development/coding-guidelines.md:18–127`), und MRE-Contract-Tests sind beschrieben (`docs/architecture/api-design.md:1896–1923`; `docs/architecture/mre-integration.md:1094–1108`). Bei der Dateisystemprüfung war `.git` nicht vorhanden und `git rev-parse` meldete kein Worktree; das Backlog führt `git init` selbst noch als VC-0-01 (`docs/development/backlog.md:27–32`). Zudem fordert die Done-Regel, keine `.DS_Store`-Dateien einzuchecken (`AGENTS.md:888–904`), während die Dateisystemprüfung solche Dateien in Repo-Wurzel und `docs/` fand; `.gitignore` ignoriert sie lediglich (`.gitignore:1`). |

## 3. BLOCKIERENDE PROBLEME (müssen vor JEDEM produktiven Code behoben werden)

### P0.1 — Eine einzige Autoritätshierarchie festlegen

**Problem:** Die Hierarchie in Brief/`AGENTS.md` und die Hierarchie im ADR-Dokument unterscheiden sich materiell (`docs/project-brief.md:14–25`; `AGENTS.md:38–55`; `docs/architecture/architecture-decisions.md:1784–1796`). Damit ist bei einem Konflikt nicht eindeutig, ob etwa Architecture Overview oder Data Model/Glossar/API Vorrang hat; `AGENTS.md` verlangt für einen solchen Konflikt ausdrücklich Anhalten und Melden (`AGENTS.md:793–816`).

**Konkreter Fix:** Eine kanonische Reihenfolge als Accepted ADR oder als eindeutig normativen Verweis festlegen und dieselbe Liste wortgleich in Brief, `AGENTS.md`, ADR-Dokument und README verwenden; dabei die Sonderautorität von `mre-integration.md` für verifizierte MRE-Semantik explizit einordnen (`AGENTS.md:49–55`; `docs/project-brief.md:25`).

### P0.2 — Ledger-Vorzeichen und Rundungsinvariante normativ entscheiden

**Problem:** `Transaction` verlangt gleichzeitig `amount` und `direction`, erlaubt aber alternativ signed Money (`docs/architecture/data-model.md:859–896`). Das API-Beispiel nutzt einen positiven Betrag mit `INFLOW`, die Split-API dagegen negative Beträge (`docs/architecture/api-design.md:689–701`; `docs/architecture/api-design.md:735–751`). Gleichzeitig verweist die Split-Invariante auf eine nicht definierte Währungs-Rundungstoleranz (`docs/architecture/data-model.md:974–980`), obwohl die Coding-Guidelines behaupten, das Modell definiere exakte Sign-/Rundungsregeln (`docs/development/coding-guidelines.md:62–66`).

**Konkreter Fix:** Vor dem Money-/Transaction-Code genau eine Konvention akzeptieren und in Domain Model, Data Model und API synchronisieren: entweder Betrag stets nichtnegativ plus `direction`, oder signed Amount ohne redundante Richtung. Zusätzlich pro Währung die zulässige Skala, Rundungsart und die Split-Prüfung definieren; bei kanonisch gespeicherten Geldbeträgen sollte klar sein, ob Gleichheit exakt oder innerhalb welcher expliziten Minor-Unit-Toleranz gilt (`docs/architecture/technology.md:354–380`; `AGENTS.md:533–545`).

### P0.3 — Kanonische FinancialAccount-ID und vollständige Phase-1-DTOs festziehen

**Problem:** Das stabile Transaction-Modell verwendet `accountId`, das API-Beispiel `financialAccountId`, und ImportBatch führt erneut `accountId` (`docs/architecture/data-model.md:847–868`; `docs/architecture/data-model.md:1092–1121`; `docs/architecture/api-design.md:687–701`). Das widerspricht dem Terminologie-Lock, unqualifiziertes `Account` zu vermeiden (`docs/glossary.md:1655–1664`). Außerdem nennt `POST /financial-accounts` nur Endpunkt und mögliche Typen, aber keinen Request/Response-Vertrag (`docs/architecture/api-design.md:628–651`), und der Bankimport nennt weder Upload-/Mapping-DTO noch normiertes Row-Schema oder Fehlerantwort (`docs/architecture/api-design.md:706–723`), obwohl jeder öffentliche Endpunkt Inputs, Outputs, Fehler, Idempotenz und Seiteneffekte dokumentieren soll (`docs/architecture/api-design.md:1880–1892`).

**Konkreter Fix:** `financialAccountId` in Domain/Data/API als kanonisches FK-Feld festlegen oder eine andere eindeutige Benennung ausdrücklich normieren; danach für `POST /financial-accounts` und `POST /imports/bank-transactions` minimale Request-, Response-, Fehler-, Realm-, Idempotency- und Audit-Verträge ergänzen (`docs/architecture/api-design.md:2147–2156`).

### P0.4 — Dublettenidentität für den ersten CSV-Adapter spezifizieren

**Problem:** Re-Import muss keine doppelte kanonische Transaction erzeugen (`docs/project-brief.md:100–109`; `docs/product/workflows.md:505–507`), aber die Spezifikation nennt nur optionale Fingerprint-Bestandteile und verschiebt den Algorithmus (`docs/product/workflows.md:474–487`; `docs/architecture/data-model.md:2910–2925`). Ohne Identitätsregel ist nicht entscheidbar, ob zwei fachlich legitime gleiche Bankbewegungen Dubletten sind; stilles Mergen ist nur bei deterministischer Idempotency-Identität erlaubt (`docs/product/workflows.md:1513–1516`).

**Konkreter Fix:** Für den ersten konkreten CSV-Adapter eine versionierte Normalisierung und Priorität festlegen: stabile externe Transaktions-ID, andernfalls adapter-/quellengebundener Row-Fingerprint; Hash-Eingaben, Normalisierung, Account-/Realm-Scope, Retry-Verhalten, Kollision/Mehrdeutigkeit und „identische echte zweite Zahlung“ als Testfälle dokumentieren (`docs/development/backlog.md:55–60`; `AGENTS.md:596–608`).

### P0.5 — Git-Gate vor dem ersten Code erfüllen

**Problem:** Die Dateisystemprüfung fand weder `.git` noch einen umgebenden Worktree, obwohl ADR-036 ein separates Repository verlangt (`docs/architecture/architecture-decisions.md:1414–1428`) und Phase 0 mit `git init` beginnt (`docs/roadmap.md:37–43`; `docs/development/backlog.md:27–32`). Ohne Versionshistorie ist der erste Code nicht entsprechend der eigenen Scope-/Commit-Regeln nachvollziehbar (`docs/development/coding-guidelines.md:139–143`).

**Konkreter Fix:** `git init`, initialen reinen Spezifikationsstand committen, `.DS_Store` aus dem Arbeitsbaum entfernen und erst danach Code hinzufügen; die Done-Regel verbietet entsprechende Artefakte (`AGENTS.md:888–904`).

## 4. NICHT-BLOCKIERENDE PROBLEME (parallel behebbar)

1. **Veraltete Terminologie in der Product Specification:** `units`/`Units` und unqualifizierte `leases`/`Leases` müssen an `Property`, `Lease Definition` und `RentalContractReference` angepasst werden (`docs/product/product-specification.md:146–166`; `docs/product/product-specification.md:489–501`; `docs/glossary.md:1575–1594`). Der höherrangige Terminologie-Lock ist für Phase 1 bereits eindeutig, daher ist dies nach Bereinigung der Hierarchie kein eigener Domänenentscheid (`AGENTS.md:667–695`).

2. **Tote Revisionsverweise:** Die Header referenzieren nicht vorhandene versionierte Dateinamen (`docs/architecture/domain-model.md:3–7`; `docs/architecture/data-model.md:3–7`; `docs/architecture/architecture-decisions.md:3–7`; `docs/glossary.md:3–7`). Die Verweise sollten auf die tatsächlichen kanonischen Dateien zeigen oder als historische Versionsbezeichnungen ohne Pfadsyntax kenntlich gemacht werden (`AGENTS.md:888–904`).

3. **Historische Open-Abschnitte lesen sich weiterhin offen:** Der ADR-Open-Abschnitt deklariert alle Einträge als gelöst (`docs/architecture/architecture-decisions.md:1582–1590`), enthält aber weiter Formulierungen wie „Still open“ (`docs/architecture/architecture-decisions.md:1642–1666`; `docs/architecture/architecture-decisions.md:1670–1687`). Status und Resolution sind formal eindeutig, doch die historische Frage sollte als solche markiert oder eingeklappt werden, damit keine akzeptierte Wahl irrtümlich neu geöffnet wird (`docs/architecture/architecture-decisions.md:1800–1825`).

4. **Andere Dokumente enthalten bereits gelöste Open-Punkte:** `mre-integration.md` führt Shared Authentication und Document Storage weiter unter „Open Integration Decisions“ (`docs/architecture/mre-integration.md:1125–1158`), obwohl ADR-034/035 die Richtung bzw. Architektur akzeptieren (`docs/architecture/architecture-decisions.md:1291–1336`; `docs/architecture/architecture-decisions.md:1340–1391`). Die verbleibende Token-Propagation ist korrekt als Phase-0-Spike zu kennzeichnen, Document Storage dagegen als gelöst (`docs/architecture/mre-integration.md:933–940`).

5. **Implementierungsbibliotheken fehlen noch:** PG-Zugriff, Migration, Decimal, Validation und Test Runner sind noch nicht ausgewählt (`docs/development/coding-guidelines.md:18–26`). Das ist zulässige Phase-0-Arbeit, muss aber vor dem jeweils abhängigen Scaffold/Money-Code dokumentiert werden (`docs/development/backlog.md:31–35`; `docs/architecture/technology-adrs.md:546–593`).

6. **Deutschland-Verifikation bleibt ein späteres Gate:** Alle Fachregeln bleiben bis zur Bestätigung `VERIFY` und dürfen nicht implementiert werden (`docs/germany/verification-checklist.md:10–23`; `docs/germany/verification-checklist.md:107–109`). Sie blockieren Phase 0/1 nicht, weil die Roadmap sie ausdrücklich Phasen 6–8 zuordnet (`docs/roadmap.md:96–124`; `docs/roadmap.md:170–181`).

7. **Lizenzdatei/Projektlizenz:** Das Backlog markiert die Lizenz noch als unentschieden (`docs/development/backlog.md:90–100`). Das blockiert die interne Phase-0/1-Implementierung nicht, sollte aber vor externer Veröffentlichung geklärt werden; die Constitution verlangt Open Source und offene, migrierbare Daten (`docs/constitution.md:187–203`; `docs/constitution.md:26–38`).

## 5. KONKRET: Können Phase 0 und Phase 1 JETZT starten?

### Phase 0

**Nur codefreie Gate-Arbeit kann jetzt starten; produktiver Scaffold-Code noch nicht.** Sofort zulässig sind `git init`, die Dokumentbereinigungen, die Bibliotheksauswahl und der Auth-/MRE-Contract-Spike, denn genau diese Punkte sind als Phase-0-Aufgaben vorgesehen (`docs/development/backlog.md:27–41`; `docs/architecture/mre-integration.md:933–940`). Der TypeScript-/HTTP-Scaffold und das Money-Objekt warten auf P0.1–P0.5, insbesondere auf Hierarchie-, Feldnamen- und Vorzeichen-/Rundungsentscheid (`AGENTS.md:793–816`; `docs/development/backlog.md:34–35`).

### Phase 1

**Nein.** Die sieben geforderten Kommandos sind wie folgt abgedeckt:

| Phase-1-Kommando | Domain Model | Data Model | API Design | Ergebnis |
|---|---|---|---|---|
| `POST /property-references/link` | PropertyReference als DE-Repräsentation mit Realm-/MRE-Identität (`docs/architecture/domain-model.md:190–218`) | Required Fields sind definiert (`docs/architecture/data-model.md:467–505`) | Request und Verhalten sind definiert (`docs/architecture/api-design.md:496–527`) | **ausreichend**, sobald Auth-Spike und Hierarchie-Gate erledigt sind (`docs/architecture/mre-integration.md:923–940`). |
| `POST /financial-accounts` | Bedeutung und Abgrenzung zu MRE Account/Loan sind definiert (`docs/architecture/domain-model.md:753–771`) | Kernfelder und Invarianten sind definiert (`docs/architecture/data-model.md:793–843`) | Nur Route und mögliche Typen, kein DTO/Fehlervertrag (`docs/architecture/api-design.md:628–651`) | **nicht ausreichend**. |
| `POST /transactions` | Cash-only Transaction, Provenienz und Status sind definiert (`docs/architecture/domain-model.md:536–626`) | Felder vorhanden, Vorzeichenkonvention offen (`docs/architecture/data-model.md:847–934`) | Beispielrequest vorhanden (`docs/architecture/api-design.md:679–702`) | **nicht ausreichend** wegen `accountId`/`financialAccountId` und Sign-Semantik (`docs/architecture/data-model.md:859–896`; `docs/architecture/api-design.md:689–700`). |
| `POST /imports/bank-transactions` | Import-Idempotenz ist als Pflicht formuliert (`docs/architecture/domain-model.md:2063–2073`) | ImportBatch vorhanden, Algorithmus offen (`docs/architecture/data-model.md:1092–1123`; `docs/architecture/data-model.md:2910–2925`) | Route und Verantwortungen, aber kein Upload-/Row-/Fehlervertrag (`docs/architecture/api-design.md:706–723`) | **nicht ausreichend**. |
| `PUT /transactions/{id}/splits` | Split-Aggregat und Summeninvariante sind definiert (`docs/architecture/domain-model.md:630–687`) | Felder und Invariante sind definiert, Toleranz nicht (`docs/architecture/data-model.md:938–982`) | Request und atomisches Ersetzen sind definiert (`docs/architecture/api-design.md:727–754`) | **nicht ausreichend** bis Sign/Skala/Rundung normativ sind. |
| `POST /transactions/{id}/confirm` | Bestätigung trennt unsichere von autoritativer Finanzinformation (`docs/architecture/domain-model.md:608–626`) | Lifecycle und vollständige Split-Abdeckung sind genannt (`docs/architecture/data-model.md:900–934`) | Validierung und Resultat sind genannt (`docs/architecture/api-design.md:758–775`) | **teilweise**; konkrete zulässige Zustandsübergänge bleiben als „precise workflow“ offen (`docs/architecture/domain-model.md:608–626`). |
| `POST /transactions/{id}/correct` | `Correction` ist nur abstrakt beschrieben (`docs/architecture/domain-model.md:1673–1679`) | Ein einzelnes `correctionOfTransactionId` und die allgemeine Reversal-Aussage existieren (`docs/architecture/data-model.md:872–885`; `docs/architecture/data-model.md:2790–2810`) | ADR-037-Verhalten und ein partieller Replacement-Request sind beschrieben (`docs/architecture/api-design.md:779–798`) | **teilweise**; Reversal/Replacement-Rollen, Verkettungsinvarianten und Auswirkung auf Splits/Bestätigungsstatus fehlen. Das Kommando kann alternativ ausdrücklich aus Phase 1 herausgenommen und als Fast-follow gegated werden, wie die Roadmap bereits erlaubt (`docs/roadmap.md:58–60`). |

### Kleinster nötiger Schritt zur Freigabe

Ein einzelner, reiner **Readiness-Fix** ohne Anwendungscode genügt, wenn er folgende fünf Ergebnisse liefert:

1. eine einheitliche Autoritätshierarchie und bereinigte kanonische Terminologie (`AGENTS.md:38–55`; `docs/glossary.md:1575–1594`);
2. eine angenommene Money-/Direction-/Split-Rundungsregel (`docs/architecture/data-model.md:889–896`; `docs/architecture/data-model.md:974–980`);
3. `financialAccountId`-Konsistenz und minimale DTO-/Fehlerverträge für FinancialAccount und Bankimport (`docs/architecture/api-design.md:628–723`; `docs/architecture/api-design.md:1880–1892`);
4. eine testbare Idempotenzidentität für den ersten CSV-Adapter (`docs/product/workflows.md:474–507`; `docs/product/workflows.md:1513–1516`);
5. entweder ein vollständiger Correct-Command-Vertrag oder die explizite Verschiebung aus dem Phase-1-Exit sowie ein initialisiertes Git-Repository (`docs/roadmap.md:58–60`; `docs/development/backlog.md:27–32`).

Nach diesem Fix kann Phase 0 mit den bereits geplanten Scaffold-, Money-, Auth- und Contract-Test-Aufgaben beginnen (`docs/development/backlog.md:31–41`); Phase 1 wird erst nach erfolgreichem Phase-0-Exit gestartet (`docs/roadmap.md:37–58`).

## 6. KONFIDENZ + was nicht verifiziert wurde

**Konfidenz: hoch (0,90) für das Readiness-Verdikt.** Die Bewertung folgt der dokumentierten Autoritätsordnung, soweit diese übereinstimmt, und behandelt verbleibende Konflikte selbst als Gate (`docs/project-brief.md:10–25`; `AGENTS.md:34–55`; `AGENTS.md:793–816`). Alle angeforderten Kernbereiche wurden gegen ADR-, Domain-, Data-, API-, Integration-, Technologie-, Produkt-, Roadmap-, Entwicklungs- und Germany-Dokumente abgeglichen (`AGENTS.md:34–121`).

Nicht verifiziert wurden:

- **Upstream-MRE-Code und laufende MRE-Instanz:** Es wurde kein externes MRE-Repository ausgecheckt oder gestartet; die Bewertung verwendet ausschließlich den dokumentierten Referenzstand `479d0ad…` und die dort festgehaltene `/api/v2`-Semantik (`docs/architecture/mre-integration.md:1–20`; `docs/architecture/mre-integration.md:62–80`). Der Phase-0-Contract-Test bleibt deshalb real auszuführen (`docs/development/backlog.md:36–40`).
- **Aktuelle deutsche Rechts-/Steuerlage:** Kein `VERIFY`-Punkt wurde fachlich bestätigt; die Checkliste verlangt diese Bestätigung vor Implementierung der betroffenen Regeln (`docs/germany/verification-checklist.md:10–23`; `docs/germany/verification-checklist.md:107–109`).
- **Build, Tests, Migrationen und Container:** Es gibt noch keinen implementierten Scaffold; deren erfolgreiche Ausführung ist erst Exit-Bedingung von Phase 0 (`docs/roadmap.md:37–50`; `docs/development/backlog.md:31–41`).
- **Produktionsbetrieb, Security-Härtung und Performance:** Die vorliegende API-Spezifikation fordert Realm-Isolation und Command-Tests, liefert aber noch keine laufende Implementierung, an der diese Eigenschaften geprüft werden könnten (`docs/architecture/api-design.md:228–240`; `docs/architecture/api-design.md:1896–1923`).
