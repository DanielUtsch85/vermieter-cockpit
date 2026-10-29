# Phase 6 Plan — WEG

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 6 · **Backlog:** `backlog.md` §3e (VC-6-xx)

Phase 6 is modelled conceptually in several places:
- ADR-017 (WEG is a dedicated German domain) and ADR-018 (incomplete reserve data out of the MVP);
- `docs/germany/weg.md`, the domain's legal rules, verified on 29.10.2026 (v0.2; `verification-checklist.md` C1–C7, E1, E4);
- data-model §27–§32 and §73; domain-model §31–§37 and its WEG aggregate;
- BR-WEG-001…010, UC-030…033, WF-008/009, DF-012/013, `reports.md` §2.5;
- api-design §49–§51, a list of routes.

Several points are open, or would not fit what Phases 1–5 built:
- **How a Hausgeld payment is tied to its WEG.** The categories `WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE` and `WEG_RESERVE_CONTRIBUTION` exist since 0008, but nothing links such a split to a WEG or a unit.
- **What the Wirtschaftsplan is for DE.** Data-model §29 carries totals only (`totalPlannedAmount`, `propertyPlannedAmount`). Splitting a payment needs the unit's monthly components.
- **What "split into ledger effects" means for a Jahresabrechnung** (the roadmap's exit). A statement creates no cash (BR-WEG-007, anti-pattern 3 of data-flow). Confirmed splits are frozen (ADR-037), so the year's Hausgeld cannot be re-split in place either.
- **The Erhaltungsrücklage.** `WEG_RESERVE_CONTRIBUTION` has `category_type = OPERATING_EXPENSE`. A contribution is not yet a deductible expense when it is paid (weg.md §5.2, BFH IX R 19/24). Phase 7 reads the type, as P5-D6 relies on for deposits.
- **The Sonderumlage.** Data-model §32 has the record, but no category and no link to its payments. Its payment is not automatically an expense either (weg.md §5.3).
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

**The real documents** (supplied 29.10.2026: three Jahresabrechnungen, one Wirtschaftsplan, one protocol; not committed, structure only):
- **Einzelwirtschaftsplan:** cost lines in two groups as printed, "Betriebskosten (auf Mieter umlegbar nach BetrKV)" and "Sonstige Kosten (nicht auf Mieter umlegbar)", each with an allocation key as printed (Miteigentumsanteile, Einheit, a consumption key), the WEG total and the unit's share, and a subtotal per group; an income line; a separate section for the reserve advance; and a "Neufestsetzung" of the **monthly** Hausgeld and Rücklage **from a date within the year**. This shapes VC-6-02 (api-design §49.5).
- **MEA:** printed with three decimals over 10.000,000 (api-design §49.2).
- **Jahresabrechnung (three years):** the same two cost groups with subtotals; per line the allocation key, the allocation quantities (total and the unit's) and the amounts (total and the unit's); the advances in two blocks (Hausgeld and Rücklage, each requested, paid and balance); the result (costs − Hausgeld requested = Abrechnungsspitze, a back-payment or a credit; the Abrechnungsergebnis; the reserve balance apart); the reserve development (opening, contributions, interest, withdrawals; the unit's share computed by MEA); the WEG's bank accounts and an annex on household-related services (§ 35a EStG), neither stored. This shapes VC-6-03 (api-design §50).

---

# 1. Decisions

### P6-D1 The WEG and the membership (resolves data-model §27–§28, UC-030)

- **`Weg`:** `displayName`, `administratorPartyId` (a Party of Phase 2, optional), `financialYearStartMonth` (1–12, default 1), `notes`. Statuses `ACTIVE` → `VOID`. A WEG with memberships, plans, statements or assessments is never voided (as P5's `DEPOSIT_HAS_SPLITS`).
- **`WegMembership`:** a PropertyReference (a unit) in a WEG, from `validFrom` to an optional `validUntil`. The `Miteigentumsanteil` is stored as a fraction (`meaNumerator`/`meaDenominator`), never as a rounded percentage. The real statements print it with three decimals over a base of `10.000,000`, so both parts are decimals with up to three places (api-design §49.2). It is distinct from the Ownership share (data-model §28).
- **One WEG per unit at a time:** a PropertyReference has at most one `ACTIVE` membership valid on any day, else `409 OVERLAPPING_WEG_MEMBERSHIP`. This is a trigger after the Ownership's (0019), not an exclusion constraint, which would need the `btree_gist` extension that the schema does not have:
  - the trigger first locks the PropertyReference row (`UPDATE property_reference SET version = version`, as `ownership_invariants`), so two concurrent memberships of one unit are serialised;
  - it then refuses an overlap with `daterange(valid_from, valid_until, '[]') && …`.
- The Realm is checked through composite foreign keys, as everywhere.
- No MRE call: a WEG has no MRE counterpart (BR-WEG-001). The unit comes in through the PropertyReference.
- Docs: data-model §27–§28, api-design §49.

### P6-D2 A WEG split names its unit (resolves the missing link)

- A split in `WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE`, `WEG_RESERVE_CONTRIBUTION` or `WEG_SPECIAL_ASSESSMENT` (P6-D7) **requires a `propertyReferenceId`**. That unit has a membership valid on the Transaction's booking date, else `422 NO_WEG_MEMBERSHIP`.
- The WEG is derived from the membership, so there is no `wegId` on the split. This keeps one source of truth and lets Phase 7 read costs per unit, as all other operating expenses are read. So §33.2's `NOT_SUPPORTED` for `wegId` stays for good, as for `acquisitionId`.
- The rule holds for new writes, through the split command and `correct`. Existing splits of these categories (written before Phase 6) are left as they are, since confirmed splits are frozen. VC-6-02 counts them and reports the number in its PR.
- **Lock order:** Transaction → PropertyReference (a no-op write; revised in VC-6-02's spec, api-design §49.3: a share lock on the membership rows would let a REPEATABLE READ end through). A membership's validity is changed only while no split falls outside the new range, else `409 MEMBERSHIP_HAS_SPLITS`.
- Docs: api-design §34/§35 (split rule), data-model §18.

### P6-D3 Money paid into WEG funds is not an expense when paid (resolves weg.md §5.2–§5.3 in the model)

- A new `category_type = WEG_FUNDS`: money the owner pays to the WEG that is not yet the owner's expense. `WEG_RESERVE_CONTRIBUTION` moves to it, no longer `OPERATING_EXPENSE`, and so does `WEG_SPECIAL_ASSESSMENT` (P6-D7). Phase 7 then can never read a contribution or a Sonderumlage as Werbungskosten at payment.
- **Verified (BFH IX R 19/24 of 14.01.2025, also under the WEG law since 01.12.2020):** a contribution is not deductible when it is paid. It becomes deductible only when and as far as the WEG spends the money on measures that would be Werbungskosten if paid directly. So the contribution and the later spending are kept apart (P6-D6 (3)). Whether a spending is Erhaltungsaufwand or Herstellungskosten is Phase 7's.
- **Schema:** `WEG_FUNDS` is a new value of the `category_type` CHECK of 0008 and of `CATEGORY_TYPES` (`domains/ledger/financial-category.ts`). The migration updates `WEG_RESERVE_CONTRIBUTION`'s row; `down` restores `OPERATING_EXPENSE`.
- **Retroactive on purpose:** the type belongs to the category, not to the split. So every split of `WEG_RESERVE_CONTRIBUTION`, including confirmed ones written before Phase 6, reads as `WEG_FUNDS` from the migration on. That is intended, since all contributions are then read alike. Today only `GET /financial-categories` returns `categoryType`; no read filters by it yet, so no figure changes now. VC-6-02 counts the affected splits (confirmed and unconfirmed) and reports the number in its PR, as for P6-D2.
- This mirrors P5-D6: the category type carries the rule, not a convention.
- Docs: data-model §18 (categories), weg.md §5.2.

### P6-D4 The Wirtschaftsplan gives the unit's monthly components (resolves data-model §29, DF-012)

- **`WegEconomicPlan`** for one membership (the unit's Einzelwirtschaftsplan) and one financial year:
  - the monthly advance, split into `recoverable`, `nonRecoverable` and `reserveContribution` (Money; they sum to the advance);
  - the date of the Vorschussbeschluss. The resolution on the advances, not the plan as a document, makes them owed (§ 28 Abs. 1 WEG, checklist C3). The plan is the resolution's basis and is stored with it;
  - optional plan cost lines (description, total, the unit's share, recoverability), kept as the source structure (BR-WEG-006).
- Statuses `ACTIVE` → `VOID`. A later resolution with new amounts is a new plan with a later `effectiveFrom` (the real plans set the monthly amounts "ab 1.3."), so the old one stays as it is (BR-WEG-008) without a `SUPERSEDED` status; a wrong plan is voided. A plan is planning data: it never creates a Transaction (BR-WEG-003).
- **The plan for a booking date** is the membership's `ACTIVE` plan with the latest `effectiveFrom` on or before it. If its financial year does not contain the date, the proposal carries the flag `PLAN_OF_EARLIER_YEAR`. Whether a resolution keeps the advances owed into the next year depends on the resolution itself; weg.md v0.2 does not state a general rule. So DE never decides it: it proposes and shows which plan it used.
- **Hausgeld split proposal** (a read, never a write, like §37.6 and §41.5): `GET /api/v1/transactions/{id}/hausgeld-proposal` for an unconfirmed `OUTFLOW`. The unit is the membership of the Transaction's PropertyReference, or is given in the query. The proposal by amount:
  - **= the full advance:** the three components;
  - **= the reserve contribution only:** `WEG_RESERVE_CONTRIBUTION`. This is the second debit of F5;
  - **= the advance without the reserve:** the recoverable and non-recoverable parts;
  - **two of these cases at once** (e.g. the reserve contribution equals the advance without the reserve): no proposed split, only the matching cases and the flag `AMBIGUOUS_AMOUNT`, so the user decides;
  - **otherwise:** the components in the plan's proportions, rounded half-up to the cent, with the rest on the largest part, and the flag `AMOUNT_DIFFERS_FROM_PLAN`.
- A plan's `reserveContribution` is never split into `WEG_RECOVERABLE`: the reserve is not recoverable (weg.md §6, checklist C7).
- Docs: data-model §29, api-design §50.

### P6-D5 The Jahresabrechnung is stored with its structure (resolves data-model §30–§31, BR-WEG-006/008)

- **`WegAnnualStatement`** for one membership and one financial year:
  - the source document reference;
  - the resolution date, and an optional due date (§ 28 Abs. 3 WEG). **Verified (§ 28 Abs. 2 WEG, checklist C2):** the owners resolve on the back-payments (Nachschüsse) or on the adjustment of the advances, the **Abrechnungsspitze**. The statement is the arithmetic basis of that resolution, not its object, as it was before 01.12.2020;
  - **cost lines** (data-model §31): position, description, the WEG total, the allocation key as printed, the unit's share, and a classification of `RECOVERABLE`, `NON_RECOVERABLE` or `RESERVE`. The classification is the user's, may be refined later, and is kept apart from tax (BR-WEG-010). weg.md §6 asks for four separate attributes per line; Phase 6 stores the first two:
    1. the WEG allocation (the printed key and the unit's share);
    2. the recoverability from the tenant;
    3. the lease's allocation key: Phase 7/9, with the tenant's operating-cost statement. By § 556a Abs. 3 BGB the WEG key applies unless the lease agrees otherwise, which is why (1) is kept as printed;
    4. the tax class: Phase 7;
  - **the unit's totals as printed:** costs, advances owed under the plan, and the Abrechnungsspitze (back-payment or credit);
  - **the reserve section, optional:** the unit's share at the start and end of the year, contributions and withdrawals, each withdrawal with its description. Its source is the statement or the Vermögensbericht (§ 28 Abs. 4 WEG), recorded as `ANNUAL_STATEMENT` or `ASSET_REPORT`. What neither shows stays `null` (BR-WEG-009, ADR-018); nothing is estimated.
- **The statement's own check:** the cost lines' shares sum to the printed subtotals and total, costs − Hausgeld requested = the Abrechnungsspitze, a line's share matches its allocation quantities, and the reserve development adds up. A mismatch is a flag (api-design §50: `LINES_DIFFER_FROM_SUBTOTAL`, `SUBTOTALS_DIFFER_FROM_TOTAL`, `SETTLEMENT_DIFFERS`, `RESULT_DIFFERS`, `LINE_SHARE_DIFFERS`, `RESERVE_DIFFERS`), never a refusal: the printed statement wins, and the flag points to a typo or to the Verwalter.
- **Lifecycle:**
  - `DRAFT` (entered, editable) → `CONFIRMED` (frozen) → `SUPERSEDED` by a corrected statement for the same membership and year, which keeps the old one readable (BR-WEG-008); also `VOID` from `DRAFT`.
  - One `CONFIRMED` statement per membership and year; a corrected statement is confirmed with `supersedes`, which makes the old one `SUPERSEDED` in the same transaction.
- **Classification default** (P6-D8): a line without one takes the classification of the same account in the last confirmed statement of an earlier year, else its printed group.
- **Entry:** structured JSON through the API (WF-OPEN-005: a structured import, and OCR later, are out of scope).
- Docs: data-model §30–§31, api-design §50–§51.

### P6-D6 The ledger effects of a statement (resolves the exit; DF-013)

A statement never re-splits the year's cash, and never creates cash. Its ledger effects are three, each traceable to a cost line:
1. **The comparison of advances with actual costs** (a read on a `CONFIRMED` statement), per class (`RECOVERABLE`, `NON_RECOVERABLE`, `RESERVE`):
   - **paid:** the year's counted WEG splits of the unit, by category, as booked by plan (P6-D4);
   - **actual:** the cost lines' shares by class;
   - **difference:** actual − paid.

   The sum of the differences equals the Abrechnungsspitze (up to advances owed but not paid, shown separately as `unpaidAdvances`). This tells Phase 7 and the tenant's operating-cost statement how much of the year was really recoverable, without touching a confirmed split.
2. **The settlement payment:** the Abrechnungsspitze arrives as one Transaction (a debit for a back-payment, a credit for a refund). Its split proposal comes from the differences of (1), in the same categories. The split names the statement (`wegAnnualStatementId` on the split, like `loanId`), so the payment is traced to its source. A credit is an `INFLOW` in the same expense categories and names the statement, so its year is known. Its tax effect is Phase 7's: a refund of Werbungskosten offsets them in the same year and is income in a later year (checklist A10).
3. **The reserve withdrawals** of the reserve section, kept on the statement with their descriptions. By BFH IX R 19/24 they are where a deduction can arise, so Phase 7 classifies each one (Erhaltungsaufwand, Herstellungskosten). They are not booked: the owner paid no cash for them.

- A later correction of a counted split moves (1) on read. A superseding statement takes over (1)–(3), and the settlement split keeps naming the statement it was booked against. A flag `SETTLED_AGAINST_SUPERSEDED` shows when that is not the current one.
- Docs: data-flow DF-013, api-design §51.

### P6-D7 The Sonderumlage (resolves data-model §32)

- **`WegSpecialAssessment`** for one membership: description, the resolution date, the WEG total, the unit's share, due dates (one or several instalments), and a purpose as resolved (`MAINTENANCE`, `MODERNISATION`, `LIQUIDITY`, `OTHER`).
- **Its use**, optional and added later: what the WEG actually spent the money on, with date, description and the unit's share, from the statement or the Verwalter. **Verified (weg.md §5.3, checklist C6):** the payment alone is no deductible expense. What counts is when and for what the WEG uses the money. So the purpose is not the tax meaning; the use is the input for Phase 7.
- A new category `WEG_SPECIAL_ASSESSMENT` of type `WEG_FUNDS` (P6-D3), whatever the purpose. Its splits name the assessment (`wegSpecialAssessmentId`). Paid and outstanding are derived from counted cash, as P5-D2.
- Statuses `ACTIVE` → `SETTLED` (derived when fully paid) / `VOID` (unreferenced only).
- Docs: data-model §32, api-design §49.

### P6-D8 Recoverability is DE's classification, tax is Phase 7's (BR-WEG-010)

- Phase 6 records recoverability (`RECOVERABLE` / `NON_RECOVERABLE`, BetrKV, rent-and-operating-costs.md §4) on plan and statement lines and on the split categories. It records no tax class.
- **Verified (weg.md §6, checklist C7, E4):** WEG costs and operating costs are not the same. Administration, Instandhaltung and Instandsetzung, and the reserve contribution are never recoverable from a tenant. Other costs are recoverable only if the lease validly agrees it and BetrKV § 2 covers them. TV and broadband basic fees are no longer recoverable since 01.07.2024, a dated rule for Phase 7/9. A WEG statement is not the tenant's operating-cost statement.
- A catalogue that pre-classifies typical line descriptions (BR-OPEN-008) is out of scope: the user classifies each line once per statement. The next statement proposes the previous year's classification for a line with the same description.

### P6-D9 Conventions carried over (as P5-D9)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord. Every row is Realm-scoped by composite foreign keys.
- **Lock order:** Transaction → PropertyReference (no-op write) → membership → statement or assessment rows, in id order. A membership write locks its PropertyReference first (P6-D1), then the membership row. Writers of a plan, statement or assessment lock only their own row and read splits. Each guard gets a concurrency test under RC and RR.
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

# 3. Verification (29.10.2026)

The roadmap asks to confirm `weg.md`'s `VERIFY` rules before coding. The user supplied the verified `weg.md` v0.2 and the filled `verification-checklist.md` v0.2 on 29.10.2026. The five points this plan relied on:
1. **The resolution on the Abrechnungsspitze** (§ 28 Abs. 2 WEG): confirmed, with a precise wording (checklist C2). The owners resolve on back-payments or on the adjustment of the advances; the statement is the basis. P6-D5 stores the printed totals, the resolution date and an optional due date (§ 28 Abs. 3).
2. **A Wirtschaftsplan stays in force until the next one:** not confirmed as a general rule; it depends on the resolution. P6-D4 now prefers the plan of the booking year and flags `PLAN_OF_EARLIER_YEAR` otherwise. DE does not decide the legal question.
3. **A reserve contribution is deductible only when the WEG spends it:** confirmed by BFH IX R 19/24 of 14.01.2025 (checklist C1, E1). P6-D3 keeps contribution and spending apart; P6-D6 (3) keeps the withdrawals with their descriptions.
4. **Recoverable lines:** confirmed (checklist C7, E4). Administration, Instandhaltung/Instandsetzung and the reserve are never recoverable. New for the model: § 556a Abs. 3 BGB makes the WEG key the tenant's key unless the lease agrees otherwise (P6-D5, P6-D8).
5. **A Sonderumlage's tax meaning:** corrected (checklist C6). It follows the WEG's actual use, not the payment and not the resolved purpose alone. P6-D7 now records the use, and the category is of type `WEG_FUNDS`.

Still open, and handled conservatively in the MVP (weg.md §8): the tax class of a specific Sonderumlage or reserve spending, Erhaltungsaufwand vs. Herstellungskosten, cost allocation resolutions under § 16 WEG, structural changes, and commercial leases. None of them is needed by Phase 6, which records no tax meaning.
