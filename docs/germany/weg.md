# WEG — Wohnungseigentum & Verwaltung

**Projekt:** Vermieter Cockpit DE
**Version:** 0.1 (Erst-Draft)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — WEG

> **Wichtiger Hinweis (AGENTS.md §30):** Etablierte Regeln des Wohnungseigentumsrechts mit Gesetzesbezug als **versioniertes Fachwissen**, **keine Rechts-/Steuerberatung**. Das WEG wurde durch das **WEMoG zum 1.12.2020** wesentlich reformiert; ältere Quellen sind teils überholt. Jede Angabe ist `VERIFY`-markiert.

---

# 1. Zweck & Prinzip

Definiert die deutsche WEG-Domäne als **eigenständige Fachdomäne** (ADR-017). WEG-Konzepte werden **nicht** in generische MRE-Property-Strukturen eingebettet; die Objektbeziehung läuft über `PropertyReference`. WEG-Abrechnungen werden **nicht** ohne Erhalt ihrer Struktur/Provenienz in Ledger-Transaktionen plattgedrückt (`AGENTS.md` §15).

**MVP-Scope-Hinweis (ADR-018):** unvollständige/komplexe Rücklagen-Sonderfälle werden im MVP bewusst ausgeklammert — bei Bedarf anhalten (`AGENTS.md` §33).

---

# 2. Grundbegriffe

| Begriff | Bedeutung (prüfen) |
|---|---|
| **Wohnungseigentum** | Sondereigentum an der Wohnung + Miteigentumsanteil am Gemeinschaftseigentum |
| **Sondereigentum / Gemeinschaftseigentum** | individuell vs. gemeinschaftlich; bestimmt Kostentragung |
| **Miteigentumsanteil (MEA)** | Bruchteil am Gemeinschaftseigentum; häufiger Verteilungsschlüssel |
| **GdWE** | Gemeinschaft der Wohnungseigentümer; seit WEMoG **rechtsfähig** (§ 9a WEG) `VERIFY` |
| **Verwalter** | vertritt die GdWE (§ 9b WEG) `VERIFY` |
| **Verwaltungsbeirat** | unterstützt/kontrolliert den Verwalter |

---

# 3. Wirtschaftsplan (§ 28 Abs. 1 WEG)

- Vorausschauende Planung der Einnahmen/Ausgaben und der **Vorschüsse (Hausgeld)** je Eigentümer `VERIFY`.
- Aus dem Wirtschaftsplan ergibt sich das monatliche **Hausgeld** und der Anteil der **Zuführung zur Erhaltungsrücklage**.
- Modell: der Wirtschaftsplan ist **Planung**, kein Cash → **keine** Transaktion (`AGENTS.md` §7). Er liefert die Soll-Struktur, gegen die reale Hausgeld-Zahlungen laufen.

---

# 4. Jahresabrechnung (§ 28 Abs. 2 WEG)

- Rückblickende Abrechnung der tatsächlichen Einnahmen/Ausgaben eines Wirtschaftsjahres, mit Einzelabrechnung je Eigentümer `VERIFY`.
- **Seit WEMoG** beschließt die Eigentümerversammlung regelmäßig nur noch die **Abrechnungsspitze** (Nachschüsse bzw. Anpassung der beschlossenen Vorschüsse), nicht mehr die gesamte Abrechnung als solche `VERIFY`.
- Enthält typischerweise **Kostenlinien** (Cost Lines), Verteilungsschlüssel, Rücklagenentwicklung.
- Modell: als **strukturierte** Abrechnung mit erhaltener Statement-Struktur und Provenienz abbilden; Ableitungen in den Ledger nur über nachvollziehbare Splits.

---

# 5. Hausgeld, Rücklage, Sonderumlage

## 5.1 Hausgeld (Vorschüsse)
Monatliche Vorschüsse laut Wirtschaftsplan. Eine Hausgeld-Zahlung ist wirtschaftlich **gemischt** und wird als **`TransactionSplit`** zerlegt, z. B.:

- umlagefähige Betriebskosten (auf Mieter umlegbar → `rent-and-operating-costs.md`)
- nicht umlagefähige Kosten (Verwaltung etc.)
- **Zuführung zur Erhaltungsrücklage**

Summeninvariante `sum(splits)==transaction` (`AGENTS.md` §9).

## 5.2 Erhaltungsrücklage (§ 19 Abs. 2 Nr. 4 WEG)
- Angemessene Ansammlung von Mitteln für künftige Erhaltungsmaßnahmen (früher „Instandhaltungsrücklage"); Glossar nutzt `Erhaltungsrücklage` `VERIFY`.
- **Steuerlicher Kernpunkt (umstritten/nuanciert):** die **Zuführung** zur Erhaltungsrücklage ist beim Vermieter regelmäßig **noch kein Werbungskosten**; abziehbar erst, wenn die **GdWE die Mittel tatsächlich für Erhaltungsmaßnahmen verausgabt** (BFH-Rechtsprechung) `VERIFY` — Rechtsentwicklung beobachten. → im Modell die Rücklagen-Zuführung getrennt führen, damit der spätere WK-Zeitpunkt korrekt abgeleitet werden kann.

## 5.3 Sonderumlage
- Außerordentlicher Beitrag außerhalb des laufenden Hausgelds (z. B. Großreparatur) `VERIFY`.
- Steuerliche Behandlung folgt dem zugrunde liegenden Aufwand (Erhaltung vs. Herstellung → `taxation.md` §6).

---

# 6. Umlagefähigkeit gegenüber dem Mieter

Nicht jede WEG-Kostenlinie ist gegenüber dem Mieter umlagefähig: Verwaltungskosten und Rücklagenzuführung sind es **nicht**; Betriebskosten i. S. der BetrKV grds. schon (→ `rent-and-operating-costs.md` §4). Die WEG-Kostenlinie muss daher auf **umlagefähig/nicht umlagefähig** klassifizierbar sein.

---

# 7. Abbildung im Modell

- Eigenständige WEG-Domäne (ADR-017): `WEG`, `WEG Membership`, `Wirtschaftsplan`, `Jahresabrechnung`, `WEG Cost Line`, `Erhaltungsrücklage`, `Sonderumlage` (domain-model §31–35).
- Objektbezug ausschließlich über `PropertyReference`.
- Plan/Abrechnung sind **kein** Cash; nur reale Hausgeld-/Sonderumlage-**Zahlungen** sind Transaktionen, zerlegt via Splits.
- Statement-Struktur & Provenienz erhalten (`AGENTS.md` §15, §22).
- Regeln (Schlüssel, Rücklagenlogik) als versioniertes Fachwissen nach Schema in `taxation.md` §9 (ADR-022).

---

# 8. Offene Punkte / VERIFY

- Post-WEMoG-Beschlusslogik (nur Abrechnungsspitze) präzise abbilden.
- Steuerlicher WK-Zeitpunkt der Erhaltungsrücklage (Zuführung vs. Verausgabung) rechtlich final klären → mit `taxation.md` abstimmen.
- Verteilungsschlüssel (MEA, Wohnfläche, Verbrauch, Einheiten) als konfigurierbare, aber geführte Schlüssel modellieren.
- MVP-Grenzen der Rücklagen-Sonderfälle (ADR-018) konkret festschreiben.
- Verhältnis WEG-Jahresabrechnung ↔ mieterseitige Betriebskostenabrechnung dokumentieren.
