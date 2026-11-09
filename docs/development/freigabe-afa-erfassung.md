# Freigabeprotokoll: AfA-Erfassung nach Freigabestufen (VC-X-45)

**Status:** no stage released. `DEPRECIATION_RECORDING_ENABLED` is `false` (api-design §60), `DEPRECIATION_RECORDING_STAGE` is unset (stage `1`, api-design §60A), and nothing in this file turns either on. Synthetic data only: this file names no person, no address, no document content and no figure of a real case.

**What this file is:** the release protocol the owner decided on 2026-11-02 (second round, question 236-5 of PR #236; Entscheidung des Projektinhabers, 2026-11-02):

> „je Stufe eine eigene Inhaberentscheidung im Freigabeprotokoll, kein Kalenderdatum. Stufe 2 erst, wenn VC-X-27, VC-X-36 und VC-X-38 umgesetzt sind, ein Stufe-1-Jahr produktiv erfasst wurde, deine echte Jahresabrechnung durch Phase 6 bis 8 gelaufen ist und die schriftliche Bestätigung zu den Fragen 14 bis 17 und 23 vorliegt. Stufe 3 erst, wenn VC-X-41 in beiden Teilen umgesetzt ist, die Fragen 8, 9, 11 und 12 schriftlich beantwortet sind und ein Musterfall mit Soll-Ergebnis grün ist, wie der Bericht unter G empfiehlt.“

The question numbers are those of the tax review of 2026-11-01 (`docs/germany/pruefbericht-2026-11-01.md`; mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01). That oral confirmation is not the written confirmation this protocol asks for.

## How a stage is released

1. **Every point of the stage's checklist is met**, each with its evidence named (a merged PR, a test, a note under `docs/germany/`). A point is ticked only in the decision entry, never ahead of it; the checklists below show the state on the date given, not a decision.
2. **The owner records one decision entry for that stage** under "Decisions" below, and in api-design §60A and `docs/development/phase-8-plan.md`. One entry releases one stage. Releasing stage 2 releases nothing of stage 3. **No calendar date releases a stage**, and no entry is written in advance with a future date.
3. **A written confirmation stays outside the repository** (§60A, A5). Only a note is kept under `docs/germany/`: the date, the role without a name, the scope (which questions), the SHA-256 of the file and where it is stored. The decision entry points to that note.
4. **Recording itself** needs §60 "Turning it on" (VC-X-35's tests, the answers worked in, the owner's decision to start recording, the operator's switch). A stage above `1` is set by the operator (`DEPRECIATION_RECORDING_STAGE`) and a restart only after its entry here (§60A "The switch").
5. **What no release changes:** missing facts and unsupported methods block at every stage, a §58E acknowledgement replaces neither evidence nor computation, and an unconfirmed tax assumption never reads as released (§60A "What blocks at every stage").

## Stage 1 (Standard)

Prepared (VC-X-45, PR #236), not released. Its release is the first productive enablement of recording, by §60 "Turning it on"; decision 236-5 of 2026-11-02 sets no further checklist for it. Its prerequisites (State on 2026-11-04):

- [ ] **VC-X-41 Part 2 implemented** (the residual value over the remaining useful life, api-design §59G). **Decided by the owner on 2026-11-02** (Entscheidung des Projektinhabers, 2026-11-02): „Teil 2 muss deshalb vor der ersten Freischaltung landen, sonst kostet er eine Regelversion. Das ist mit dem Backlog-Status „vor Freischaltung“ vereinbar und sollte in `freigabe-afa-erfassung.md` als Voraussetzung von Stufe 1 stehen, nicht erst von Stufe 3.“ The reason is the rule freeze, not the case: Part 2 changes `shorterUsefulLife.fromEvidenceYear` and `subsequentCostRate.shorterLife` of `DE_AFA_BUILDING_LINEAR@1` and `@2`, which freeze at the first enablement of recording (§60 open question 11); after it, any change would be an `@3` with a new hash although stage 1 never records the case. A purchase with a shorter-life entry stays stage 3 (§60A). State: specified and decided (§59G, the owner's decisions of 2026-11-02 on its open questions 2, 4, 5, 8 and 11), implemented in PR #251 (migration 0061), merged (f147b76) (backlog VC-X-41 Part 2).
- [ ] **VC-X-34 implemented** (the anschaffungsnahe check without `economicTransferDate`, api-design §58K). State: implemented in PR #266 (migration 0066), merged on 2026-11-04 (dd1e4c7).
- [ ] **VC-X-52 implemented** (recording `economicTransferDate` on a `CONFIRMED` or `DRAFT` Acquisition, with requirement 0 of §28.1 in the database, migration 0067). **Decided by the owner on 2026-11-04** (Entscheidung des Projektinhabers, 2026-11-04): „In freigabe-afa-erfassung.md sollte VC-X-52 deshalb unter die Voraussetzungen von Stufe 1 rutschen, neben VC-X-34.“ Reason given: „Eine bestätigte Anschaffung ohne Datum hat keinen AfA-Beginn und keine anschaffungsnahe Prüfung; nichts an ihr ist erfassbar.“ State: open questions 1–8 of api-design §58N decided by the owner on 2026-11-04 (Entscheidung des Projektinhabers, 2026-11-04); **implemented in PR #268 (migration 0067), merged in PR #268 (b301e94)** (backlog VC-X-52; §58N "As implemented (VC-X-52)"). The checkbox is ticked only in a stage decision entry.
- [ ] **VC-X-44: Plausibilität der Aufteilung Grund/Gebäude** (`DE_LAND_BUILDING_PLAUSIBILITY@1`, api-design §58T). Entered as the owner asked (Entscheidung des Projektinhabers, 2026-11-07): „**Stufe-1-Voraussetzung VC-X-44: jetzt eintragen**, als Zeile unter Stufe 1 in `freigabe-afa-erfassung.md` mit Status „spezifiziert, Umsetzung folgt“. Die Entscheidung zur Freigabe selbst bleibt mein Eintrag am Tag der Freischaltung.“ State: umgesetzt (#294, #296, Migration 0075); Freigabe offen. The status confirmed by the owner on 2026-11-09 (Entscheidung des Projektinhabers, 2026-11-09): „Ja, passt. „umgesetzt (#294, #296, Migration 0075); Freigabe offen“ ist der richtige Status, mein Vorschlag war veraltet. Die Trennung stimmt auch inhaltlich: Umgesetzt ist der Code, die Freigabe ist mein Eintrag am Tag der Freischaltung von Stufe 1, und bis dahin bleibt das Kästchen leer.“ (PR #294 with migration 0075 merged in 4543d30, its follow-up PR #296 in 41f025b.) The checkbox is ticked only in a stage decision entry.

## Stage 2 (Erweitert): checklist

Each point is one condition of decision 236-5. State on 2026-11-02:

- [ ] **VC-X-27 implemented** (maintenance paid from the Hausgeld in the anschaffungsnahe check). State: implemented in PR #269, not merged (api-design §58M "As implemented (VC-X-27)", migration 0068; backlog VC-X-27).
- [ ] **VC-X-36 implemented** (capitalised Loan interest in the AfA basis, api-design §59E). State: implemented (migration 0055; backlog VC-X-36).
- [ ] **VC-X-38 implemented** (the date of performance, api-design §59F). State: implemented (PR #239, migration 0058); its questions 239-1 … 239-9 decided by the owner on 2026-11-02, third round (§59F "Still open"), with the VC-X-38 follow-up (239-6, 239-7, 239-8) planned; VC-X-38 Part 2 (239-2, the split treatment of a source straddling the window) is planned separately, and until it lands such a source is refused for capitalisation on the check.
- [ ] **A stage-1 year recorded productively:** at least one schedule version of a year at stage 1, recorded in a productive installation after the enablement of recording. State: none (recording disabled).
- [ ] **The owner's real annual statement (Jahresabrechnung) run through phases 6 to 8** („deine echte Jahresabrechnung durch Phase 6 bis 8“): WEG (phase 6), taxation and the tax-year view (phase 7) and depreciation (phase 8) on the owner's real data, with the findings recorded without personal data (as `docs/development/real-data-run.md` does). State: not done.
- [ ] **Written confirmation of questions 14 to 17 and 23** (three-year period, scope of 15 %, WEG maintenance from the Hausgeld, land and building allocation; Bauzeitzinsen), noted under `docs/germany/` as in "How a stage is released" 3. State: oral only (2026-11-01).

## Stage 3 (Spezial): checklist

- [ ] **Stage 2's checklist met** (a released stage 3 also records every stage-2 year, §60A "The highest applicable stage wins", so stage 2's conditions are needed too). **Decided by the owner on 2026-11-02, third round** (Entscheidung des Projektinhabers, 2026-11-02): „Stufe 3 setzt die Kriterien von Stufe 2 voraus, ja.“ This was the protocol's reading, asked on the PR that added this file (#241).
- [ ] **VC-X-41 implemented in both parts** (api-design §59G). State: Part 1 implemented (PR #238, migration 0056); Part 2's four blocking points decided by the owner on 2026-11-02 (§59G "Still open"), not implemented, and a prerequisite of stage 1 already (above).
- [ ] **Written confirmation of §59G's open questions 2 and 11** (the switch from January of the evidence year; the residual value when the declared AfA differs from the computed), noted under `docs/germany/` as in "How a stage is released" 3 (`docs/germany/beratungsfragen.md` §4). **Decided by the owner on 2026-11-02** (Entscheidung des Projektinhabers, 2026-11-02): „Was für Stufe 3 schriftlich vom Berater bleibt: die Umstellung ab Januar (Frage 2) und die Restwertregel bei abweichend erklärter AfA (Frage 11). Fragen 4 und 8 sind durch Gesetz beziehungsweise Frage 9 des Berichts gedeckt.“ The confirmation is part of the release of stage 3, not a prerequisite of Part 2's implementation. State: not asked yet.

- [ ] **Written answers to questions 8, 9, 11 and 12** (shorter useful life; later costs with a shorter useful life; partial sale after several purchases; Einbauküche and its later additions), noted under `docs/germany/`. State: oral only (2026-11-01); the calculation of a later addition to a movable asset (question 12) is not answered by the report.
- [ ] **A sample case (Musterfall) with its expected result (Soll-Ergebnis) green**, as the report recommends under G: the case and its expected figures stated before the test is run, the test green on the code to be released, both named in the decision entry. State: the report's sample case of question 11 (100,000 / 160,000, sale of 50 % → 130,000) exists as a schedule-level test (`pruefbericht-2026-11-01.md`, "Nach Bestätigung auflösbare VERIFY-Punkte"); which sample case covers stage 3 is named in the decision entry.

## Decisions

None yet. An entry has this form:

```
### Stage N released (decision of the owner, YYYY-MM-DD)

- Checklist: each point ticked with its evidence (PR, test, note).
- Written confirmations: the notes under docs/germany/ (date, role, scope, SHA-256, storage).
- Rule versions and the stage mapping in force (DE_RECORDING_STAGES@n).
- Owner's statement (verbatim).
```

## Go-live der ersten produktiven Installation

**A template, not an entry.** The date is left empty on purpose: the owner enters and commits the entry on the day of the start (Entscheidung des Projektinhabers, 2026-11-06): „Die Hashes von `DE_CASH_TIMING@1` und `DE_ANSCHAFFUNGSNAHE@1` such bitte vorab heraus und lege sie als Vorlage des Go-live-Eintrags ins Protokoll, mit leerem Datum. Den Eintrag selbst und den Start mit leerer Datenbank übernehme ich am Tag des Starts.“ (issue #281). This go-live is the freeze point of the Phase-7 rules (api-design §58F, "Decided by the owner on 2026-11-01", "Freeze point"): from it on, a change of `DE_CASH_TIMING@1` or `DE_ANSCHAFFUNGSNAHE@1` is a new version (`@2`), and the pins in `services/de-backend/src/infrastructure/hashing/frozen-rules.test.ts` are never updated in place again. It is not a release of a stage and turns on no recording.

```
### Go-live der ersten produktiven Installation (Entscheidung des Projektinhabers, YYYY-MM-DD)

- Datum:
- Installation:
- Voraussetzungen (api-design §58F, "Prerequisites": VC-X-39, VC-X-27 and VC-X-40 done before the go-live):
  - VC-X-27 done: PR #269 (migration 0068), merged 2026-11-05 (e7cb10e); follow-up PR #271 (10709ad) (backlog VC-X-27).
  - VC-X-39 done: PR #237 (migration 0057), merged 2026-11-02 (766b28c); follow-ups PR #242 and PR #247 (backlog VC-X-39, "VC-X-39 follow-up", "VC-X-39 follow-up 2").
  - VC-X-40 done: PR #270 (migration 0069), merged 2026-11-05 (cb8eb63) (backlog VC-X-40).
- Freeze of the Phase-7 rules (api-design §58F, "Freeze point"), the ruleVersionHash of each:
  - DE_CASH_TIMING@1:       dab6ce4e53383d47c0505dee9988316075c9c25cc2bb28abfb2ff75b292241cf
  - DE_ANSCHAFFUNGSNAHE@1:  7cbb166d2593d3af818f039a68048bba8948cf672fd8b01bfa61dee8e78c5eae
  - Computed on: ddeb37334a1d3e7ab889ef0734bfd519be651be1 (main); on the day of the start, recheck them on the commit deployed.
- Database: empty at the start (backlog VC-X-23, closed 2026-11-06).
- DEPRECIATION_RECORDING_ENABLED: stays unset (false, api-design §60); this go-live enables no recording and releases no stage.
- Owner's statement (verbatim):
```

**How the hashes were computed:** `ruleVersionHash` (`services/de-backend/src/domains/depreciation/fingerprint.ts`) is the SHA-256 (`sha256Fingerprinter`, UTF-8, lower-case hex) over the canonical JSON of the version's `ruleCode`, `version`, `title`, `legalBasis`, `effectiveFrom`, `parameters` and `source` (not `effectiveTo`, not `status`), read from the registry `TAX_RULES` with the repository's own code on commit `ddeb373`. Both values equal the literals pinned in `frozen-rules.test.ts` (green on that commit) and the `dab6ce4e…41cf` of `DE_CASH_TIMING@1` in `invariant-suite.md` and backlog VC-X-39. If a change lands on either rule before the start, its pin is updated explicitly in the same commit, and this template takes the new value.
