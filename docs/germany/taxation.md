# Besteuerung der Vermietung (Einkünfte aus V+V)

**Projekt:** Vermieter Cockpit DE
**Version:** 0.2 (Ergebnisse der Prüfliste übernommen)
**Stand der Prüfung:** 29.10.2026 (`verification-checklist.md` v0.2, Abschnitt A, E1, E2, E5, E6)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — Steuer

> **Hinweis (AGENTS.md §30):** Etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**, **keine Steuerberatung** im Einzelfall. Die Aussagen sind gegen Gesetz, Verwaltungsanweisungen und BFH-Rechtsprechung geprüft (Stand 29.10.2026, Fundstellen in der Prüfliste). Regeln sind **nicht zeitlos**: Im Modell tragen sie Geltungszeitraum und Quelle (§9). Wo eine steuerlich materielle Regel hier nicht spezifiziert ist, gilt `AGENTS.md` §33: **anhalten, nicht raten.**

---

# 1. Zweck & Abgrenzung

Definiert, wie das steuerliche Ergebnis der **Vermietung im Privatvermögen** ermittelt wird und wie Steuer als **Interpretation über Cash** modelliert wird (ADR-006). Steuer erzeugt **keine** Finanzfakten und mutiert **keine** Transaktionen.

- **In Scope (MVP-Annahme):** Einkünfte aus **Vermietung und Verpachtung (§ 21 EStG)** im **Privatvermögen**, Überschussermittlung.
- **Out of Scope (MVP):** gewerblicher Grundstückshandel, Betriebsvermögen/Bilanzierung, Umsatzsteueroption bei Vermietung, Gewerbesteuer, Erbschaft-/Schenkungsteuer, ELSTER-Übermittlung. → jeweils eigene, spätere Entscheidung.

Die AfA-Details stehen in `docs/germany/depreciation.md`, die Miet-/Betriebskosten-Grundlagen in `docs/germany/rent-and-operating-costs.md`, die WEG-Regeln in `docs/germany/weg.md`.

---

# 2. Musterobjekt (durchgängiges Beispiel)

> Erfundene, illustrative Zahlen.

Vermietete ETW, 70 m², Baujahr 2005, in WEG, fremdfinanziert, in einem Land mit 6,5 % Grunderwerbsteuer (z. B. NW).

- Kaufpreis (Grund + Gebäude): 250.000 €
- Anschaffungsnebenkosten: Grunderwerbsteuer 6,5 % = 16.250 € (Satz je Land und Stichtag, §6.1); Notar/Grundbuch des Eigentumserwerbs ~2 % = 5.000 €; Makler ~3,57 % = 8.925 € → **Nebenkosten ≈ 30.175 €**. Notar- und Grundbuchkosten der Grundschuld gehören **nicht** dazu (Finanzierungskosten, §5).
- **Gesamtanschaffungskosten ≈ 280.175 €**
- Kaufpreisaufteilung (illustrativ) 25 % Grund und Boden / 75 % Gebäude (Methode §6.2)
- Finanzierung: Darlehen 200.000 €, 3,5 % Zins, 2 % anfängliche Tilgung; Zinsanteil Jahr 1 ≈ 7.000 €, Tilgung ≈ 4.000 €
- Nettokaltmiete 10.800 €/Jahr

---

# 3. Ermittlungsschema (Überschusseinkünfte)

**§ 2 Abs. 2 Nr. 2 EStG:** Einkünfte = **Einnahmen − Werbungskosten**.

```text
Einnahmen aus V+V (§ 21, § 8 EStG)
− Werbungskosten (§ 9 EStG)
= Überschuss / Verlust der Einkünfte aus V+V
```

**Zufluss-/Abflussprinzip (§ 11 EStG):** Steuerlich zählt der Zeitpunkt des Geldflusses. → passt zum **cash-only** Ledger.
- **Ausnahme für regelmäßig wiederkehrende Beträge:** „kurze Zeit“ um den Jahreswechsel ist regelmäßig **bis zu 10 Tage**. Nach BFH/BMF muss ein solcher Betrag innerhalb dieses Zeitraums **sowohl fällig als auch gezahlt bzw. zugeflossen** sein. Mieten und Nebenkostenvorauszahlungen können darunter fallen, wenn das im Einzelfall erfüllt ist (A4).
- Modell: Die Zuordnung zum Steuerjahr ist eine abgeleitete Interpretation. Sie braucht das Buchungsdatum **und** die Fälligkeit (bei Miete aus MRE), nie nur eines von beiden.

**Einkünfteerzielungsabsicht (A8):** Bei auf Dauer angelegter Wohnungsvermietung wird sie typisiert angenommen. Eine Prüfung (Totalüberschussprognose, typischerweise über 30 Jahre) kommt insbesondere in Betracht bei:
- zeitlich begrenzter Vermietung;
- gemischter Selbst- und Fremdnutzung;
- bestimmten Ferienwohnungen;
- außergewöhnlichen Gestaltungen;
- nach BFH IX R 17/21 bei Wohnobjekten **über 250 m²**.

**Verluste (A12, Stand 2026):**
- Verluste aus V+V werden im laufenden Veranlagungszeitraum mit positiven Einkünften verrechnet. Was übrig bleibt, unterliegt § 10d EStG.
- Verlustrücktrag: in die **zwei** vorangegangenen Veranlagungszeiträume, bis 1 Mio. € (2 Mio. € bei Zusammenveranlagung).
- Verlustvortrag: bis 1 Mio. € unbeschränkt, darüber **70 %** des übersteigenden Gesamtbetrags der Einkünfte.
- Das Modell weist den Verlust aus. Rücktrag und Vortrag gehören zur Einkommensteuer und liegen außerhalb des MVP.

---

# 4. Einnahmen

- Nettokaltmiete
- vereinnahmte Umlagen und Betriebskostenvorauszahlungen. Sie sind steuerlich **Einnahmen**; die vom Vermieter getragenen umlagefähigen Kosten sind Werbungskosten. Beide werden erfasst, auch wenn sie sich oft ausgleichen (D8, → rent-and-operating-costs §6).
- Nebenerlöse (z. B. Stellplatz)
- **nicht** die Kaution: Eine rückzahlbare Kaution ist bei Entgegennahme keine Einnahme (A11; → Security-Deposit-Domäne, ADR-013). Wird sie später berechtigt für Ansprüche des Vermieters einbehalten, ist dieser Vorgang neu zu klassifizieren (z. B. Ersatz für Mietausfall oder Schaden).
- **nicht** Zinsen auf eine Wohnraumkaution: Sie stehen nach § 551 Abs. 3 BGB dem Mieter zu und erhöhen die Sicherheit (E6, Kategorie `SECURITY_DEPOSIT_INTEREST`). Wie Kapitalertragsteuer einbehalten wird, hängt von Konto und Zurechnung ab und wird nicht fest unterstellt. Für Gewerberaum gilt § 551 BGB nicht.
- **Erstattungen (A10)** sind nicht pauschal neutral:
  - erstattete Werbungskosten im **selben Jahr**: mit den Aufwendungen verrechnen;
  - Erstattung in einem **späteren Jahr**: regelmäßig Einnahme;
  - Zuschüsse und Versicherungsleistungen: mindern je nach Sachverhalt Anschaffungs-/Herstellungskosten oder abziehbaren Aufwand.

---

# 5. Werbungskosten (§ 9 EStG)

Sofort abziehbar, u. a.:

- **Schuldzinsen** (§ 9 Abs. 1 S. 3 Nr. 1 EStG), soweit sie wirtschaftlich der Vermietung zuzuordnen sind; **Tilgung ist nicht abziehbar** (A1). Dazu gehören auch:
  - **Bereitstellungszinsen** bei Finanzierungszusammenhang;
  - ein **marktübliches Damnum/Disagio**: sofort abziehbar und nicht über die Laufzeit verteilt (§ 11 Abs. 2 S. 4 EStG);
  - **vorab entstandene Werbungskosten**, wenn eine hinreichend konkrete Vermietungsabsicht besteht.
- **Finanzierungskosten:** Notar- und Grundbuchkosten der Darlehensbesicherung (Grundschuld) sind regelmäßig Werbungskosten, keine Anschaffungskosten (A6).
- **AfA** (Gebäude) → `docs/germany/depreciation.md`
- **Erhaltungsaufwand** (Reparaturen/Instandhaltung): sofort abziehbar. Bei Gebäuden im Privatvermögen, die überwiegend Wohnzwecken dienen (> 50 % der Nutzfläche), kann größerer Erhaltungsaufwand auf Antrag gleichmäßig auf **2 bis 5 Jahre** verteilt werden (§ 82b EStDV). Es gibt **keinen Höchstbetrag**. Bei Verkauf, Einlage ins Betriebsvermögen oder Ende der Einkunftsnutzung wird der Rest sofort abgezogen (A5).
- **nicht umlagefähige Betriebskosten** und **Verwaltungskosten**
- Fahrtkosten, Porto, Telefon (anteilig), Kontoführung
- **Steuerberatungs- und Rechtskosten**, soweit sie unmittelbar V+V zuzurechnen sind (A9). Erwerbsbezogene Rechtskosten können Anschaffungsnebenkosten sein; private und allgemeine einkommensteuerliche Beratung ist abzugrenzen.
- Versicherungen (soweit nicht umgelegt)
- **WEG:**
  - Die Zuführung zur Erhaltungsrücklage ist bei Zahlung **noch keine** Werbungskosten. Abziehbar ist erst die tatsächliche Verausgabung durch die GdWE für entsprechende Maßnahmen (BFH IX R 19/24 vom 14.01.2025; E1, `weg.md` §5.2).
  - Für Sonderumlagen gilt das Gleiche: Maßgeblich ist die tatsächliche Verwendung (`weg.md` §5.3).

Nicht sofort abziehbar (nur über AfA): **Anschaffungs- und Herstellungskosten** (siehe §6).

---

# 6. Anschaffungskosten, Herstellungskosten, Erhaltungsaufwand

Kernabgrenzung für die korrekte Behandlung:

| Kategorie | Behandlung |
|---|---|
| **Anschaffungskosten** (Kaufpreis Gebäudeanteil + anteilige Nebenkosten) | aktivieren, über **AfA** absetzen |
| **Anschaffungsnebenkosten** (erwerbsbezogene GrESt, Kaufvertrags-/Auflassungsnotar, Grundbuchkosten des Eigentumserwerbs, Makler) | Teil der Anschaffungskosten; anteilig Grund und Gebäude zuordnen; Gebäudeanteil in die AfA-Basis. **Nicht** dazu gehören Notar- und Grundbuchkosten der Finanzierung (§5) (A6) |
| **Herstellungskosten** (Neubau, Erweiterung, wesentliche Verbesserung; § 255 HGB analog) | aktivieren, über AfA |
| **Anschaffungsnahe Herstellungskosten** (**§ 6 Abs. 1 Nr. 1a EStG**): Instandsetzung/Modernisierung innerhalb von **3 Jahren** nach Anschaffung, wenn die Aufwendungen **ohne USt mehr als 15 %** der Anschaffungskosten **des Gebäudes** betragen (nicht „mindestens“). Ausgenommen sind Erweiterungen und jährlich üblicherweise anfallende Erhaltungsarbeiten (A2) | gelten als Herstellungskosten → nur AfA (nicht sofort) |
| **Erhaltungsaufwand** (Reparatur, Ersatz vorhandener Teile) | sofort abziehbar (ggf. § 82b EStDV) |

## 6.1 Grunderwerbsteuer als datierter Landesparameter (A7, E5)

Der Satz ist je Bundesland verschieden und ändert sich. Er wird als Parameter `state`, `rate`, `validFrom`, `validTo`, `source` geführt, nie als Konstante. Stand 29.10.2026:

| Land | Satz | Land | Satz |
|---|---|---|---|
| BW | 5,0 % | NI | 5,0 % |
| BY | 3,5 % | NW | 6,5 % |
| BE | 6,0 % | RP | 5,0 % |
| BB | 6,5 % | SL | 6,5 % |
| HB | 5,5 % (seit 01.07.2025) | SN | 5,5 % |
| HH | 5,5 % | ST | 5,0 % |
| HE | 6,0 % | SH | 6,5 % |
| MV | 6,0 % | TH | 5,0 % (seit 01.01.2024) |

Ältere Sätze (z. B. HB und TH vor diesen Stichtagen) werden mit ihrem Geltungszeitraum nachgetragen, bevor ein Altfall gerechnet wird.

## 6.2 Kaufpreisaufteilung (A3, E2)

**Grund und Boden ist nicht abschreibbar**, nur der Gebäudeanteil. Deshalb ist die Kaufpreisaufteilung steuerlich zentral (→ Acquisition-Input, ADR-010):
- Maßgeblich ist das Verhältnis der Verkehrswerte bzw. Teilwerte.
- Die **BMF-Arbeitshilfe (Stand März 2026)** ist das typisierte Verfahren zur Aufteilung und Plausibilisierung.
- Eine vertragliche Aufteilung und ein Gutachten werden gesondert gewürdigt. Im Streit gilt eine sachgerechte Verkehrswertaufteilung.
- Eingaben mindestens: Gesamtkaufpreis, Erwerbsnebenkosten, Bodenwert- und Grundstücksdaten, Gebäudedaten, ggf. abweichende vertragliche oder gutachterliche Werte samt Quelle.

---

# 7. Beispielrechnung (Musterobjekt, Jahr 1)

> Illustrativ.

```text
Einnahmen
  Nettokaltmiete                         10.800 €
  (Umlagen: Einnahme; umlagefähige BK: Werbungskosten in gleicher Höhe, hier ausgeglichen)

Werbungskosten
  Schuldzinsen                          − 7.000 €
  AfA Gebäude (2 % v. ~210.131 €)       − 4.203 €   (Herleitung → depreciation.md)
  nicht umlagefähige Bewirtschaftung    − 1.000 €
  Erhaltungsaufwand (Reparatur)         −   500 €
= Ergebnis V+V                          − 1.903 €   (steuerlicher Verlust)
```

Hinweise:
- **Tilgung (~4.000 €) ist nicht enthalten.** Sie ist keine Werbungskosten, obwohl Cash abfließt. → zeigt, warum **Cashflow ≠ steuerliches Ergebnis**.
- Die Zuführung zur Erhaltungsrücklage ist **nicht** als Werbungskosten angesetzt (BFH IX R 19/24; `docs/germany/weg.md` §5.2).
- Die AfA im Erwerbsjahr wird zeitanteilig gekürzt (`depreciation.md` §5); das Beispiel zeigt ein volles Jahr.

---

# 8. Klassifikationen im Modell

- `Werbungskosten`-Klassifikation je `TransactionSplit` (nicht am rohen Transaction-Betrag) — Steuer interpretiert, mutiert nicht (`AGENTS.md` §16).
- Acquisition-Cost-Klassifikation (Anschaffung vs. Nebenkosten vs. anschaffungsnah) am Acquisition-Aggregat; Finanzierungskosten des Erwerbs getrennt davon.
- `umlagefähig`/`nicht umlagefähig` aus `rent-and-operating-costs.md`.
- WEG: Zuführungen und Sonderumlagen (Kategorietyp `WEG_FUNDS`, `phase-6-plan.md` P6-D3) werden erst über ihre Verwendung zu Werbungskosten; die Verwendung wird als Erhaltungsaufwand oder Herstellungskosten klassifiziert.
- Steuerjahr (`tax year`) als Domänendatum, getrennt von technischen Timestamps (`AGENTS.md` §21).

---

# 9. Regeldarstellung (gemeinsames Schema für alle germany/*-Docs)

Deutsche Regeln sind **versioniertes Fachwissen** (ADR-022, constitution Art. VII), **keine** Magic Constants. Sie werden als **versionierte, unit-getestete Code-Module** umgesetzt — keine generische Rule Engine (**ADR-041**). Struktur je RuleSet:

```text
TaxRule / RuleSet
├── ruleId / name
├── legalBasis        // z. B. "§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG"
├── effectiveFrom     // Geltungsbeginn (Fachdatum)
├── effectiveTo?      // Geltungsende (falls befristet)
├── parameters        // z. B. Satz 2 %, Grenze 15 %
├── source/provenance // Fundstelle, Stand, ggf. BMF/BFH-Referenz
└── version           // Regelversion für Reproduzierbarkeit
```

Jede abgeleitete Steuer-/AfA-Zahl referenziert die **angewandte Regelversion**, damit Reports reproduzierbar sind (constitution Art. III; `docs/product/reports.md`).

**Quellen:** Merkblätter sind Sekundärquellen und werden nicht ungeprüft übernommen. Vorrang haben Gesetz, aktuelle Verwaltungsanweisungen und Rechtsprechung (Prüfliste, „Zusätzliche Feststellung zum beigefügten Merkblatt“).

---

# 10. Offene Punkte

- Ältere Grunderwerbsteuersätze je Land mit Geltungszeitraum ergänzen, sobald ein Altfall sie braucht.
- Modellabbildung der 10-Tage-Regel (Fälligkeit aus MRE + Buchungsdatum) in Phase 7 spezifizieren.
- Datenfelder der Kaufpreisaufteilung (§6.2) gegen die Acquisition (ADR-010) abgleichen.
- Neuklassifikation einbehaltener Kautionen (A11) mit der Security-Deposit-Domäne festlegen.
- Struktur des Steuerjahr-Reports an die aktuell gültige Formularlogik anlehnen (`reports.md` 2.2), ohne ELSTER-Anspruch.
- Weiter fallabhängig: Abgrenzung Erhaltungsaufwand / Herstellungskosten / anschaffungsnahe Herstellungskosten im Einzelfall.
