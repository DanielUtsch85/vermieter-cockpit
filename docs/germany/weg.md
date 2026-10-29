# WEG — Wohnungseigentum & Verwaltung

**Projekt:** Vermieter Cockpit DE
**Version:** 0.2 (fachlich verifiziert/überarbeitet)
**Stand der Prüfung:** 29.10.2026
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — WEG

> **Hinweis:** Dieses Dokument beschreibt allgemeine Rechts- und Modellierungsregeln für Deutschland und ersetzt keine Rechts- oder Steuerberatung im Einzelfall. Gesetzes- und Rechtsprechungsstände müssen als versioniertes Fachwissen mit Geltungszeitraum und Quelle gespeichert werden.

---

# 1. Zweck & Prinzip

Definiert die deutsche WEG-Domäne als **eigenständige Fachdomäne** (ADR-017). WEG-Konzepte werden **nicht** in generische MRE-Property-Strukturen eingebettet; die Objektbeziehung läuft über `PropertyReference`. WEG-Abrechnungen werden **nicht** ohne Erhalt ihrer Struktur/Provenienz in Ledger-Transaktionen plattgedrückt (`AGENTS.md` §15).

**MVP-Scope-Hinweis (ADR-018):** Unvollständige oder komplexe Rücklagen-Sonderfälle werden im MVP bewusst ausgeklammert; nicht sicher ableitbare Fälle sind als prüfpflichtig zu behandeln.

---

# 2. Grundbegriffe

| Begriff | Verifizierte Bedeutung |
|---|---|
| **Wohnungseigentum** | Sondereigentum an einer Wohnung in Verbindung mit dem Miteigentumsanteil am gemeinschaftlichen Eigentum (§ 1 Abs. 2 WEG). |
| **Sondereigentum / Gemeinschaftseigentum** | Sondereigentum ist dem jeweiligen Eigentümer zugeordnet; gemeinschaftliches Eigentum umfasst insbesondere Grundstück und Gebäude, soweit sie nicht im Sondereigentum oder im Eigentum eines Dritten stehen (§ 1 WEG). |
| **Miteigentumsanteil (MEA)** | Bruchteil am gemeinschaftlichen Eigentum; gesetzlicher Ausgangspunkt für die Kostenverteilung ist § 16 WEG, soweit Gesetz, Vereinbarung oder Beschluss nichts Abweichendes bestimmen. |
| **GdWE** | Die Gemeinschaft der Wohnungseigentümer kann nach § 9a WEG Rechte erwerben, Verbindlichkeiten eingehen, klagen und verklagt werden. **Korrektur:** Die Rechtsfähigkeit entstand nicht erst mit dem WEMoG; sie war bereits vor dem 01.12.2020 anerkannt. Das WEMoG hat die Stellung der GdWE neu geordnet und ausdrücklich in § 9a WEG geregelt. |
| **Verwalter** | Vertritt die GdWE gerichtlich und außergerichtlich nach § 9b WEG; für Grundstückskauf- oder Darlehensverträge ist ein Eigentümerbeschluss erforderlich. |
| **Verwaltungsbeirat** | Unterstützt und überwacht den Verwalter (§ 29 Abs. 2 WEG). |

---

# 3. Wirtschaftsplan (§ 28 Abs. 1 WEG)

- Die Wohnungseigentümer **beschließen über die Vorschüsse zur Kostentragung und zu Rücklagen**. Zu diesem Zweck stellt der Verwalter für jedes Kalenderjahr einen Wirtschaftsplan auf, der auch die voraussichtlichen Einnahmen und Ausgaben enthält.
- **Präzisierung:** Nicht der Wirtschaftsplan als Dokument allein, sondern der Beschluss über die Vorschüsse begründet die Zahlungspflichten.
- Das monatliche Hausgeld kann Anteile für laufende Kosten und für die Zuführung zur Erhaltungsrücklage enthalten.
- Modell: Wirtschaftsplan und Vorschussbeschluss sind **Soll-/Plan-Daten**, keine Cash-Transaktionen. Erst tatsächliche Zahlungen sind Ledger-Ereignisse.

**Quelle:** § 28 Abs. 1 WEG.

---

# 4. Jahresabrechnung (§ 28 Abs. 2 WEG)

- Nach Ablauf des Kalenderjahres stellt der Verwalter eine **Abrechnung über den Wirtschaftsplan (Jahresabrechnung)** auf; sie enthält darüber hinaus die tatsächlichen Einnahmen und Ausgaben.
- Die Wohnungseigentümer beschließen nach geltendem Recht **über die Einforderung von Nachschüssen oder die Anpassung der beschlossenen Vorschüsse**. Die Jahresabrechnung selbst ist damit die rechnerische Grundlage des Beschlusses; Gegenstand des Beschlusses ist nicht mehr die „Genehmigung der gesamten Abrechnung“ nach altem Recht.
- Die Fälligkeit kann durch Beschluss nach § 28 Abs. 3 WEG bestimmt werden.
- Der Verwalter hat zusätzlich nach § 28 Abs. 4 WEG einen **Vermögensbericht** zu erstellen, der insbesondere den Stand der Rücklagen und das wesentliche Gemeinschaftsvermögen ausweist.
- Modell: Jahresabrechnung und Vermögensbericht als **strukturierte Statements** mit Kostenlinien, Verteilungsschlüssel und Provenienz abbilden; Ledger-Ableitungen nur über nachvollziehbare Splits.

**Geltung:** aktuelle Systematik seit 01.12.2020 (WEMoG).

---

# 5. Hausgeld, Erhaltungsrücklage und Sonderumlage

## 5.1 Hausgeld / Vorschüsse

Eine tatsächliche Hausgeldzahlung kann wirtschaftlich mehrere Komponenten enthalten und wird im Modell als `TransactionSplit` zerlegt, z. B.:

- umlagefähige Betriebskosten,
- nicht umlagefähige Kosten (z. B. Verwaltung),
- Zuführung zur Erhaltungsrücklage.

Summeninvariante: `sum(splits) == transaction`.

## 5.2 Erhaltungsrücklage (§ 19 Abs. 2 Nr. 4 WEG)

- Zur ordnungsmäßigen Verwaltung gehört die **Ansammlung einer angemessenen Erhaltungsrücklage**.
- Der heute gesetzlich verwendete Begriff ist `Erhaltungsrücklage`; ältere Unterlagen verwenden häufig `Instandhaltungsrücklage` oder `Instandhaltungsrückstellung`.
- **Steuerlich verifiziert:** Die Zuführung von Hausgeld zur Erhaltungsrücklage ist beim vermietenden Wohnungseigentümer **noch keine Werbungskosten**. Der Werbungskostenabzug entsteht erst, wenn und soweit die GdWE die Mittel tatsächlich für Maßnahmen verausgabt, die bei direkter Zahlung Werbungskosten wären.
- Das gilt nach BFH, Urteil vom **14.01.2025 – IX R 19/24**, ausdrücklich auch unter Berücksichtigung der seit 01.12.2020 geltenden WEG-Rechtslage.
- Konsequenz für das Modell: Rücklagenzuführung und spätere Mittelverwendung müssen getrennt gespeichert werden. Die Verwendung muss zusätzlich steuerlich klassifiziert werden (z. B. Erhaltungsaufwand vs. Herstellungs-/Anschaffungskosten).

## 5.3 Sonderumlage

- Eine Sonderumlage ist eine zusätzliche, außerhalb der laufenden Vorschüsse beschlossene Zahlung zur Deckung eines besonderen Finanzbedarfs der GdWE.
- **Steuerliche Präzisierung:** Die bloße Zahlung einer Sonderumlage führt nicht automatisch zu sofort abziehbaren Werbungskosten. Entscheidend ist, wann und wofür die GdWE die Mittel tatsächlich verwendet. Bei Erhaltungsaufwand kann ein Werbungskostenabzug entstehen; bei Herstellungs-/Anschaffungskosten erfolgt die steuerliche Berücksichtigung grundsätzlich über die AfA.
- Modell: Sonderumlage als eigener Vorgang mit Zweck, Beschluss, Zahlung und tatsächlicher Mittelverwendung führen.

---

# 6. Umlagefähigkeit gegenüber dem Mieter

WEG-Kosten und mietrechtliche Betriebskosten sind **nicht deckungsgleich**.

- Umlagefähig sind nur Betriebskosten, deren Übernahme mietvertraglich wirksam vereinbart ist und die unter § 556 BGB i. V. m. BetrKV bzw. Spezialvorschriften fallen.
- Verwaltungskosten sowie Zuführungen zur Erhaltungsrücklage sind keine umlagefähigen Betriebskosten.
- Instandhaltung und Instandsetzung sind grundsätzlich keine Betriebskosten.
- **Wichtige Besonderheit für vermietetes Wohnungseigentum:** Haben die Mietvertragsparteien keinen anderen Umlageschlüssel vereinbart, werden Betriebskosten nach § 556a Abs. 3 BGB grundsätzlich nach dem zwischen den Wohnungseigentümern geltenden Verteilungsschlüssel umgelegt. Nur wenn dieser Maßstab billigem Ermessen widerspricht, gilt die Auffangregel des § 556a Abs. 1 BGB.
- TV-/Breitbandkosten: Seit **01.07.2024** dürfen laufende Grundentgelte für den TV-/Breitbandanschluss nicht mehr über das frühere Nebenkostenprivileg pauschal auf Mieter umgelegt werden. § 2 Nr. 15 BetrKV enthält nur noch begrenzte umlagefähige Betriebsbestandteile; für Glasfaser gelten besondere Regeln.

**Modell:** Jede WEG-Kostenlinie benötigt getrennte Merkmale für:
1. WEG-Verteilung,
2. mietrechtliche Umlagefähigkeit,
3. mietvertraglichen Umlageschlüssel,
4. steuerliche Einordnung beim Vermieter.

---

# 7. Abbildung im Modell

- Eigenständige WEG-Domäne: `WEG`, `WEG Membership`, `Wirtschaftsplan`, `Vorschussbeschluss`, `Jahresabrechnung`, `Vermögensbericht`, `WEG Cost Line`, `Erhaltungsrücklage`, `Sonderumlage`.
- Objektbezug ausschließlich über `PropertyReference`.
- Plan-/Abrechnungsdokumente sind **keine Cash-Transaktionen**; tatsächliche Hausgeld- und Sonderumlagezahlungen sind Transaktionen.
- Rücklagenzuführung und Rücklagenverbrauch strikt getrennt führen.
- Statement-Struktur und Provenienz erhalten.
- Rechtsregeln mit `validFrom`, ggf. `validTo`, Fundstelle und Versionshinweis speichern.
- Bei mietrechtlicher Umlage von WEG-Kosten § 556a Abs. 3 BGB als eigenen Entscheidungszweig modellieren.

---

# 8. Verifizierte Regeln / verbleibende fachliche Grenzen

## Verifiziert

- § 28 Abs. 1 WEG: Beschluss über Vorschüsse/Rücklagen; Wirtschaftsplan als Grundlage.
- § 28 Abs. 2 WEG: Beschluss über Nachschüsse bzw. Anpassung der Vorschüsse; Jahresabrechnung als Grundlage.
- § 28 Abs. 4 WEG: Vermögensbericht.
- § 9a / § 9b WEG: Rechtsstellung der GdWE und Vertretung durch den Verwalter.
- § 19 Abs. 2 Nr. 4 WEG: angemessene Erhaltungsrücklage.
- BFH IX R 19/24: kein Werbungskostenabzug bereits bei Zuführung zur Erhaltungsrücklage.
- § 556a Abs. 3 BGB: Sonderregel für vermietetes Wohnungseigentum.
- Verwaltungskosten, Instandhaltung/Instandsetzung und Rücklagenzuführung sind nicht als laufende Betriebskosten auf den Wohnraummieter umlagefähig.

## Weiter fallabhängig / im MVP konservativ behandeln

- Steuerliche Einordnung konkreter Sonderumlagen und konkreter Rücklagenverwendungen.
- Abgrenzung Erhaltungsaufwand / Herstellungskosten / anschaffungsnahe Herstellungskosten.
- Abweichende Kostenverteilungsbeschlüsse nach § 16 WEG.
- Sonderregeln für bauliche Veränderungen.
- Gewerberaummiete; dort gelten die zwingenden Wohnraumschutzregeln nicht in gleicher Weise.

---

# 9. Quellen (Stand 29.10.2026)

1. WEG § 1: https://www.gesetze-im-internet.de/woeigg/__1.html
2. WEG § 9a: https://www.gesetze-im-internet.de/woeigg/__9a.html
3. WEG § 9b: https://www.gesetze-im-internet.de/woeigg/__9b.html
4. WEG § 19: https://www.gesetze-im-internet.de/woeigg/__19.html
5. WEG § 28: https://www.gesetze-im-internet.de/woeigg/__28.html
6. BGB § 556: https://www.gesetze-im-internet.de/bgb/__556.html
7. BGB § 556a: https://www.gesetze-im-internet.de/bgb/__556a.html
8. BetrKV § 2: https://www.gesetze-im-internet.de/betrkv/__2.html
9. BFH, Urteil 14.01.2025 – IX R 19/24: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE202510025/
10. Bundesnetzagentur, Ende des Nebenkostenprivilegs: https://www.bundesnetzagentur.de/DE/Vportal/TK/InternetTelefon/Nebenkostenprivileg/artikel.html
