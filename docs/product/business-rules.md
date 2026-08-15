# Business Rules

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Living Document  
**Scope:** Cross-domain and domain-level business rules

---

# 1. Purpose

This document defines the business rules that govern Vermieter Cockpit DE.

It consolidates rules that must hold across use cases and workflows without duplicating the full domain model, persistence model, or API specification.

The document answers:

> Which business conditions, invariants, validations, and decision rules must the system enforce?

Business rules are written to be understandable independently of a specific UI or implementation technology.

Detailed entity structure remains governed by:

- `docs/architecture/domain-model.md`
- `docs/architecture/data-model.md`

Detailed commands and API behavior remain governed by:

- `docs/architecture/api-design.md`

User goals and orchestration remain governed by:

- `docs/product/use-cases.md`
- `docs/product/workflows.md`

German legal and tax rules that require detailed jurisdiction-specific specification belong under:

- `docs/germany/`

---

# 2. Rule Classification

Rules use the following categories.

| Type | Meaning |
|---|---|
| `INV` | invariant that must always hold |
| `VAL` | validation rule applied to input or state transition |
| `DER` | derived-value rule |
| `DEC` | decision / classification rule |
| `INT` | integration rule |
| `AUD` | audit / provenance rule |
| `SEC` | security / access rule |
| `LIFE` | lifecycle / state-transition rule |

Rule IDs are stable references and should be used in tests, ADRs, API documentation, and implementation comments where useful.

---

# 3. Rule Authority

Business rules must comply with the project authority hierarchy:

1. `docs/constitution.md`
2. accepted Architecture Decisions
3. Domain Model
4. Data Model
5. Glossary
6. API Design
7. this document and domain-specific specifications
8. implementation

If a rule in this document conflicts with a higher-authority document, the higher-authority document wins and this document must be corrected.

Rules that depend on unresolved German legal or tax interpretation must remain explicitly unresolved rather than being guessed.

---

# 4. General Source-of-Truth Rules

## BR-GEN-001 — Separate Sources of Truth

**Type:** INV

Operational truth, financial truth, interpretation, and derived analysis are distinct layers.

```text
Operational truth     → MRE
Financial truth       → DE Financial Ledger
Interpretation        → DE domain classifications
Derived analysis      → DE calculations / snapshots / reports
```

No layer may silently replace another.

---

## BR-GEN-002 — No Convenience Duplication

**Type:** INV

Canonical data owned by one domain must not be duplicated as a second editable source of truth merely to simplify queries or UI behavior.

Cached non-authoritative display metadata is allowed only where explicitly modeled.

---

## BR-GEN-003 — Derived Data Does Not Become Canonical Input

**Type:** INV

Calculated metrics, schedules, projections, summaries, and reports must not silently become canonical facts.

If derived data is persisted, its derived nature must remain explicit.

---

## BR-GEN-004 — Unknown Is Different From Zero

**Type:** INV

Missing, unknown, unresolved, and zero values must not be treated as equivalent.

Examples:

- unknown WEG reserve ≠ EUR 0 reserve
- unknown valuation ≠ EUR 0 valuation
- unresolved Tax Classification ≠ non-deductible
- missing payment ≠ zero-value Transaction

---

## BR-GEN-005 — Business Date and Technical Timestamp Are Distinct

**Type:** INV

A real-world effective date must not be replaced by `createdAt` or another technical timestamp.

Historical records may be entered after their effective business date.

---

# 5. Identity and Reference Rules

## BR-ID-001 — MRE Property Identity

**Type:** INT

An MRE Property is referenced in DE domains through `PropertyReference`.

DE-owned domain entities use `propertyReferenceId`.

Raw upstream identity uses `mrePropertyId` plus Realm context where required.

---

## BR-ID-002 — PropertyReference Uniqueness

**Type:** INV

Within the applicable integration scope, the same MRE Realm + MRE Property identity must resolve to at most one active canonical PropertyReference.

Repeated onboarding must be idempotent.

---

## BR-ID-003 — No MVP Unit Entity

**Type:** INV

The MVP must not introduce a canonical `Unit`, `UnitReference`, `unitId`, or `unitIds` merely to recreate a generic:

`Property → Unit → Lease → Tenant`

hierarchy.

A future need for a distinct building/sub-asset hierarchy requires an explicit architecture decision.

---

## BR-ID-004 — Rental Relationship Reference

**Type:** INT

DE domains reference the concrete MRE rental relationship through `RentalContractReference`.

A generic `leaseId` must not be used as a substitute.

---

## BR-ID-005 — MRE Account Is Not FinancialAccount

**Type:** INV

MRE `Account` represents an authenticated MRE user.

DE `FinancialAccount` represents a bank/cash account.

They must never share semantic identity.

---

## BR-ID-006 — Party Is Independent of MRE Tenant

**Type:** INV

A DE `Party` must not be assumed to be identical to an MRE Tenant.

Identity relationships between DE Party and external/MRE records must be explicit.

---

# 6. MRE Integration Rules

## BR-MRE-001 — MRE Owns Operational Rental State

**Type:** INV

MRE remains authoritative for:

- operational Property data
- Tenant rental relationships
- Lease Definitions
- rent obligations
- operational rent settlement state
- operational rental management

The DE layer must not establish competing editable operational state.

---

## BR-MRE-002 — Historical DE Records Survive Upstream Deletion

**Type:** INV

Deletion or unavailability of an upstream MRE entity must not cascade-delete historical DE financial, acquisition, tax, WEG, financing, or investment records.

---

## BR-MRE-003 — Cached MRE Data Is Non-Authoritative

**Type:** INT

Where PropertyReference or another integration entity caches upstream display metadata, the cached value is not authoritative for current MRE operational state.

---

## BR-MRE-004 — MRE Unavailability Does Not Invalidate DE Cash

**Type:** INV

A temporary MRE outage must not make already persisted DE Ledger Transactions unavailable or invalid.

Operations requiring current MRE state may fail or become retryable.

---

## BR-MRE-005 — MRE Write-Back Is Explicit

**Type:** LIFE

A DE-side reconciliation does not silently imply a successful MRE state change.

MRE write-back is a distinct integration action with its own result and audit state.

---

## BR-MRE-006 — MRE Write-Back Must Be Idempotent

**Type:** INT

Retrying a write-back must not create duplicate MRE payment state.

---

# 7. Party and Ownership Rules

## BR-OWN-001 — Ownership Is Temporal

**Type:** INV

Ownership is represented through time-bounded relationships.

Historical Ownership must not be overwritten when ownership changes.

---

## BR-OWN-002 — Legal Share Is Canonical Allocation Basis

**Type:** DEC

Within the current product scope, legal ownership shares are the canonical basis for owner-level allocation of income, expenses, and tax-related amounts.

Separate economic or tax ownership percentages must not be introduced without an accepted architecture decision.

---

## BR-OWN-003 — Ownership Shares Must Be Valid

**Type:** VAL

For a fully specified ownership period, active ownership shares for the PropertyReference must reconcile to 100%.

Temporary incomplete draft data may remain unconfirmed.

---

## BR-OWN-004 — No Conflicting Confirmed Ownership Periods

**Type:** INV

Confirmed Ownership records must not create contradictory overlapping ownership structures for the same PropertyReference and date.

---

## BR-OWN-005 — Ownership Change Preserves History

**Type:** LIFE

An ownership change closes or supersedes the previous valid ownership period and establishes a new one.

It must not rewrite historical owner allocation.

---

# 8. Acquisition Rules

## BR-ACQ-001 — Acquisition Is Independent of MRE Property

**Type:** INV

Acquisition facts belong to the Acquisition Aggregate and must not be embedded as canonical acquisition state into MRE Property.

---

## BR-ACQ-002 — Acquisition Fact Is Not Cash Fact

**Type:** INV

A known purchase price, cost, or contractual obligation does not become a Transaction unless actual cash moved.

---

## BR-ACQ-003 — Acquisition Costs Preserve Provenance

**Type:** AUD

Acquisition costs should retain the source of their amount and classification where practical, including linked Transactions and documents.

---

## BR-ACQ-004 — One Payment May Contain Multiple Acquisition Meanings

**Type:** DEC

Where one actual payment contains multiple economic components, the Transaction remains singular and TransactionSplits represent the components.

---

## BR-ACQ-005 — Land and Building Allocation Must Reconcile

**Type:** VAL

A confirmed land/building allocation must reconcile to its defined allocation basis subject to the approved precision and rounding rules.

---

## BR-ACQ-006 — Land Value Is Not Depreciable

**Type:** DER

The land component of a land/building allocation must not contribute to the depreciable building basis.

Detailed German depreciation rules remain defined separately.

---

# 9. Financial Account Rules

## BR-ACC-001 — FinancialAccount Represents Cash Location

**Type:** INV

A FinancialAccount represents a source or destination of actual cash.

Examples include supported bank accounts and deposit holding accounts.

---

## BR-ACC-002 — Loan Is Not FinancialAccount

**Type:** INV

A Loan remains a Financing-domain entity even if the lender exposes a technical loan account number.

---

## BR-ACC-003 — Currency Must Be Explicit

**Type:** INV

Every FinancialAccount and monetary cash record must have unambiguous currency semantics.

Currencies must not be silently mixed.

---

## BR-ACC-004 — Account Closure Preserves History

**Type:** LIFE

Closing a FinancialAccount prevents or restricts future use according to its lifecycle but must not remove historical Transactions.

---

# 10. Ledger Rules

## BR-LED-001 — Ledger Is Cash-Only

**Type:** INV

A Transaction exists only for actual cash movement.

The following must not become Transactions merely because they have monetary values:

- expected rent
- Loan schedules
- WEG economic plans
- depreciation
- valuations
- forecasts
- scenarios
- tax calculations
- planned maintenance
- unpaid invoices or obligations unless represented in a separate appropriate domain

---

## BR-LED-002 — Transaction Amount Uses Decimal Precision

**Type:** INV

Monetary values must not use binary floating-point arithmetic for persistence or business calculations.

---

## BR-LED-003 — Imported Transaction Preserves Source

**Type:** AUD

An imported Transaction must retain sufficient provenance to identify its external source and support duplicate detection.

---

## BR-LED-004 — Import Is Idempotent

**Type:** INV

Re-importing the same external bank record must not create another canonical Transaction.

---

## BR-LED-005 — Potential Duplicate Is Not Automatically a New Transaction

**Type:** DEC

Where deterministic identity cannot be established but duplicate indicators are strong, the record should be flagged for review rather than silently duplicated.

---

## BR-LED-006 — Transaction Split Reconciliation

**Type:** INV

For a fully split Transaction:

`sum(TransactionSplit.amount) == Transaction.amount`

subject to canonical sign and rounding rules.

---

## BR-LED-007 — Split Does Not Duplicate Cash

**Type:** INV

TransactionSplits interpret one cash movement.

They do not represent additional cash movement.

---

## BR-LED-008 — One Split Has One Defined Amount

**Type:** INV

A TransactionSplit must have an explicit amount and must not rely on implicit remainder semantics once confirmed unless the Data Model explicitly defines such behavior.

---

## BR-LED-009 — Classification Does Not Change Cash Fact

**Type:** INV

Changing:

- Financial Category
- PropertyReference
- Party
- Tax Classification
- Loan relationship
- other interpretation

must not silently alter the underlying amount, account, or booking event.

---

## BR-LED-010 — No Fabricated Balancing Transactions

**Type:** INV

The system must not create fake Transactions merely to make:

- rent reconciliation
- WEG statements
- Loan schedules
- tax reports
- scenarios

balance.

---

## BR-LED-011 — Confirmed Cash Correction Must Be Auditable

**Type:** AUD

If a confirmed canonical cash fact is corrected, the previous state and correction relationship must remain traceable according to the final correction/mutability design.

---

# 11. Rent Reconciliation Rules

## BR-RENT-001 — MRE Settlement Is Not Cash

**Type:** INV

An MRE rent obligation marked paid or settled does not prove that cash exists in the DE Ledger.

---

## BR-RENT-002 — Cash Receipt Does Not Automatically Settle MRE

**Type:** INV

A rent-like Transaction does not silently alter MRE operational payment state.

---

## BR-RENT-003 — Reconciliation Is Explicit

**Type:** INV

The relationship between MRE operational rent state and DE cash is represented through `RentPaymentReconciliation`.

---

## BR-RENT-004 — Suggestions Are Not Confirmations

**Type:** LIFE

Automated matching may create a suggested reconciliation.

A suggestion does not become confirmed merely because its confidence is high unless a future accepted policy explicitly permits auto-confirmation.

---

## BR-RENT-005 — Cash Cannot Be Consumed Twice

**Type:** INV

The same Transaction or TransactionSplit amount must not be reconciled more than once beyond its available amount.

---

## BR-RENT-006 — Partial Payment Remains Partial

**Type:** DER

Where matched cash is less than the relevant obligation, the obligation remains partially unsettled.

The system must not synthesize the missing amount.

---

## BR-RENT-007 — Overpayment Remains Explicit

**Type:** DER

Where received cash exceeds the matched obligation, the excess remains unresolved or separately classified until its economic meaning is determined.

---

## BR-RENT-008 — Combined Payment Uses Explicit Allocation

**Type:** INV

Where one Transaction covers several obligations or economic purposes, matched amounts must be explicitly allocated.

TransactionSplits are required where economic meaning differs.

---

## BR-RENT-009 — Historical Reconciliation Follows Historical Rental Relationship

**Type:** INV

A Tenant change must not reassign historical rent reconciliations to the new RentalContractReference.

---

## BR-RENT-010 — Failed Write-Back Does Not Delete Reconciliation

**Type:** LIFE

If DE reconciliation is confirmed but MRE write-back fails, the reconciliation remains confirmed and the integration failure remains visible/retryable.

---

# 12. Financing Rules

## BR-FIN-001 — Loan Is Canonical Financing Entity

**Type:** INV

A financing contract is represented once as a canonical Loan.

---

## BR-FIN-002 — Shared Loan Is Not Duplicated

**Type:** INV

If one Loan relates to multiple PropertyReferences, it must remain one Loan.

Property relationships use LoanAllocation.

---

## BR-FIN-003 — Loan Schedule Is Not Cash

**Type:** INV

Expected principal and interest schedule entries are not Transactions.

Only actual Loan payments are Ledger cash.

---

## BR-FIN-004 — Loan Payment Components Use Splits

**Type:** DEC

Where an actual Loan payment contains principal and interest, the cash Transaction is decomposed through TransactionSplits or the canonical equivalent defined by the Data Model.

---

## BR-FIN-005 — Principal and Interest Are Distinct

**Type:** INV

Loan principal repayment and Loan interest must remain separately identifiable because they have different financing, investment, and tax meaning.

---

## BR-FIN-006 — Remaining Debt Is Derived From Financing Truth

**Type:** DER

Remaining debt must be calculated from canonical Loan terms/state and actual reconciled financing events according to the defined financing model.

It must not be inferred solely from arbitrary bank-account balances.

---

## BR-FIN-007 — Allocation Must Be Explicit

**Type:** INV

Property-level use of a shared Loan requires a supported LoanAllocation.

The system must not invent a hidden allocation basis.

---

## BR-FIN-008 — Confirmed Full Allocation Reconciles

**Type:** VAL

Where a Loan is defined as fully allocated across Properties for a period, active allocation shares must reconcile to 100%.

---

## BR-FIN-009 — Undefined Allocation Policy Is a Stop Condition

**Type:** DEC

If a property-level metric requires a Loan allocation rule not defined by accepted documentation, the calculation must stop or return an explicit unresolved result rather than invent a rule.

---

# 13. Security Deposit Rules

## BR-DEP-001 — Security Deposit Is Not Rental Income

**Type:** INV

Kaution must not be classified as Rental Income merely because cash was received from a tenant.

---

## BR-DEP-002 — Expected Deposit Is Not Received Deposit

**Type:** INV

The contractual/operational expected deposit amount is distinct from actual cash received.

---

## BR-DEP-003 — Actual Receipt Requires Cash Evidence

**Type:** INV

A Security Deposit may only be treated as actually received to the extent supported by linked actual Transaction amounts.

---

## BR-DEP-004 — Deposit May Be Paid in Installments

**Type:** LIFE

One SecurityDeposit may be linked to multiple receipt Transactions.

Outstanding amount is derived.

---

## BR-DEP-005 — Deposit Repayment Requires Cash Evidence

**Type:** INV

Actual repayment is derived from linked repayment Transactions.

---

## BR-DEP-006 — Mixed Rent and Deposit Payment Must Be Split

**Type:** DEC

If one cash movement contains rent and Kaution, use TransactionSplits before applying the respective rent and deposit lifecycle logic.

---

## BR-DEP-007 — MRE Guaranty Is Operational Context

**Type:** INT

MRE guaranty/guaranty-payback values may inform deposit workflow but are not canonical evidence of cash receipt or repayment.

---

## BR-DEP-008 — Deposit Holding Account Is Explicit

**Type:** VAL

Where the holding account is known, SecurityDeposit should reference the relevant FinancialAccount rather than storing an unstructured bank-account description.

---

# 14. WEG Rules

## BR-WEG-001 — WEG Is Separate From MRE Property

**Type:** INV

WEG-specific concepts belong to the DE WEG domain and must not be embedded into MRE Property as canonical WEG state.

---

## BR-WEG-002 — WEG Membership References PropertyReference

**Type:** INV

The relationship between a condominium and a WEG is represented through the canonical WEG membership model and PropertyReference.

---

## BR-WEG-003 — Wirtschaftsplan Is Planned Data

**Type:** INV

Amounts in a Wirtschaftsplan are plan/obligation data and are not Transactions.

---

## BR-WEG-004 — Hausgeld Payment Is One Cash Movement

**Type:** INV

One actual Hausgeld bank debit remains one Transaction even when it has several economic components.

---

## BR-WEG-005 — Hausgeld Components Use Splits

**Type:** DEC

Components such as:

- recoverable operating costs
- non-recoverable costs
- administration
- reserve contribution

must be represented at split/classification level where economically required.

---

## BR-WEG-006 — WEG Statement Structure Is Preserved

**Type:** AUD

A Jahresabrechnung must retain enough line-level structure and provenance to trace classifications back to the source statement.

---

## BR-WEG-007 — WEG Statement Does Not Create Cash

**Type:** INV

Statement lines do not become Transactions merely because they contain monetary amounts.

They may be reconciled with actual Transactions.

---

## BR-WEG-008 — Corrected Statement Preserves Previous Provenance

**Type:** AUD

A corrected/superseding WEG statement must not silently erase a previously used statement where historical traceability is required.

---

## BR-WEG-009 — Missing Reserve Data Remains Missing

**Type:** INV

Incomplete Erhaltungsrücklage data must not be converted into invented zero or estimated canonical values merely to complete the model.

---

## BR-WEG-010 — Recoverability and Tax Treatment Are Separate

**Type:** INV

Whether a WEG cost is tenant-recoverable and whether it has a particular tax treatment are distinct classifications.

---

# 15. Maintenance and Improvement Rules

## BR-MNT-001 — Maintenance Project Is Not Cash

**Type:** INV

A MaintenanceProject represents an economic/project context.

Actual payments remain Ledger Transactions.

---

## BR-MNT-002 — Project Costs Link to Actual Cash Where Paid

**Type:** INV

Paid project costs should be traceable to Transactions/TransactionSplits.

---

## BR-MNT-003 — Mixed Invoice Uses Splits

**Type:** DEC

If one paid invoice contains several economic/tax components, one Transaction may have multiple TransactionSplits.

---

## BR-MNT-004 — Unresolved Repair vs Improvement Treatment Remains Unresolved

**Type:** DEC

Where German tax treatment has not been determined, the system must not guess whether expenditure is immediately deductible, acquisition-related, or capitalized.

---

# 16. Tax Rules

## BR-TAX-001 — Tax Classification Is Interpretation

**Type:** INV

Tax Classification interprets a canonical economic or financial fact.

It must not replace or mutate that fact.

---

## BR-TAX-002 — Unknown Tax Treatment Is Explicit

**Type:** INV

An unresolved tax treatment must remain unresolved/needs-review.

It must not default silently to deductible, non-deductible, or another substantive treatment.

---

## BR-TAX-003 — Tax Rules Must Be Version-Aware Where Time-Dependent

**Type:** INV

A tax rule that changes by effective date must retain an applicable rule/version context.

---

## BR-TAX-004 — Tax Rule Provenance

**Type:** AUD

Legally material rule definitions should retain provenance sufficient to understand the basis for the implemented rule.

---

## BR-TAX-005 — Ownership Allocation Uses Legal Ownership Share

**Type:** DER

For the current scope, owner-level tax allocations follow the valid legal Ownership shares for the applicable period.

---

## BR-TAX-006 — Tax Year Uses Business-Relevant Dates

**Type:** DEC

Tax-year inclusion must use the relevant domain/tax date rule rather than technical creation timestamps.

Concrete German timing rules belong in `docs/germany/taxation.md`.

---

## BR-TAX-007 — Tax Preparation Is Not Tax Filing

**Type:** INV

The product may prepare, classify, calculate, report, and export tax-relevant data.

It must not imply that a generated report is itself a legally filed tax return.

---

## BR-TAX-008 — Missing Rule Blocks Automatic Conclusion

**Type:** DEC

Where a legally material German tax rule is not yet specified, automated classification/calculation must not fabricate the rule.

---

# 17. Depreciation Rules

## BR-AFA-001 — Depreciation Is Non-Cash

**Type:** INV

Depreciation must never create a Ledger Transaction.

---

## BR-AFA-002 — Depreciation Basis Comes From Canonical Inputs

**Type:** DER

The depreciable basis must derive from canonical Acquisition and allocation inputs rather than manually duplicating unrelated values where avoidable.

---

## BR-AFA-003 — Land Is Excluded

**Type:** DER

Land value is excluded from building depreciation basis.

---

## BR-AFA-004 — Rule Version Is Required

**Type:** VAL

A confirmed depreciation calculation must identify the applicable depreciation rule/version where rule selection affects the result.

---

## BR-AFA-005 — Calculation Must Be Reproducible

**Type:** INV

Given the same canonical inputs and rule version, the calculation should reproduce the same result subject to defined rounding.

---

## BR-AFA-006 — Recalculation Preserves Relevant History

**Type:** AUD

Where a depreciation schedule previously used for reporting is recalculated due to changed basis or rule interpretation, prior calculation provenance must remain traceable according to the versioning model.

---

# 18. Market Valuation Rules

## BR-VAL-001 — Market Valuation Is Dated

**Type:** INV

Every MarketValuation must have an explicit valuation date.

---

## BR-VAL-002 — Market Valuation Is Not Purchase Price

**Type:** INV

A MarketValuation is a separate economic estimate and must not silently overwrite Acquisition purchase price.

---

## BR-VAL-003 — MRE Property Price Is Not Canonical Valuation

**Type:** INV

MRE Property.price must not automatically become the canonical DE MarketValuation.

---

## BR-VAL-004 — Valuation Source Is Traceable

**Type:** AUD

Where practical, MarketValuation should identify method/source.

---

## BR-VAL-005 — Missing Valuation Must Not Be Silently Substituted

**Type:** DEC

If a metric requires a valuation and none satisfying its definition exists, the metric must be unavailable or explicitly warned.

The system must not silently substitute purchase price or MRE Property.price.

---

# 19. Investment Rules

## BR-INV-001 — Investment Metrics Are Derived

**Type:** INV

NOI, cashflow, Equity, LTV, Cash-on-Cash Return, IRR, remaining debt, and similar metrics are calculated results.

They are not editable canonical facts.

---

## BR-INV-002 — Metric Definition Must Be Explicit

**Type:** INV

Each material investment metric must have a defined formula, input semantics, period/as-of semantics, and version where formula evolution matters.

---

## BR-INV-003 — Missing Required Input Produces Warning or No Result

**Type:** DEC

A metric must not silently invent a required input.

---

## BR-INV-004 — Actual and Scenario Results Are Separate

**Type:** INV

Scenario assumptions and projected results must not overwrite actual canonical data.

---

## BR-INV-005 — Scenario Uses Explicit Assumptions

**Type:** INV

Every scenario-specific deviation from actual/baseline data must be represented as an explicit assumption or derived scenario result.

---

## BR-INV-006 — Snapshot Is Immutable Derived History

**Type:** INV

An InvestmentMetricSnapshot represents a historical calculated state.

It must not become an editable replacement for canonical source data.

---

## BR-INV-007 — Snapshot Retains Calculation Context

**Type:** AUD

A meaningful snapshot should retain sufficient context to identify:

- as-of date / period
- metric definition/version
- relevant source/input references
- scenario where applicable
- warnings or completeness information where supported

---

## BR-INV-008 — Portfolio Aggregation Preserves Missing-Data Visibility

**Type:** INV

Portfolio-level metrics must not hide material unresolved allocations or missing property-level inputs.

---

# 20. Reporting Rules

## BR-REP-001 — Reports Are Derived Views

**Type:** INV

Reports do not become independent sources of truth.

---

## BR-REP-002 — Material Figures Should Be Traceable

**Type:** AUD

Where practical, a material report figure should be traceable to the canonical records and calculation logic that produced it.

---

## BR-REP-003 — Report Period Is Explicit

**Type:** VAL

Reports whose meaning depends on time must state the relevant period or as-of date.

---

## BR-REP-004 — Missing Data Is Visible

**Type:** INV

Reports must not present incomplete calculations as complete without warning where missing data materially affects the result.

---

## BR-REP-005 — Export Preserves Referenceability

**Type:** AUD

Exports intended for review should preserve identifiers or references sufficient to trace records back to the application.

---

# 21. Lifecycle Rules

## BR-LIFE-001 — Suggested Is Not Confirmed

**Type:** LIFE

Machine-generated or rule-generated suggestions remain non-authoritative until confirmed according to the relevant workflow.

---

## BR-LIFE-002 — Confirmed State Requires Validation

**Type:** LIFE

A record must not enter Confirmed state if a hard invariant required for confirmation fails.

---

## BR-LIFE-003 — Correction Is Explicit

**Type:** LIFE

Changing a material confirmed interpretation should use an explicit correction/update action rather than hidden background mutation.

---

## BR-LIFE-004 — Superseded Does Not Mean Deleted

**Type:** LIFE

Where a versioned business record is superseded, historical versions remain available when required for auditability.

---

## BR-LIFE-005 — External Failure Has Explicit State

**Type:** LIFE

If a confirmed DE action requires an external write that fails, the external synchronization status must remain visible rather than pretending the whole operation succeeded.

---

# 22. Idempotency Rules

## BR-IDEM-001 — External Imports Require Stable Duplicate Protection

**Type:** INV

Retryable external imports must use stable identity, fingerprinting, or another deterministic duplicate-protection strategy.

---

## BR-IDEM-002 — Commands May Accept Idempotency Keys

**Type:** INT

Where the API design defines idempotency keys for retryable commands, the same key and semantically same request must not create duplicate side effects.

---

## BR-IDEM-003 — Reconciliation Retry Must Not Consume Amount Twice

**Type:** INV

Retrying reconciliation confirmation must not duplicate matched amounts.

---

## BR-IDEM-004 — External Write Retry Must Be Safe

**Type:** INT

Retrying MRE or future external-system write-back must not duplicate the external business event.

---

# 23. Concurrency Rules

## BR-CON-001 — Concurrent Material Changes Must Not Be Silently Lost

**Type:** INV

Where optimistic concurrency/versioning applies, stale writes must fail explicitly rather than overwrite a newer material state.

---

## BR-CON-002 — Financial Classification Conflicts Are Explicit

**Type:** VAL

Concurrent edits to Transaction classification or splits must be detected where they could violate confirmed financial interpretation.

---

## BR-CON-003 — Allocation Conflicts Are Explicit

**Type:** VAL

Concurrent changes to Ownership or LoanAllocation must not create silently contradictory confirmed periods or totals.

---

# 24. Audit and Provenance Rules

## BR-AUD-001 — Imported Data Retains External Identity

**Type:** AUD

Where available, external IDs, source system, import batch, and import timestamp are retained.

---

## BR-AUD-002 — Material Confirmations Record Actor and Time

**Type:** AUD

Confirmation of material financial, reconciliation, tax, WEG, or calculation state should record who confirmed it and when.

---

## BR-AUD-003 — Source Documents Remain Referenced

**Type:** AUD

Where a classification or amount derives materially from a document, the domain model should preserve the document/source relationship where supported.

---

## BR-AUD-004 — Rule-Based Calculations Retain Rule Version

**Type:** AUD

Calculations whose result depends on a versioned rule must retain or be able to resolve the rule version used.

---

## BR-AUD-005 — Provenance Must Not Be Destroyed by Normalization

**Type:** INV

Normalization may create structured canonical data but must not unnecessarily discard the source information required to understand its origin.

---

# 25. Money and Rounding Rules

## BR-MON-001 — No Binary Floating Point for Money

**Type:** INV

Monetary persistence and domain calculations must use the approved decimal/money representation.

---

## BR-MON-002 — Currency Is Part of Monetary Meaning

**Type:** INV

An amount without defined currency semantics is incomplete.

---

## BR-MON-003 — Rounding Is Defined Per Calculation

**Type:** VAL

Calculations that can create fractional minor units must use an explicit rounding strategy.

Do not rely on language/runtime defaults without specification.

---

## BR-MON-004 — Rounding Must Preserve Reconciliation

**Type:** INV

Split, allocation, and report calculations must define how rounding differences are handled so confirmed totals remain reconcilable.

---

# 26. Date and Period Rules

## BR-DATE-001 — Effective Periods Use Explicit Boundaries

**Type:** INV

Temporal relationships such as Ownership and LoanAllocation must use explicit effective dates/periods where their meaning changes over time.

---

## BR-DATE-002 — Historical Records Remain Evaluated in Historical Context

**Type:** INV

Owner allocation, tax treatment, and other time-dependent interpretation must use the rule/state applicable to the relevant historical period, not merely today's state.

---

## BR-DATE-003 — As-Of Metrics Are Time-Bounded

**Type:** INV

Metrics such as remaining debt, Equity, and LTV must identify their as-of date.

---

# 27. Validation Severity

Validation results should conceptually distinguish:

## Error

The state would violate a hard invariant and cannot be confirmed.

Examples:

- split total mismatch
- duplicate canonical external transaction
- invalid ownership total
- reconciliation exceeds available cash

## Warning

The state can exist but may be incomplete or require attention.

Examples:

- missing MarketValuation
- unresolved Tax Classification
- incomplete WEG reserve data
- stale MRE cached metadata

## Information

The system highlights context without blocking the action.

Exact UI treatment is outside this document.

---

# 28. Rule Enforcement Boundaries

Rules should be enforced as close as practical to the domain that owns them.

Examples:

| Rule | Owning Boundary |
|---|---|
| Transaction split total | Financial Ledger |
| PropertyReference uniqueness | MRE Integration |
| Ownership period validity | Ownership |
| LoanAllocation validity | Financing |
| Security Deposit cash linkage | Security Deposit |
| WEG statement structure | WEG |
| Tax rule version | Taxation |
| Depreciation reproducibility | Depreciation |
| Metric input completeness | Investment |

Workflow orchestration may call these validations.

It should not duplicate the rules independently.

---

# 29. Rules Requiring Further Specification

The following business-rule areas remain intentionally open.

## BR-OPEN-001 — Confirmed Transaction Cash-Fact Correction

The project still needs a final rule for whether confirmed canonical cash facts use:

- audited mutation
- reversal + replacement
- append-only replacement chain

Until decided, implementations must not choose an irreversible strategy casually.

---

## BR-OPEN-002 — Shared Loan Allocation Methods

The model supports LoanAllocation.

The supported allocation bases and their metric-specific use still require definition.

---

## BR-OPEN-003 — Security Deposit Account Requirements

The exact German/legal metadata and lifecycle requirements for dedicated Kautionskonten require further domain specification.

---

## BR-OPEN-004 — Automatic Reconciliation Confirmation

The current architecture distinguishes suggestion and confirmation.

Any future auto-confirmation threshold/policy requires an explicit decision.

---

## BR-OPEN-005 — MRE Automatic Write-Back Policy

The technical capability and explicit write-back concept exist.

Whether confirmation automatically triggers write-back remains a product decision.

---

## BR-OPEN-006 — German Tax Catalogue

Concrete rules for:

- Werbungskosten
- acquisition-related expenditure
- immediately deductible repairs
- capitalization
- financing costs
- ownership allocation edge cases
- timing rules

must be defined in `docs/germany/taxation.md`.

---

## BR-OPEN-007 — German Depreciation Catalogue

Concrete AfA methods, rates, start-date rules, and special cases must be defined in `docs/germany/depreciation.md`.

---

## BR-OPEN-008 — WEG Classification Catalogue

Concrete rules for:

- recoverability
- reserve treatment
- Sonderumlage
- annual statement treatment
- operating-cost relevance

must be defined in `docs/germany/weg.md` and `docs/germany/rent-and-operating-costs.md`.

---

## BR-OPEN-009 — Metric Formula Catalogue

The canonical formulas and period semantics for NOI, CCR, IRR, LTV, Equity, and other metrics should be specified before implementation of the analytics engine.

---

# 30. Minimum Rule Test Matrix

The implementation should eventually include automated tests covering at least:

| Rule Area | Minimum Test |
|---|---|
| PropertyReference | duplicate MRE reference rejected/resolved idempotently |
| Ownership | confirmed shares reconcile to 100% |
| Ownership | historical ownership preserved after change |
| Bank import | repeated import creates no duplicate Transaction |
| TransactionSplit | split total must equal Transaction amount |
| Rent reconciliation | cash cannot be matched beyond available amount |
| Rent reconciliation | partial payment remains partial |
| Rent reconciliation | failed MRE write-back preserves DE reconciliation |
| Loan | shared Loan is not duplicated per Property |
| LoanAllocation | full allocation reconciles to 100% |
| Security Deposit | expected amount does not imply cash receipt |
| Security Deposit | installment payments aggregate correctly |
| WEG | Wirtschaftsplan does not create Transactions |
| WEG | Hausgeld split preserves one underlying Transaction |
| Tax | unresolved treatment does not auto-classify |
| Depreciation | no depreciation Transaction is created |
| Depreciation | same inputs + rule version reproduce result |
| Valuation | missing valuation is not silently replaced |
| Investment | scenario does not mutate actual data |
| Snapshot | persisted snapshot does not become editable source truth |
| Money | decimal arithmetic preserves required precision |
| Concurrency | stale material update fails explicitly |

---

# 31. Implementation Guidance

Business-rule code should favor explicit domain functions over scattered conditional logic.

Prefer concepts such as:

```text
validateOwnershipPeriod(...)
validateTransactionSplits(...)
availableReconciliationAmount(...)
validateLoanAllocations(...)
deriveSecurityDepositBalance(...)
calculateDepreciation(...)
calculateInvestmentMetric(...)
```

over repeating the same rule in:

- controllers
- UI code
- import adapters
- reporting code
- background jobs

A rule should have one clear semantic owner.

---

# 32. Relationship to Future Germany-Specific Rules

This document deliberately defines structural business rules without pretending that every German legal or tax detail is already decided.

For example:

```text
This document:
Tax treatment must be version-aware.

docs/germany/taxation.md:
Defines the actual German tax treatments and applicability rules.
```

Likewise:

```text
This document:
Depreciation must exclude land and be reproducible.

docs/germany/depreciation.md:
Defines applicable AfA methods, rates, dates, and rule versions.
```

This separation is intentional.

It allows the architecture and core business invariants to remain stable while jurisdiction-specific rules evolve.

---

# 33. Final Business Rule Principle

When the system is uncertain, it must prefer:

```text
explicit unknown
over invented certainty

explicit reconciliation
over duplicated truth

actual cash
over inferred cash

historical traceability
over convenient overwrite

canonical domain ownership
over cross-domain shortcuts
```

A business rule is successful when it prevents the application from producing a result that looks precise but cannot be explained from its underlying operational, financial, legal, or analytical facts.
