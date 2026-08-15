# Besteuerung der Vermietung (Einkünfte aus V+V)

**Projekt:** Vermieter Cockpit DE
**Version:** 0.1 (Erst-Draft)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — Steuer

> **Wichtiger Hinweis (AGENTS.md §30):** Etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**, **keine Steuerberatung**. Jede Zahl/Grenze/Frist ist `VERIFY`-markiert und vor Nutzung gegen die aktuelle Rechtslage sowie ggf. durch eine steuerlich fachkundige Person zu prüfen. Regeln sind **nicht zeitlos**. Wo eine steuerlich materielle Regel hier nicht spezifiziert ist, gilt `AGENTS.md` §33: **anhalten, nicht raten.**

---

# 1. Zweck & Abgrenzung

Definiert, wie das steuerliche Ergebnis der **Vermietung im Privatvermögen** ermittelt wird und wie Steuer als **Interpretation über Cash** modelliert wird (ADR-006). Steuer erzeugt **keine** Finanzfakten und mutiert **keine** Transaktionen.

- **In Scope (MVP-Annahme):** Einkünfte aus **Vermietung und Verpachtung (§ 21 EStG)** im **Privatvermögen**, Überschussermittlung.
- **Out of Scope (MVP):** gewerblicher Grundstückshandel, Betriebsvermögen/Bilanzierung, Umsatzsteueroption bei Vermietung, Gewerbesteuer, Erbschaft-/Schenkungsteuer, ELSTER-Übermittlung. → jeweils eigene, spätere Entscheidung.

Die AfA-Details stehen in `docs/germany/depreciation.md`, die Miet-/Betriebskosten-Grundlagen in `docs/germany/rent-and-operating-costs.md`.

---

# 2. Musterobjekt (durchgängiges Beispiel)

> Erfundene, illustrative Zahlen.

Vermietete ETW, 70 m², Baujahr 2005, in WEG, fremdfinanziert.

- Kaufpreis (Grund + Gebäude): 250.000 €
- Anschaffungsnebenkosten: Grunderwerbsteuer 6,5 % = 16.250 € `VERIFY` (Satz je Bundesland verschieden); Notar/Grundbuch ~2 % = 5.000 €; Makler ~3,57 % = 8.925 € → **Nebenkosten ≈ 30.175 €**
- **Gesamtanschaffungskosten ≈ 280.175 €**
- Kaufpreisaufteilung (illustrativ) 25 % Grund und Boden / 75 % Gebäude `VERIFY`
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

**Zufluss-/Abflussprinzip (§ 11 EStG):** steuerlich zählt der Zeitpunkt des Geld­flusses (mit der 10-Tage-Regel für regelmäßig wiederkehrende Einnahmen/Ausgaben um den Jahreswechsel) `VERIFY`. → passt zum **cash-only** Ledger.

**Einkünfteerzielungsabsicht:** bei dauerhafter Vermietung grds. unterstellt; bei Verlusten kann das Finanzamt die Absicht prüfen (Stichwort „Liebhaberei") `VERIFY`.

---

# 4. Einnahmen

- Nettokaltmiete
- vereinnahmte umlagefähige Betriebskosten(-vorauszahlungen) — durchlaufend (siehe rent-and-operating-costs §6)
- Nebenerlöse (z. B. Stellplatz)
- **nicht** Kaution (keine Einnahme; → Security-Deposit-Domäne, ADR-013)
- Erstattungen (z. B. vom Finanzamt) nach Regel prüfen `VERIFY`

---

# 5. Werbungskosten (§ 9 EStG)

Sofort abziehbar, u. a.:

- **Schuldzinsen** des Immobiliendarlehens — **nur der Zinsanteil**, **nicht die Tilgung** (Tilgung ist kein Aufwand) `VERIFY`
- **AfA** (Gebäude) → `docs/germany/depreciation.md`
- **Erhaltungsaufwand** (Reparaturen/Instandhaltung) — sofort abziehbar; auf Antrag Verteilung auf 2–5 Jahre (**§ 82b EStDV**) `VERIFY`
- **nicht umlagefähige Betriebskosten** und **Verwaltungskosten**
- Fahrtkosten, Porto, Telefon (anteilig), Kontoführung
- Steuerberatungs-/Rechtskosten, soweit der Einkunftsart zurechenbar `VERIFY`
- Versicherungen (soweit nicht umgelegt)

Nicht sofort abziehbar (nur über AfA): **Anschaffungs- und Herstellungskosten** (siehe §6).

---

# 6. Anschaffungskosten, Herstellungskosten, Erhaltungsaufwand

Kernabgrenzung für die korrekte Behandlung:

| Kategorie | Behandlung |
|---|---|
| **Anschaffungskosten** (Kaufpreis Gebäudeanteil + anteilige Nebenkosten) | aktivieren, über **AfA** absetzen |
| **Anschaffungsnebenkosten** (GrESt, Notar, Grundbuch, Makler) | Teil der Anschaffungskosten; auf Grund/Gebäude aufteilen; Gebäudeanteil in AfA-Basis `VERIFY` |
| **Herstellungskosten** (Neubau, Erweiterung, wesentliche Verbesserung; § 255 HGB analog) | aktivieren, über AfA |
| **Anschaffungsnahe Herstellungskosten** (**§ 6 Abs. 1 Nr. 1a EStG**): Instandsetzung/Modernisierung innerhalb **3 Jahren** nach Anschaffung, netto **> 15 %** der **Gebäude**-Anschaffungskosten | gelten als Herstellungskosten → nur AfA (nicht sofort) `VERIFY` (15%-Grenze, 3-Jahres-Zeitraum, Ausnahmen prüfen) |
| **Erhaltungsaufwand** (Reparatur, Ersatz vorhandener Teile) | sofort abziehbar (ggf. § 82b EStDV) |

**Grund und Boden ist nicht abschreibbar** — nur der Gebäudeanteil. Deshalb ist die **Kaufpreisaufteilung** (Grund vs. Gebäude) steuerlich zentral; Orientierung u. a. an der BMF-Arbeitshilfe bzw. gutachterlicher Aufteilung, im Streitfall BFH-Rechtsprechung `VERIFY`. → Aufteilung ist ein Acquisition-Input (ADR-010).

---

# 7. Beispielrechnung (Musterobjekt, Jahr 1)

> Illustrativ, `VERIFY`.

```text
Einnahmen
  Nettokaltmiete                         10.800 €
  (umlagefähige BK: durchlaufend, neutral)

Werbungskosten
  Schuldzinsen                          − 7.000 €
  AfA Gebäude (2 % v. ~210.131 €)       − 4.203 €   (Herleitung → depreciation.md)
  nicht umlagefähige Bewirtschaftung    − 1.000 €
  Erhaltungsaufwand (Reparatur)         −   500 €
= Ergebnis V+V                          − 1.903 €   (steuerlicher Verlust)
```

Hinweise:
- **Tilgung (~4.000 €) ist nicht enthalten** — kein Werbungskosten, obwohl Cash-Abfluss. → zeigt, warum **Cashflow ≠ steuerliches Ergebnis**.
- Zuführung zur Erhaltungsrücklage ist hier **nicht** als WK angesetzt (umstritten; siehe `docs/germany/weg.md`) `VERIFY`.

---

# 8. Klassifikationen im Modell

- `Werbungskosten`-Klassifikation je `TransactionSplit` (nicht am rohen Transaction-Betrag) — Steuer interpretiert, mutiert nicht (`AGENTS.md` §16).
- Acquisition-Cost-Klassifikation (Anschaffung vs. Nebenkosten vs. anschaffungsnah) am Acquisition-Aggregat.
- `umlagefähig`/`nicht umlagefähig` aus `rent-and-operating-costs.md`.
- Steuerjahr (`tax year`) als Domänendatum, getrennt von technischen Timestamps (`AGENTS.md` §21).

---

# 9. Regeldarstellung (gemeinsames Schema für alle germany/*-Docs)

Deutsche Regeln sind **versioniertes Fachwissen** (ADR-022, constitution Art. VII), **keine** Magic Constants. Sie werden als **versionierte, unit-getestete Code-Module** umgesetzt — keine generische Rule Engine (**ADR-041**). Struktur je RuleSet:

```text
TaxRule / RuleSet
├── ruleId / name
├── legalBasis        // z. B. "§ 7 Abs. 4 Nr. 2 Buchst. b EStG"
├── effectiveFrom     // Geltungsbeginn (Fachdatum)
├── effectiveTo?      // Geltungsende (falls befristet)
├── parameters        // z. B. Satz 2 %, Grenze 15 %
├── source/provenance // Fundstelle, Stand, ggf. BMF/BFH-Referenz
└── version           // Regelversion für Reproduzierbarkeit
```

Jede abgeleitete Steuer-/AfA-Zahl referenziert die **angewandte Regelversion**, damit Reports reproduzierbar sind (constitution Art. III; `docs/product/reports.md`).

---

# 10. Offene Punkte / VERIFY

- Grunderwerbsteuersätze je Bundesland als versionierte Parameter erfassen.
- 15 %-Grenze und 3-Jahres-Zeitraum (§ 6 Abs. 1 Nr. 1a) inkl. Ausnahmen präzisieren.
- 10-Tage-Regel (§ 11) und ihre Modellabbildung festlegen.
- Behandlung Erhaltungsrücklagen-Zuführung (WK-Zeitpunkt) rechtlich klären → mit `weg.md` abstimmen.
- Kaufpreisaufteilungs-Methodik (BMF-Arbeitshilfe vs. Gutachten) und deren Datenfelder definieren.
- Verlustverrechnung/-vortrag: MVP-Umfang festlegen.
- Struktur des Steuerjahr-Reports an die aktuell gültige Formularlogik anlehnen (`reports.md` 2.2), ohne ELSTER-Anspruch.
