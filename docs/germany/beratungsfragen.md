# Beratungsfragen für die Steuerberatung

**Projekt:** Vermieter Cockpit DE
**Stand:** 30.10.2026 (#172)
**Bezug:** [`verification-checklist.md`](verification-checklist.md) v0.3, Spalte „Bestätigt durch“

> **Zweck:** Die Prüfliste ist von einer Coding-Session recherchiert, nicht von einer Fachperson bestätigt. Diese Seite fasst die fünf Punkte zusammen, bei denen Geld und Unsicherheit zusammentreffen, als Vorlage für ein Gespräch mit der Steuerberatung. Je Punkt: die Frage in einem Satz, der heutige Stand der Spezifikation und was die Software damit tut. Alle Rechtsangaben stammen aus der Prüfliste, `taxation.md` oder `depreciation.md`; was dort nicht belegt ist, ist mit **VERIFY** markiert. Die Seite enthält keine personenbezogenen Daten; Beispiele im Gespräch nur mit erfundenen Werten.

**Nicht auf dieser Seite:** Punkte mit `Primärquelle` (C1, E1, E6) und A7 (GrESt-Sätze, ein datierter Länderparameter, der mit dem jeweiligen Landesgesetz zu belegen ist, keine Beratungsfrage), sowie alles Mechanische (Rundung, Stichtagsgrenzen, Idempotenz).

**Nach dem Gespräch:** Die Antworten werden als datierte Notiz (Datum, Fachperson in ihrer Funktion, Form der Bestätigung) in `docs/germany/` abgelegt, die betroffenen Zeilen der Prüfliste erhalten in „Bestätigt durch“ den Wert `Fachperson, <Datum>` mit Verweis auf die Notiz, und die Phasenpläne (Phase 7, Phase 8) verweisen für die betroffenen Entscheidungen auf diese Notiz.

---

## 1. Anschaffungsnahe Herstellungskosten: maßgeblicher Zeitpunkt und Hausgeld (A2, A2a, A2b)

**Frage:** Misst die 15-%-Grenze des § 6 Abs. 1 Nr. 1a EStG Maßnahmen nach ihrer Ausführung oder ihrer Zahlung (A2a), und zählt der Eigentümeranteil an Instandsetzungen, die die WEG aus dem laufenden Hausgeld bezahlt, mit (A2b)?

**Stand der Spezifikation** (`api-design.md` §58B, offene Fragen 9 und 12): Aufwendungen ohne USt **mehr als** 15 % der Anschaffungskosten des Gebäudes innerhalb von drei Jahren nach Anschaffung (A2). Gemessen wird das Buchungsdatum bzw. das Datum der Rücklagenentnahme oder Sonderumlagen-Verwendung. Nach dem BMF-Schreiben vom 20.10.2017 (zitiert in §58B, VERIFY) kommt es auf die Ausführung an. Ein Feld `performedOn` ist zurückgestellt. Aus dem Hausgeld bezahlte Instandsetzungen werden nicht summiert.

**Was die Software tut:** Sie berechnet die Prüfung je Erwerb, schlägt bei Überschreitung `CAPITALIZED` vor und ändert selbst nichts. Das Ergebnis bleibt `NOT_FINAL`, solange Quellen nahe den Fristgrenzen liegen (`DATE_IS_BOOKING_DATE`, `DATES_NEAR_WINDOW_EDGE`, 90 Tage nach Fristende), Bruttobeträge verwendet werden oder eine bestätigte WEG-Jahresabrechnung die Frist überschneidet (`WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED`).

**Warum es zählt:** Das Dreijahresfenster läuft. Kippt die Grenze, werden Sofortabzüge rückwirkend zu AfA-Bemessungsgrundlage (Phase 8, P8-D6); bereits abgegebene Jahre können betroffen sein.

---

## 2. Aufteilung Grund und Boden / Gebäude (A3, E2)

**Frage:** Genügt es, die vom Nutzer eingegebene und bestätigte Kaufpreisaufteilung (vertraglich, gutachterlich oder nach der BMF-Arbeitshilfe) zu übernehmen, und wann muss eine vertragliche Aufteilung gegen die BMF-Arbeitshilfe (Stand März 2026) plausibilisiert werden?

**Stand der Spezifikation:** Der Kaufpreis ist nach dem Verhältnis der Verkehrswerte aufzuteilen; die BMF-Arbeitshilfe dient als typisiertes Plausibilisierungsinstrument, vertragliche Aufteilungen sind gesondert zu würdigen (A3, E2). Die Aufteilung ist eine Eingabe mit Methode und Quelle (`api-design.md` §27.3). Ihr Verhältnis wird auf Kaufpreis plus aktive Erwerbsnebenkosten ohne Finanzierungskosten angewandt (`api-design.md` §58B, offene Frage 5). Vom Projektinhaber entschieden (`phase-8-plan.md` P8-D3, 30.10.2026): die Aufteilung übernehmen, nicht nach der Arbeitshilfe berechnen. Die Steuerberatung soll bestätigen, dass das genügt.

**Was die Software tut:** Nur eine bestätigte Aufteilung speist die 15-%-Prüfung und die AfA; ohne sie ist das Ergebnis `NOT_COMPUTABLE`. Eine neue Aufteilung soll in Phase 8 die Bemessungsgrundlage aller Jahre ab Beginn ändern und dies sichtbar machen (P8-D3).

**Warum es zählt:** Der Gebäudeanteil bestimmt die AfA-Bemessungsgrundlage für Jahrzehnte und die 15-%-Schwelle.

---

## 3. Die 10-Tage-Regel bei angenommener Fälligkeit (A4)

**Frage:** Darf für die 10-Tage-Regel des § 11 EStG der Beginn des Zahlungszeitraums als Fälligkeit angenommen werden, wenn kein Fälligkeitstag erfasst ist?

**Stand der Spezifikation** (`phase-7-plan.md` P7-D3, `api-design.md` §58A): Regelmäßig wiederkehrende Beträge gehören in das Jahr der wirtschaftlichen Zugehörigkeit, wenn **sowohl** Fälligkeit **als auch** Zahlung innerhalb von 10 Tagen um den Jahreswechsel liegen (A4). Die Fälligkeit wird je Quelle bestimmt: Fälligkeitstag aus dem Mietvertrag, Fälligkeitstag aus dem Wirtschaftsplan, Tilgungsplan des Darlehens. Fehlt er, gilt der Beginn des Zeitraums als Fälligkeit.

**Was die Software tut:** Sie ordnet nach der Regel `DE_CASH_TIMING@1` zu, markiert jede Annahme mit `DUE_DATE_ASSUMED` und die Zuordnung mit `ATTRIBUTED_BY_10_DAY_RULE`. Hausgeld wird ohne bekannte Periode nie auf Verdacht verschoben (`ECONOMIC_PERIOD_ASSUMED`). Der Nutzer kann das Steuerjahr je Split um ein Jahr übersteuern.

**Warum es zählt:** Eine Miete für Januar, Ende Dezember gezahlt, wechselt mit der Annahme das Steuerjahr; bei Monatsersten als Fälligkeit trifft das regelmäßig zu.

---

## 4. AfA: Satz, Nutzungsdauer, Beginn, Ende (Abschnitt B, vor Phase 8)

**Frage:** Welche zeitlichen Regeln gelten für die lineare Gebäude-AfA im Privatvermögen dort, wo `depreciation.md` schweigt?

**Stand der Spezifikation:** Sätze 3 % / 2 % / 2,5 % nach Fertigstellungsjahr (B1–B3), Beginn mit Übergang des wirtschaftlichen Eigentums, im ersten Jahr Kürzung um 1/12 je vollem Vormonat (B6), kürzere Nutzungsdauer nach § 7 Abs. 4 S. 2 EStG mit Nachweis (B7), nachträgliche Herstellungskosten nach der Methode des Gebäudes (B11). Degressive AfA, § 7b, § 7h/§ 7i bleiben außerhalb von Phase 8. Offen sind die VERIFY-Punkte aus `phase-8-plan.md` §3:

- **Beginn nachträglicher (auch anschaffungsnaher) Herstellungskosten:** ab Jahresbeginn, ab Monat oder ab Übergang? Hinweis aus der Durchsicht: R 7.4 Abs. 9 S. 3 EStR, Jahresbeginn (VERIFY).
- **Jahr der Veräußerung:** zeitanteilig, Stichtag Übergang des wirtschaftlichen Eigentums? Hinweis aus der Durchsicht: R 7.4 Abs. 8 EStR (VERIFY).
- **Nicht abziehbare USt in der Bemessungsgrundlage:** brutto für Vermieter ohne USt-Option? (§ 9b Abs. 1 EStG, VERIFY)
- **Sätze vor 2023:** galten die Bänder b und c unverändert für frühere Jahre?
- **Kürzere Nutzungsdauer:** ab Beginn der AfA oder ab dem nachgewiesenen Jahr? Und die Grenzwerte des § 7 Abs. 4 S. 2 EStG je Band: nach dem im Review zu #174 zitierten Gesetzestext feste Jahreszahlen (weniger als 33 / 50 / 40 Jahre), nicht der Kehrwert des Satzes (33⅓ Jahre bei 3 %); am amtlichen Text prüfen (VERIFY).
- **Miteigentümer:** AfA auf die eigenen Anschaffungskosten (P8-D8); Fortführung durch Rechtsnachfolger (§ 11d EStDV) bleibt außerhalb.

**Was die Software tut:** Bis zur Antwort berechnet sie nichts geraten: Jahre vor 2023 `NO_APPLICABLE_RULE`, Veräußerungsjahr zeitanteilig nach Monaten nach dem Hinweis aus der Durchsicht berechnet, aber mit dem offenen Hinweis `DISPOSAL_YEAR_TO_VERIFY`, sodass das Jahr nie als endgültig gilt (api-design §59A); die offenen Wahlen sind Regelparameter (`subsequentCostStart`, `endMonthCounts`).

---

## 5. § 82b EStDV: Verteilung und Verkauf eines Miteigentumsanteils (A5)

**Frage:** Zieht beim Verkauf eines Miteigentumsanteils während einer § 82b-Verteilung nur der verkaufende Miteigentümer seinen Rest im Verkaufsjahr ab, während die übrigen Miteigentümer weiter verteilen?

**Stand der Spezifikation:** Größerer Erhaltungsaufwand an überwiegend Wohnzwecken dienenden Gebäuden darf gleichmäßig auf 2 bis 5 Jahre verteilt werden; bei Verkauf oder Ende der Einkunftsnutzung ist der Rest sofort abzuziehen (A5). Die Spezifikation faltet je Eigentümer (`api-design.md` §58C, offene Frage 6; §58B, offene Frage 10): Maßgeblich ist die ununterbrochene Eigentumszeit; eine bloße Anteilsänderung ohne Verkauf faltet nichts, der Käufer erhält keinen Teil.

**Was die Software tut:** Sie leitet die Jahresteile ab (Rest im letzten Jahr), verlangt die Bestätigung der überwiegenden Wohnnutzung und markiert den Fall mit `OWNERSHIP_PARTLY_ENDED` und `DISTRIBUTION_FOLDED_PER_OWNER`. Gespeichert wird nur die Wahl, nie die Teile.

**Warum es zählt:** Bei mehreren Eigentümern verschiebt die Faltung Werbungskosten zwischen Personen und Jahren.
