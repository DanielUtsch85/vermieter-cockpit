# Data Flow

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Living Document  
**Scope:** Cross-domain and external-system data movement

---

# 1. Purpose

This document defines how data moves through Vermieter Cockpit DE.

It translates the business workflows into technical data-flow relationships while preserving the accepted domain boundaries and sources of truth.

The document answers:

> Where does data originate, which domain owns it, how is it transformed or referenced, and where may it flow next?

This document does **not** define:

- database tables or collections
- concrete transport protocols
- final message-bus design
- exact HTTP payloads
- UI component behavior

Those remain governed by:

- `docs/architecture/data-model.md`
- `docs/architecture/api-design.md`
- `docs/architecture/technology.md`

The business intent behind these flows is defined in:

- `docs/product/use-cases.md`
- `docs/product/workflows.md`
- `docs/product/business-rules.md`

---

# 2. Core Data-Flow Principle

The system must preserve this separation:

```text
Operational truth
        ↓
Financial truth
        ↓
Interpretation
        ↓
Derived analysis
```

The layers are connected, but no layer silently replaces another.

---

# 3. System Boundaries

The main system boundaries are:

```text
┌──────────────────────────────┐
│        External Systems      │
│                              │
│  MicroRealEstate             │
│  Bank / CSV / Bank API       │
│  Document Sources            │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Integration Layer       │
│                              │
│  MRE Adapter                 │
│  Bank Import Adapter         │
│  Document Import Adapter     │
│  Reconciliation Services     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Canonical DE Domains    │
│                              │
│  Party / Ownership           │
│  Acquisition                 │
│  Financial Ledger            │
│  Financing                   │
│  Security Deposit            │
│  WEG                         │
│  Taxation                    │
│  Depreciation                │
│  Investment                  │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│      Read Models / Output    │
│                              │
│  Dashboards                  │
│  Reports                     │
│  Exports                     │
│  Metric Snapshots            │
└──────────────────────────────┘
```

---

# 4. Source-of-Truth Matrix

| Data | Canonical Source |
|---|---|
| MRE Property operational data | MRE |
| MRE Tenant rental relationship | MRE |
| Lease Definition | MRE |
| expected rent / rent terms | MRE |
| operational rent-payment state | MRE |
| DE Property linkage | PropertyReference |
| Party identity across DE domains | Party |
| legal Ownership | Ownership |
| acquisition facts | Acquisition |
| actual cash movement | Transaction |
| cash interpretation | TransactionSplit / FinancialCategory |
| shared Loan contract | Loan |
| Loan-to-Property allocation | LoanAllocation |
| Security Deposit lifecycle | SecurityDeposit |
| WEG statement structure | WEG domain |
| tax interpretation | TaxClassification |
| depreciation basis / schedule | Depreciation domain |
| market valuation | MarketValuation |
| investment metrics | Investment calculations |
| historical metric result | InvestmentMetricSnapshot |

---

# 5. Data-Flow Rules

## 5.1 Read Does Not Imply Copy

Reading MRE data does not justify duplicating it into DE canonical entities.

Only explicit integration references or modeled caches may be persisted.

---

## 5.2 External State Is Referenced Through Integration IDs

MRE-linked flows preserve:

- `mreRealmId`
- external entity ID
- DE integration reference ID

DE domains do not depend on arbitrary raw MRE persistence structures.

---

## 5.3 Cash Enters Only Through Financial Boundaries

Actual cash enters the system through:

- bank import
- supported external bank integration
- manual Transaction entry

MRE payment state, WEG statements, schedules, and reports do not generate cash.

---

## 5.4 Interpretation Flows Downstream

Typical flow:

```text
Transaction
   ↓
TransactionSplit
   ↓
TaxClassification
   ↓
Tax Report / Investment Metric
```

Interpretation may reference source data.

It must not mutate the source fact silently.

---

## 5.5 Derived Results Do Not Flow Back as Canonical Facts

Example:

```text
MarketValuation + Loan
          ↓
         LTV
```

LTV does not flow back into:

- Loan
- MarketValuation
- Transaction

---

# 6. DF-001 — MRE Property to PropertyReference

## Goal

Make an MRE Property available to DE domains without duplicating MRE Property ownership.

## Flow

```text
MRE Realm
   │
   ▼
MRE Property
   │
   ▼
MRE Adapter
   │
   ▼
Validate access + identity
   │
   ▼
PropertyReference
   │
   ├── mreRealmId
   ├── mrePropertyId
   ├── externalReferenceState
   └── optional cached display data
```

## Write Direction

```text
MRE → DE
```

for reference and cached operational metadata.

## Canonical Ownership

MRE remains authoritative for the Property.

PropertyReference is authoritative only for the DE-side linkage.

## Idempotency

Same:

```text
mreRealmId + mrePropertyId
```

must resolve to the same PropertyReference.

## Failure State

If MRE Property later disappears:

```text
PropertyReference
externalReferenceState = DELETED_UPSTREAM / MISSING
```

Historical DE data remains intact.

---

# 7. DF-002 — MRE Tenant to RentalContractReference

## Goal

Reference the concrete MRE rental relationship.

## Flow

```text
MRE Tenant
   │
   ├── MRE Lease Definition
   ├── Property assignments
   ├── rent terms
   └── operational payment state
   │
   ▼
MRE Adapter
   │
   ▼
RentalContractReference
   │
   ├── mreRealmId
   ├── mreTenantId
   ├── optional mreLeaseDefinitionId
   ├── PropertyReference(s)
   └── Party mapping(s)
```

## Important Rule

The flow does not create a duplicate Tenant domain.

## Party Mapping

Conceptually:

```text
MRE Tenant identity/contact context
          │
          ▼
PartyExternalReference
          │
          ▼
DE Party
```

One MRE Tenant must not automatically imply exactly one permanent Party.

---

# 8. DF-003 — Bank Data to Canonical Transaction

## Goal

Turn external bank movement into one canonical DE Transaction.

## Flow

```text
Bank CSV / Bank API
       │
       ▼
Bank Import Adapter
       │
       ▼
Normalize
       │
       ▼
Fingerprint / External ID
       │
       ▼
Duplicate Check
       │
       ├── duplicate
       │     └── stop / mark existing
       │
       └── new
              │
              ▼
         ImportBatch
              │
              ▼
         Transaction
              │
              ▼
         UNREVIEWED
```

## Canonical Ownership

Bank source proves external cash evidence.

DE Transaction becomes canonical application representation of actual cash.

## Required Provenance

Where available:

- external transaction ID
- source account
- FinancialAccount
- booking date
- value date
- amount
- currency
- counterparty
- raw description
- source file/API
- import timestamp

## Idempotency

Repeated import must not create duplicate canonical cash.

---

# 9. DF-004 — Transaction to TransactionSplit

## Goal

Represent one actual cash movement with multiple economic meanings.

## Flow

```text
Transaction
   │
   ▼
Classification / user review
   │
   ├── one meaning
   │       ▼
   │   one Split / category
   │
   └── several meanings
           │
           ▼
      TransactionSplits
           │
           ├── Loan interest
           ├── Loan principal
           ├── WEG reserve
           ├── operating cost
           └── other category
```

## Invariant

```text
sum(TransactionSplit.amount)
=
Transaction.amount
```

for fully classified Transactions.

## Data Direction

```text
Transaction → interpretation
```

Never:

```text
Split → additional cash Transaction
```

---

# 10. DF-005 — Rent Obligation to Cash Reconciliation

## Goal

Connect MRE operational rent state to DE actual cash.

## Flow

```text
MRE Tenant.rents / rent term
          │
          │
          ▼
     MRE Adapter
          │
          ▼
RentalContractReference
          │
          │
          │                     Bank
          │                      │
          │                      ▼
          │                 Transaction
          │                      │
          └──────────┬───────────┘
                     ▼
          Matching / Reconciliation
                     │
                     ▼
        RentPaymentReconciliation
                     │
                     ├── MRE rent term
                     ├── Transaction / Split
                     ├── matched amount
                     └── status
```

## Canonical Sources

- obligation: MRE
- operational settlement: MRE
- cash: DE Ledger
- mapping: RentPaymentReconciliation

## No Automatic Merge

An MRE payment record does not create a Transaction.

A Transaction does not automatically create an MRE payment record.

---

# 11. DF-006 — Rent Reconciliation Write-Back to MRE

## Goal

Optionally synchronize confirmed DE rent reconciliation into MRE operational payment state.

## Flow

```text
Confirmed RentPaymentReconciliation
              │
              ▼
Validate write-back eligibility
              │
              ▼
Build MRE payment request
              │
              ▼
MRE Adapter
              │
              ▼
MRE Rent Payment API
              │
              ▼
Write-back result
              │
              ├── success
              │     └── mark synchronized
              │
              └── failure
                    └── mark retryable/failed
```

## Write Direction

```text
DE → MRE
```

only after explicit reconciliation logic.

## Idempotency

Retry must not duplicate payment state.

## Failure Rule

DE reconciliation remains valid if MRE write-back fails.

---

# 12. DF-007 — Acquisition to Ownership and Financing

## Goal

Connect acquisition facts to related ownership and financing without turning them into duplicate cash.

## Flow

```text
PropertyReference
      │
      ▼
Acquisition
      │
      ├── purchase price
      ├── contract dates
      ├── acquisition costs
      ├── documents
      │
      ├──────────────► Ownership
      │
      └──────────────► Loan / Financing
```

## Actual Cash

Actual acquisition payments enter separately:

```text
Bank
  ↓
Transaction
  ↓
TransactionSplit
  ↓
AcquisitionCost classification
```

## Important Rule

Acquisition may describe a cost before actual payment exists.

That cost must not fabricate cash.

---

# 13. DF-008 — Acquisition to Depreciation

## Goal

Produce a depreciation basis from canonical acquisition inputs.

## Flow

```text
Acquisition
    │
    ▼
Acquisition Costs / allocable basis
    │
    ▼
LandBuildingAllocation
    │
    ├── Land
    │     └── excluded from building depreciation
    │
    └── Building
          │
          ▼
   DepreciationAsset
          │
          ▼
   TaxRuleVersion
          │
          ▼
DepreciationScheduleVersion
          │
          ▼
Tax-Year depreciation result
```

## Data Direction

```text
Acquisition → Depreciation
```

No cash flows back from depreciation to Ledger.

---

# 14. DF-009 — Loan Schedule and Actual Loan Payment

## Goal

Keep expected financing behavior separate from actual cash.

## Flow

```text
Loan
 │
 ├── LoanTerms
 │
 └── LoanScheduleEntry
         │
         │ expected
         ▼
   Expected payment

Bank
 │
 ▼
Transaction
 │
 ▼
TransactionSplits
 ├── interest
 └── principal
         │
         ▼
LoanPaymentReconciliation
         │
         ▼
Financing state / Remaining Debt
```

## Canonical Ownership

- financing contract: Loan
- expectation: LoanScheduleEntry
- actual cash: Transaction
- financing mapping: LoanPaymentReconciliation

## Difference Handling

Schedule deviation is explicit.

Actual cash is never modified to match expected schedule.

---

# 15. DF-010 — Shared Loan Allocation

## Goal

Use one Loan across several PropertyReferences.

## Flow

```text
Loan
 │
 ├── LoanAllocation ──► PropertyReference A
 ├── LoanAllocation ──► PropertyReference B
 └── LoanAllocation ──► PropertyReference C
```

## Derived Use

```text
Loan
 + LoanAllocation
 + Remaining Debt
       │
       ▼
Property-level financing metrics
```

## Important Rule

LoanAllocation does not duplicate the Loan.

Exact allocation basis remains a separate business decision where not yet specified.

---

# 16. DF-011 — Security Deposit Expectation to Actual Cash

## Goal

Separate expected Kaution from actual receipt and repayment.

## Flow

```text
MRE Tenant.guaranty
         │
         ▼
operational expected deposit context
         │
         ▼
RentalContractReference
         │
         ▼
SecurityDeposit
         │
         ├── expected amount
         ├── holding FinancialAccount
         │
         │
         ├──────────────┐
         │              │
         ▼              ▼
Receipt Transaction   Repayment Transaction
         │              │
         └──────┬───────┘
                ▼
   Derived deposit lifecycle
```

## Important Rule

MRE guaranty is context.

Actual receipt requires Ledger cash.

---

# 17. DF-012 — WEG Economic Plan to Hausgeld Cash

## Goal

Use planned WEG information to help interpret actual Hausgeld payments.

## Flow

```text
WEG Economic Plan
       │
       ├── planned cost lines
       └── expected owner amount
       │
       ▼
classification context
       │
       │
Bank
 │
 ▼
Hausgeld Transaction
       │
       ▼
TransactionSplits
       ├── recoverable
       ├── non-recoverable
       ├── administration
       └── reserve contribution
```

## Important Rule

The Wirtschaftsplan does not generate Transactions.

It only provides plan/classification context.

---

# 18. DF-013 — WEG Annual Statement to Tax and Operating-Cost Interpretation

## Goal

Preserve statement structure while deriving relevant interpretations.

## Flow

```text
WEG Annual Statement Document
            │
            ▼
    WEGAnnualStatement
            │
            ▼
       WEGCostLines
            │
            ├────────────► Financial interpretation
            │
            ├────────────► Operating-cost recoverability
            │
            ├────────────► Reserve treatment
            │
            └────────────► TaxClassification
```

## Reconciliation with Cash

```text
WEGCostLine / Statement
          │
          ▼
Statement reconciliation / classification context
          │
          ▼
Transaction / TransactionSplit
```

## Important Rule

Statement line value is not automatically cash.

## Implementation (Phase 6, P6-D6, api-design §51)

```text
Counted WEG splits of the unit in the period (booked by plan, §49.6)   ──► paid, per class
WEGCostLines by stored classification (+ reserve requested)            ──► actual, per class
                                                                             │
                                          difference = actual − paid ◄──────┘
                                          Σ difference = Abrechnungsspitze + unpaid advances
                                                                             │
Settlement Transaction ──► splits by the differences, naming the statement (wegAnnualStatementId)
Reserve withdrawals (statement, unit's share by MEA) ──► Phase 7 classification, never booked
```

No confirmed split is re-split; a superseding statement takes over the comparison, and a settlement keeps naming the
statement it was booked against.

---

# 19. DF-014 — Maintenance Project to Financial and Tax Interpretation

## Goal

Group project-level context without duplicating actual expenditure.

## Flow

```text
MaintenanceProject
      │
      ├── Document
      ├── vendor / Party
      └── project classification
      │
      │
Bank
 │
 ▼
Transaction
 │
 ▼
TransactionSplits
      │
      └──────────────► MaintenanceProject
                          │
                          ▼
                     TaxClassification
```

## Important Rule

MaintenanceProject is contextual/economic grouping.

Actual paid cost remains in Ledger.

---

# 20. DF-015 — Tax Classification Flow

## Goal

Apply tax meaning without altering financial facts.

## Flow

```text
Canonical source fact
      │
      ├── TransactionSplit
      ├── AcquisitionCost
      ├── WEGCostLine
      ├── MaintenanceProject
      └── DepreciationAsset
      │
      ▼
TaxRuleVersion
      │
      ▼
TaxClassification
      │
      ▼
Tax-Year aggregation
      │
      ▼
Tax preparation report / export
```

## Important Rule

Tax Classification is downstream interpretation.

It must not mutate source cash or acquisition facts.

---

# 21. DF-016 — Ownership to Owner-Level Allocation

## Goal

Apply legal Ownership shares to owner-level reporting.

## Flow

```text
PropertyReference
       │
       ▼
Ownership records
       │
       ├── valid period
       └── legal share
       │
       ▼
Relevant financial/tax amount
       │
       ▼
Owner-level allocation
```

## Historical Rule

The Ownership record valid for the relevant period must be used.

Current Ownership must not be applied retroactively to historical periods.

---

# 22. DF-017 — Market Valuation to Investment Metrics

## Goal

Use a dated valuation as a defined analytical input.

## Flow

```text
MarketValuation
      │
      ├── value
      ├── valuation date
      ├── method/source
      └── review state
      │
      ▼
Investment Calculation
      │
      ├── LTV
      ├── Equity
      └── other valuation-dependent metrics
```

## Important Rule

MRE Property.price is not a substitute for MarketValuation.

If required valuation is missing:

```text
metric unavailable / warning
```

not:

```text
silent fallback
```

---

# 23. DF-018 — Canonical Data to Investment Metrics

## Goal

Calculate reproducible analytics.

## Flow

```text
Financial Ledger
      │
      ├──────────┐
      │          │
      ▼          ▼
Financing     MarketValuation
      │          │
      └────┬─────┘
           │
           ▼
   Investment Engine
           │
           ├── NOI
           ├── Cashflow
           ├── Remaining Debt
           ├── Equity
           ├── LTV
           ├── CCR
           └── IRR
```

## Additional Inputs

Depending on metric definition:

- Ownership
- Acquisition
- period
- Scenario assumptions

## Output Rule

Results include:

- metric value
- calculation date/as-of date
- formula version
- relevant input references
- warnings

---

# 24. DF-019 — Investment Scenario Flow

## Goal

Calculate hypothetical results without changing Actual data.

## Flow

```text
Canonical Actual Data
       │
       ▼
Baseline
       │
       +
ScenarioAssumptions
       │
       ▼
Scenario Calculation
       │
       ▼
Scenario Results
```

## No Reverse Flow

Scenario results must not flow back into:

- Transaction
- Loan
- Ownership
- MarketValuation
- MRE rent state

as Actual facts.

---

# 25. DF-020 — Investment Metric Snapshot

## Goal

Persist historical derived calculation state.

## Flow

```text
Canonical inputs
      │
      ▼
Metric Calculation
      │
      ▼
Result + Formula Version
      │
      ▼
InvestmentMetricSnapshot
```

## Snapshot Stores

Where relevant:

- metric code
- value
- period/as-of date
- formula version
- input references
- Scenario reference
- warnings
- calculation timestamp

## Important Rule

Snapshot is persisted derived data.

It does not flow back as canonical source input.

---

# 26. DF-021 — Tax-Year Report

## Goal

Aggregate tax-relevant canonical and derived information for a period.

## Flow

```text
Tax Year
  │
  ├── Ownership
  ├── TransactionSplits
  ├── TaxClassifications
  ├── WEG interpretations
  ├── Loan interest
  ├── Depreciation
  └── Acquisition-related classifications
          │
          ▼
 Tax-Year Aggregation
          │
          ▼
 Missing-data validation
          │
          ▼
 Tax Preparation Report
```

## Important Rule

Report does not become a second tax ledger.

---

# 27. DF-022 — Dashboard Read Model

## Goal

Provide a coherent user view across domain-owned data.

## Flow

```text
MRE Property / Rent State
        │
Financial Ledger
        │
Financing
        │
WEG
        │
Taxation
        │
Investment
        ▼
Composite Read Model
        ▼
Dashboard
```

## Important Rule

Composite read models are read-only projections.

They do not become canonical business entities.

---

# 28. DF-023 — Document Provenance Flow

## Goal

Connect source documents to domain interpretation.

## Flow

```text
Document
   │
   ├── Acquisition
   ├── WEG Annual Statement
   ├── Loan
   ├── TaxClassification
   ├── MaintenanceProject
   └── other supported domain entity
```

## External MRE Document

```text
MRE Document
    │
    ▼
External Document Reference
    │
    ▼
DE Document metadata / Domain link
```

## Important Rule

Do not duplicate file binaries unnecessarily.

---

# 29. DF-024 — Correction Propagation

## Goal

Handle correction of a source fact or interpretation and update downstream derived state safely.

## Interpretation Correction

```text
Transaction remains unchanged
       │
       ▼
Classification corrected
       │
       ▼
Affected:
- TaxClassification
- reconciliation
- metrics
- reports
       │
       ▼
Recalculate / mark stale
```

## Cash-Fact Correction

```text
Confirmed Transaction
       │
       ▼
Explicit correction strategy
       │
       ▼
New/updated canonical cash state
       │
       ▼
Affected reconciliations identified
       │
       ▼
Derived outputs recalculated
```

## Important Rule

A downstream recalculation does not erase prior audit/provenance.

---

# 30. Read vs Write Direction Matrix

| Source | Target | Direction | Meaning |
|---|---|---|---|
| MRE Property | PropertyReference | MRE → DE | reference/sync |
| MRE Tenant | RentalContractReference | MRE → DE | reference/sync |
| Bank | Transaction | external → DE | canonical cash import |
| Transaction | MRE rent state | DE → MRE | optional explicit write-back |
| Acquisition | Depreciation | DE → DE | derived tax basis |
| Loan schedule | Ledger | none | no automatic cash creation |
| WEG Plan | Ledger | none | no automatic cash creation |
| WEG Statement | Tax | DE → DE | interpretation |
| Ledger | Investment | DE → DE | derived analytics |
| MarketValuation | Investment | DE → DE | analytical input |
| Scenario | Actual domains | none | no reverse mutation |
| Metric Snapshot | canonical domains | none | no reverse mutation |

---

# 31. Write Ownership Matrix

Only the owning domain may authoritatively mutate its canonical entity.

| Entity | Authoritative Writer |
|---|---|
| MRE Property | MRE |
| MRE Tenant / rent state | MRE |
| PropertyReference | MRE Integration |
| Party | Party domain |
| Ownership | Ownership domain |
| Acquisition | Acquisition domain |
| FinancialAccount | Financial Ledger |
| Transaction | Financial Ledger |
| TransactionSplit | Financial Ledger |
| RentPaymentReconciliation | Integration / Ledger boundary |
| Loan | Financing |
| LoanAllocation | Financing |
| SecurityDeposit | Security Deposit domain |
| WEG entities | WEG domain |
| TaxClassification | Taxation |
| Depreciation entities | Depreciation |
| MarketValuation | Investment |
| InvestmentMetricSnapshot | Investment |

---

# 32. Idempotency Boundaries

## MRE Property Sync

Key concept:

```text
mreRealmId + mrePropertyId
```

must not create duplicate PropertyReference.

## Bank Import

External transaction identity/fingerprint prevents duplicate Transaction.

## Rent Reconciliation

Confirmed matched amount may not be consumed twice.

## MRE Write-Back

Repeated request may not create duplicate payment state.

## Document Import

External identity/content hash should prevent accidental duplicate import where feasible.

---

# 33. Failure Propagation Rules

## External Read Failure

Example:

MRE unavailable.

Result:

- current integration-dependent query may fail
- existing DE canonical state remains valid
- no fabricated fallback canonical data is created

---

## External Write Failure

Example:

MRE write-back fails.

Result:

```text
DE state remains confirmed
+
external sync status = failed
```

Retry may be offered.

---

## Domain Validation Failure

Example:

TransactionSplits do not reconcile.

Result:

- confirmation fails
- draft/unconfirmed state remains
- no downstream authoritative state change occurs

---

## Derived Calculation Failure

Example:

missing valuation for LTV.

Result:

- source data remains untouched
- metric returns unavailable/warning
- no fallback is silently invented

---

# 34. Data Freshness

Not all data has the same freshness semantics.

## MRE Operational Data

May require refresh from MRE.

Cached values should include a freshness or last-refreshed concept where useful.

## Bank Cash

Once imported and confirmed, historical cash does not depend on current external availability.

## Market Valuation

Always dated.

A newer valuation does not overwrite historical valuations.

## Tax Rules

Version/effective-date sensitive.

## Metric Snapshots

Historical and immutable as derived records.

---

# 35. Data Lineage

Material outputs should support conceptual lineage.

Example:

```text
Tax Report Figure
      │
      ▼
TaxClassification
      │
      ▼
TransactionSplit
      │
      ▼
Transaction
      │
      ▼
Bank Import Source
```

Another example:

```text
LTV Snapshot
    │
    ├── Loan / Remaining Debt
    ├── LoanAllocation
    ├── MarketValuation
    └── Metric Formula Version
```

The implementation does not need a universal lineage engine initially.

It does need explicit domain references sufficient to explain important outputs.

---

# 36. Eventing and Synchronization

The architecture does not currently require an event bus.

Initial flows may be coordinated synchronously or through simple application workflows.

Do not introduce:

- Kafka
- generic event sourcing
- distributed event bus
- complex asynchronous orchestration

without a justified architectural need and ADR.

---

# 37. Recommended Initial Integration Pattern

For MVP:

```text
Frontend
   │
   ▼
DE API
   │
   ├── Domain Services
   │
   └── MRE Adapter
            │
            ▼
          MRE API
```

Bank import:

```text
CSV / supported bank input
      │
      ▼
DE Import Adapter
      │
      ▼
Financial Ledger
```

This keeps external dependencies behind explicit adapter boundaries.

---

# 38. Security and Realm Isolation

All MRE-related flows must preserve Realm access boundaries.

Conceptually:

```text
Authenticated User
      │
      ▼
Authorized MRE Realm
      │
      ▼
Allowed Property/Tenant references
```

The DE layer must not allow one Realm's external identifiers to be resolved under another Realm without explicit authorization.

---

# 39. Data Deletion Rules

Deletion must follow domain ownership and audit requirements.

## Upstream MRE Deletion

Does not cascade into DE historical financial data.

## Financial Records

Confirmed financial history should generally be corrected/superseded, not physically removed without explicit retention policy.

## Derived Snapshots

May follow retention policy but should not be confused with source data.

## Draft / Failed Imports

May be deletable according to implementation policy.

---

# 40. Data-Flow Anti-Patterns

## Anti-Pattern 1 — MRE Payment → Automatic Transaction

Forbidden.

Operational payment state is not bank cash.

---

## Anti-Pattern 2 — Loan Schedule → Generated Transaction

Forbidden.

Schedule is expected financing behavior.

---

## Anti-Pattern 3 — WEG Statement Line → Transaction

Forbidden unless there is actual corresponding cash evidence and a separate Transaction exists.

---

## Anti-Pattern 4 — MarketValuation → MRE Property.price

Forbidden.

Different semantics.

---

## Anti-Pattern 5 — Scenario → Actual Mutation

Forbidden.

---

## Anti-Pattern 6 — Dashboard Writes Domain Truth

Forbidden.

Dashboard is read model/presentation.

---

## Anti-Pattern 7 — Cross-Domain Direct DB Mutation

Avoid.

Use owning domain interfaces.

---

# 41. Data-Flow Test Matrix

| Flow | Minimum Test |
|---|---|
| MRE Property → PropertyReference | idempotent link |
| MRE Tenant → RentalContractReference | Realm-safe mapping |
| Bank → Transaction | duplicate import prevention |
| Transaction → Splits | totals reconcile |
| Rent obligation ↔ cash | partial and exact match |
| Reconciliation → MRE | failed write-back retry |
| Loan payment | interest/principal split |
| Shared Loan | allocation remains one Loan |
| Security Deposit | installment receipt |
| WEG Plan | no Transaction generated |
| WEG Statement | statement line remains non-cash |
| Tax Classification | source fact unchanged |
| Depreciation | no Ledger cash created |
| Valuation | historical values preserved |
| Scenario | Actual state unchanged |
| Metric Snapshot | input references preserved |

---

# 42. Open Data-Flow Decisions

## DF-OPEN-001 — Synchronization Trigger Strategy

MRE reference refresh may be:

- on demand
- on page load
- periodic
- event-driven later
- combination

Initial bias: simple explicit/on-demand synchronization.

---

## DF-OPEN-002 — MRE Write-Back Timing

After confirmed rent reconciliation:

- automatic write-back
- explicit second action
- configurable behavior

remains a product decision.

---

## DF-OPEN-003 — Bank Integration Mode

Initial implementation may use CSV.

Future options may include bank APIs/Open Banking.

The Ledger contract must remain provider-independent.

---

## DF-OPEN-004 — Document Storage

**Resolved by ADR-035:** pluggable `DocumentStorage` with a local-filesystem default; canonical metadata stays in PostgreSQL. A future S3-compatible adapter is possible without domain changes.

Data-flow principle remains:

metadata and domain references are separate from raw binary storage concerns.

---

## DF-OPEN-005 — Derived Data Staleness

The implementation must define when cached metrics/read models are:

- recalculated synchronously
- marked stale
- refreshed on demand
- snapshotted

No generic event infrastructure is required initially.

---

# 43. Relationship to Workflows

The technical flows map to product workflows as follows:

| Data Flow | Workflow |
|---|---|
| DF-001 | WF-001 Property Onboarding |
| DF-002 | WF-015 Tenant Change / rental integration |
| DF-003 + DF-004 | WF-003 Bank Import and Review |
| DF-005 + DF-006 | WF-004 / WF-005 Rent Reconciliation |
| DF-007 | WF-002 Acquisition Onboarding |
| DF-008 | WF-011 Depreciation |
| DF-009 | WF-006 Mortgage Processing |
| DF-010 | WF-014 Shared Loan Allocation |
| DF-011 | WF-007 Security Deposit |
| DF-012 | WF-008 Hausgeld |
| DF-013 | WF-009 WEG Annual Statement |
| DF-015 + DF-016 | WF-010 Tax Year |
| DF-017 + DF-018 | WF-012 Investment Metrics |
| DF-019 | Investment Scenario |
| DF-020 | Metric Snapshot |
| DF-024 | WF-013 Transaction Correction |

---

# 44. Implementation Guidance

Data-flow orchestration should remain explicit and narrow.

Prefer:

```text
BankImportService
RentReconciliationWorkflow
MrePropertySyncService
LoanPaymentReconciliationService
TaxYearAggregationService
InvestmentCalculationService
```

over one global integration service that owns unrelated rules.

Adapters own external translation.

Domains own invariants.

Workflow/orchestration coordinates calls.

Read models aggregate outputs.

---

# 45. Final Data-Flow Principle

The safest data movement in Vermieter Cockpit DE follows this pattern:

```text
External source
      │
      ▼
Adapter
      │
      ▼
Canonical owning domain
      │
      ▼
Explicit interpretation
      │
      ▼
Derived output
```

Reverse flow only occurs through explicit business operations such as MRE write-back.

Data should never move merely because two concepts contain similar fields.

Every meaningful flow should answer:

- who owns the source?
- who owns the target?
- is this a copy, reference, reconciliation, or derivation?
- what happens on retry?
- what happens on failure?
- can the result be traced back to the source?

If those questions cannot be answered, the data flow is not yet sufficiently specified.
