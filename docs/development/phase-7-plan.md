# Phase 7 Plan — Taxation

**Status:** Proposal (accepted by review of the PR that adds it)
**Roadmap:** `docs/roadmap.md` Phase 7 · **Backlog:** `backlog.md` §3f (VC-7-xx)

Phase 7 is modelled conceptually in several places:
- ADR-006 (taxation interprets, it does not create financial facts), ADR-022 (rules are versioned) and ADR-041 (versioned code modules, no rule engine);
- `docs/germany/taxation.md` and `docs/germany/rent-and-operating-costs.md`, verified on 29.10.2026 (v0.2; `verification-checklist.md` A, D, E);
- data-model §36 (`TaxClassification`) and §37 (`TaxRuleVersion`); domain-model §43–§47;
- `reports.md` §2.2, the tax-year overview.

Several points are open, or would not fit what Phases 1–6 built:
- **Where a classification lives.** Data-model §36 has a `TaxClassification` per source entity. It does not say whether every split carries one, or what a split without one means.
- **Where a rule lives.** Data-model §37 has a `TaxRuleVersion` table, but ADR-041 puts rules in code. Both cannot be the source of truth.
- **The tax year of a cash movement.** The ledger is cash-only, which fits § 11 EStG. The 10-day rule around the year-end needs a due date, and the ledger has none (taxation.md §3, §10).
- **What WEG money becomes deductible, and when.** Phase 6 keeps reserve contributions and Sonderumlagen as `WEG_FUNDS` and records the reserve withdrawals and the Sonderumlage uses. Phase 7 has to turn exactly those into Werbungskosten, once.
- **Erhaltungsaufwand vs. Herstellungskosten**, including the anschaffungsnahe Herstellungskosten (§ 6 Abs. 1 Nr. 1a EStG) and the distribution by § 82b EStDV.
- **AfA.** The roadmap's exit names it, but AfA schedules are Phase 8.

This plan fixes those points **before** the items are specified, as `phase-6-plan.md` did for Phase 6. Each item's spec PR then only has to write out the contract.

**Exit (roadmap Phase 7):** a tax-year view derives Einkünfte aus Vermietung und Verpachtung from classified cash + AfA, every figure traceable, no cash mutated.

---

# 0. Input from the real data and the earlier phases

- **Imports are the normal path for cash**, split by proposals (Phases 4–6). So almost every relevant split already has a category, and the category is the natural default for its tax meaning (P7-D2).
- **The categories already carry the hard rules:**
  - `WEG_FUNDS` (P6-D3) for reserve contributions and Sonderumlagen: never Werbungskosten at payment;
  - `SECURITY_DEPOSIT` (P5-D6) for deposits and their interest: never income;
  - `FINANCING` for interest and principal, which differ in tax (A1);
  - `CAPITAL_MOVEMENT` for the purchase price.
- **Phase 6 records the WEG inputs Phase 7 needs:**
  - the reserve withdrawals on a confirmed statement (P6-D6 (3));
  - the uses of a Sonderumlage (P6-D7);
  - the settlement payment naming its statement, so its year is known (A10).
- **Phase 5 records `retainedAmount` at a deposit's closing** and leaves its tax meaning to Phase 7 (api-design §47.4, A11).
- **Phase 2 records the Acquisition, its costs and the land/building allocation** (P2-D7, P2-D9). They give the building's acquisition cost that § 6 Abs. 1 Nr. 1a EStG measures against.

---

# 1. Decisions

### P7-D1 Rules are code modules; the database stores only which version was applied (resolves data-model §37 against ADR-041)

- Each rule is a TypeScript module in `domains/taxation/rules/` with `ruleCode`, `version`, `legalBasis`, `effectiveFrom`, optional `effectiveTo`, `parameters` and `source` (taxation.md §9). A changed rule is a new version; the old one stays in the code and in its tests.
- A **registry** selects the version applicable on a date. `GET /api/v1/tax-rules` (api-design §58) lists the registry (read-only), so a user sees which rules exist and from when. Rule administration (§58) is not an API: a rule changes by a code change.
- **No `tax_rule_version` table.** Data-model §37 becomes the description of the registry entry. A stored classification, and every derived figure, records the applied rule as `ruleCode@version`. A version is never removed from the code while a stored reference names it. Two checks enforce it (review on #156):
  - **on write:** a classification may only name a version the registry knows;
  - **on start:** like the migration check, the backend resolves every stored `ruleCode@version` against the registry and refuses to start if one is missing.

  A test covers the mechanism.
- **Rules of Phase 7:**
  - the default meaning of each category (P7-D2);
  - the attribution to a tax year, § 11 EStG with the 10-day rule (P7-D3);
  - WEG funds become deductible when spent, BFH IX R 19/24 (P7-D5);
  - the anschaffungsnahe Herstellungskosten, § 6 Abs. 1 Nr. 1a EStG: 3 years, 15 % without VAT (P7-D6);
  - the distribution of Erhaltungsaufwand, § 82b EStDV: 2 to 5 years (P7-D6);
  - refunds, A10 (P7-D4).
- Docs: data-model §37, ADR-041 (a consequence, no new ADR).

### P7-D2 A classification is a separate record; without one, the category's default applies (resolves data-model §36)

- **The default:** each category has a tax meaning by rule (P7-D1), derived on read and never stored. For example:
  - `RENT_BASE`, `RENT_OPERATING_COST_ADVANCE`, `RENT_OPERATING_COST_SETTLEMENT`, `OTHER_INCOME`: **income** (D8: tenant advances are income);
  - `LOAN_INTEREST`, `ADMINISTRATION`, `INSURANCE`, `PROPERTY_TAX`, `BANK_FEES`, `WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE`: **deductible when paid**;
  - `LOAN_PRINCIPAL`, `ACQUISITION`, the `WEG_FUNDS`, `SECURITY_DEPOSIT` types, `OWNER_*`, `TRANSFER`: **not deductible / not taxable** (A1, A11, E6, BFH IX R 19/24);
  - `MAINTENANCE`: deductible when paid **as Erhaltungsaufwand**, open to P7-D6;
  - `OTHER_EXPENSE`, `OTHER`: **needs review**; no default meaning.
- **A `TaxClassification`** (data-model §36) is stored only when the user confirms or changes the default. It references a split (or another source, P7-D5) and records:
  - `taxCategory` (the line of the tax-year view);
  - `treatment`: `INCOME`, `DEDUCTIBLE`, `CAPITALIZED` (to the AfA basis, Phase 8), `DISTRIBUTED_82B`, `NOT_RELEVANT`;
  - `reviewState`: `SUGGESTED` (derived only) → `USER_CONFIRMED` / `ADVISOR_CONFIRMED`, or `NEEDS_REVIEW` (domain-model §45);
  - the applied rule version, a note and source references.
- **It never changes the split**, its amount or its category (ADR-006). A changed classification is a new record and supersedes the old one, which stays readable (data-model §36: "historical changes must remain traceable").
- **A corrected Transaction** (ADR-037): the classification belongs to the split it was made for. The replacement's splits fall back to their default, and the view flags `CLASSIFICATION_ON_CORRECTED_SPLIT` until the user confirms again. Nothing moves silently.
- Docs: data-model §36, api-design §55–§57 (the routes listed there become the contract).

### P7-D3 The tax year of a cash movement (§ 11 EStG; resolves taxation.md §3 and §10)

- **The rule:** the tax year is the calendar year of the booking date (Zufluss/Abfluss).
- **The 10-day exception** (§ 11 Abs. 1 S. 2, Abs. 2 S. 2 EStG; A4): a regularly recurring amount belongs to the year it **economically belongs to** when **both** its due date **and** its payment fall within 10 days around the year-end (revised in review on #156).
- **The economic year** is the year of the period the amount pays for: the rent month of the confirmed `RentPaymentReconciliation` (Phase 4), the month of the Hausgeld advance by the plan used (P6-D4), and the interest period of the loan schedule entry (Phase 3).
- **The due date** is determined per source, explicitly. A period is not a due date: rent due on the 15th of January and paid on 28 December stays in the year of payment.
  - **Loan interest:** the due date of the matching schedule entry (Phase 3).
  - **Rent:** a recorded due day of the month, from the lease. It is a new optional field on the `RentalContractReference`, since DE reads no due day from MRE today (mre-integration.md documents none). The spec of VC-7-02 checks MRE's source for one first.
  - **Hausgeld:** a recorded due day of the month, as the Vorschussbeschluss sets it. It is a new optional field on the `WegEconomicPlan` (P6-D4).
- **No recorded due day:** the start of the period serves as the due date, flagged `DUE_DATE_ASSUMED`. The assumption is never silent.
- **Proposal, not decision:** where the exception applies, the view attributes the amount to its economic year, flags `ATTRIBUTED_BY_10_DAY_RULE` (and `DUE_DATE_ASSUMED` where it applies), and names the rule version. The user can override it per split through the classification (`taxYear`), and the flag then shows the override.
- **Otherwise** the booking year applies.
- **Tax year ≠ WEG financial year ≠ reporting period** (domain-model §47). Where a WEG's financial year is not the calendar year, P7-D5 flags it.
- Docs: data-model §36 (`taxYear`), api-design §55.

### P7-D4 Income and refunds (A10, A11, D8)

- **Income:** rent, advances, settlements and other income, each in its tax year (P7-D3). Deposits and deposit interest are never income (A11, E6).
- **A refund**, that is an `INFLOW` split in an expense category:
  - for an expense of the **same** year, it reduces that line;
  - for an **earlier** year, it is income of the year received (A10).
  - The refund's year comes from the WEG statement it names (P6-D6), else from the classification (`refundOfYear`), else it is flagged `REFUND_YEAR_UNKNOWN` and shown as a reduction. The result is the same either way; only the line differs.
- **A retained deposit** (`retainedAmount` at closing, P5-D7): the user classifies it per closing (e.g. compensation for unpaid rent or for damage), default `NEEDS_REVIEW`, in the year of the closing date (A11). No cash moves: the deposit's cash was received earlier and stays in the ledger as it is.
- **Subsidies and insurance payments** (A10): classified by the user. They may reduce acquisition costs (Phase 8) or a deductible expense; there is no default.

### P7-D5 WEG money becomes deductible when the WEG spends it (BFH IX R 19/24; resolves taxation.md §8)

- **What counts when paid:** Hausgeld advances without the reserve (`WEG_RECOVERABLE`, `WEG_NON_RECOVERABLE`) and the settlement payments naming a statement, in the year paid.
- **What does not:** the `WEG_FUNDS` splits (the reserve contribution, the Sonderumlage), never, whatever their purpose.
- **What becomes deductible later:**
  - each **reserve withdrawal** of a confirmed, current statement (P6-D6 (3));
  - each **use** of a Sonderumlage (P6-D7).
  
  Each is classified once (Erhaltungsaufwand or Herstellungskosten, or not relevant), in the tax year of its date. A withdrawal without its own date takes the end of the statement's period. That is the end of the financial year, so `WEG_FINANCIAL_YEAR_NOT_CALENDAR` is flagged where the two differ.
- **Never counted twice:** a statement's cost lines are not added to the view. They are already in the Hausgeld paid, and the comparison of §51 only explains them. A superseded statement's withdrawals stop counting, and the superseding statement's count instead (BR-WEG-008).
- **Not decided by DE:** whether a given spending is Erhaltungsaufwand or Herstellungskosten (weg.md §8). The user classifies it, default `NEEDS_REVIEW`.

### P7-D6 Erhaltungsaufwand, Herstellungskosten and § 82b EStDV (A2, A5; resolves taxation.md §6)

- **Erhaltungsaufwand** (default for `MAINTENANCE`) is deductible when paid. **Herstellungskosten** are `CAPITALIZED`: they leave the year's Werbungskosten and go to the AfA basis of Phase 8.
- **The anschaffungsnahe check** (§ 6 Abs. 1 Nr. 1a EStG; A2) is a derived read per Acquisition:
  - the window is the 3 years from the transfer date;
  - it sums **every source** classified as Erhaltungsaufwand in that window, **without VAT**, and leaves out annually recurring work (a flag on the classification). The sources are (revised in review on #156):
    - the splits of the Acquisition's PropertyReference, at their booking date;
    - the reserve withdrawals and Sonderumlage uses of the unit's WEG membership (P7-D5), at the date of the withdrawal or use. Repairs to the common property arrive this way, often through a Sonderumlage shortly after a purchase;
  - it compares the sum with **15 % of the building's acquisition cost**: the building share of the price and of the acquisition costs, by the land/building allocation (P2-D9).
  - **Above 15 %:** every such source is flagged `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN` and its suggested treatment becomes `CAPITALIZED`, in earlier years too. DE shows that a filed year may be affected; it changes nothing on its own.
  - **No allocation, or not confirmed:** the check is `NOT_COMPUTABLE` with that reason. It is never estimated.
- **VAT:** the ledger stores gross cash. A private landlord pays gross, but the threshold is net. So the classification takes an optional `netAmount`; it is never required (review on #156). Without one, the check uses the gross amount:
  - the source is flagged `VAT_NOT_SEPARATED`;
  - the result of the check itself is marked `NOT_FINAL`, with a note that the gross amount reaches the threshold sooner than the net one would.
- **§ 82b EStDV** (A5): the user may elect, per Erhaltungsaufwand, to distribute it evenly over 2 to 5 years (`DISTRIBUTED_82B`, with the number of years). The view derives each year's part. On the end of ownership (Phase 2's Ownership `validUntil`), the rest falls into that year. The condition "mostly residential (> 50 %)" is the user's to confirm with the election; DE does not know a building's use.

### P7-D7 Owners' shares (domain-model §9; resolves `ownerAllocationBasis`)

- Legal ownership shares are the basis for the owner level (AGENTS.md §12). The view per owner takes each figure × the owner's Ownership share valid on the figure's date.
- The share is valid on the booking date for cash, and on the withdrawal or use date for WEG items. It is rounded half-up to the cent, with the rest on the largest share, so the owners' figures sum to the property's.
- No separate tax percentages (AGENTS.md §12).

### P7-D8 The tax-year view (resolves the exit; `reports.md` §2.2)

- `GET /api/v1/property-references/{id}/tax-years/{year}` and `…?ownerPartyId=` (P7-D7). It is a derived read in one `REPEATABLE READ READ ONLY` snapshot and is never stored. Snapshots are Phase 9's (ADR-040).
- **Structure**, modelled on the form's logic without being the form (taxation.md §10):
  - **Einnahmen:** by line;
  - **Werbungskosten:** by line (interest, Hausgeld without the reserve, WEG withdrawals and uses, Erhaltungsaufwand including § 82b parts, administration, insurance, property tax, bank fees, other);
  - **AfA:** a block of its own (below);
  - **Ergebnis:** the result (Überschuss or Verlust). Loss carry-back and carry-forward (§ 10d EStG) are income-tax matters and stay out (A12).
- **Every figure is traceable:** each line lists its items (split, withdrawal, use, deposit closing), with amount, date, treatment, review state and rule version. Summing the items gives the line.
- **Flags** for what needs a person:
  - unclassified (`OTHER_*`);
  - `NEEDS_REVIEW`;
  - `ATTRIBUTED_BY_10_DAY_RULE`, `DUE_DATE_ASSUMED`;
  - `CLASSIFICATION_ON_CORRECTED_SPLIT`;
  - `ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN`, and the check's `NOT_FINAL`;
  - `VAT_NOT_SEPARATED`;
  - `REFUND_YEAR_UNKNOWN`;
  - `WEG_FINANCIAL_YEAR_NOT_CALENDAR`.
  
  A year with open flags is shown, never hidden, and never presented as final (domain-model §45).
- **AfA:** Phase 8 derives the schedules (roadmap Phase 8: "feeds the tax-year view"). Until then the block is empty and flagged `DEPRECIATION_NOT_AVAILABLE`, and the result is labelled "before AfA". **So the roadmap's exit is met in two steps:** Phase 7 delivers the view and its classified cash, Phase 8 fills the AfA block. ACC7 proves everything except the AfA figure; ACC8 adds it.
- **No cash mutated:** the view only reads. A test compares the ledger, its splits and their versions before and after every Phase-7 command.

### P7-D9 Conventions carried over (as P6-D9)

- Creates take `Idempotency-Key` (§15), changes take `If-Match` (§16.1), and every write writes an AuditRecord. Every row is Realm-scoped by composite foreign keys.
- **Lock order:** a classification write locks its source row (split, withdrawal's statement, use's assessment, deposit) as a no-op write, then the current classification of that source. One current classification per source is enforced by a partial unique index.
- No MRE call beyond Phase 4's stored rent periods.

---

# 2. Items

See `backlog.md` §3f. The order follows the dependencies:
1. **VC-7-01:** the rule registry of P7-D1, the category defaults of P7-D2, `TaxClassification` on splits (confirm, change, history; api-design §55–§57), `GET /tax-rules` (§58). Migration.
2. **VC-7-02:** the tax year of P7-D3 (the 10-day rule with the due dates of Phase 3 and the new due days on the rental contract and the plan) and the income and refunds of P7-D4, including the retained deposit.
3. **VC-7-03:** the WEG inputs of P7-D5 (withdrawals and uses as classification sources) and P7-D6 (Erhaltungsaufwand vs. Herstellungskosten, the anschaffungsnahe check, § 82b).
4. **VC-7-04:** the tax-year view of P7-D8 per PropertyReference and per owner (P7-D7), with items, flags and rule versions; the AfA block empty and flagged.
5. **VC-7-05:** the Phase-7 invariant suite and ACC7. One scenario through the API:
   - a property with two owners;
   - a year of rent, Hausgeld (two debits), interest and principal, a repair and a deposit;
   - a statement with a reserve withdrawal, and a Sonderumlage with a use;
   - a rent payment within the 10 days after the year-end;
   - a refund of an earlier year;
   - a Sonderumlage with a use within 3 years that, together with a repair, takes the sum above 15 %;
   - a § 82b election;
   - a retained deposit;
   - the view per property and per owner.

   Counter-checks:
   - a reserve contribution counted when paid;
   - principal or a deposit counted;
   - a WEG cost line counted on top of the Hausgeld;
   - a classification that changes a split;
   - a figure without its items.

**Out of scope for Phase 7:**
- AfA schedules (Phase 8);
- the tenant's operating-cost statement (Phase 9, with `rent-and-operating-costs.md` §5);
- loss carry-back and carry-forward (§ 10d EStG), and the income tax itself;
- the check of the intention to make a profit (A8);
- ELSTER or an official form;
- VAT option, business assets, commercial leases (taxation.md §1);
- a classification catalogue for free text (BR-OPEN-008);
- reports and dashboards (Phase 9).

# 3. Verification

`taxation.md` and `rent-and-operating-costs.md` are v0.2, verified on 29.10.2026. This plan relies on:
1. **A1:** interest deductible, principal not (P7-D2).
2. **A2:** 15 % **without VAT**, more than, within 3 years of the acquisition; annual maintenance and extensions excluded (P7-D6).
3. **A4:** the 10-day rule needs due **and** paid within the window (P7-D3).
4. **A5:** § 82b EStDV, 2 to 5 years, buildings mostly residential, the rest on sale (P7-D6).
5. **A10:** refunds (P7-D4).
6. **A11, E6:** deposits and their interest are not income; a retention is reclassified (P7-D4).
7. **A12:** losses are shown, their carry is out of scope (P7-D8).
8. **E1 (BFH IX R 19/24):** WEG funds are deductible when spent (P7-D5).
9. **D8:** tenant advances are income, the costs borne are Werbungskosten, both recorded (P7-D2).

**Still case-dependent, so the user decides and DE never guesses** (taxation.md §10):
- Erhaltungsaufwand vs. Herstellungskosten in the individual case;
- the reclassification of a retained deposit;
- the tax meaning of subsidies and insurance payments.

**Answered in the review on #156:**
1. **Net amounts for the 15 % check:** the warning is enough; the net amount stays optional. The check's result carries `NOT_FINAL` and the note on gross amounts (P7-D6).
2. **AfA in two steps:** accepted, as long as the AfA block is flagged `DEPRECIATION_NOT_AVAILABLE`, the result is labelled "before AfA" and ACC8 completes the exit (P7-D8). Reversing the order would cost more, since the AfA needs the anschaffungsnahe Herstellungskosten of P7-D6 as an input.
