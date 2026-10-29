# Phase 6 Plan — WEG

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 6 · **Backlog:** `backlog.md` §3e (VC-6-xx)

Phase 6 is modelled conceptually in several places:
- ADR-017 (WEG is a dedicated German domain) and ADR-018 (incomplete reserve data out of the MVP);
- `docs/germany/weg.md`, the domain's legal draft, every rule `VERIFY`-marked;
- data-model §27–§32 and §73; domain-model §31–§37 and its WEG aggregate;
- BR-WEG-001…010, UC-030…033, WF-008/009, DF-012/013, `reports.md` §2.5;
- api-design §49–§51, a list of routes.

Several points are open, or would not fit what Phases 1–5 built:
- **How a Hausgeld payment is tied to its WEG.** The categories `WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE` and `WEG_RESERVE_CONTRIBUTION` exist since 0008, but nothing links such a split to a WEG or a unit.
- **What the Wirtschaftsplan is for DE.** Data-model §29 carries totals only (`totalPlannedAmount`, `propertyPlannedAmount`). Splitting a payment needs the unit's monthly components.
- **What "split into ledger effects" means for a Jahresabrechnung** (the roadmap's exit). A statement creates no cash (BR-WEG-007, anti-pattern 3 of data-flow). Confirmed splits are frozen (ADR-037), so the year's Hausgeld cannot be re-split in place either.
- **The Erhaltungsrücklage.** `WEG_RESERVE_CONTRIBUTION` has `category_type = OPERATING_EXPENSE`. A contribution is regularly not yet a deductible expense when it is paid (weg.md §5.2, `VERIFY`). Phase 7 reads the type, as P5-D6 relies on for deposits.
- **The Sonderumlage.** Data-model §32 has the record, but no category and no link to its payments.
- **Corrected statements** (BR-WEG-008) and **missing reserve data** (BR-WEG-009, ADR-018).

This plan fixes those points **before** the items are specified, as `phase-5-plan.md` did for Phase 5. Each item's spec PR then only has to write out the contract.

**Exit (roadmap Phase 6):** a Jahresabrechnung is represented with preserved statement structure and split into ledger effects without losing provenance.

---

# 0. Input from the real-data run (#93)

`real-data-run.md` changes or confirms these points:
- **Hausgeld arrives as two debits (F5).** The WEG debits the Hausgeld and the Erhaltungsrücklage separately, each monthly. So a proposal must handle a debit that is only the reserve, only the Hausgeld, or both (P6-D4).
- **Which part of the Hausgeld is recoverable is only known from the Jahresabrechnung (F5).** At payment time only the Wirtschaftsplan's split exists. This is the core of the phase: book by plan now, account for the difference with the statement (P6-D6).
- **Imports are the normal path for cash.** A Hausgeld debit arrives as an imported Transaction with the WEG's IBAN. A suggestion from that IBAN, as P4-D4 does for rent, is left out of Phase 6: one debit per month and WEG makes the proposal by amount enough (P6-D4).
- **The landlord is a member, never the administrator.** DE records what the owner receives from the Verwalter (Wirtschaftsplan, Jahresabrechnung, Sonderumlage resolutions) and pays. It does not run a WEG's books.

**What the real data needs from the user** before VC-6-03 is specified: the structure (not the amounts) of one real Jahresabrechnung and Einzelwirtschaftsplan from the owner's Verwalter. That means the column headings, how the cost lines are grouped, whether recoverability is marked per line, and how the reserve section looks. Anonymised notes only, as for #93.

---

# 1. Decisions

### P6-D1 The WEG and the membership (resolves data-model §27–§28, UC-030)

- **`Weg`:** `displayName`, `administratorPartyId` (a Party of Phase 2, optional), `financialYearStartMonth` (1–12, default 1), `notes`. Statuses `ACTIVE` → `VOID`. A WEG with memberships, plans, statements or assessments is never voided (as P5's `DEPOSIT_HAS_SPLITS`).
- **`WegMembership`:** a PropertyReference (a unit) in a WEG, from `validFrom` to an optional `validUntil`. The `Miteigentumsanteil` is stored as a fraction (`meaNumerator`/`meaDenominator`, e.g. 125/10,000), never as a rounded percentage. It is distinct from the Ownership share (data-model §28).
- **One WEG per unit at a time:** a PropertyReference has at most one membership valid on any day (an exclusion constraint on the date range). The Realm is checked through composite foreign keys, as everywhere.
- No MRE call: a WEG has no MRE counterpart (BR-WEG-001). The unit comes in through the PropertyReference.
- Docs: data-model §27–§28, api-design §49.

### P6-D2 A WEG split names its unit (resolves the missing link)

- A split in `WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE`, `WEG_RESERVE_CONTRIBUTION` or `WEG_SPECIAL_ASSESSMENT` (P6-D7) **requires a `propertyReferenceId`**. That unit has a membership valid on the Transaction's booking date, else `422 NO_WEG_MEMBERSHIP`.
- The WEG is derived from the membership, so there is no `wegId` on the split. This keeps one source of truth and lets Phase 7 read costs per unit, as all other operating expenses are read.
- The rule holds for new writes, through the split command and `correct`. Existing splits of these categories (written before Phase 6) are left as they are, since confirmed splits are frozen. VC-6-02 counts them and reports the number in its PR.
- **Lock order:** Transaction → membership rows (`FOR SHARE`). A membership's validity is changed only while no split falls outside the new range, else `409 MEMBERSHIP_HAS_SPLITS`.
- Docs: api-design §34/§35 (split rule), data-model §18.

### P6-D3 The Erhaltungsrücklage is not an expense when paid (resolves weg.md §5.2 in the model)

- `WEG_RESERVE_CONTRIBUTION` moves to a new `category_type = WEG_RESERVE`, no longer `OPERATING_EXPENSE`. Phase 7 then can never read a contribution as Werbungskosten at payment. When the WEG spends the reserve, the deductible amount comes from the Jahresabrechnung's reserve section (P6-D6), and its tax meaning is Phase 7's (`VERIFY`).
- This mirrors P5-D6: the category type carries the rule, not a convention.
- Docs: data-model §18 (categories), weg.md §5.2, verification-checklist (one line).

### P6-D4 The Wirtschaftsplan gives the unit's monthly components (resolves data-model §29, DF-012)

- **`WegEconomicPlan`** for one membership (the unit's Einzelwirtschaftsplan) and one financial year:
  - the monthly advance, split into `recoverable`, `nonRecoverable` and `reserveContribution` (Money; they sum to the advance);
  - the approval date of the resolution;
  - optional plan cost lines (description, total, the unit's share, recoverability), kept as the source structure (BR-WEG-006).
- Statuses `ACTIVE` → `SUPERSEDED` (a new plan for the same year, keeping the old one, BR-WEG-008) or `VOID`. A plan is planning data: it never creates a Transaction (BR-WEG-003).
- A plan stays in force until the next one is approved, as is common practice (`VERIFY`, weg.md §3). So the plan for a booking date is the latest `ACTIVE` plan whose year starts on or before it.
- **Hausgeld split proposal** (a read, never a write, like §37.6 and §41.5): `GET …/hausgeld-proposal?transactionId=` for an unconfirmed `OUTFLOW`. The unit is the membership of the Transaction's PropertyReference, or is given in the query. The proposal by amount:
  - **= the full advance:** the three components;
  - **= the reserve contribution only:** `WEG_RESERVE_CONTRIBUTION`. This is the second debit of F5;
  - **= the advance without the reserve:** the recoverable and non-recoverable parts;
  - **otherwise:** the components in the plan's proportions, rounded half-up to the cent, with the rest on the largest part, and the flag `AMOUNT_DIFFERS_FROM_PLAN`.
- Docs: data-model §29, api-design §50.

### P6-D5 The Jahresabrechnung is stored with its structure (resolves data-model §30–§31, BR-WEG-006/008)

- **`WegAnnualStatement`** for one membership and one financial year:
  - the source document reference;
  - the resolution date (since WEMoG the owners resolve on the **Abrechnungsspitze**: the advances' adjustment and the back-payments, weg.md §4, `VERIFY`);
  - **cost lines** (data-model §31): position, description, the WEG total, the allocation key as printed, the unit's share, and a classification of `RECOVERABLE`, `NON_RECOVERABLE` or `RESERVE`. The classification is the user's, may be refined later, and is kept apart from tax (BR-WEG-010);
  - **the unit's totals as printed:** costs, advances owed under the plan, and the Abrechnungsspitze (back-payment or credit);
  - **the reserve section, optional:** the unit's share at the start and end of the year, contributions and withdrawals. What the statement does not show stays `null` (BR-WEG-009, ADR-018); nothing is estimated.
- **The statement's own check:** the cost lines' shares sum to the printed costs, and costs − advances = the Abrechnungsspitze. A mismatch is a flag (`LINES_DIFFER_FROM_TOTAL`, `SETTLEMENT_DIFFERS`), never a refusal: the printed statement wins, and the flag points to a typo or to the Verwalter.
- **Lifecycle:**
  - `DRAFT` (entered, editable) → `CONFIRMED` (frozen) → `SUPERSEDED` by a corrected statement for the same membership and year, which keeps the old one readable (BR-WEG-008); also `VOID` from `DRAFT`.
  - One `CONFIRMED` statement per membership and year.
- **Entry:** structured JSON through the API (WF-OPEN-005: a structured import, and OCR later, are out of scope).
- Docs: data-model §30–§31, api-design §50–§51.

### P6-D6 The ledger effects of a statement (resolves the exit; DF-013)

A statement never re-splits the year's cash, and never creates cash. Its ledger effects are three, each traceable to a cost line:
1. **The comparison of advances with actual costs** (a read on a `CONFIRMED` statement), per class (`RECOVERABLE`, `NON_RECOVERABLE`, `RESERVE`):
   - **paid:** the year's counted WEG splits of the unit, by category, as booked by plan (P6-D4);
   - **actual:** the cost lines' shares by class;
   - **difference:** actual − paid.

   The sum of the differences equals the Abrechnungsspitze (up to advances owed but not paid, shown separately as `unpaidAdvances`). This tells Phase 7 and the tenant's operating-cost statement how much of the year was really recoverable, without touching a confirmed split.
2. **The settlement payment:** the Abrechnungsspitze arrives as one Transaction (a debit for a back-payment, a credit for a refund). Its split proposal comes from the differences of (1), in the same categories. The split names the statement (`wegAnnualStatementId` on the split, like `loanId`), so the payment is traced to its source. A credit is an `INFLOW` in the same expense categories, a reduction of the year's cost (`VERIFY` with Phase 7).
3. **The reserve withdrawals** of the reserve section, kept on the statement as the later deductible amount for Phase 7. They are not booked: the owner paid no cash for them.

- A later correction of a counted split moves (1) on read. A superseding statement takes over (1)–(3), and the settlement split keeps naming the statement it was booked against. A flag `SETTLED_AGAINST_SUPERSEDED` shows when that is not the current one.
- Docs: data-flow DF-013, api-design §51.

### P6-D7 The Sonderumlage (resolves data-model §32)

- **`WegSpecialAssessment`** for one membership: description, the resolution date, the WEG total, the unit's share, due dates (one or several instalments), and a purpose (`MAINTENANCE`, `MODERNISATION`, `LIQUIDITY`, `OTHER`, as resolved; its tax meaning is Phase 7's, weg.md §5.3).
- A new category `WEG_SPECIAL_ASSESSMENT` (type `WEG_RESERVE` when it goes into the reserve, else `OPERATING_EXPENSE`; decided per assessment at its purpose, `VERIFY`). Its splits name the assessment (`wegSpecialAssessmentId`). Paid and outstanding are derived from counted cash, as P5-D2.
- Statuses `ACTIVE` → `SETTLED` (derived when fully paid) / `VOID` (unreferenced only).
- Docs: data-model §32, api-design §49.

### P6-D8 Recoverability is DE's classification, tax is Phase 7's (BR-WEG-010)

- Phase 6 records recoverability (`RECOVERABLE` / `NON_RECOVERABLE`, BetrKV, rent-and-operating-costs.md §4) on plan and statement lines and on the split categories. It records no tax class.
- A catalogue that pre-classifies typical line descriptions (BR-OPEN-008) is out of scope: the user classifies each line once per statement. The next statement proposes the previous year's classification for a line with the same description.

### P6-D9 Conventions carried over (as P5-D9)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord. Every row is Realm-scoped by composite foreign keys.
- **Lock order:** Transaction → membership (`FOR SHARE`) → statement or assessment rows, in id order. Writers of a plan, statement or assessment lock only their own row and read splits. Each guard gets a concurrency test under RC and RR.
- No MRE call anywhere in Phase 6.

---

# 2. Items

See `backlog.md` §3e. The order follows the dependencies:
1. **VC-6-01:** `Weg` and `WegMembership` (create, read, list, amend, end, void), the one-WEG-per-unit constraint, migration.
2. **VC-6-02:** the split rule of P6-D2, the category type of P6-D3, the Wirtschaftsplan of P6-D4 and the Hausgeld split proposal, migration.
3. **VC-6-03:** the Jahresabrechnung of P6-D5: entry, the statement's own check, confirm, supersede, void. Migration. Needs the structure of a real statement (§0).
4. **VC-6-04:** the ledger effects of P6-D6: the comparison read, the settlement proposal and `wegAnnualStatementId` on splits, the reserve withdrawals.
5. **VC-6-05:** the Sonderumlage of P6-D7, with its category and link.
6. **VC-6-06:** the Phase-6 invariant suite and ACC6. One scenario through the API:
   - a WEG with a membership;
   - a plan;
   - twelve months of the two debits of F5, imported and split by proposal;
   - a statement with a back-payment;
   - the comparison read, whose differences sum to the Abrechnungsspitze;
   - the settlement split naming the statement;
   - a corrected statement that supersedes it, with the flag;
   - a Sonderumlage in two instalments;
   - Realm isolation on every §49–§51 route.

   Counter-checks:
   - a statement that re-splits confirmed cash;
   - a reserve contribution read as an operating expense;
   - a WEG split without a membership.

**Out of scope for Phase 6:**
- running a WEG's books as its administrator;
- a structured import or OCR of statements (WF-OPEN-005);
- a classification catalogue (BR-OPEN-008);
- a suggestion of WEG debits from the IBAN history;
- the tenant's operating-cost statement (Betriebskostenabrechnung) built from the recoverable costs, which belongs to Phase 7/9 with `rent-and-operating-costs.md`;
- the WEG report (`reports.md` §2.5), which is Phase 9's;
- every tax meaning (Phase 7).

# 3. `VERIFY` before the items are specified

The roadmap asks to confirm `weg.md`'s `VERIFY` rules before coding. These are the ones the plan relies on, for the user (and, where marked, a tax adviser):
1. **Since WEMoG, the owners resolve on the Abrechnungsspitze** (§ 28 Abs. 2 WEG). P6-D5 stores the printed totals and the resolution date; it does not need the exact legal effect.
2. **A Wirtschaftsplan stays in force until the next one** (P6-D4's choice of the plan for a date).
3. **A reserve contribution is not deductible when paid, only when the WEG spends it** (BFH; tax adviser). P6-D3 only keeps the two apart, so either answer of Phase 7 remains possible.
4. **Typical recoverable lines** (BetrKV § 2) and that administration and the reserve are never recoverable (weg.md §6).
5. **A Sonderumlage's tax meaning follows its purpose** (weg.md §5.3; tax adviser). P6-D7 only records the purpose.
