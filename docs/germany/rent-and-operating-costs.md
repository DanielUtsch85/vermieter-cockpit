# Miete, Betriebskosten und Abrechnung

**Projekt:** Vermieter Cockpit DE
**Version:** 0.1 (Erst-Draft)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — Miete & Betriebskosten

> **Wichtiger Hinweis (AGENTS.md §30):** Dieses Dokument beschreibt etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**. Es ist **keine Rechts- oder Steuerberatung**. Jede konkrete Zahl, Frist und Quote ist mit `VERIFY` markiert und vor Implementierung gegen die aktuelle Rechtslage und ggf. durch eine fachkundige Person zu prüfen. Regeln sind **nicht zeitlos** — sie tragen im Modell Geltungszeitraum und Quelle.

---

# 1. Zweck & Abgrenzung

Dieses Dokument definiert, wie Miete und Betriebskosten fachlich zu verstehen sind und wie die **mietrechtliche** von der **steuerlichen** Sicht getrennt wird. Es liefert die Grundlagen für:

- die Klassifikation `umlagefähig` / `nicht umlagefähig` (Glossar),
- die Aufteilung von Zahlungen in `TransactionSplit`s (z. B. Hausgeld),
- die Werbungskosten-Ermittlung in `docs/germany/taxation.md`.

Nicht Gegenstand: WEG-interne Abrechnung (→ `docs/germany/weg.md`), AfA (→ `docs/germany/depreciation.md`).

---

# 2. Musterobjekt (durchgängiges Beispiel)

> Erfundene, illustrative Zahlen — kein realer Fall.

Eine vermietete **Eigentumswohnung (ETW)**, 70 m² Wohnfläche, Baujahr 2005, in einer WEG, fremdfinanziert.

- Nettokaltmiete: 900 €/Monat (10.800 €/Jahr)
- Betriebskostenvorauszahlung des Mieters: 200 €/Monat (2.400 €/Jahr)
- Hausgeld an die WEG: 300 €/Monat (3.600 €/Jahr), davon ~180 € umlagefähige Betriebskosten, ~60 € Zuführung Erhaltungsrücklage, ~60 € Verwaltung/nicht umlagefähig `VERIFY` (Aufteilung ergibt sich real aus dem Wirtschaftsplan)

---

# 3. Mietbegriffe

| Begriff | Bedeutung |
|---|---|
| **Nettokaltmiete** (Grundmiete) | Miete ohne Betriebskosten |
| **Betriebskostenvorauszahlung** | monatliche Vorauszahlung auf umlagefähige Betriebskosten, jährlich abzurechnen |
| **Betriebskostenpauschale** | pauschale Abgeltung ohne Einzelabrechnung (Alternative zur Vorauszahlung) |
| **Bruttokaltmiete** | Nettokaltmiete + kalte Betriebskosten |
| **Warmmiete / Bruttowarmmiete** | inkl. Heiz-/Warmwasserkosten |

Für das Datenmodell ist die **Nettokaltmiete** die zentrale Ertragsgröße; Betriebskosten sind separat zu führen (siehe §6).

---

# 4. Betriebskosten: umlagefähig vs. nicht umlagefähig

## 4.1 Umlagefähige Betriebskosten
Rechtsgrundlage: **§ 556 BGB** i. V. m. **Betriebskostenverordnung (BetrKV)**. Der Katalog des **§ 2 BetrKV** nennt die umlagefähigen Kostenarten `VERIFY` (Katalog vollständig gegen aktuelle BetrKV prüfen), u. a.:

- laufende öffentliche Lasten (Grundsteuer)
- Wasserversorgung, Entwässerung
- Heizung und Warmwasser (Betrieb)
- Aufzug, Straßenreinigung, Müllbeseitigung
- Gebäudereinigung, Ungezieferbekämpfung
- Gartenpflege
- Beleuchtung (Allgemeinflächen)
- Schornsteinreinigung
- Sach- und Haftpflichtversicherung
- Hauswart
- Gemeinschaftsantenne/Breitband `VERIFY` (Rechtslage zur Umlage von TV/Breitband hat sich geändert)
- sonstige Betriebskosten (nur bei ausdrücklicher Vereinbarung)

**Umlagefähig ist nur, was vereinbart ist:** ohne wirksame Umlagevereinbarung im Mietvertrag trägt der Vermieter die Kosten `VERIFY`.

## 4.2 Nicht umlagefähige Kosten
Nicht auf den Mieter umlegbar (verbleiben beim Vermieter), insbesondere:

- **Verwaltungskosten** (§ 1 Abs. 2 Nr. 1 BetrKV)
- **Instandhaltung / Instandsetzung / Reparaturen** (§ 1 Abs. 2 Nr. 2 BetrKV)
- Zuführung zur **Erhaltungsrücklage** (WEG-intern)
- Zinsen/Tilgung, Kontoführung

Diese Kosten sind mietrechtlich beim Vermieter, steuerlich aber regelmäßig **Werbungskosten** (siehe `docs/germany/taxation.md`).

---

# 5. Betriebskostenabrechnung

- **Abrechnungszeitraum:** i. d. R. 12 Monate.
- **Abrechnungsfrist:** spätestens **12 Monate nach Ende des Abrechnungszeitraums** muss abgerechnet werden (**§ 556 Abs. 3 BGB**) `VERIFY`; verspätete Nachforderungen sind grds. ausgeschlossen.
- **Einwendungsfrist des Mieters:** 12 Monate nach Zugang der Abrechnung `VERIFY`.
- **Umlageschlüssel:** nach Vereinbarung; ohne Vereinbarung Auffangschlüssel **Wohnfläche** (**§ 556a Abs. 1 BGB**) `VERIFY`. Verbrauchsabhängige Kosten nach Verbrauch.
- **Heizkosten:** **HeizkostenV** verlangt überwiegend verbrauchsabhängige Abrechnung (regelmäßig 50–70 %) `VERIFY` (genaue Quote und Ausnahmen prüfen).

---

# 6. Mietrechtliche vs. steuerliche Sicht (zentral fürs Modell)

Beide Sichten greifen auf **dieselben** Ledger-Transaktionen zu (constitution Art. II), interpretieren sie aber unterschiedlich:

| Cash-Vorgang | Mietrechtlich | Steuerlich (Vermieter) |
|---|---|---|
| Nettokaltmiete zufließend | Grundmiete | Einnahme aus V+V |
| Betriebskostenvorauszahlung zufließend | Vorauszahlung, abzurechnen | Einnahme (durchlaufend) |
| Umlagefähige Kosten verausgabt | vom Mieter zu tragen | Werbungskosten (durch Umlage neutralisiert) |
| Nicht umlagefähige Kosten verausgabt | Vermieter trägt | Werbungskosten (mindern Ergebnis) |

**Merksatz:** Umlagefähige Betriebskosten sind für den Vermieter wirtschaftlich **durchlaufende Posten** (Einnahme + korrespondierende Werbungskosten), nicht umlagefähige Kosten mindern das steuerliche Ergebnis unmittelbar.

---

# 7. Abbildung im Modell (versioniertes Fachwissen)

- **Cash-only Ledger:** Miete/Betriebskosten sind Cash-Vorgänge → `Transaction`. Vorausschauende Sollstellungen sind **keine** Transaktionen (`AGENTS.md` §7); operative Miet-Sollstellung bleibt in MRE und wird über `RentPaymentReconciliation` verbunden.
- **Hausgeld-Split:** eine Hausgeld-Zahlung enthält mehrere wirtschaftliche Bedeutungen → **`TransactionSplit`** (umlagefähig / nicht umlagefähig / Rücklagenzuführung), Summeninvariante `sum(splits)==transaction` (`AGENTS.md` §9).
- **Klassifikation:** `umlagefähig`/`nicht umlagefähig` ist eine **Interpretation** über dem Split, keine Mutation des Cash-Werts (`AGENTS.md` §16).
- **Regeldarstellung:** Kataloge/Fristen/Quoten dieses Dokuments werden als **RuleSet mit Geltungszeitraum + Quellenangabe (§)** hinterlegt (ADR-022), nicht als Magic Constants (siehe gemeinsames Schema in `docs/germany/taxation.md` §"Regeldarstellung").

---

# 8. Offene Punkte / VERIFY

- BetrKV-§2-Katalog vollständig und aktuell verifizieren (inkl. Breitband/TV-Umlage-Änderungen).
- Genaue Fristen (§ 556 Abs. 3 BGB) und Einwendungsfrist bestätigen.
- HeizkostenV-Quoten und Ausnahmen präzisieren.
- Behandlung von Betriebskostenpauschale vs. Vorauszahlung im Datenmodell festlegen.
- Zusammenspiel mit der WEG-Jahresabrechnung (welche WEG-Kostenlinie ist gegenüber dem Mieter umlagefähig) mit `docs/germany/weg.md` abstimmen.
