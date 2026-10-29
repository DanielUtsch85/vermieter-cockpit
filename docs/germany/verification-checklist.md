# Prüfliste: rechtliche/steuerliche Verifikation der germany/*-Entwürfe

**Projekt:** Vermieter Cockpit DE
**Version:** 0.2 (recherchiert und ausgefüllt)
**Prüfstand:** 29.10.2026
**Bezug:** `docs/germany/taxation.md`, `depreciation.md`, `weg.md`, `rent-and-operating-costs.md`

> **Einordnung:** Die Ergebnisse beruhen auf dem beigefügten Merkblatt, aktuellem Gesetzesrecht, BMF-Verwaltungsquellen und BFH-Rechtsprechung. Das Merkblatt ist eine nützliche Sekundärquelle, aber nicht in jedem Punkt aktuell und enthält mindestens einen offensichtlichen Rechen-/Redaktionsfehler bei der AfA-Beispielrechnung (Gebäudeanteil 400.000 €, danach wird dennoch 600.000 € × 3 % gerechnet). Für die Implementierung haben Gesetz, aktuelle Verwaltungshinweise und Rechtsprechung Vorrang.

**Scope:** Vermietung im Privatvermögen (§ 21 EStG), Buy-and-Hold, vermietete Eigentumswohnung in einer WEG. Kein gewerblicher Grundstückshandel, kein Betriebsvermögen, keine USt-Option, keine ELSTER-Implementierung.

**Legende:**
- `OK` = Aussage kann in dieser Form verwendet werden.
- `KORREKTUR` = Aussage ist falsch, zu pauschal oder benötigt eine entscheidende Ergänzung.
- `NUANCE` = Grundgedanke stimmt, aber Implementierung muss weitere Voraussetzungen abbilden.

---

## A. Besteuerung der Vermietung (`taxation.md`)

| Nr. | Ergebnis | Verifizierte Fassung / Implementierungshinweis |
|---|---|---|
| **A1** | **OK + NUANCE** | Schuldzinsen sind nach § 9 Abs. 1 S. 3 Nr. 1 EStG Werbungskosten, soweit sie wirtschaftlich der Vermietung zugeordnet sind; Tilgung ist nicht abziehbar. Vorab entstandene WK sind bei hinreichend konkreter Vermietungsabsicht möglich. Marktübliches Damnum/Disagio wird von § 11 Abs. 2 S. 3 nicht über die Nutzungsdauer verteilt (§ 11 Abs. 2 S. 4). Bereitstellungszinsen sind bei Finanzierungszusammenhang grundsätzlich ebenfalls als Finanzierungskosten einzuordnen. |
| **A2** | **KORREKTUR (Schwelle)** | § 6 Abs. 1 Nr. 1a EStG: Instandsetzungs-/Modernisierungsmaßnahmen innerhalb von drei Jahren nach Anschaffung sind anschaffungsnahe Herstellungskosten, wenn die Aufwendungen **ohne USt mehr als 15 %** der Anschaffungskosten **des Gebäudes** betragen. Nicht „mindestens 15 %“. Ausgenommen sind Erweiterungen und jährlich üblicherweise anfallende Erhaltungsarbeiten. |
| **A3** | **OK + NUANCE** | Grund und Boden ist nicht abschreibbar; Kaufpreis ist nach dem Verhältnis der Verkehrswerte/Teilwerte aufzuteilen. Die **BMF-Arbeitshilfe Stand März 2026** ist weiterhin als typisiertes Plausibilisierungs-/Aufteilungsinstrument vorgesehen. Vertragliche Aufteilungen und Gutachten sind gesondert zu würdigen; bei Streit ist eine sachgerechte Verkehrswertaufteilung maßgeblich. |
| **A4** | **OK + KORREKTUR** | § 11 EStG: Zu-/Abflussprinzip. „Kurze Zeit“ = regelmäßig **bis zu 10 Tage** rund um den Jahreswechsel. Nach BFH/BMF müssen regelmäßig wiederkehrende Beträge innerhalb dieses Zeitraums **sowohl fällig als auch gezahlt/zugeflossen** sein. Regelmäßig wiederkehrende Mieten oder Nebenkostenvorauszahlungen können grundsätzlich darunter fallen, wenn die Voraussetzungen im Einzelfall erfüllt sind. |
| **A5** | **OK + NUANCE** | § 82b EStDV erlaubt größeren Erhaltungsaufwand bei Gebäuden im Privatvermögen, die überwiegend Wohnzwecken dienen (> 50 % der Nutzfläche), gleichmäßig auf **2 bis 5 Jahre** zu verteilen. Gesetzlicher Höchstbetrag: **keiner**. Bei Verkauf, Einlage ins Betriebsvermögen oder Ende der Einkunftsnutzung ist der Rest sofort abzuziehen. |
| **A6** | **OK + NUANCE** | Erwerbsbezogene GrESt, Kaufvertrags-/Auflassungsnotar, Grundbuchkosten des Eigentumserwerbs und Maklerprovision sind grundsätzlich Anschaffungsnebenkosten und anteilig Grund/Gebäude zuzuordnen. **Nicht sämtliche Notar-/Grundbuchkosten** sind Anschaffungskosten: Kosten der Darlehens-/Grundschuldfinanzierung sind regelmäßig Finanzierungskosten/Werbungskosten. |
| **A7** | **KORREKTUR / PARAMETER** | 6,5 % ist nur für einzelne Länder richtig. **Stand 29.10.2026:** BW 5,0; BY 3,5; BE 6,0; BB 6,5; HB **5,5 seit 01.07.2025**; HH 5,5; HE 6,0; MV 6,0; NI 5,0; NW 6,5; RP 5,0; SL 6,5; SN 5,5; ST 5,0; SH 6,5; TH **5,0 seit 01.01.2024**. Als datierte Landesparameter modellieren. |
| **A8** | **OK + NUANCE** | Bei auf Dauer angelegter Wohnungsvermietung wird die Einkünfteerzielungsabsicht grundsätzlich typisiert angenommen. Prüfung insbesondere bei zeitlich begrenzter Vermietung, gemischter Selbst-/Fremdnutzung, bestimmten Ferienwohnungen, außergewöhnlichen Gestaltungen und nach BFH auch bei Wohnobjekten **über 250 m²**. Totalüberschussprognose typischerweise über 30 Jahre. |
| **A9** | **OK + NUANCE** | Steuerberatungs- und Rechtskosten sind Werbungskosten, soweit sie unmittelbar der Einkunftsart V+V zuzurechnen sind. Erwerbsbezogene Rechtskosten können dagegen Anschaffungsnebenkosten sein; private oder einkommensteuerliche Allgemeinberatung ist abzugrenzen. |
| **A10** | **KORREKTUR** | Erstattungen sind nicht pauschal „neutral“: Erstattete Werbungskosten sind im selben Jahr mit den Aufwendungen zu verrechnen; bei Erstattung in einem späteren Jahr regelmäßig als Einnahme zu erfassen. Zuschüsse/Versicherungsleistungen können je nach Sachverhalt Anschaffungs-/Herstellungskosten oder abziehbaren Aufwand mindern. |
| **A11** | **OK + NUANCE** | Eine rückzahlbare Mietkaution ist bei Entgegennahme grundsätzlich keine Mieteinnahme; sie ist fremd-/treuhandähnlich gebunden. Wird sie später berechtigt zur Erfüllung von Ansprüchen des Vermieters verwendet/einbehalten, ist der konkrete Vorgang neu steuerlich zu klassifizieren. |
| **A12** | **OK + AKTUALISIEREN** | Verluste aus V+V werden grundsätzlich im laufenden VZ mit positiven Einkünften verrechnet. Nicht ausgeglichene negative Einkünfte unterliegen § 10d EStG. Stand 2026: Verlustrücktrag grundsätzlich in die **zwei** vorangegangenen VZ bis 1 Mio. € (Zusammenveranlagung 2 Mio. €); Verlustvortrag bis 1 Mio. € unbeschränkt, darüber **70 %** des übersteigenden Gesamtbetrags der Einkünfte. Sonderrestriktionen außerhalb des MVP separat behandeln. |

---

## B. Abschreibung / AfA (`depreciation.md`)

| Nr. | Ergebnis | Verifizierte Fassung / Implementierungshinweis |
|---|---|---|
| **B1** | **OK** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG: **3 %** p. a. für Gebäude, die **nach dem 31.12.2022** fertiggestellt wurden. |
| **B2** | **OK** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG: **2 %** p. a. für Gebäude, die **vor dem 01.01.2023 und nach dem 31.12.1924** fertiggestellt wurden. |
| **B3** | **OK** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. c EStG: **2,5 %** p. a. bei Fertigstellung **vor dem 01.01.1925**. |
| **B4** | **OK + PRÄZISIERUNG** | § 7 Abs. 5a EStG: degressive Wohngebäude-AfA **5 % vom jeweiligen Restwert**. Herstellung: Baubeginn **nach 30.09.2023 und vor 01.10.2029**; maßgeblich ist grundsätzlich die Baubeginnsanzeige. Anschaffung nur bis Ende des Fertigstellungsjahres und aufgrund eines obligatorischen Vertrags im selben Zeitfenster. Wechsel zur linearen AfA zulässig. |
| **B5** | **OK** | AfA nur auf den Gebäudeanteil einschließlich der diesem zugeordneten Anschaffungsnebenkosten; Grund und Boden ist nicht abnutzbar und nicht abschreibbar. |
| **B6** | **OK + PRÄZISIERUNG** | § 7 Abs. 1 S. 4 EStG: im Anschaffungs-/Herstellungsjahr Kürzung um 1/12 für jeden **vollen Monat vor** dem Anschaffungs-/Herstellungsmonat; der Monat selbst zählt voll. Bei Erwerb eines vermieteten Gebäudes ist der Übergang des wirtschaftlichen Eigentums (regelmäßig Nutzen/Lasten/Gefahr) entscheidend; bei Neubau die Fertigstellung. |
| **B7** | **OK; Verwaltungsstand geändert** | § 7 Abs. 4 S. 2 EStG erlaubt AfA nach kürzerer tatsächlicher Nutzungsdauer. Das restriktive BMF-Schreiben vom 22.02.2023 wurde mit Schreiben vom **01.12.2025 aufgehoben**. Damit sind die gesetzlichen Vorgaben und die BFH-Rechtsprechung maßgeblich; Nachweise sind weiterhin belastbar zu dokumentieren, aber die aufgehobenen 2023er Verwaltungsanforderungen dürfen nicht als aktuelle Muss-Regeln hardcodiert werden. |
| **B8** | **KORREKTUR** | BFH IX R 14/15: Eine vollständige Einbauküche in einer vermieteten Wohnung ist ein **einheitliches Wirtschaftsgut** und über **10 Jahre** abzuschreiben; nicht als sofortiger Erhaltungsaufwand. Andere bewegliche Wirtschaftsgüter nach § 7 Abs. 1 EStG über ihre Nutzungsdauer. |
| **B9** | **KORREKTUR** | Für Werbungskosten verweist § 9 Abs. 1 S. 3 Nr. 7 S. 2 EStG auf **§ 6 Abs. 2 S. 1–3**: selbständig nutzbare bewegliche WG bis **800 € netto** können sofort abgezogen werden. Der **Sammelposten nach § 6 Abs. 2a** ist in dieser Verweisung gerade **nicht** enthalten und sollte für reine V+V-Einkünfte nicht als Standardregel modelliert werden. |
| **B10** | **OK als Sonderfall** | § 7h/§ 7i EStG: bei qualifizierten Sanierungs-/Denkmalschutzmaßnahmen erhöhte AfA, grundsätzlich bis zu **9 % in Jahr der Maßnahme + 7 Folgejahren** und **7 % in den folgenden 4 Jahren**, mit gesetzlich geforderter Bescheinigung. Für MVP optional, aber fachlich relevant. |
| **B11** | **OK + NUANCE** | Nachträgliche Anschaffungs-/Herstellungskosten erhöhen die AfA-Bemessungsgrundlage. Sie sind nicht pauschal „Restwert-AfA“ als eigener Modus; die weitere AfA richtet sich nach der für das Gebäude einschlägigen gesetzlichen Methode und den zeitlichen Regeln. Sonderregeln (z. B. § 7h/7i) separat modellieren. |

---

## C. WEG / Wohnungseigentum (`weg.md`)

| Nr. | Ergebnis | Verifizierte Fassung / Implementierungshinweis |
|---|---|---|
| **C1** | **OK – nun höchstrichterlich ausdrücklich bestätigt** | BFH, Urteil **14.01.2025 – IX R 19/24**: Zuführung zur Erhaltungsrücklage ist auch nach dem WEMoG noch kein WK-Abzug. Abzug erst, wenn und soweit die GdWE die Mittel für einkunftsbezogene Erhaltungsmaßnahmen tatsächlich verausgabt. |
| **C2** | **OK + PRÄZISIERUNG** | § 28 Abs. 2 WEG: Beschlossen werden Nachschüsse bzw. Anpassungen der beschlossenen Vorschüsse. Die Jahresabrechnung ist die Grundlage, nicht mehr als Ganzes Genehmigungsgegenstand wie nach altem Recht. Fälligkeit kann nach § 28 Abs. 3 beschlossen werden. |
| **C3** | **KORREKTUR der Formulierung** | § 28 Abs. 1: Eigentümer beschließen **über Vorschüsse**; der Verwalter stellt hierzu den Wirtschaftsplan auf. § 28 Abs. 2: Nach Ablauf des Jahres Beschluss über Nachschüsse/Anpassung; der Verwalter erstellt hierzu die Jahresabrechnung. Nicht der Plan/die Abrechnung allein begründet die Zahlungspflicht. |
| **C4** | **KORREKTUR** | Aktuell richtig: GdWE kann nach § 9a WEG Rechte erwerben/Verbindlichkeiten eingehen und klagen/verklagt werden; Verwalter vertritt sie nach § 9b. **Falsch/irreführend ist „seit WEMoG rechtsfähig“**: Rechtsfähigkeit war schon vor 2020 anerkannt und gesetzlich verankert; WEMoG hat sie neu systematisiert. |
| **C5** | **OK** | § 19 Abs. 2 Nr. 4 WEG nennt die „Ansammlung einer angemessenen **Erhaltungsrücklage**“. Ältere Begriffe: Instandhaltungsrücklage/-rückstellung. |
| **C6** | **NUANCE / KORREKTUR** | Sonderumlage steuerlich nicht allein nach Zahlungsdatum behandeln. Maßgeblich sind tatsächliche Verwendung durch die GdWE und Art des zugrunde liegenden Aufwands. Erhaltung kann WK sein; Herstellung/Anschaffung nur über AfA. |
| **C7** | **OK + wichtige Ergänzung** | Verwaltung, Instandhaltung/Instandsetzung und Rücklagenzuführung sind nicht umlagefähige laufende Betriebskosten. Betriebskosten nur bei wirksamer mietvertraglicher Vereinbarung. Bei vermietetem Wohnungseigentum gilt ohne abweichende Vereinbarung **§ 556a Abs. 3 BGB**: grundsätzlich der WEG-Verteilungsschlüssel. |

---

## D. Miete & Betriebskosten (`rent-and-operating-costs.md`)

| Nr. | Ergebnis | Verifizierte Fassung / Implementierungshinweis |
|---|---|---|
| **D1** | **OK** | § 2 BetrKV enthält **17 Nummern**; Nr. 17 ist die Auffangposition „sonstige Betriebskosten“. Nr. 15 (Antennen-/Breitband-/Glasfaseranlagen) wurde materiell geändert. |
| **D2** | **KORREKTUR / Stichtag 01.07.2024** | Das frühere Nebenkostenprivileg für laufende TV-/Breitbandentgelte endete **30.06.2024**. Ab **01.07.2024** dürfen monatliche Anschluss-/Grundentgelte nicht mehr wie früher über die Betriebskosten abgerechnet werden. Umlagefähig bleiben nur die in § 2 Nr. 15 BetrKV genannten begrenzten Betriebskosten; für Glasfaser kann unter § 556 Abs. 3a BGB/§ 72 TKG ein Bereitstellungsentgelt gelten. |
| **D3** | **OK** | § 556 Abs. 1 BGB: Betriebskosten trägt der Mieter nur aufgrund Vereinbarung. Eine zulässige allgemeine Verweisung auf die BetrKV kann genügen; „sonstige Betriebskosten“ müssen hinreichend bestimmt vereinbart werden. |
| **D4** | **OK** | § 556 Abs. 3 BGB: Jahresabrechnung über Vorauszahlungen; Zugang spätestens bis Ablauf des **12. Monats** nach Ende des Abrechnungszeitraums. Nachforderungen danach grundsätzlich ausgeschlossen, außer der Vermieter hat die Verspätung nicht zu vertreten. |
| **D5** | **OK** | Einwendungen des Mieters spätestens **12 Monate nach Zugang** der Abrechnung; Ausnahme, wenn verspätete Geltendmachung nicht zu vertreten ist. |
| **D6** | **KORREKTUR** | § 556a Abs. 1 BGB: ohne Vereinbarung grundsätzlich Wohnfläche, verbrauchs-/verursachungsabhängige Kosten entsprechend Verbrauch/Verursachung. **Aber bei vermietetem Wohnungseigentum gilt § 556a Abs. 3:** ohne abweichende Vereinbarung grundsätzlich der WEG-Verteilungsschlüssel; bei Verstoß gegen billiges Ermessen Rückfall auf Abs. 1. |
| **D7** | **OK + NUANCE** | § 7 HeizkostenV: grundsätzlich **mindestens 50 %, höchstens 70 %** der Heizkosten nach erfasstem Verbrauch; in bestimmten älteren öl-/gasbeheizten Gebäuden zwingend 70 %. Ausnahmen ergeben sich insbesondere aus § 11 HeizkostenV. |
| **D8** | **KORREKTUR der Terminologie** | Umlagen/Nebenkostenvorauszahlungen des Mieters sind steuerlich **Einnahmen**; die vom Vermieter getragenen umlagefähigen Kosten sind grundsätzlich **Werbungskosten**. Bei gleicher Höhe entsteht wirtschaftlich oft Neutralität, aber es sind steuerlich nicht einfach „durchlaufende Posten“ außerhalb der Einnahmen-/WK-Erfassung. Nicht umlagefähige, einkunftsbezogene Kosten können ebenfalls WK sein. |

---

## E. Übergreifende offene Fragen – Ergebnis

| Nr. | Ergebnis |
|---|---|
| **E1** | **Geklärt:** BFH IX R 19/24. Rücklagenzuführung ≠ WK; WK erst bei tatsächlicher Verwendung für eine einkunftsbezogene Maßnahme. |
| **E2** | **Geklärt für MVP:** Verkehrswertverhältnis; BMF-Arbeitshilfe **Stand März 2026** als typisiertes Verfahren/Plausibilisierung. Eingaben sollten mindestens Gesamtkaufpreis, Erwerbsnebenkosten, Bodenwert-/Grundstücksdaten, Gebäudedaten und ggf. abweichende vertragliche/gutachterliche Werte samt Quelle erfassen. |
| **E3** | **Geklärt:** Betriebskosten-**Vorauszahlung** → jährliche Abrechnung nach § 556 Abs. 3 BGB. Betriebskosten-**Pauschale** → grundsätzlich keine verbrauchs-/kostenbezogene Jahresabrechnung wie bei Vorauszahlungen; Spezialrecht (insb. HeizkostenV) bleibt zu beachten. Datenmodell muss `PAUSCHALE` und `VORAUSZAHLUNG` trennen. |
| **E4** | **Geklärt:** WEG-Jahresabrechnung ist keine mieterseitige Betriebskostenabrechnung. WEG-Kostenlinien müssen nach Mietvertrag/BetrKV/Spezialrecht klassifiziert und ggf. nach § 556a Abs. 3 BGB mit dem WEG-Schlüssel auf den Mieter übertragen werden. |
| **E5** | **Empfehlung: JA.** GrESt-Sätze als datierte Länderparameter (`state`, `rate`, `validFrom`, `validTo`, `source`) führen. Bremen und Thüringen zeigen, warum Stichtage zwingend sind. |
| **E6** | **KORREKTUR/NUANCE:** Bei Wohnraummiete schreibt § 551 Abs. 3 BGB getrennte Anlage vor; Erträge **stehen dem Mieter zu und erhöhen die Sicherheit**. Daher sind sie nicht als eigene Mieteinnahme des Vermieters zu behandeln. Ob und wie Kapitalertragsteuer technisch einbehalten wird, hängt von Konto-/Anlageform und steuerlicher Zurechnung ab und darf nicht pauschal als „Abgeltungsteuer der Bank beim Mieter“ hardcodiert werden. Für **Gewerberaummiete** gilt § 551 BGB nicht; Verzinsung und Zurechnung richten sich primär nach Vertrag und allgemeinen Regeln. |

---

## Zusätzliche Feststellung zum beigefügten Merkblatt

Das Merkblatt stützt mehrere Kernaussagen (Werbungskostenbegriff, Schuldzinsen, AfA nur Gebäude, Anschaffungsnebenkosten, Erhaltungsaufwand, anschaffungsnahe Herstellungskosten, Rücklagenzuführung erst bei Verwendung). Es darf aber **nicht ungeprüft als aktuelle Rechtsquelle implementiert werden**:

1. Im AfA-Beispiel werden zunächst 2/3 von 600.000 € = 400.000 € als abschreibbare Gebäude-Anschaffungskosten ermittelt, anschließend aber fälschlich **600.000 € × 3 %** gerechnet. Richtig wären bei 400.000 € Bemessungsgrundlage 12.000 € Jahres-AfA (vor zeitanteiliger Kürzung), sofern 3 % einschlägig sind.
2. Zeitabhängige Förderregeln (§ 7b EStG) und andere Stichtagsangaben in Merkblättern altern schnell.
3. Die Aussage zur Erhaltungsrücklage ist dagegen durch BFH IX R 19/24 aus 2025 aktuell bestätigt.

---

# Primärquellen / belastbare Fundstellen

- EStG § 6: https://www.gesetze-im-internet.de/estg/__6.html
- EStG § 7: https://www.gesetze-im-internet.de/estg/__7.html
- EStG § 9: https://www.gesetze-im-internet.de/estg/__9.html
- EStG § 10d: https://www.gesetze-im-internet.de/estg/__10d.html
- EStG § 11: https://www.gesetze-im-internet.de/estg/__11.html
- EStDV § 82b: https://www.gesetze-im-internet.de/estdv_1955/__82b.html
- BMF Kaufpreisaufteilung, Stand März 2026: https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Berechnung-Aufteilung-Grundstueckskaufpreis.html
- BMF Aufhebung Schreiben zur kürzeren tatsächlichen Nutzungsdauer, 01.12.2025: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-12-01-afa-von-gebaeuden.html
- BFH IX R 19/24 (Erhaltungsrücklage): https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE202510025/
- BFH IX R 14/15 (Einbauküche): https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE201610271/
- BFH IX R 17/21 (Einkünfteerzielungsabsicht, >250 m²): https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE202310225/
- WEG § 9a: https://www.gesetze-im-internet.de/woeigg/__9a.html
- WEG § 9b: https://www.gesetze-im-internet.de/woeigg/__9b.html
- WEG § 19: https://www.gesetze-im-internet.de/woeigg/__19.html
- WEG § 28: https://www.gesetze-im-internet.de/woeigg/__28.html
- BGB § 551: https://www.gesetze-im-internet.de/bgb/__551.html
- BGB § 556: https://www.gesetze-im-internet.de/bgb/__556.html
- BGB § 556a: https://www.gesetze-im-internet.de/bgb/__556a.html
- BetrKV § 2: https://www.gesetze-im-internet.de/betrkv/__2.html
- HeizkostenV § 7: https://www.gesetze-im-internet.de/heizkostenv/__7.html
- Bundesnetzagentur zum Ende des Nebenkostenprivilegs: https://www.bundesnetzagentur.de/DE/Vportal/TK/InternetTelefon/Nebenkostenprivileg/artikel.html
- Bremen, GrESt 5,5 % seit 01.07.2025: Jahresbericht Steuerverwaltung 2024 (Senator für Finanzen)
- Thüringen, GrESt 5,0 % seit 01.01.2024: Thüringer Finanzministerium
