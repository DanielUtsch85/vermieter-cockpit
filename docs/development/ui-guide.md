> **Status (30.10.2026): Entwurf zur Übergabe, noch nicht übergeben.**
> Der Leitfaden wurde gegen den Referenzstand dd110b9 geprüft; seine Aussagen zu vorhandenen Routen, Lücken und Limits treffen zu. Vor der Übergabe an ein Frontend-Team ging es um drei Dinge; offen ist nur noch Punkt 3:
>
> 1. **Backend-Voraussetzungen:** erledigt. Die Lese-Endpunkte für FinancialAccounts und PropertyReferences (#160, mit #162 und #165; `docs/architecture/api-design.md` §23.3 und §29.3) sowie der Token-Verifikations-Cache und der Sitzungsvertrag für Clients (#161, mit #163; `docs/architecture/mre-integration.md` §47.1 und §47.2).
> 2. **Entscheidungen des Projektinhabers:** am 30.10.2026 getroffen und in Abschnitt 7.1, 7.2, 11 und 13 eingetragen: gemeinsame Origin hinter einem Reverse-Proxy, eigene App im Monorepo mit dem MRE-Stack, Version 1 auf die drei P0-Bereiche begrenzt, Import ohne Vorschau, kein Audit-Verlauf in Version 1.
> 3. **Beilagen:** `design-tokens.css` und das Routeninventar liegen nicht im Repository. Das Inventar sollte aus `services/de-backend/src/api/app.ts` erzeugt werden, nicht von Hand gepflegt; `main` entwickelt sich schneller als eine statische Liste.
>
> Die in Abschnitt 9 genannten HTML-Entwürfe sind die Canvas-Skizzen vom 29.10.2026; sie sind Gestaltungsskizzen, keine Spezifikation.

# Vermieter Cockpit DE – Leitfaden für die erste Benutzeroberfläche

**Übergabe an Entwicklung und Design · Version 1.0 · 30.10.2026**

**Referenzstand:** [dd110b9](https://github.com/DanielUtsch85/vermieter-cockpit/commit/dd110b90f9da6680ffcb22a79323d6350021449d)  
**Geltung:** vorhandene DE-API für Phasen 0–6. Phase 7 ist zu diesem Stand spezifiziert, aber noch nicht als HTTP-Routen implementiert.  
**Ziel:** eine verständliche Oberfläche auf vorhandenen Datenstrukturen und Fachbefehlen aufbauen, ohne diese für das Layout umzubauen.

## 1. Entscheidung für den Projektstart

Die Oberfläche ist ein Client der Fach-API, keine zweite Fachanwendung. Sie formatiert, erklärt, navigiert und führt ausdrücklich ausgelöste Befehle aus. Geldberechnung, Verteilung, steuerliche Regeln und erlaubte Zustandswechsel bleiben im Backend.

**Eine vollständige Oberfläche ganz ohne Ergänzungen lässt sich zum geprüften Stand nicht zusagen.** Die Fachabläufe sind weitgehend verfügbar; wichtige Einstiegspunkte zum Wiederfinden von Konten und Objekten fehlen. Diese Lücken dürfen nicht durch lokale Schattenverzeichnisse oder erfundene Endpunkte verdeckt werden.

Empfohlene Entscheidung:

1. Vor dem ersten Sprint die MRE-Sitzungsintegration sowie die verlässliche Auswahl von Konto und Objekt klären.
2. Zunächst vorhandene Listen und Fachabläufe umsetzen: Buchungen, Importergebnis, Mietabgleich, Darlehen, Kautionen, WEG.
3. Die Startseite als Arbeitsnavigation beginnen. Portfolio-Kennzahlen, globale Suche, Benachrichtigungszentrale und vorgelagerte fachliche Importvorschau zurückstellen.
4. Falls die Auswahl von Konten/Objekten mit dem vorhandenen MRE-Kontext nicht abgedeckt werden kann, eine kleine additive Lese-API gesondert beschließen. Keine Änderung an Finanzinvarianten, Entitätsnamen oder Persistenz allein für ein UI.

Die bisherigen Bilder und HTML-Dateien sind **Gestaltungsskizzen**. Dieser Leitfaden korrigiert ihre technischen Annahmen. Insbesondere sind Importvorschau, globale Kennzahlen, vollständige Änderungsverläufe, Dokument-Uploads und globale Suche keine automatisch vorhandenen Backend-Funktionen.

## 2. Quellen und Verbindlichkeit

- Verfassung und akzeptierte Architekturentscheidungen bleiben maßgeblich.
- Die ausführlichen Verträge stehen in docs/architecture/api-design.md.
- Tatsächlich verfügbare Routen und Payload-Formate wurden in src/api geprüft; ihre Registrierung wurde mit src/api/app.ts abgeglichen.
- Authentifizierung: docs/architecture/mre-integration.md §47.1.
- Frontend-Ausrichtung: docs/architecture/technology.md §7.
- Eingaben und Versionierung: src/api/validation.ts.
- Transaktions-DTO und Filter: src/api/transaction-dto.ts.
- Gemeinsame Fehler: src/api/error-answers.ts.
- Das beiliegende API-INVENTAR.csv/.json listet implementierte Routen am Referenzstand, **nicht** geplante Routen aus der Spezifikation. Es ist kein OpenAPI-Schema.

Bei einem Widerspruch nicht stillschweigend ein UI-Verhalten erfinden: Fundstelle dokumentieren, Vertragsfrage klären und erst dann anbinden. Nach neuem Backend-Stand Routen und DTOs erneut prüfen; ein alter Prototyp ist keine API-Spezifikation.

## 3. Informationsarchitektur und Einstieg

### 3.1 Navigation

| Navigation | Inhalt | Startpriorität |
|---|---|---|
| Übersicht | Arbeitsnavigation, Datum, Verbindungskontext, Links zu vorhandenen Listen | P1, ohne erfundene Kennzahlen |
| Buchungen | Liste, Detail, Aufteilung, Bestätigung, Korrektur | P0 |
| Import | Datei/Konto wählen, Import ausführen, Ergebnis und Klärfälle | P0 |
| Mietabgleich | Vorschläge, bestätigte Zuordnungen, Abdeckung, Übertragung und Entfernung | P0 |
| Finanzierung | Darlehen, Konditionen, Plan, Ist-Restschuld, Objektzuordnung | P1 |
| Kautionen | Erwartet/erhalten/gehalten/zurückgezahlt, Abschluss | P1 |
| WEG | WEG, Mitgliedschaften, Wirtschaftsplan, Jahresabrechnung, Sonderumlagen | P1 |
| Personen | Personen/Organisationen, Kontaktangaben, MRE-Referenzen | P1 |
| Objekte | MRE-Verknüpfung und kontextbezogene Fachansichten | P1, Einstiegslücke beachten |
| Erwerbe | Erwerb, Nebenkosten, Zahlungslinks, Eigentümerverteilung | P1 |

**Entscheidung (30.10.2026):** Version 1 umfasst genau die P0-Zeilen, Buchungen, Import und Mietabgleich, als durchgehender Ablauf gegen die echte API, dazu die Übersicht als Arbeitsnavigation. Die P1-Zeilen folgen danach in der Reihenfolge Finanzierung, Kautionen, WEG, Erwerbe, Personen, Objekte. Menüpunkte für P1 erscheinen erst, wenn ihr Bereich fertig ist.

Keine aktiven Menüpunkte für Steuern, AfA oder Investment ohne implementierte Routen. Späteres Modul höchstens in der Produktplanung nennen, nicht mit einem scheinbar funktionierenden Leerformular veröffentlichen.

### 3.2 App-Shell

- Links konstante Navigation; oben aktueller Realm/Bestand, Seitentitel und Sitzungsstatus.
- Die Auswahl eines Bestandes ist ein Wechsel des Berechtigungskontexts, kein einfacher Tabellenfilter.
- Unterseiten mit Breadcrumbs: Finanzierung → Darlehen → Konditionen.
- Listenfilter und Seitennummern in der URL ablegen; keine Tokens, IBANs oder freien Verwendungszwecke in URLs.
- Deep Links nutzen stabile DE-IDs. Datumsangaben und Auswahlkontext müssen beim Teilen reproduzierbar sein.
- Rollen im UI aus der geprüften Identität ableiten. Eine Party als Eigentümer ist **keine** Anmelderolle.
- Globale Suche und Glocke erst implementieren, wenn es einen definierten Datenweg gibt. Keine funktionslosen Zier-Controls.

### 3.3 Grenzen der Zusammenstellung

Mehrere existierende Detailabfragen können eine Seite füllen. Daraus entsteht aber kein gemeinsamer Datenbank-Snapshot. Die UI darf verschiedene Ladezeitpunkte nicht als atomaren Gesamtstand darstellen. Kennzahlen mit Datum/Zeitraum und Herkunft beschriften; nach Mutationen betroffene Karten neu laden.

Keine komplette Mandantenhistorie bei jedem Seitenaufruf herunterladen, um fehlende Portfolio-Abfragen zu ersetzen. Eine Liste zeigt serverseitig gefilterte Ergebnisse; lokale Suche ist nur dann zulässig, wenn sie ausdrücklich „auf dieser Seite“ heißt.

## 4. Style Guide

### 4.1 Visuelle Richtung

Ruhige Arbeitsoberfläche für private Vermieter: helle Flächen, klare Tabellen, wenig Dekoration. Vertrauen entsteht durch nachvollziehbare Zahlen, erkennbare Quellen und eindeutige Aktionen. Keine großen Renditegrafiken ohne Berechnungsgrundlage.

Die beiliegende design-tokens.css ist ein Vorschlag, keine neue Framework-Vorgabe.

| Token | Wert | Verwendung |
|---|---|---|
| background | #F5F7F9 | Seitenhintergrund |
| surface | #FFFFFF | Tabellen, Formulare, Karten |
| text | #16243A | Titel, wichtige Zahlen |
| muted | #526278 | Sekundärtext auf hellen Flächen |
| border | #DDE5ED | Trennlinien |
| primary | #087F79 | Primäraktion, Links, Fokus |
| success-text / bg | #086448 / #E8F5EE | erfolgreich, bestätigt |
| warning-text / bg | #805300 / #FFF3D8 | offen, prüfen, unklar |
| danger-text / bg | #A52B40 / #FCECEF | Fehler, destruktive Aktion |
| info-text / bg | #315A7A / #EDF4FA | Hinweise, Quellen |

Kontrast für reale Komponenten einschließlich Hover, Disabled und Fokus messen. Ziel WCAG 2.2 AA; Farben nie als einzigen Informationsträger verwenden. Ein Minuszeichen bezeichnet einen Geldabfluss, keine technische Fehlermeldung.

### 4.2 Typografie und Layout

- Systemschrift oder selbst gehostete Inter, keine externen Font-Abfragen mit Mandantendaten.
- Fließtext 14–16 px, Formulare vorzugsweise 16 px, kleine Beschriftungen mindestens 12 px.
- Haupttitel 28–32 px; Abschnitte 18–20 px; Zahlen mit tabular-nums.
- Abstandsraster 4/8/12/16/24/32 px.
- Kartenradius 10–12 px, Eingaben 6–8 px; subtile Schatten nur bei überlagerten Elementen.
- Inhalt maximal etwa 1440 px; Desktop-Navigation 220–240 px.
- Primäre Ziele mindestens 44 × 44 px anstreben. Sichtbare Fokusmarkierung, beschriftete Icons.
- Tabellen rechtsbündig für Beträge, linksbündig für Text; Datum konsequent formatiert.
- Kleine Bildschirme: Navigation als Drawer, Details unter der Liste, Tabellen mit kontrolliertem horizontalem Scrollen. Betrag, Status und Hauptaktion dürfen nicht verloren gehen.

### 4.3 Komponenten

Benötigt werden: AppShell, Breadcrumbs, PageHeader, FilterBar, paginierte DataTable, MoneyText, DateText, StatusBadge, SourceBadge, DetailDrawer, SplitEditor, EntityPicker, ReasonDialog, VersionConflictDialog, FlagsPanel, EmptyState, ErrorState und LoadingState.

Jede Komponente behandelt Fokus, Tastatur, zugängliche Namen, Ladezustand und Fehler. Ein Drawer erhält einen echten Dialog- oder Region-Kontext; ein Formularfehler fokussiert das erste fehlerhafte Feld und zeigt eine Zusammenfassung.

### 4.4 Sprache

- Deutsch für Nutzer, API-Schlüssel unverändert im Client.
- „Buchung bestätigen“, „Zuordnung bestätigen“ und „An MRE übertragen“ sind drei verschiedene Aktionen.
- „Ungültig setzen“, „Zeitraum beenden“, „Zuordnung aufheben“, „Stornieren“ und „Korrigieren“ nicht als einheitliches „Löschen“ übersetzen.
- Kein allgemeiner Erfolgs-Toast „Alles gespeichert“, wenn nur ein Teilschritt erfolgreich war.
- Herkunft explizit: „Aus Bankimport“, „MRE-Zahlungsstand“, „Aus bestätigten Buchungen“, „Plan aus Konditionen“.
- Bei null: „Nicht verfügbar“ oder ein begründeter Leerzustand. Niemals 0,00 € erfinden.
- Fehler aus Codes und details in verständliche Meldungen übersetzen; englische Backend-Messages nicht als alleinige Übersetzungsquelle benutzen.

## 5. Datenverträge im Frontend

### 5.1 Begriffe und Identitäten

| Nutzerbegriff | Technischer Bezug | Regel |
|---|---|---|
| Objekt/Wohnung | PropertyReference | DE-Verknüpfung zur MRE-Property, keine neue Unit-Entität |
| Person/Organisation | Party | Kann Eigentümer oder Kreditnehmer sein; kein Benutzerkonto |
| Eigentumsanteil | Ownership | Gilt in einem Zeitraum; keine globale Prozentzahl |
| Erwerb | Acquisition | Eigene Entität, nicht MRE-Property.price |
| Finanzkonto | FinancialAccount | Quelle/Ziel von Geld; nicht MRE Account und nicht Loan |
| Darlehen | Loan | Über Allocation-Sets mehreren Objekten zuordenbar |
| Mietverhältnis in MRE | mreTenantId | Nicht mit Party-ID oder Lease-Definition verwechseln |
| Mietforderung | mreTenantId + mreRentTerm | MRE-Schlüssel exakt transportieren |
| Buchungsaufteilung | TransactionSplit | Teilbetrag mit Kategorie und zulässigen Fachreferenzen |

DE-UUIDs und MRE-IDs niemals austauschen oder aus Namen ableiten. Im Client separate Typen benutzen. Antworten verwenden ressourcenspezifische Schlüssel wie transactionId, financialAccountId und propertyReferenceId, nicht überall id.

### 5.2 Geld, Brüche und Datum

- Money-Transport: { "amount": "850.00", "currency": "EUR" }. Betrag ist ein String, kein JSON-number.
- Zurzeit EUR, zwei Nachkommastellen. Lokalisierte Eingabe „1.234,56“ explizit zu „1234.56“ normalisieren. Mehrdeutige Formate ablehnen statt raten.
- Kein parseFloat, Number oder Fließkomma für fachliche Summen. Exakte Dezimal-/Cent-Verarbeitung auch für die reine Validierung.
- Backend erlaubt bis 18 Vorkommastellen. Große Werte dürfen beim Formatieren nicht durch Number an Präzision verlieren.
- Transaktionsbetrag und Splitbetrag sind nicht negativ; Richtung ist INFLOW/OUTFLOW auf der Transaktion. Vorzeichen nur bei der Darstellung ergänzen.
- Abweichungen, Restschulden und WEG-Zeilen können **signierte** Werte sein. Keine generelle globale „Beträge müssen positiv sein“-Validierung.
- Eigentumsanteile exakt als Bruch n/d; keine Rückrechnung aus gerundeten Prozentanzeigen. Prozent dürfen sekundäre Anzeige sein.
- MEA in der WEG übernimmt die gedruckten Größen mit den erlaubten Nachkommastellen; nicht ungeprüft den Ownership-Bruchvalidator dafür wiederverwenden.
- BusinessDate ist YYYY-MM-DD ohne Zeitzonenverschiebung; vorhandener gemeinsamer Validator akzeptiert 1900–2100. Keine UTC-Mitternachtskonvertierung für reine Geschäftsdaten.
- Technische Zeitstempel mit Zeitzone; Anzeige nachvollziehbar in Europe/Berlin. Explizite Stichtage bei Abfragen bevorzugen.
- Der MRE-Miettermin ist ein Schlüssel YYYYMMDDHH, kein beliebig konvertierbarer JavaScript-Zeitstempel.

### 5.3 DTOs und Formulare

Nicht das komplette Response-Objekt an einen Schreibendpunkt zurücksenden. Separate Request- und Response-Typen pro Befehl; strikte Schemas lehnen fremde Schlüssel ab. Insbesondere keine UI-only Felder wie displayLabel, selected oder computedTotal mitsenden.

Unterschied beachten: ausgelassen = unverändert, null = optionalen Wert löschen, leerer String kann normalisiert oder abgelehnt werden. Je Route prüfen.

Kategorien aus GET /financial-categories laden. Fachcodes in Requests verwenden; Anzeige übersetzen. Kein eigener, vom Seed unabhängiger Kategorienkatalog.

## 6. Ansichten und Backend-Passung

### 6.1 Umsetzbarkeitsmatrix

„Direkt“ heißt: Fach-API existiert. Es garantiert nicht, dass jede Referenzauswahl ohne Integrationsklärung funktioniert.

| Ansicht/Funktion | Status | Konsequenz |
|---|---|---|
| Buchungsliste, Detail und Fachaktionen | Direkt | Vorhandene Filter und DTOs nutzen |
| Import ausführen, Ergebnis und Klärfälle | Direkt mit bekanntem Konto | Keine fachliche Vorschau vor dem Import |
| Mietabgleich, Vorschläge und MRE-Übertragung | Direkt mit bekanntem MRE-Kontext | DE-Zuordnung und MRE-Status getrennt |
| Darlehen, Kautionen, Parteien, WEG-Listen | Direkt | Eigene Listen-Endpunkte vorhanden |
| Erwerb, Eigentum und WEG pro bekanntem Objekt | Direkt | Objekt-ID muss verlässlich verfügbar sein |
| Vollständige Kontoauswahl nach Neuladen | Vorhanden (#160, #165) | GET /financial-accounts (Filter `status`, `accountType`; seitenweise) und GET /financial-accounts/{id} mit `ETag`; api-design §29.3 |
| Allgemeine DE-Objektliste und passives Objektdetail | Vorhanden (#160, #165) | GET /property-references (Filter `externalReferenceState`; seitenweise) und GET /property-references/{id} mit `ETag`, aus dem Cache ohne MRE-Aufruf; nur link und refresh schreiben; api-design §23.3 |
| Unverändernde fachliche Importvorschau | Lücke | Kein dry-run/preview-Endpunkt |
| Liste früherer Importläufe | Lücke | GET eines bekannten Batches vorhanden, kein Batch-Listen-Endpunkt |
| Audit-Timeline aller Änderungen | Nicht in Version 1 (Entscheidung 30.10.2026) | Kein Audit-Read, und die Aufbewahrung personenbezogener Daten im Audit (VC-X-24) ist offen. Die Korrekturkette einer Buchung (Original, Storno, Ersatz) kommt aus dem Transaction-DTO und ist die sichtbare Historie |
| Portfolio-KPIs, Kontostand, Gesamt-LTV, globale Aufgabenanzahl | Lücke | Keine entsprechende Aggregate-API |
| Volltextsuche über alle Buchungen | Lücke | Kein q-/search-Filter der Transaktionsliste |
| Server-Sortierung nach beliebiger Tabellenspalte | Lücke | Kein generischer sort-Parameter |
| Suche/Benachrichtigungen über alle Module | Lücke | Kein globaler Dienst |
| Dokument-Upload und PDF-Anhänge | Lücke | Quellenangaben sind kein Dokumentenmanagement |
| Steuer-, AfA- und Investment-Oberflächen | Nicht verfügbar | Phase-7-Vertrag allein ist keine Implementierung |

**Nicht als Workaround verwenden:** refresh-POST bei jedem Rendern zum Lesen; Datenbankzugriff aus dem Frontend; kompletter Export aller Seiten für jede Kachel; Kontolisten ausschließlich in localStorage; MRE-IDs als DE-UUIDs; Browserberechnung einer steuerlichen Wahrheit.

### 6.2 Übersicht – zunächst Arbeitsnavigation

**Layout:** Seitentitel, Bestand, Links zu Buchungen/Import/Mietabgleich, zuletzt in dieser Sitzung besuchte Ressourcen. Keine vollständigen, dauerhaften Aufgaben-Zähler versprechen.

Zähler dürfen aus einer **benannten vorhandenen Liste** stammen, etwa dem total der Vorschlagsliste. Zeitraumfilter nur anbieten, wenn genau diese Liste den Filter besitzt. Die Mietabgleichsliste hat keinen allgemeinen from/to-Filter; das Zeitfenster gehört zum suggest-Befehl.

Nicht vorhandene Gesamtkennzahlen weglassen. Keine „Vermögen“, „Eigenkapital“, „Rendite“ oder „Kontostand“-Kacheln aus unvollständigen Buchungsdaten.

### 6.3 Buchungen – erste vollständige Arbeitsansicht

**Layout:** Filter, Tabelle, Detailpanel. Filter: financialAccountId, status, provenance, reviewable=true, current=true, propertyReferenceId, financialCategoryCode, bookingDateFrom/To, page, pageSize.

- GET /transactions: Listen-DTO **ohne Splitdetails**.
- GET /transactions/{transactionId}: Detail mit splits und ETag.
- GET /property-references/{propertyReferenceId}/transactions: Kontextliste.
- Keine erfundenen q, sort, counterparty oder unreconciled-Parameter. Nur tatsächlich unterstützte Parameter senden; unbekannte werden abgelehnt.
- pageSize maximal 200, Standard 50. Gesamtanzahl aus total; Seitensumme nie „Gesamtsumme“ nennen.
- Fachobjektbezogene Liste zeigt volle Transaktionsbeträge. Eine Transaktion kann mehrere Objekte über ihre Splits betreffen. Daraus keinen Objekt-Cashflow durch Aufsummieren der Zeilen ableiten.
- Detail: Datum, Betrag/Richtung, Gegenpartei, Zweck, Herkunft, Status, Konto-ID/aufgelöstes Label, Splitreferenzen, Korrekturverknüpfungen.
- Gegenpartei ist sichtbar, aber im manuellen Create/Amend nicht frei editierbar. Keine editierbaren Felder anbieten, die das Request-Schema nicht kennt.

Statusbeschriftung:

| API | Anzeige | Interaktion |
|---|---|---|
| IMPORTED | Importiert · zu prüfen | Detail, erlaubte Feldänderungen, Splits, Bestätigen |
| UNREVIEWED | Ungeprüft | Wie oben |
| CLASSIFIED | Aufgeteilt | Prüfen und bestätigen; nicht mit reviewable=true gleichsetzen |
| CONFIRMED | Bestätigt | Lesen, fachlich erlaubte Korrektur/Storno |
| RECONCILED | Abgeglichen | Nicht allein daraus „an MRE übertragen“ ableiten |
| CORRECTED | Korrigiert/storniert | Kette zeigen; Original nicht editieren |
| IGNORED | Ignoriert | Wiederherstellen gemäß Backend-Regeln |

Keine Status-Selectbox, die beliebige Zustände schreibt. Buttons lösen Fachbefehle aus. Backend bleibt letzte Instanz, auch wenn UI-Aktionen passend deaktiviert werden.

### 6.4 Split-Editor

Zeilen: Kategorie, Betrag, Bezug, optionale Beschreibung. Referenztyp steuert passende Felder.

- 1–100 Splits, gleiche Währung, exakte Summe gleich Betrag; keine kanonische Rundungstoleranz.
- PUT /transactions/{id}/splits ersetzt das **gesamte** Set. Kein Einzelzeilen-PATCH erfinden.
- Ein Split hat keine eigene Richtung.
- loanId schließt propertyReferenceId aus; Objektzuordnung erfolgt am Darlehen.
- securityDepositId schließt loanId und propertyReferenceId aus.
- WEG-Settlement mit wegAnnualStatementId braucht das passende Objekt und erlaubt keinen Loan-/Kautionsbezug.
- Sonderumlage mit wegSpecialAssessmentId braucht das passende Objekt; kein Loan, keine Kaution und keine Jahresabrechnung auf demselben Split.
- Unsupported am Referenzstand: rentalContractReferenceId, wegId, maintenanceProjectId, acquisitionId, taxClassificationId im Split. Weg ist stattdessen über Objekt/Mitgliedschaft und ggf. konkrete Abrechnung/Sonderumlage angebunden.
- Nicht verwendete Referenzen beim Typwechsel gezielt entfernen.
- Vorschlag ist editierbarer Formularentwurf. Er wird erst durch PUT und danach explizites Bestätigen zur bestätigten Buchung.

### 6.5 CSV-Import – technisch korrekter Ablauf

Schritte **1 Datei & Konto → 2 Import ausführen → 3 Ergebnis & Klärfälle**.

**Entscheidung (30.10.2026):** Es gibt keine fachliche Vorschau vor dem Import und keinen Dry-Run-Endpunkt. Der Import ist idempotent; ein zweiter Lauf derselben Datei erzeugt keine zweite Buchung. Das Ergebnis mit den Klärfällen nach dem POST ist die Prüfansicht.

Vor dem Import möglich: Dateiname, Größe, ausgewähltes Konto, Adapterversion und Mapping/Vorlage zeigen. Eine lokale CSV-Anzeige darf nur „Dateiinhalt, ungeprüft“ heißen. Sie berechnet keine Duplikate oder kanonische Zeilenidentitäten.

POST /imports/bank-transactions ist multipart/form-data:
- genau ein file-Part und ein Text-Part metadata;
- Content-Type mit Boundary vom Browser setzen lassen;
- Dateilimit 5 MiB; generischer Adapter höchstens 10.000 Zeilen;
- metadata enthält financialAccountId, adapterId, adapterVersion sowie Optionen auf derselben Ebene.

Beispiel metadata für vorhandene v2-Vorlage:

~~~json
{
  "financialAccountId": "<DE-Konto-UUID>",
  "adapterId": "generic-csv",
  "adapterVersion": "2",
  "preset": "vr-banking"
}
~~~

Nicht zugleich preset und columnMapping senden. Es gibt keinen separaten Read-Endpunkt für Presets. Die am Referenzstand vorhandene Vorlage kann als geprüfte, versionierte Client-Konfiguration abgebildet werden; unbekannte Vorlagen nicht erfinden.

Nach erfolgreichem POST: importBatchId, row-Ergebnisse, Zähler und continuity aus der Antwort anzeigen. Über GET /imports/{id} erneut lesen. Klärfälle über GET /imports/{id}/review-items laden.

Klärfall zeigt neue Zeile und konkurrierende Transaktionen nebeneinander. Aktionen:
- CREATE: „Als eigenständige Buchung übernehmen“.
- SKIP: „Nicht als neue Buchung übernehmen“.

Keine „Zusammenführen“-Funktion erfinden. Nach resolve Ergebnis und Liste neu lesen. Verweise auf einen früheren owning batch respektieren; dessen Item aufrufen, nicht unter dem neuen Batch lösen.

Bei Timeout nicht einfach behaupten, dass nichts importiert wurde. Bekannte Batch-ID wieder lesen; sonst dieselbe Datei mit identischem Konto/Adapter/Optionen bewusst erneut senden und die serverseitige Duplikaterkennung nutzen. Kein beliebig neuer Dateiinhalt zur Umgehung.

### 6.6 Mietabgleich – drei getrennte Bestätigungen

1. Unbestätigte Buchung öffnen.
2. GET /rent-reconciliations/split-proposal?transactionId=…&mreTenantId=…&mreRentTerm=… lesen.
3. Aufteilung prüfen; vollständig zuordnen; PUT /transactions/{id}/splits.
4. POST /transactions/{id}/confirm.
5. POST /rent-reconciliations/suggest mit from/to als YYYY-MM, maximal zwölf Monate.
6. Vorschläge prüfen und über /confirm bestätigen oder mit Begründung /reject ablehnen.
7. Erst danach separat /write-back-to-mre auslösen.

**Buchung bestätigen ≠ Mietzuordnung bestätigen ≠ MRE-Zahlung übertragen.** Keine Automatik aus einem Button „Alles erledigen“ bauen.

GET /rent-reconciliations liefert Referenzen, nicht alle Objekt- und Mieternamen. Labels nicht aus IDs raten; vorhandene Referenzdaten/Integration nutzen. Vorschlag kann gemindert, aber nicht erhöht bestätigt werden.

Vorschlagslauf gibt skipped.unconfirmed und skipped.noRentCash zurück: bei leerer Liste die Ursache erklären und zu Buchungen führen. „Keine Vorschläge“ heißt nicht „Alle Mieten bezahlt“.

Abdeckungsansicht:
- GET /rent-reconciliations/terms/{mreTenantId}/{mreRentTerm}
- GET /transactions/{transactionId}/rent-reconciliations

MRE-Zahlungen und DE-matchedTotal getrennt zeigen. coverage/openAmount mit Quelle darstellen. AVAILABLE, NOT_RETURNED und UNAVAILABLE unterscheiden. Bei null keine „bezahlt“-Aussage. Selbst bei fachlicher MRE-Ausfalltoleranz kann die vorgelagerte Authentifizierungsprüfung weiter 503 liefern.

Zuordnung besitzt status **und** mreWriteBackState. Zwei getrennte Badges verwenden. Ein Aufheben der Zuordnung ist kein erfolgreiches Entfernen aus MRE. Nach release ggf. gesondert /remove-from-mre anbieten.

Bei konkurrierender Übertragung Retry-After respektieren, Detail neu laden; keine eng getaktete Endlosschleife. Wiederholung des ausdrücklich vorgesehenen Befehls ist etwas anderes als eine eigenständig konstruierte MRE-PATCH-Anfrage. Die UI schreibt **nie direkt** MRE-Zahlungsrecords.

### 6.7 Objekte, Personen, Eigentum und Erwerb

**Objekt:** Die UI darf DE-Fachdetails für eine bekannte propertyReferenceId zusammensetzen: transactions, ownerships, acquisitions, loans und weg-memberships. Objektname/Adresse/Fläche stammen aus MRE bzw. explizit aktualisiertem Cache.

Da ein passives DE-Objekt-GET fehlt, vollständige Objektliste und Rehydration als Integrationspunkt behandeln. Keine Objekt-Stammdaten in DE neu editieren. Bilder, Zimmerzahl und Vermietungsstatus nur anzeigen, wenn der konkrete MRE-Datenweg geprüft ist.

**Personen:** Listen/Detail vorhanden. PERSON und ORGANIZATION mit typabhängigen Formularen; partyType bleibt nach Erstellung fix. Deaktivieren ist kein Löschen; keine automatische Reaktivierung oder Namens-Deduplizierung.

**Eigentum:** Stichtag und Gültigkeitszeitraum immer sichtbar. Historie und asOf-Abfrage nicht vermischen. close beendet, void korrigiert fehlerhafte Erfassung. Ein Eigentümerwechsel wird mit /property-references/{id}/ownership-changes atomar ausgeführt, nicht als lose Folge von Einzelaufrufen.

**Erwerb:** DRAFT → CONFIRMED oder CANCELLED. Invariante Felder nicht mit einem allgemeinen Editformular versehen. Kosten und tatsächliche Zahlungslinks getrennt. Zahlung wird aus existierender Transaktion verknüpft, nicht durch „als bezahlt markieren“ erfunden.

Boden-/Gebäudeaufteilung ist eingegebene, versionierte Information, kein automatisches BMF-Gutachten. Korrektur nennt supersedes; bei Konflikt aktuelle Aufteilung neu laden. Owner-allocation liefert bestätigte oder PROVISIONAL-Daten. Vorläufige Verteilung sichtbar beschriften; nicht selbst Prozentwerte neu verteilen.

### 6.8 Finanzierung

Liste über /loans, Detail über /loans/{id}. Tabs: Überblick, Konditionen, Plan, Zahlungen, Zuordnung, Bankbestätigungen.

- Ist/Plan/Abweichung direkt aus /remaining-debt, mit asOf. perProperty=true nur bei vorhandener Objektzuordnung.
- planned=null ist kein Nullsaldo. Bei LOAN_NOT_ALLOCATED Zuordnung erklären.
- fixedRateEnd zeigt einen **Planwert**, nicht den prognostizierten Effekt aller Sondertilgungen. Nach Zinsbindung unbekannten Folgezins kennzeichnen.
- Kein lokal berechneter Tilgungsplan als Wahrheit. Planpunkte kommen aus /schedule.
- Tatsächliche historische Verlaufsgrafik hat keine eigene Zeitreihen-API. Im ersten Schritt Stichtagsvergleich und Zahlungsdaten verwenden; keine erfundene Ist-Kurve.
- Monatliche Planlogik nicht als exakter Bankabschluss für jeden Teilzinsfall bewerben.
- Neue Konditionsperiode anhängen, nicht historische Werte überschreiben; nur erlaubte letzte Periode void.
- Ein Darlehen bleibt eine Entität. Mehrere Objekte über datierte Allocation-Sets, Summe exakt 1/1.
- /payment-proposal liefert nur einen Vorschlag. Unallocated und flags zeigen; keine unbeaufsichtigte Split-/Confirm-Kette.
- Bankbestätigung ist Betrag/Datum/Quelle, kein vorhandener PDF-Upload. Abweichung verändert keine Buchung.
- /close mit passendem Grund; Refinanzierung referenziert Nachfolgedarlehen. Voraussetzungen aus Fehlerdetails erklären.

### 6.9 Kautionen

Liste und Detail vorhanden. Im Detail expectedAmount und die abgeleiteten received, interestCredited, returned, outstanding, held sowie Status/Flags anzeigen. Der gespeicherte status ACTIVE/CLOSED/VOID und der abgeleitete Fachzustand sind verschieden.

Erhaltenes Geld nicht per Formular in received eintragen: importieren/erfassen, passenden Split mit securityDepositId setzen und Buchung bestätigen. Zinsen reduzieren nicht automatisch die erwartete Einzahlung. Negative held-Werte nicht ausblenden.

holdingFinancialAccountId muss ein Konto des Typs SECURITY_DEPOSIT sein; Auswahl der Konten ist Teil der benannten Leselücke.

Abschluss mit closingDate/reason/closingNote; Einbehalt und andere Gründe brauchen Erläuterung. Bei UNCONFIRMED_CASH oder späteren Buchungen betroffene Transaktionen verlinken. checkMre=true zeigt Vergleich, keinen Cash-Beweis. Abschluss und Wiedereröffnung sind explizite Befehle.

### 6.10 WEG

Einstieg über vorhandene WEG-Liste; Mitgliedschaften verbinden ein Objekt mit einer WEG in einem Zeitraum. Keine neue Unit-Hierarchie anlegen. Nutzersprache „Wohnung“ ist zulässig; technischer Bezug bleibt propertyReferenceId.

Tabs: Mitgliedschaften, Wirtschaftsplan, Jahresabrechnung, Sonderumlagen.

- WEG-Geschäftsjahr kann vom Kalenderjahr abweichen. Perioden ausdrücklich anzeigen.
- Wirtschaftsplan: gedruckte Verteilung und Beträge aufnehmen, nicht automatisch Haushaltszahlungen erzeugen.
- /transactions/{id}/hausgeld-proposal nutzen. HAUSGELD_ONLY/RESERVE_ONLY-Fälle und Unklarheiten zeigen; bestehende Buchung bleibt eigene Geldquelle.
- Rücklagenbeiträge und Sonderumlagen sind WEG_FUNDS, keine automatisch abziehbaren Betriebsausgaben.
- Jahresabrechnung: DRAFT editierbar über vollständigen PUT; CONFIRMED unveränderlich. Korrektur als neuer Nachfolger mit supersedes, alte Version bleibt lesbar.
- Gedruckte Werte und Prüfhinweise nebeneinander. Flags sind nicht immer Schreibverbote.
- /comparison erklärt bezahlt/tatsächlich/Differenz; Abrechnungsspitze, unbezahlte Vorschüsse und Zahlungen auf Vorgänger sauber unterscheiden.
- Nachzahlung/Erstattung mittels /settlement-proposal zu bestehender Transaktion; keine bestätigten Altbuchungen rückwirkend neu aufteilen.
- Sonderumlage: Beschluss, Wohnungsanteil, Raten, Fälligkeiten, Verwendungen. Verwendungen sind Fachinformationen und erzeugen keine Bankbuchungen.
- Überschneidungs-/Mitgliedschaftsfehler mit Datum und referenziertem Objekt zeigen.

## 7. Client-Architektur und Authentifizierung

### 7.1 Framework und Module

**Entscheidung (30.10.2026):** Die Oberfläche ist eine eigene Anwendung im Monorepo unter `webapps/cockpit`, kein Eingriff in die MRE-Landlord-App (Verfassung: MRE nur ändern, wo nötig; ADR-036 Upgrade-Fähigkeit). Der Stack folgt dem gepinnten MRE-Landlord-Frontend, damit niemand zwei Welten lernt: React 18, TypeScript, Tailwind, TanStack Query für Cache und Invalidierung. Gebaut wird mit Vite statt Next.js, weil hinter einem Login kein Server-Rendering nötig ist. Die DTO-Typen kommen aus den Zod-Schemata des Backends über ein gemeinsames Workspace-Paket, damit nicht zwei Wahrheiten über die API entstehen. Konkrete Versionen vor Implementierung am gepinnten Upstream prüfen; keine zusätzliche Designbibliothek.

Schichten: Komponenten → View-/Form-Modelle → typisierter API-Client → DE-API. Keine Imports aus PostgreSQL-Adaptern oder DE-Anwendungsservices in Browsercode. Backend-Regeln nicht als kopierte zweite Domainbibliothek im UI fortschreiben.

API-Client zentral für Base-URL, Realm, Token, Fehler, Versionen und Anfragenabbruch. Keine direkte MRE-Vertragslogik in jeder React-Komponente.

### 7.2 Sitzung und Realm

Jeder DE-Fachrequest:
- Authorization: Bearer <MRE-Landlord-Access-Token>
- organizationid: <mreRealmId>

Der dokumentierte MRE-Access-Token ist nur etwa 30 Sekunden gültig. Vor dem UI-Start müssen Wiederverwendung der MRE-Sitzung, Token-Erneuerung und Realm-Auswahl praktisch gegen die gepinnte Installation geprüft werden. Kein separater DE-Passwortspeicher; kein ACCESS_TOKEN_SECRET im Browser.

Am Referenzstand hat nur administrator DE-Zugriff. renter und unbekannte Rollen haben ihn nicht. Keine Eigentümer-/Steuerberaterrollen allein aus der visionären Spezifikation als verfügbare Berechtigung implementieren.

**Entscheidung (30.10.2026):** gemeinsame Origin hinter einem Reverse-Proxy, kein CORS. Der verbindliche Sitzungsvertrag für Clients (Anmeldung und Refresh über den MRE-Authenticator, Proxy-Schnitt, Realm-Auswahl, Bedeutung von 401/403/503, was DE nie tut) steht in docs/architecture/mre-integration.md **§47.2**; dieser Leitfaden wiederholt ihn nicht. Die Token-Prüfung im Backend ist pro Token und Realm höchstens 30 s gecacht (§47.1, #163).

Kein Refresh-Token in URLs oder Logs. Persistenz und Cookies nur gemäß geprüfter MRE-Sitzungsintegration; keine spontane Langzeitablage von Tokens in localStorage.

### 7.3 Cache, Konflikte und Wiederholungen

Cache-Key beginnt mit Realm und authentifizierter Sitzung, danach Ressource/Filter/Stichtag. Bei Realm-Wechsel laufende Requests abbrechen, Cache und Auswahllisten leeren; späte Antworten des alten Kontexts nicht anzeigen.

Mutationen erst nach bestätigter Serverantwort fachlich grün markieren. Optimistische Finanzzustände und Offline-Schreibwarteschlangen für den ersten Release vermeiden.

Wo unterstützt, bei Änderungen immer den gelesenen starken ETag senden, z.B. If-Match: "3". Fehlt ein ETag-Header, aber version ist im DTO vorhanden, den Vertrag je Route beachten.

Bei 412:
1. Eingaben als lokalen Entwurf erhalten.
2. Aktuellen Datensatz neu lesen.
3. Unterschiede zeigen.
4. Nutzer erneut entscheiden lassen.

Nicht bloß mit details.currentVersion automatisch wiederholen. No-op kann trotz veraltetem ETag erfolgreich sein; den konkreten Serverausgang akzeptieren.

Für unterstützte Create-/Correct-/Reverse-Befehle stabilen Idempotency-Key je **fachlicher Benutzerabsicht** erzeugen. Derselbe Request nach Timeout nutzt denselben Schlüssel. Geänderter Payload oder bewusste neue Buchung ist eine neue Absicht. Nicht jeder Klick und jeder Netzwerk-Retry bekommt einen neuen Schlüssel.

Replay kann einen historischen Snapshot zurückgeben. Danach bei vorhandenem Read aktuelle Daten neu laden; nicht den historischen Stand ungeprüft in einen frischeren Cache schreiben. Der Server behält Schlüssel zurzeit unbegrenzt.

Nicht alle Mutationen unterstützen denselben Mechanismus: Import nutzt seine Zeilen-/Dateiidentität; Write-back hat eigene Claim-/Markerlogik. Header nicht als Garantie an jeden Endpunkt kleben.

Nach Mutation gezielt invalidieren: Buchung und Listen, zugehörige Mietabdeckung, Darlehenssaldo/-zahlungen, Kautionsfiguren und WEG-Vergleiche, soweit betroffen. Client-seitige referenzübergreifende Zahlen nicht mit alten Werten mischen.

### 7.4 Fehler und Ladezustände

| Ergebnis | UI-Verhalten |
|---|---|
| Lädt | Skeleton/Busy-Status, Formzustand erhalten, keine Nullwerte als Platzhalter |
| Leer | Unterschied zwischen keine Daten, keine Filtertreffer und keine verfügbaren Vorschläge |
| 400 / 422 | error.details.fields an konkrete Eingaben binden; zusätzliche fachliche reasons/flags beachten |
| 401 | Sitzung kontrolliert erneuern; automatische Wiederholung nur mit geklärter Request-/Retry-Semantik |
| 403 | Zugriff verweigert; nicht automatisch in anderen Realm ausweichen |
| 404 | Nicht gefunden oder nicht zugänglich; keine Existenz in anderem Bestand verraten |
| 409 | Fachkonflikt aus code und details.reason erklären; passende Ressource verlinken |
| 412 | Versionskonflikt mit Vergleich statt blindem Retry |
| 413 | Dateigröße erklären; Datei nicht nachträglich automatisch zerteilen und importieren |
| 503 / Timeout | Zustand unklar bzw. Dienst nicht verfügbar; kein Erfolg vortäuschen; Retry-After beachten |
| Unbekannter Code/Enum | Sichere allgemeine Anzeige mit Code; keine gefährliche Aktion freischalten |

Fehlerenvelope tatsächlich: { error: { code, message, details? } }. Ein traceId wird nicht allgemein garantiert. Auf details.reason achten: viele fachliche Fehler kommen unter code=CONFLICT mit genauerer Ursache.

Backend-Flags vollständig darstellen; bekannte Codes übersetzen, unbekannte nicht verschlucken. Warnung, Referenz auf fehlende Daten und harter Fehler brauchen verschiedene Komponenten.

## 8. Beispielintegration eines vorhandenen Ablaufs

Die folgenden relativen Pfade enthalten /api/v1. UUIDs sind Platzhalter, keine kopierfertigen realen IDs. Status, Felder und Header der konkreten Antwort verwenden.

~~~http
GET /api/v1/transactions?page=1&pageSize=50&reviewable=true
Authorization: Bearer <token>
organizationid: <realm>
~~~

Detail abrufen; nicht von der Listenzeile auf vollständige Splits schließen.

~~~http
GET /api/v1/transactions/<transactionId>
Authorization: Bearer <token>
organizationid: <realm>
~~~

Angenommen, Antwort hat ETag: "3", Betrag 850.00 EUR, unbestätigter Eingang:

~~~http
PUT /api/v1/transactions/<transactionId>/splits
Authorization: Bearer <token>
organizationid: <realm>
If-Match: "3"
Content-Type: application/json

{
  "splits": [
    {
      "amount": { "amount": "700.00", "currency": "EUR" },
      "financialCategoryCode": "RENT_BASE",
      "propertyReferenceId": "<DE-Objekt-UUID>"
    },
    {
      "amount": { "amount": "150.00", "currency": "EUR" },
      "financialCategoryCode": "RENT_OPERATING_COST_ADVANCE",
      "propertyReferenceId": "<DE-Objekt-UUID>"
    }
  ]
}
~~~

Danach den **neu zurückgegebenen** ETag verwenden. Split-IDs, Positionen oder Status nicht aus der Detailantwort zurück in dieses Input-Schema kopieren.

~~~http
POST /api/v1/transactions/<transactionId>/confirm
Authorization: Bearer <token>
organizationid: <realm>
If-Match: "<version-aus-der-Split-Antwort>"
~~~

Für Korrekturen bestätigter Daten:

~~~json
{
  "reason": "Falsche Kategorie bei der Prüfung festgestellt",
  "replacement": {
    "description": "Korrigierter Verwendungszweck"
  }
}
~~~

Dieses Objekt an POST /transactions/{id}/correct mit unterstütztem If-Match und Idempotency-Key senden. Antwort enthält original, reversal und replacement; kein einzelner Datensatz. Bei bestehendem bestätigtem Mietabgleich kann die Korrektur abgewiesen werden; zuerst den vorgesehenen Release-/Removal-Ablauf erklären.

## 9. Bezüge zu den vorhandenen HTML-Entwürfen

| Entwurfselement | Für Produktionsbeginn ändern |
|---|---|
| Übersicht mit Portfolio-Ein-/Ausgängen | Weglassen, bis vollständige Aggregation definiert ist |
| Liste „Deine Objekte“ | Verlässlichen MRE-/DE-Referenz-Einstieg klären |
| Live-Suche in allen Buchungen | Nur implementierte Filter; lokale Suche ausdrücklich auf aktuelle Seite beschränken |
| CSV-Vorschau mit Duplikaten vor Import | Zu Importergebnis **nach** POST umbauen |
| Datei-Upload im Prototyp | Echten multipart-Import nur nach bewusster Bestätigung aktivieren |
| Klick „bestätigen“ mit Toast | Echte Anfrage, Status/Version neu lesen, Fachfehler behandeln |
| Vollständige Änderungsverlauf-Akkordeons | Nur verfügbare Zeitstempel/Korrekturbezüge; kein erfundener Audit-Verlauf |
| Objektfoto, Zimmerzahl, Status | Nur mit geprüftem MRE-Datenweg |
| Restschuld-Kurve „Ist“ | Ohne historische Quelle nicht zeichnen |
| Bankbestätigung als PDF-Link | Als Datum/Betrag/Quelle darstellen; Upload ist nicht vorhanden |
| Zusätzliche Fachmodule | Kautionen und WEG können nun aufgenommen werden; Steuern noch nicht |

Die Mockups sind keine pixelgenaue Pflicht. Fachlich korrekte, einfache Abläufe haben Vorrang.

## 10. Umsetzungsreihenfolge

### Sprint-Vorbereitung: Integrations-Gate

- Gepinnten Backend-Stand festhalten und Routeninventar prüfen.
- MRE-Login, Refresh, Realm-Auswahl und zulässige Deploy-Origin demonstrieren.
- Herkunft der Konto- und DE-Objekt-Auswahl schriftlich klären.
- Falls diese nicht verfügbar ist: explizite additive Backend-Aufgabe oder beschränkter Pilot mit bekanntem Kontext. IDs per Hand sind allenfalls ein Entwicklerwerkzeug, keine freigegebene Endnutzerlösung.
- Import ohne dry-run akzeptieren oder zusätzliche Vorschau separat planen.
- Keine fachlichen Endpunkte verändern, nur um einen Screenshot zu imitieren.

### Erster nutzbarer Durchstich

1. AppShell und Sitzung.
2. Buchungsliste/Detail mit vorhandenen Filtern.
3. Split-Editor mit exakter Summe und If-Match.
4. Bestätigung und Korrektur.
5. Echte CSV-Datei importieren und einen Klärfall lösen.
6. Mietvorschlag prüfen, bestätigen und getrennt an MRE übertragen.
7. Fehler- und Konfliktfälle im selben Durchstich demonstrieren.

### Danach

Darlehen und Erwerb → Kautionen → WEG. Arbeitsübersicht erst mit belastbaren Datenquellen ausbauen. Steueransichten erst nach implementiertem Vertrag integrieren; ein neuer Spezifikations-PR ist kein Go-live-Signal.

## 11. Abnahmekriterien für die Programmierer

**Entscheidung (30.10.2026):** Die Kriterien sind in Pflicht für Version 1 und Später geteilt. Später heißt: vor dem ersten Release nicht gefordert, aber nicht gestrichen.

### Pflicht für Version 1

- Ein vollständiger Nutzerablauf läuft mit echter API; Mockdaten sind im Testmodus sichtbar beschriftet und gelangen nie in produktive Requests.
- Jeder aktive Button besitzt implementierten Datenweg und Fehlerfall.
- Kein neuer Fachzustand wird ausschließlich im Browser gespeichert.
- Bestätigte Buchungen bleiben unveränderlich; Korrekturen bleiben verknüpft.
- Beträge werden ohne Fließkomma verarbeitet; Splits unterscheiden sich nicht durch Browserrundung.
- Geschäftsdaten verschieben sich nicht bei Zeitzonenwechsel.
- 412 erhält den lokalen Entwurf und führt nicht zu stiller Überschreibung.
- Timeout bei Create/Correct erzeugt beim kontrollierten Retry keine neue Absicht.
- MRE-Schreibvorgänge werden nie durch bloßes Rendern, Refetch oder Tabwechsel ausgelöst.
- Release und Removal werden getrennt und im richtigen Status angeboten.
- Realm-Wechsel entfernt vorherige Daten und selektierte Ressourcen; in Version 1 genügt dafür ein vollständiges Neuladen der Anwendung.
- Alle Listen besitzen leer/lädt/Fehler-Zustände; Pagination und Filter funktionieren mit mehr als einer Seite.
- Ein unknown enum oder neuer Fehlercode ergibt keine leere Seite.
- Tastaturnavigation und Fokus nach Dialogen sind geprüft; Icons haben beschriftete Namen.
- Keine persönlichen Bankdaten, Token oder ganze Serverantworten in Telemetrie/Console.
- Keine Platzhalter-Uploads oder scheinbar funktionierenden Backend-Erweiterungen.
- Durchstich gegen gepinntes MRE und PostgreSQL; zusätzlich ein kontrollierter Praxistest mit echten Daten und festgehaltener Erwartung.

### Später

- Geld über 2^53 Cent wird ohne Präzisionsverlust eingegeben und angezeigt.
- Realm-Wechsel bricht laufende Requests ab und verwirft verspätete Antworten des alten Kontexts ohne Neuladen.
- Screenreader-Namen und gemessene Kontraste in allen Zuständen (Hover, Disabled, Fokus) nach WCAG 2.2 AA.
- Visuelle Regressionstests (Abschnitt 12, Punkt 6).

## 12. Teststrategie

1. **Komponenten:** Geld-Eingabe/-Formatierung, Bruchanzeige, Flags, Fehlerzuordnung, Fokus und Tabellen.
2. **Client-Verträge:** tatsächliche Request- und Response-Formate, strikte Query-Whitelist, Versionen, Realm und Abbruch veralteter Requests.
3. **Integrationsabläufe:** Import → Klärfall → Split → Confirm → Mietabgleich → Write-back → Release/Removal → Korrektur.
4. **Finanzierung/Kaution/WEG:** Backend-Figuren lesen statt im Browser eine zweite Rechenwahrheit testen.
5. **Fehlerfälle:** abgelaufener Token, 403/404, 409, 412, 413, MRE nicht erreichbar, verlorene Antwort und doppelter Klick.
6. **Visuelle Regression:** Kernansichten bei Desktop/Mobil und langen Labels/großen Beträgen. Keine Tests schreiben, die nur CSS-Klassennamen spiegeln.

API-Mocks ausschließlich aus den echten DTO-Mappings ableiten. Neu spezifizierte Steuerfelder nicht vorzeitig in produktiven Fake-Antworten als verfügbar erscheinen lassen.

## 13. Offene Entscheidungen vor Beginn

| Frage | Zuständig | Ergebnis muss sein | Entscheidung (30.10.2026) |
|---|---|---|---|
| Wie nutzt die DE-Oberfläche die MRE-Sitzung einschließlich Refresh? | Frontend + Integration | Funktionierender Anmeldedurchstich, kein separater DE-Login | **Entschieden:** kein DE-Login; Sitzungsvertrag in mre-integration.md §47.2 (#161, #163). Der Anmeldedurchstich wird im Sprint 0 demonstriert. |
| Wie findet man bestehende FinancialAccounts wieder? | Frontend + Backend | Geprüfte Quelle; sonst additive Read-Aufgabe | **Entschieden und umgesetzt:** additive Reads, #160 (#165; api-design §29.3). |
| Wie entstehen auswählbare DE-PropertyReferences aus dem MRE-Kontext? | Frontend + Integration | Stabile UUID-Auflösung, keine Namensheuristik | **Entschieden und umgesetzt:** additive Reads, #160 (#165; api-design §23.3); Anzeigedaten aus dem Cache, Aktualisierung nur über refresh. |
| Gemeinsame Origin oder separate Domain? | Deployment | Header-/Cookie-/CORS-Vertrag | **Entschieden:** gemeinsame Origin hinter einem Reverse-Proxy; kein CORS (Abschnitt 7.2). |
| Importergebnis statt Vorab-Duplikatvorschau akzeptiert? | Produkt | Eindeutige Beschriftung oder separat beschlossener Preview-Vertrag | **Entschieden:** ja, kein Preview-Vertrag (Abschnitt 6.5). |
| Welche Navigation ist im ersten Release wirklich erreichbar? | Produkt + Frontend | Kleine, vollständig funktionierende Auswahl | **Entschieden:** Buchungen, Import, Mietabgleich und die Übersicht als Arbeitsnavigation (Abschnitt 3.1). |
| Soll ein vollständiger Audit-Verlauf sichtbar sein? | Produkt + Backend | Falls ja, expliziter Read-Vertrag und Datenschutzumfang | **Entschieden:** nicht in Version 1; Korrekturkette aus dem Transaction-DTO reicht (Abschnitt 6.1). |
| Eigene App oder Erweiterung der MRE-Landlord-App; welcher Stack? | Produkt + Frontend | Keine Grundsatzdiskussion im ersten Sprint | **Entschieden:** eigene App unter `webapps/cockpit`, React 18, TypeScript, Tailwind, TanStack Query, Vite; DTO-Typen aus den Backend-Schemata (Abschnitt 7.1). |

Damit ist vor dem Sprint 0 keine Backend-Frage mehr offen; alles andere ist entschieden oder wird im Integrations-Gate demonstriert. Offen bleiben die Beilagen aus dem Statusblock (`design-tokens.css`, Routeninventar).

## 14. Definition des Erfolgs

Ein Nutzer kann nach erneutem Anmelden und nach Neuladen des Browsers seine relevanten Daten zuverlässig wiederfinden, eine Bankdatei übernehmen, eine Buchung prüfen, eine Zuordnung bestätigen und deren MRE-Status verstehen. Jede Zahl nennt Zeitraum und Quelle. Konflikte und unklare Zustände bleiben sichtbar. Das Layout erzwingt keine Veränderung des Fachmodells.

Wo der heutige API-Stand diesen Anspruch nicht vollständig erfüllt, wird die Lücke **vor** der UI-Implementierung entschieden. Das verhindert größere Backend-Umbauten später, statt sie nur in die Zukunft zu verschieben.

## Anhang: Referenzen

- [AGENTS.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/AGENTS.md)
- [docs/constitution.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/constitution.md)
- [docs/architecture/architecture-decisions.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/architecture/architecture-decisions.md)
- [docs/architecture/api-design.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/architecture/api-design.md)
- [docs/architecture/data-model.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/architecture/data-model.md)
- [docs/architecture/mre-integration.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/architecture/mre-integration.md)
- [docs/architecture/technology.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/architecture/technology.md)
- [docs/development/coding-guidelines.md](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/docs/development/coding-guidelines.md)
- [services/de-backend/src/api/app.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/app.ts)
- [services/de-backend/src/api/validation.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/validation.ts)
- [services/de-backend/src/api/transaction-dto.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/transaction-dto.ts)
- [services/de-backend/src/api/error-answers.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/error-answers.ts)
- [services/de-backend/src/api/imports.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/imports.ts)
- [services/de-backend/src/api/financial-accounts.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/financial-accounts.ts)
- [services/de-backend/src/api/property-references.ts](https://github.com/DanielUtsch85/vermieter-cockpit/blob/dd110b90f9da6680ffcb22a79323d6350021449d/services/de-backend/src/api/property-references.ts)
