# Miete, Betriebskosten und Abrechnung

**Projekt:** Vermieter Cockpit DE
**Version:** 0.2 (Ergebnisse der Prüfliste übernommen)
**Stand der Prüfung:** 29.10.2026 (`verification-checklist.md` v0.2, Abschnitt D, E3, E4)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — Miete & Betriebskosten

> **Hinweis (AGENTS.md §30):** Dieses Dokument beschreibt etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**. Es ist **keine Rechts- oder Steuerberatung** im Einzelfall. Zahlen, Fristen und Quoten sind gegen die aktuelle Rechtslage geprüft (Stand 29.10.2026, Fundstellen in der Prüfliste). Regeln sind **nicht zeitlos** — sie tragen im Modell Geltungszeitraum und Quelle.

---

# 1. Zweck & Abgrenzung

Dieses Dokument definiert, wie Miete und Betriebskosten fachlich zu verstehen sind und wie die **mietrechtliche** von der **steuerlichen** Sicht getrennt wird. Es liefert die Grundlagen für:

- die Klassifikation `umlagefähig` / `nicht umlagefähig` (Glossar),
- die Aufteilung von Zahlungen in `TransactionSplit`s (z. B. Hausgeld),
- die Werbungskosten-Ermittlung in `docs/germany/taxation.md`.

Nicht Gegenstand: WEG-interne Abrechnung (→ `docs/germany/weg.md`), AfA (→ `docs/germany/depreciation.md`). Mietrecht für Gewerberaum: Dort gelten die zwingenden Wohnraumschutzregeln nicht in gleicher Weise; dieses Dokument beschreibt Wohnraum.

---

# 2. Musterobjekt (durchgängiges Beispiel)

> Erfundene, illustrative Zahlen — kein realer Fall.

Eine vermietete **Eigentumswohnung (ETW)**, 70 m² Wohnfläche, Baujahr 2005, in einer WEG, fremdfinanziert.

- Nettokaltmiete: 900 €/Monat (10.800 €/Jahr)
- Betriebskostenvorauszahlung des Mieters: 200 €/Monat (2.400 €/Jahr)
- Hausgeld an die WEG: 300 €/Monat (3.600 €/Jahr), davon ~180 € umlagefähige Betriebskosten, ~60 € Zuführung Erhaltungsrücklage, ~60 € Verwaltung/nicht umlagefähig (illustrativ; real ergibt sich die Aufteilung aus dem Wirtschaftsplan und erst endgültig aus der Jahresabrechnung)

---

# 3. Mietbegriffe

| Begriff | Bedeutung |
|---|---|
| **Nettokaltmiete** (Grundmiete) | Miete ohne Betriebskosten |
| **Betriebskostenvorauszahlung** | monatliche Vorauszahlung auf umlagefähige Betriebskosten, jährlich abzurechnen |
| **Betriebskostenpauschale** | pauschale Abgeltung; grundsätzlich keine kostenbezogene Jahresabrechnung wie bei Vorauszahlungen. Spezialrecht (insb. HeizkostenV) bleibt zu beachten (E3) |
| **Bruttokaltmiete** | Nettokaltmiete + kalte Betriebskosten |
| **Warmmiete / Bruttowarmmiete** | inkl. Heiz-/Warmwasserkosten |

Für das Datenmodell ist die **Nettokaltmiete** die zentrale Ertragsgröße; Betriebskosten sind separat zu führen (siehe §6). Das Modell trennt `PAUSCHALE` und `VORAUSZAHLUNG`, weil nur die Vorauszahlung die Abrechnung nach §5 auslöst (E3).

---

# 4. Betriebskosten: umlagefähig vs. nicht umlagefähig

## 4.1 Umlagefähige Betriebskosten
Rechtsgrundlage: **§ 556 BGB** i. V. m. **Betriebskostenverordnung (BetrKV)**. Der Katalog des **§ 2 BetrKV** hat **17 Nummern**; Nr. 17 ist die Auffangposition „sonstige Betriebskosten“ (D1). Er nennt u. a.:

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
- Antennen-, Breitband- und Glasfaseranlagen (Nr. 15), **seit 01.07.2024 nur noch begrenzt** (D2): Das Nebenkostenprivileg für laufende TV-/Breitbandentgelte endete am 30.06.2024. Monatliche Anschluss- und Grundentgelte werden seither nicht mehr über die Betriebskosten abgerechnet. Umlagefähig bleiben nur die in Nr. 15 genannten Kosten; für Glasfaser kann ein Bereitstellungsentgelt nach § 556 Abs. 3a BGB/§ 72 TKG gelten. Datierte Regel mit Stichtag.
- sonstige Betriebskosten (Nr. 17; nur wenn hinreichend bestimmt vereinbart)

**Umlagefähig ist nur, was vereinbart ist (§ 556 Abs. 1 BGB, D3):** Ohne wirksame Umlagevereinbarung im Mietvertrag trägt der Vermieter die Kosten. Eine zulässige allgemeine Verweisung auf die BetrKV kann genügen; „sonstige Betriebskosten“ müssen hinreichend bestimmt vereinbart sein.

## 4.2 Nicht umlagefähige Kosten
Nicht auf den Mieter umlegbar (verbleiben beim Vermieter), insbesondere:

- **Verwaltungskosten** (§ 1 Abs. 2 Nr. 1 BetrKV)
- **Instandhaltung / Instandsetzung / Reparaturen** (§ 1 Abs. 2 Nr. 2 BetrKV)
- Zuführung zur **Erhaltungsrücklage** (WEG-intern)
- Zinsen/Tilgung, Kontoführung

Diese Kosten sind mietrechtlich beim Vermieter. Steuerlich sind sie regelmäßig **Werbungskosten**, soweit sie einkunftsbezogen sind (siehe `docs/germany/taxation.md`). Ausnahme: Die Rücklagenzuführung wird erst bei Verwendung durch die WEG zu Werbungskosten (`weg.md` §5.2).

---

# 5. Betriebskostenabrechnung

- **Abrechnungszeitraum:** i. d. R. 12 Monate.
- **Abrechnungsfrist (§ 556 Abs. 3 BGB, D4):** Die Abrechnung über Vorauszahlungen muss dem Mieter spätestens bis zum Ablauf des **12. Monats** nach Ende des Abrechnungszeitraums zugehen. Danach sind Nachforderungen grundsätzlich ausgeschlossen, außer der Vermieter hat die Verspätung nicht zu vertreten.
- **Einwendungsfrist des Mieters (D5):** spätestens **12 Monate nach Zugang** der Abrechnung, außer die Verspätung ist nicht zu vertreten.
- **Umlageschlüssel (§ 556a BGB, D6):**
  - zuerst gilt die Vereinbarung;
  - **vermietetes Wohnungseigentum (Abs. 3):** ohne abweichende Vereinbarung grundsätzlich der zwischen den Wohnungseigentümern geltende Verteilungsschlüssel; widerspricht er billigem Ermessen, gilt Abs. 1;
  - **sonst (Abs. 1):** grundsätzlich Wohnfläche; verbrauchs- oder verursachungsabhängige Kosten nach Verbrauch bzw. Verursachung.
- **Heizkosten (§ 7 HeizkostenV, D7):** grundsätzlich **mindestens 50 %, höchstens 70 %** nach erfasstem Verbrauch. In bestimmten älteren öl- oder gasbeheizten Gebäuden sind 70 % zwingend. Ausnahmen ergeben sich insbesondere aus § 11 HeizkostenV.

---

# 6. Mietrechtliche vs. steuerliche Sicht (zentral fürs Modell)

Beide Sichten greifen auf **dieselben** Ledger-Transaktionen zu (constitution Art. II), interpretieren sie aber unterschiedlich:

| Cash-Vorgang | Mietrechtlich | Steuerlich (Vermieter) |
|---|---|---|
| Nettokaltmiete zufließend | Grundmiete | Einnahme aus V+V |
| Betriebskostenvorauszahlung zufließend | Vorauszahlung, abzurechnen | Einnahme |
| Umlagefähige Kosten verausgabt | vom Mieter zu tragen | Werbungskosten |
| Nicht umlagefähige Kosten verausgabt | Vermieter trägt | Werbungskosten (mindern Ergebnis) |

**Merksatz (D8):** Umlagen und Vorauszahlungen des Mieters sind steuerlich **Einnahmen**; die vom Vermieter getragenen umlagefähigen Kosten sind **Werbungskosten**. Bei gleicher Höhe gleichen sie sich wirtschaftlich oft aus, sie sind aber **keine** „durchlaufenden Posten“ außerhalb der Einnahmen- und Werbungskostenerfassung: Beide werden erfasst, in ihrem jeweiligen Zu- bzw. Abflussjahr. Nicht umlagefähige, einkunftsbezogene Kosten sind ebenfalls Werbungskosten und mindern das Ergebnis unmittelbar.

**WEG-Jahresabrechnung ≠ Betriebskostenabrechnung (E4):** Die WEG-Abrechnung ist keine mieterseitige Abrechnung. Ihre Kostenlinien werden nach Mietvertrag, BetrKV und Spezialrecht klassifiziert und ggf. nach § 556a Abs. 3 BGB mit dem WEG-Schlüssel auf den Mieter übertragen (`weg.md` §6).

---

# 7. Abbildung im Modell (versioniertes Fachwissen)

- **Cash-only Ledger:** Miete/Betriebskosten sind Cash-Vorgänge → `Transaction`. Vorausschauende Sollstellungen sind **keine** Transaktionen (`AGENTS.md` §7); operative Miet-Sollstellung bleibt in MRE und wird über `RentPaymentReconciliation` verbunden.
- **Hausgeld-Split:** eine Hausgeld-Zahlung enthält mehrere wirtschaftliche Bedeutungen → **`TransactionSplit`** (umlagefähig / nicht umlagefähig / Rücklagenzuführung), Summeninvariante `sum(splits)==transaction` (`AGENTS.md` §9).
- **Klassifikation:** `umlagefähig`/`nicht umlagefähig` ist eine **Interpretation** über dem Split, keine Mutation des Cash-Werts (`AGENTS.md` §16).
- **Regeldarstellung:** Kataloge/Fristen/Quoten dieses Dokuments werden als **RuleSet mit Geltungszeitraum + Quellenangabe (§)** hinterlegt (ADR-022), nicht als Magic Constants (siehe gemeinsames Schema in `docs/germany/taxation.md` §"Regeldarstellung").

---

# 8. Offene Punkte

- Die mieterseitige Betriebskostenabrechnung (Phase 7/9) aus den WEG-Kostenlinien spezifizieren: Umlagefähigkeit, Schlüssel nach § 556a Abs. 3 BGB, Fristen nach §5.
- Die Liste der Fälle, in denen nach HeizkostenV 70 % zwingend sind, und die Ausnahmen nach § 11 als RuleSet ausarbeiten, wenn Heizkosten abgerechnet werden.
- Glasfaser-Bereitstellungsentgelt (§ 556 Abs. 3a BGB/§ 72 TKG) erst modellieren, wenn ein realer Fall es braucht.
- Gewerberaummiete bleibt außerhalb des MVP.
