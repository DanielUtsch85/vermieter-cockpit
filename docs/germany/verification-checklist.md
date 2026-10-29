# Prüfliste: rechtliche/steuerliche Verifikation der germany/*-Entwürfe

**Projekt:** Vermieter Cockpit DE
**Version:** 0.1
**Status:** Arbeitsdokument (zur Vorlage bei fachkundiger Person)
**Bezug:** `docs/germany/taxation.md`, `depreciation.md`, `weg.md`, `rent-and-operating-costs.md`

---

## Zweck und Nutzung

Die vier `germany/*`-Dokumente sind **Erst-Entwürfe** mit Gesetzesbezug, die vor der Implementierung fachlich bestätigt werden müssen. Diese Liste bündelt **alle `VERIFY`-Punkte** als konkrete Prüffragen. Sie ist **keine** eigene Rechtsauffassung, sondern die Bitte um Bestätigung/Korrektur.

**Wichtig für die Software:** Das System speichert jede Regel als **versioniertes Fachwissen mit Geltungszeitraum und Quelle**. Bitte je Satz/Grenze **nicht nur den aktuellen Wert, sondern auch dessen Stichtag/Geltungszeitraum** angeben (z. B. „3 % gilt für Fertigstellung ab 01.01.2023"), damit auch Altfälle korrekt gerechnet werden.

**Ausdrücklicher Scope (Annahme):** Vermietung im **Privatvermögen** (Einkünfte aus Vermietung und Verpachtung, § 21 EStG), Buy-and-Hold, Beispiel „eine vermietete Eigentumswohnung in einer WEG, fremdfinanziert". Gewerblicher Grundstückshandel, Betriebsvermögen, USt-Option und ELSTER sind **nicht** Gegenstand.

**Zuständigkeiten (Vorschlag):**
- Abschnitte **A (Steuer)** und **B (AfA)** sowie die steuerlichen Fragen in C/D: **Steuerberater/in**.
- Zivilrechtliche Mechanik in **C (WEG)** und **D (Betriebskosten)**: ggf. **Fachanwält/in für Miet- und WEG-Recht** (die meisten Punkte kann aber auch die/der Steuerberater/in einordnen).

**Legende Priorität:** 🔴 hoch (kernrelevant / kürzlich geändert / umstritten) · 🟡 mittel · ⚪ überwiegend faktisch.
**Spalte „Ergebnis":** bitte `OK` / `Korrektur:` … / `+ Geltung ab TT.MM.JJJJ`.

---

## A. Besteuerung der Vermietung (`taxation.md`)

| Nr. | Aussage im Entwurf (§) | Prüffrage | Prio | Ergebnis |
|---|---|---|---|---|
| A1 | Schuldzinsen des Immobiliendarlehens sind Werbungskosten, **nur der Zinsanteil, nicht die Tilgung** (§ 9 EStG). | Korrekt so? Sonderfälle (Damnum/Disagio, Bereitstellungszinsen, vorab entstandene WK)? | 🔴 | |
| A2 | **Anschaffungsnahe Herstellungskosten** (§ 6 Abs. 1 Nr. 1a EStG): Instandsetzung/Modernisierung **innerhalb 3 Jahren** nach Anschaffung, **netto > 15 %** der **Gebäude**-Anschaffungskosten → Herstellungskosten (nur über AfA). | 15 %-Grenze, 3-Jahres-Zeitraum und Ausnahmen (jährlich üblicher Erhaltungsaufwand, Erweiterungen) korrekt? Bezugsgröße = Gebäudeanteil? | 🔴 | |
| A3 | **Kaufpreisaufteilung** Grund/Gebäude ist maßgeblich (Grund und Boden nicht abschreibbar); Orientierung BMF-Arbeitshilfe bzw. Gutachten, im Streit BFH. | Welche Methode ist derzeit akzeptiert/empfohlen? Ist die BMF-Arbeitshilfe weiterhin nutzbar oder nur eingeschränkt? | 🔴 | |
| A4 | **Zufluss-/Abflussprinzip** (§ 11 EStG) inkl. **10-Tage-Regel** für regelmäßig wiederkehrende Einnahmen/Ausgaben um den Jahreswechsel. | 10-Tage-Regel korrekt beschrieben? Gilt sie z. B. für Miete/Nebenkostenvorauszahlungen? | 🔴 | |
| A5 | **Erhaltungsaufwand** sofort abziehbar; auf Antrag **Verteilung auf 2–5 Jahre** (§ 82b EStDV). | Voraussetzungen/Höchstbetrag der Verteilung korrekt? Abgrenzung Erhaltung vs. Herstellung? | 🟡 | |
| A6 | **Anschaffungsnebenkosten** (Grunderwerbsteuer, Notar, Grundbuch, Makler) sind Teil der Anschaffungskosten und auf Grund/Gebäude aufzuteilen; Gebäudeanteil erhöht die AfA-Basis. | Zuordnung/Aktivierung korrekt? Makler stets aktivierungspflichtig? | 🟡 | |
| A7 | **Grunderwerbsteuer**: im Beispiel 6,5 % (Satz **je Bundesland verschieden**). | Aktuelle Sätze je Bundesland (mit Stichtag) bestätigen bzw. Quelle nennen. | 🟡 | |
| A8 | **Einkünfteerzielungsabsicht** bei dauerhafter Vermietung grds. unterstellt; bei Verlusten mögliche Prüfung („Liebhaberei"). | Korrekt? Ab wann wird die Absicht typischerweise hinterfragt (z. B. befristete Vermietung, Ferienwohnung)? | 🟡 | |
| A9 | Steuerberatungs-/Rechtskosten als WK, soweit der Einkunftsart zurechenbar. | Abgrenzung/Umfang korrekt? | ⚪ | |
| A10 | Erstattungen (z. B. Finanzamt) — Behandlung noch offen markiert. | Wie sind Erstattungen einzuordnen (Einnahme/Minderung/neutral)? | ⚪ | |
| A11 | **Kaution ist keine Einnahme** (eigene Domäne). | Bestätigt? | ⚪ | |
| A12 | Verlustverrechnung/-vortrag: MVP-Umfang noch offen. | Grundmechanik (horizontaler/vertikaler Ausgleich, § 10d EStG) für V+V wie? | 🟡 | |

---

## B. Abschreibung / AfA (`depreciation.md`)

> Besonders zeitkritisch: die AfA-Sätze wurden mehrfach geändert. Bitte **Satz + Geltungszeitraum** je Fall.

| Nr. | Aussage im Entwurf (§) | Prüffrage | Prio | Ergebnis |
|---|---|---|---|---|
| B1 | Lineare Wohngebäude-AfA **3 %** bei Fertigstellung **nach 31.12.2022** (§ 7 Abs. 4 Nr. 2 Buchst. a EStG, JStG 2022). | Satz, Stichtag und Buchstaben-Zuordnung korrekt? | 🔴 | |
| B2 | Lineare Wohngebäude-AfA **2 %** bei Fertigstellung **1925–2022** (Buchst. b). | Korrekt (genaue Datumsgrenzen)? | 🔴 | |
| B3 | Lineare Wohngebäude-AfA **2,5 %** bei Fertigstellung **vor 1925** (Buchst. c). | Korrekt? | 🟡 | |
| B4 | **Degressive** Wohngebäude-AfA **5 %** vom Restwert, an **Baubeginn-Fenster** gebunden (ca. **01.10.2023–30.09.2029**, Wachstumschancengesetz); Wechsel zur linearen AfA möglich. | Satz, exaktes Zeitfenster, Definition „Baubeginn", Voraussetzungen und Wechseloption bestätigen. | 🔴 | |
| B5 | **AfA-Bemessungsgrundlage = nur Gebäudeanteil** (inkl. anteiliger Nebenkosten); Grund und Boden nicht. | Bestätigt? | 🔴 | |
| B6 | Im **Anschaffungsjahr monatsgenaue** (pro rata temporis) AfA (§ 7 Abs. 1 Satz 4 EStG, sinngemäß); AfA-Beginn = Übergang Nutzen/Lasten bzw. Fertigstellung. | Monatsgenauigkeit und Beginn korrekt? | 🟡 | |
| B7 | **Kürzere tatsächliche Nutzungsdauer** kann höheren Satz rechtfertigen (§ 7 Abs. 4 Satz 2 EStG; Nachweis, z. B. Gutachten). | Aktuelle Nachweisanforderungen (BFH/BMF-Schreiben) bestätigen. | 🟡 | |
| B8 | **Bewegliche Wirtschaftsgüter** (z. B. selbständige Einbauküche): lineare AfA über Nutzungsdauer (§ 7 Abs. 1 EStG), AfA-Tabellen als Orientierung. | Abgrenzung selbständig vs. Gebäudebestandteil korrekt? Übliche Nutzungsdauern? | ⚪ | |
| B9 | **GWG** (§ 6 Abs. 2 EStG): Sofortabzug bis **netto 800 €** bzw. Sammelposten. | Aktuelle Grenze(n) und Sammelposten-Regel bestätigen. | 🟡 | |
| B10 | **Denkmal-/Sanierungs-AfA** (§ 7i, § 7h EStG) als späterer Sonderfall. | Für den Nutzerkreis relevant? Grundvoraussetzungen? | ⚪ | |
| B11 | Nachträgliche Anschaffungs-/Herstellungskosten erhöhen die Bemessungsgrundlage. | Behandlung (Weiterführung AfA, Restwert-AfA) korrekt? | 🟡 | |

---

## C. WEG / Wohnungseigentum (`weg.md`)

| Nr. | Aussage im Entwurf (§) | Prüffrage | Prio | Ergebnis |
|---|---|---|---|---|
| C1 | **Zuführung zur Erhaltungsrücklage ist beim Vermieter noch kein Werbungskosten**; WK erst bei **tatsächlicher Verausgabung durch die GdWE** für Erhaltungsmaßnahmen (BFH). | **Umstritten/nuanciert** — bitte aktuelle Rechtslage/Rechtsprechung bestätigen. Gibt es abweichende Sichtweisen/Entwicklungen? | 🔴 | |
| C2 | **Seit WEMoG (01.12.2020)** beschließt die Eigentümerversammlung regelmäßig nur noch die **Abrechnungsspitze** (Nachschüsse/Anpassung der Vorschüsse), nicht die gesamte Jahresabrechnung. | Korrekt? Auswirkung auf Fälligkeit/Verbuchung? | 🟡 | |
| C3 | **Wirtschaftsplan** (§ 28 Abs. 1 WEG) begründet die Vorschüsse (Hausgeld); **Jahresabrechnung** (§ 28 Abs. 2 WEG) rechnet ab. | Paragraphenbezug und Grundmechanik korrekt (nach aktueller Fassung)? | 🟡 | |
| C4 | **GdWE seit WEMoG rechtsfähig** (§ 9a WEG); **Verwalter** vertritt die GdWE (§ 9b WEG). | Bestätigt? | ⚪ | |
| C5 | **Erhaltungsrücklage** (§ 19 Abs. 2 Nr. 4 WEG), früher „Instandhaltungsrücklage". | Begriff/Fundstelle korrekt? | ⚪ | |
| C6 | **Sonderumlage** folgt steuerlich dem zugrunde liegenden Aufwand (Erhaltung vs. Herstellung). | Korrekt? WK-Zeitpunkt bei Sonderumlage (Zahlung vs. Verausgabung durch WEG)? | 🟡 | |
| C7 | Aus WEG-Kostenlinien ist gegenüber dem Mieter **umlagefähig/nicht umlagefähig** zu trennen (Verwaltung/Rücklage nicht umlagefähig). | Konsistent mit BetrKV (Abschnitt D)? | 🟡 | |

---

## D. Miete & Betriebskosten (`rent-and-operating-costs.md`)

| Nr. | Aussage im Entwurf (§) | Prüffrage | Prio | Ergebnis |
|---|---|---|---|---|
| D1 | Umlagefähige Betriebskosten nach **§ 556 BGB i. V. m. § 2 BetrKV** (17-Positionen-Katalog). | Katalog vollständig/aktuell? Einzelpositionen korrekt zugeordnet? | 🟡 | |
| D2 | **Umlage von TV/Breitband/Gemeinschaftsantenne** — Rechtslage hat sich geändert. | Aktueller Stand (Wegfall Nebenkostenprivileg) und Übergangsfristen bestätigen. | 🔴 | |
| D3 | **Umlagefähig nur bei wirksamer Vereinbarung** im Mietvertrag; sonst trägt Vermieter. | Korrekt? Anforderungen an die Umlagevereinbarung? | 🟡 | |
| D4 | **Abrechnungsfrist**: spätestens **12 Monate** nach Ende des Abrechnungszeitraums (§ 556 Abs. 3 BGB); verspätete Nachforderungen grds. ausgeschlossen. | Frist und Ausschlusswirkung korrekt? | 🟡 | |
| D5 | **Einwendungsfrist des Mieters**: 12 Monate nach Zugang der Abrechnung. | Bestätigt? | ⚪ | |
| D6 | **Umlageschlüssel**: ohne Vereinbarung Auffangschlüssel **Wohnfläche** (§ 556a Abs. 1 BGB); verbrauchsabhängige Kosten nach Verbrauch. | Korrekt? | 🟡 | |
| D7 | **Heizkosten**: HeizkostenV verlangt überwiegend verbrauchsabhängige Abrechnung (**regelmäßig 50–70 %**). | Genaue Quote, Rechtsgrundlage (§ 7 HeizkostenV) und Ausnahmen bestätigen. | 🟡 | |
| D8 | Steuerlich: umlagefähige Betriebskosten sind für den Vermieter **durchlaufende Posten** (Einnahme + WK), nicht umlagefähige Kosten mindern das Ergebnis unmittelbar. | Steuerliche Sicht korrekt? | 🟡 | |

---

## E. Übergreifende offene Fragen (aus den „Offene Punkte"-Abschnitten)

| Nr. | Frage | Betrifft |
|---|---|---|
| E1 | Zeitpunkt des Werbungskostenabzugs der **Erhaltungsrücklage** endgültig klären (Zuführung vs. Verausgabung) — Kernfrage, wirkt in Steuer **und** WEG. | A/C |
| E2 | Methodik der **Kaufpreisaufteilung** (BMF-Arbeitshilfe vs. Gutachten) und die dafür nötigen Eingabefelder. | A/B |
| E3 | Behandlung **Betriebskostenpauschale vs. Vorauszahlung** im Datenmodell. | D |
| E4 | Verhältnis **WEG-Jahresabrechnung ↔ mieterseitige Betriebskostenabrechnung** (welche WEG-Kostenlinie ist gegenüber dem Mieter umlagefähig). | C/D |
| E5 | Sollen **Grunderwerbsteuersätze je Bundesland** als gepflegte, datierte Parameter geführt werden? | A |
| E6 | **Zinsen auf die Mietkaution** (§ 551 Abs. 3 BGB): stehen dem Mieter zu und werden mit der Kaution zurückgezahlt; steuerlich Kapitalerträge des Mieters (Abgeltungsteuer der Bank)? Wie sind sie beim Vermieter auszuweisen (Kategorie `SECURITY_DEPOSIT_INTEREST`, nie Einnahme, Phase 5 P5-D5)? Gilt Gleiches für Gewerbekautionen? | A |

---

## Hinweis

Bitte je Korrektur möglichst **Fundstelle und Geltungszeitraum** angeben. Punkte ohne Bestätigung bleiben im System als `VERIFY` markiert und werden **nicht** implementiert (Projektregel: keine erfundenen oder unbestätigten Rechtsregeln). Diese Prüfung ersetzt keine individuelle Beratung im Einzelfall.
