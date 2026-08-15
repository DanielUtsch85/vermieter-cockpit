# Abschreibung (AfA)

**Projekt:** Vermieter Cockpit DE
**Version:** 0.1 (Erst-Draft)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — AfA / Abschreibung

> **Wichtiger Hinweis (AGENTS.md §30):** Etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**, **keine Steuerberatung**. AfA-Sätze und -Zeiträume sind **zeitabhängig** und wurden in den letzten Jahren mehrfach geändert; jede Angabe ist `VERIFY`-markiert und gegen die aktuelle Fassung des EStG sowie den konkreten Fall zu prüfen.

---

# 1. Zweck & Prinzip

Definiert, wie die **Absetzung für Abnutzung (AfA)** ermittelt wird. AfA ist ein **nicht-zahlungswirksamer** steuerlicher Aufwand → **niemals** eine Ledger-Transaktion (`AGENTS.md` §7, §17). AfA ist **abgeleitet** aus Anschaffungs-/Herstellungskosten und der Kaufpreisaufteilung — die Berechnung ist reproduzierbar und versionsbewusst.

Grundsatz: **Nur der Gebäudeanteil ist abschreibbar. Grund und Boden nicht.**

---

# 2. Musterobjekt (AfA-Basis)

> Illustrativ, `VERIFY`.

- Gesamtanschaffungskosten ≈ 280.175 € (Herleitung → `docs/germany/taxation.md` §2)
- Kaufpreisaufteilung 25 % Grund / 75 % Gebäude `VERIFY`
- **AfA-Bemessungsgrundlage (Gebäude)** ≈ 75 % × 280.175 € ≈ **210.131 €** (inkl. anteiliger Nebenkosten)
- Baujahr 2005 → lineare Gebäude-AfA **2 %** (§ 7 Abs. 4 Nr. 2 Buchst. b EStG) `VERIFY`
- **Jahres-AfA** ≈ 2 % × 210.131 € ≈ **4.203 €**

---

# 3. Lineare Gebäude-AfA (§ 7 Abs. 4 EStG)

Der maßgebliche AfA-Satz für **Wohngebäude** hängt vom **Fertigstellungszeitpunkt** ab `VERIFY` (Buchstaben-Zuordnung und Sätze gegen aktuelle Fassung prüfen):

| Fall | Satz | Grundlage (prüfen) |
|---|---|---|
| Fertigstellung **nach 31.12.2022** | **3 %** | § 7 Abs. 4 Nr. 2 Buchst. a EStG (eingef. JStG 2022) `VERIFY` |
| Fertigstellung **1925 bis 2022** | **2 %** | § 7 Abs. 4 Nr. 2 Buchst. b EStG `VERIFY` |
| Fertigstellung **vor 1925** | **2,5 %** | § 7 Abs. 4 Nr. 2 Buchst. c EStG `VERIFY` |
| Wirtschaftsgebäude (Betriebsvermögen, nicht Wohnzwecke) | 3 % | § 7 Abs. 4 Nr. 1 EStG `VERIFY` |

**Kürzere tatsächliche Nutzungsdauer:** Bei nachgewiesener kürzerer Restnutzungsdauer kann ein höherer Satz zulässig sein (§ 7 Abs. 4 Satz 2 EStG; Nachweis, z. B. Gutachten) `VERIFY`.

---

# 4. Degressive Wohngebäude-AfA (§ 7 Abs. 5a EStG)

Für neu geschaffenen Wohnraum wurde eine **degressive AfA von 5 %** (vom jeweiligen Restwert) eingeführt, an ein **Baubeginn-Zeitfenster** gebunden (Wachstumschancengesetz) — Zeitraum und Voraussetzungen `VERIFY` (Baubeginn ca. **1.10.2023–30.9.2029**, Bestätigung erforderlich). Wechsel zur linearen AfA möglich `VERIFY`.

Für den Bestandskauf des Musterobjekts (2005) **nicht** einschlägig — hier lineare 2 %.

---

# 5. Zeitanteilige AfA & Beginn

- Im **Jahr der Anschaffung** wird die AfA **monatsgenau (pro rata temporis)** angesetzt (§ 7 Abs. 1 Satz 4 EStG, sinngemäß) `VERIFY`. Beispiel: Übergang im April → 9/12 der Jahres-AfA.
- AfA-Beginn = Zeitpunkt der **Anschaffung/Lieferung** (Übergang Nutzen/Lasten) bzw. Fertigstellung.

---

# 6. Weitere AfA-Tatbestände

- **Bewegliche Wirtschaftsgüter** (z. B. Einbauküche, soweit selbständig): lineare AfA über betriebsgewöhnliche Nutzungsdauer (§ 7 Abs. 1 EStG); AfA-Tabellen als Orientierung `VERIFY`.
- **Geringwertige Wirtschaftsgüter (GWG)** (§ 6 Abs. 2 EStG): Sofortabzug bis Grenze (Netto **800 €**) bzw. Sammelposten `VERIFY` (Grenzen/Regeln prüfen).
- **Nachträgliche Anschaffungs-/Herstellungskosten** erhöhen die Bemessungsgrundlage; **anschaffungsnahe Herstellungskosten** (§ 6 Abs. 1 Nr. 1a EStG) fließen in die AfA statt Sofortabzug (→ `docs/germany/taxation.md` §6).
- **Denkmal-/Sanierungs-AfA** (§ 7i, § 7h EStG): erhöhte Absetzungen für Baudenkmale/Sanierungsgebiete — Sonderfall, **später** `VERIFY`.

---

# 7. Beispiel-AfA-Plan (Musterobjekt, linear 2 %)

> Illustrativ.

```text
Bemessungsgrundlage Gebäude   ≈ 210.131 €
Satz                           2 % linear
Jahres-AfA                    ≈ 4.203 €
Nutzungsdauer (rechnerisch)    50 Jahre
Jahr 1 (Erwerb April)         ≈ 9/12 × 4.203 ≈ 3.152 €
Folgejahre                    ≈ 4.203 € p. a. bis Restbuchwert 0
```

Restbuchwert = Bemessungsgrundlage − kumulierte AfA (abgeleitet, kein Cash).

---

# 8. Abbildung im Modell

- **Abgeleitet, nicht Cash:** AfA-Pläne werden aus Acquisition + Kaufpreisaufteilung berechnet (`AGENTS.md` §17). Anschaffungswahrheit wird nicht überschrieben, um eine Berechnung zu erleichtern.
- **Reproduzierbar & versionsbewusst:** jede AfA-Zeile referenziert die angewandte AfA-Regelversion (Satz, Grundlage, Geltungszeitraum) nach dem Regeldarstellungs-Schema in `docs/germany/taxation.md` §9 (ADR-022).
- **Speisung Steuerjahr:** die Jahres-AfA fließt als Werbungskosten in die Ermittlung in `docs/germany/taxation.md` §3 und in `docs/product/reports.md` 2.3.
- Abhängigkeit: Kaufpreisaufteilung ist ein Acquisition-Input (ADR-010); ohne sie keine AfA-Basis.

---

# 9. Offene Punkte / VERIFY

- Alle Sätze/Stichtage (§ 7 Abs. 4 Nr. 2 Buchst. a–c) gegen die aktuelle EStG-Fassung bestätigen.
- Degressive AfA (§ 7 Abs. 5a): Zeitfenster, Baubeginn-Definition, Wechseloption verifizieren.
- Monatsgenaue AfA im Erwerbsjahr und AfA-Beginn präzise regeln.
- GWG-Grenzen und Sammelposten-Regeln bestätigen.
- Kürzere Nutzungsdauer (§ 7 Abs. 4 S. 2): Nachweisanforderungen und Datenfelder.
- Denkmal-/Sanierungs-AfA als späteren Umfang einplanen.
