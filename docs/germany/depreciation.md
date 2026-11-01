# Abschreibung (AfA)

**Projekt:** Vermieter Cockpit DE
**Version:** 0.2 (Ergebnisse der Prüfliste übernommen)
**Stand der Prüfung:** 29.10.2026 (`verification-checklist.md` v0.2, Abschnitt B)
**Status:** Living Document
**Dokumenttyp:** Deutsche Fachdomäne — AfA / Abschreibung

> **Hinweis (AGENTS.md §30):** Etablierte deutsche Regeln mit Gesetzesbezug als **versioniertes Fachwissen**, **keine Steuerberatung** im Einzelfall. AfA-Sätze und -Zeiträume sind **zeitabhängig** und wurden in den letzten Jahren mehrfach geändert. Die Aussagen sind gegen das EStG, BMF-Schreiben und BFH-Rechtsprechung geprüft (Stand 29.10.2026); im Modell tragen sie Geltungszeitraum und Quelle (`taxation.md` §9).

---

# 1. Zweck & Prinzip

Definiert, wie die **Absetzung für Abnutzung (AfA)** ermittelt wird. AfA ist ein **nicht-zahlungswirksamer** steuerlicher Aufwand → **niemals** eine Ledger-Transaktion (`AGENTS.md` §7, §17). AfA ist **abgeleitet** aus Anschaffungs-/Herstellungskosten und der Kaufpreisaufteilung — die Berechnung ist reproduzierbar und versionsbewusst.

Grundsatz: **Nur der Gebäudeanteil ist abschreibbar. Grund und Boden nicht.**

---

# 2. Musterobjekt (AfA-Basis)

> Illustrativ.

- Gesamtanschaffungskosten ≈ 280.175 € (Herleitung → `docs/germany/taxation.md` §2)
- Kaufpreisaufteilung 25 % Grund / 75 % Gebäude (illustrativ; Methode `taxation.md` §6.2)
- **AfA-Bemessungsgrundlage (Gebäude)** ≈ 75 % × 280.175 € ≈ **210.131 €** (inkl. anteiliger Nebenkosten)
- Baujahr 2005 → lineare Gebäude-AfA **2 %** (§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG)
- **Jahres-AfA** ≈ 2 % × 210.131 € ≈ **4.203 €**

---

# 3. Lineare Gebäude-AfA (§ 7 Abs. 4 EStG)

Der maßgebliche AfA-Satz für Gebäude im Privatvermögen hängt vom **Fertigstellungszeitpunkt** ab (B1–B3):

| Fall | Satz | Grundlage |
|---|---|---|
| Fertigstellung **nach dem 31.12.2022** | **3 %** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG |
| Fertigstellung **vor dem 01.01.2023 und nach dem 31.12.1924** | **2 %** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG |
| Fertigstellung **vor dem 01.01.1925** | **2,5 %** | § 7 Abs. 4 S. 1 Nr. 2 Buchst. c EStG |
| Wirtschaftsgebäude im Betriebsvermögen | 3 % | § 7 Abs. 4 S. 1 Nr. 1 EStG; außerhalb des Scopes, nicht geprüft |

**Kürzere tatsächliche Nutzungsdauer (B7):** § 7 Abs. 4 S. 2 EStG erlaubt die AfA nach einer kürzeren tatsächlichen Nutzungsdauer. Das restriktive BMF-Schreiben vom 22.02.2023 wurde mit Schreiben vom **01.12.2025 aufgehoben**. Maßgeblich sind damit Gesetz und BFH-Rechtsprechung. Der Nachweis (z. B. Gutachten) ist weiter belastbar zu dokumentieren, aber die aufgehobenen Anforderungen von 2023 werden nicht als Muss-Regeln hinterlegt.

**Schwellen der kürzeren Nutzungsdauer (B7):** § 7 Abs. 4 S. 2 EStG nennt feste Jahre je Fall, nicht den Kehrwert des Satzes: „Beträgt die tatsächliche Nutzungsdauer eines Gebäudes in den Fällen des Satzes 1 Nummer 1 und 2 Buchstabe a weniger als 33 Jahre, in den Fällen des Satzes 1 Nummer 2 Buchstabe b weniger als 50 Jahre, in den Fällen des Satzes 1 Nummer 2 Buchstabe c weniger als 40 Jahre, so können …“. Kürzer ist die Nutzungsdauer damit bei **weniger als 33 Jahren** (Buchst. a, 3 %), **weniger als 50 Jahren** (Buchst. b, 2 %) und **weniger als 40 Jahren** (Buchst. c, 2,5 %). 33 Jahre im Fall des Buchst. a sind also nicht kürzer, obwohl 1/33 über 3 % liegt. Im Modell sind die Schwellen Parameter der Regel (`DE_AFA_BUILDING_LINEAR@2`, bis VC-8-02 `@1`; `shorterThanYears`; api-design §59, §59A). **Quelle und Prüfstand:** übernommen aus dem Gesetzeswortlaut, wie ihn das Review zu #174 zitiert, und am **30.10.2026 gegen den amtlichen Text** (gesetze-im-internet.de, § 7 EStG) **geprüft**, bevor VC-8-01 umgesetzt wurde: Wortlaut und Schwellen (33 / 50 / 40 Jahre) stimmen überein.

**Fassung 2006–2022 (VC-8-02, `DE_AFA_BUILDING_LINEAR@1`; api-design §59A „The rule versions“):** Vor dem JStG 2022 (BGBl. I S. 2294) hatte § 7 Abs. 4 S. 1 Nr. 2 EStG zwei Buchstaben: **Buchst. a** 2 % für Gebäude, die **nach dem 31.12.1924** fertiggestellt worden sind, **Buchst. b** 2,5 % für Gebäude, die **vor dem 01.01.1925** fertiggestellt worden sind. S. 2 lautete: „Beträgt die tatsächliche Nutzungsdauer eines Gebäudes in den Fällen des Satzes 1 Nummer 1 weniger als 33 Jahre, in den Fällen des Satzes 1 Nummer 2 Buchstabe a weniger als 50 Jahre, in den Fällen des Satzes 1 Nummer 2 Buchstabe b weniger als 40 Jahre, so können …“. Die Sätze eines Gebäudes ändern sich 2023 also nicht; nur die Buchstaben verschieben sich (alt a → neu b, alt b → neu c). **Quelle und Prüfstand (31.10.2026, vor der Umsetzung von VC-8-02):**
- der konsolidierte amtliche Text von gesetze-im-internet.de, gelesen in der Spiegelung `github.com/bundestag/gesetze` (`e/estg/index.md`), Stand der Erstübernahme 02.07.2012 (Commit `8e9e7a10`) und der letzten Aktualisierung 13.02.2022 (Commit `79bdc90d`): Wortlaut von S. 1 Nr. 2 Buchst. a/b und S. 2 in beiden Ständen wie oben;
- BT-Drs. 20/3879 (Regierungsentwurf JStG 2022), Begründung zu Art. 1 Nr. 2 Buchst. a Doppelbuchst. aa, S. 88: „Bisher werden Gebäude, die Wohnzwecken dienen und nach dem 31. Dezember 1924 fertiggestellt worden sind, linear mit 2 Prozent abgeschrieben; bei Fertigstellung vor dem 1. Januar 1925 mit 2,5 Prozent.“; BT-Drs. 20/4729 (Beschlussempfehlung), S. 32: Neufassung von S. 1 Nr. 2 mit Buchst. a 3 % ab Fertigstellung nach dem 31.12.2022, S. 2 nicht geändert;
- BT-Drs. 20/8628 (Wachstumschancengesetz, Art. 3 und Begründung S. 120 f., 239): S. 2 wird rückwirkend zum 01.01.2023 an die neuen Buchstaben angepasst, weil das JStG 2022 ihn nicht angepasst hatte. Das bestätigt, dass S. 2 bis 2022 auf die alten Buchstaben a (50 Jahre) und b (40 Jahre) verwies.

**Nicht unmittelbar gelesen:** ein Stand aus den Jahren 2006–2011 selbst (die gesetze-im-internet-Spiegelung beginnt am 02.07.2012; die BMF-Handbücher und buzer.de waren nicht abrufbar). Dass Nr. 2 Buchst. a/b und die Schwellen 50 / 40 Jahre seit 2006 unverändert sind, ist daher aus den gelesenen Ständen 2012 und 2022 und der Begründung „bisher“ geschlossen, nicht für jedes Jahr belegt. Das Unternehmensteuerreformgesetz 2008 änderte Nr. 1 (Wirtschaftsgebäude, 4 % → 3 %, 25 → 33 Jahre), nicht Nr. 2. `verified` der Version bleibt **false**, bis der Steuerberater sie bestätigt (`beratungsfragen.md` §4); jedes Jahr 2006–2022 trägt bis dahin `HISTORICAL_RULE_TO_VERIFY`.

**Aufgelöst am 01.11.2026 (Sätze):** Der Prüfbericht vom 01.11.2026 ([`pruefbericht-2026-11-01.md`](pruefbericht-2026-11-01.md), Frage 1), **mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01**, bestätigt die Sätze 2 % / 2,5 % nach dem Fertigstellungsjahr. `verified` ist seither aufgeteilt (`api-design.md` §59A „Resolved by the tax review (2026-11-01)“): `@1` trägt `rates: true` und `shorterUsefulLifeThresholds: true`. Frage 8 bestätigt die Schwellen < 33 / < 50 / < 40 im heutigen Wortlaut, für 2006–2022 nicht ausdrücklich, und der Stand 2006–2011 ist hier nicht direkt gelesen (§3); **der Projektinhaber hat am 01.11.2026 entschieden**, dass Frage 8 `@1` abdeckt, weil `@1` nur die beiden Bänder mit 50 und 40 Jahren führt. Ein Jahr 2006–2022 trägt `HISTORICAL_RULE_TO_VERIFY` damit weder zum Bandsatz noch mit kürzerer Nutzungsdauer (`1/n`). Die Abgrenzung anderer Verfahren (§ 7 Abs. 5, 5a, § 7b, §§ 7h/7i) bleibt VC-X-37. Aufgenommen in derselben Version (`api-design.md` §60, offene Frage 11); die Erfassung bleibt ausgeschaltet.

---

# 4. Degressive Wohngebäude-AfA (§ 7 Abs. 5a EStG)

Für neu geschaffenen Wohnraum gibt es eine **degressive AfA von 5 % vom jeweiligen Restwert** (B4):
- **Herstellung:** Baubeginn **nach dem 30.09.2023 und vor dem 01.10.2029**; maßgeblich ist grundsätzlich die Baubeginnsanzeige.
- **Anschaffung:** nur bis zum Ende des Fertigstellungsjahres und aufgrund eines obligatorischen Vertrags im selben Zeitfenster.
- Ein Wechsel zur linearen AfA ist zulässig.

Für den Bestandskauf des Musterobjekts (2005) **nicht** einschlägig — hier lineare 2 %.

---

# 5. Zeitanteilige AfA & Beginn

- Im **Jahr der Anschaffung oder Herstellung** wird die Jahres-AfA um **1/12 für jeden vollen Monat vor** dem Anschaffungs- bzw. Herstellungsmonat gekürzt; der Monat selbst zählt voll (§ 7 Abs. 1 S. 4 EStG, B6). Beispiel: Übergang im April → 9/12 der Jahres-AfA.
- **AfA-Beginn:** beim Erwerb eines vermieteten Gebäudes der Übergang des **wirtschaftlichen Eigentums** (regelmäßig Nutzen, Lasten und Gefahr), beim Neubau die Fertigstellung.

---

# 6. Weitere AfA-Tatbestände

- **Einbauküche (B8):** Eine vollständige Einbauküche in einer vermieteten Wohnung ist ein **einheitliches Wirtschaftsgut** und wird über **10 Jahre** abgeschrieben (BFH IX R 14/15), nicht als sofortiger Erhaltungsaufwand.
- **Andere bewegliche Wirtschaftsgüter:** lineare AfA über ihre Nutzungsdauer (§ 7 Abs. 1 EStG).
- **Geringwertige Wirtschaftsgüter (B9):** Für Werbungskosten verweist § 9 Abs. 1 S. 3 Nr. 7 S. 2 EStG auf **§ 6 Abs. 2 S. 1–3**. Selbständig nutzbare bewegliche Wirtschaftsgüter bis **800 € netto** können sofort abgezogen werden. Der **Sammelposten nach § 6 Abs. 2a** ist in dieser Verweisung **nicht** enthalten und wird für V+V nicht modelliert.
- **Nachträgliche Anschaffungs-/Herstellungskosten (B11)** erhöhen die AfA-Bemessungsgrundlage. Die weitere AfA folgt der für das Gebäude einschlägigen gesetzlichen Methode und ihren zeitlichen Regeln, nicht einem eigenen Modus „Restwert-AfA“. **Anschaffungsnahe Herstellungskosten** (§ 6 Abs. 1 Nr. 1a EStG) fließen in die AfA statt in den Sofortabzug (→ `docs/germany/taxation.md` §6).
- **Denkmal-/Sanierungs-AfA (B10, § 7h/§ 7i EStG):** Bei qualifizierten Maßnahmen und mit der gesetzlich geforderten Bescheinigung gilt eine erhöhte AfA: bis zu **9 %** im Jahr der Maßnahme und in den 7 Folgejahren, danach **7 %** in den folgenden 4 Jahren. Für den MVP optional und als eigenes RuleSet zu führen.

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

# 9. Offene Punkte

- **Aufgelöst am 01.11.2026** (Prüfbericht, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01): die Sätze 2006–2022 (Frage 1, §3), das Veräußerungsjahr (Frage 4: Veräußerungsmonat voll beim Verkäufer, `DISPOSAL_YEAR_TO_VERIFY` entfällt), der Teilverkauf nach mehreren Erwerben (Frage 11: anteilig über alle Erwerbe, `SHARE_REDUCTION_SPLIT_TO_VERIFY` entfällt), die nicht abziehbare USt in der Bemessungsgrundlage (Frage 10, brutto ohne USt-Option). Offen bleiben Beginn und Ende nachträglicher HK und die kürzere Nutzungsdauer (VC-X-38, VC-X-41).

- Kürzere Nutzungsdauer (§ 7 Abs. 4 S. 2): Datenfelder für den Nachweis (Gutachten, Quelle, Datum) in Phase 8 festlegen.
- Datum des Übergangs von Nutzen und Lasten als Acquisition-Feld (ADR-010) prüfen; es bestimmt den AfA-Beginn.
- Denkmal-/Sanierungs-AfA (§ 7h/§ 7i) als späteren Umfang einplanen.
- Hinweis zur Quelle: Das AfA-Beispiel im Merkblatt, das der Prüfung beilag, rechnet mit der falschen Bemessungsgrundlage (Prüfliste, „Zusätzliche Feststellung“). Beispiele hier rechnen nur mit dem Gebäudeanteil.
