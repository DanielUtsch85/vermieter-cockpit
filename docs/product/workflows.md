# Product Workflows

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Living Document  
**Scope:** MVP-oriented end-to-end workflows

---

# 1. Purpose

This document defines the primary end-to-end product workflows of Vermieter Cockpit DE.

It translates the user-oriented scenarios from:

`docs/product/use-cases.md`

into explicit system behavior across domains, APIs, MRE integration, validation, state transitions, audit, and failure handling.

The document answers:

> How does the system coordinate its domains to complete a user goal?

This document does **not** define low-level technical transport between services. Cross-domain technical data movement belongs in:

`docs/architecture/data-flow.md`

Concrete HTTP endpoints and command semantics are governed by:

`docs/architecture/api-design.md`

---

# 2. Workflow Principles

All workflows must respect the following architectural rules.

## 2.1 MRE Remains Operational Owner

MRE owns:

- operational Property
- Tenant rental relationship
- Lease Definitions
- rent obligations
- operational rent-payment state
- rental-management documents

The DE layer references and reconciles rather than duplicating these concepts.

---

## 2.2 Financial Ledger Is Cash-Only

Only actual cash movements become Transactions.

Expected rent, WEG plans, Loan schedules, depreciation, valuations, and scenarios must never create fake Transactions.

---

## 2.3 Reconciliation Connects Sources of Truth

Operational and financial truth remain separate.

```text
MRE operational state
        │
        ▼
Reconciliation
        │
        ▼
DE canonical cash
```

---

## 2.4 Business Commands Express Intent

State transitions should use explicit business commands.

Examples:

- link Property
- confirm Transaction
- reconcile rent payment
- allocate Loan
- confirm Tax Classification

Avoid generic state mutation where domain meaning exists.

---

## 2.5 Idempotency Is Required at External Boundaries

Particular care is required for:

- bank imports
- MRE synchronization
- reconciliation write-back
- document import
- future external APIs

Retry must not create duplicate canonical state.

---

## 2.6 Auditability Is Cross-Cutting

Material state changes should preserve:

- actor
- timestamp
- source
- previous state where relevant
- resulting state
- reason where applicable

---

# 3. Workflow State Convention

Workflows may use the following conceptual state categories.

## Draft / Unconfirmed

User or system has created a record, but it is not yet authoritative.

## Suggested

System or AI proposes an interpretation.

## Confirmed

User has accepted the domain result.

## Reconciled

Two independent sources of truth have been explicitly linked.

## Corrected

Previously confirmed interpretation has been explicitly amended.

Exact persisted state names remain governed by the Data Model.

---

# 4. Workflow Overview

The primary workflows are:

```text
WF-001 MRE Property Onboarding
WF-002 Acquisition Onboarding
WF-003 Bank Transaction Import and Review
WF-004 Rent Payment Reconciliation
WF-005 Partial / Combined Rent Reconciliation
WF-006 Mortgage Payment Processing
WF-007 Security Deposit Lifecycle
WF-008 Hausgeld Processing
WF-009 WEG Annual Statement Processing
WF-010 Tax-Year Preparation
WF-011 Depreciation Calculation
WF-012 Investment Metric Calculation
WF-013 Transaction Correction
WF-014 Shared Loan Allocation
WF-015 MRE Tenant Change
```

---

# 5. WF-001 — MRE Property Onboarding

## Goal

Connect an existing MRE Property to the DE Investment Layer without duplicating the Property.

## Trigger

User selects an MRE Property for financial/investment management.

## Participants

- User
- MRE Integration
- MRE API
- PropertyReference
- Party / Ownership

## Preconditions

- authenticated MRE access
- accessible MRE Realm
- MRE Property exists

## Main Flow

```text
User
  │
  ▼
List MRE Properties
  │
  ▼
Select Property
  │
  ▼
MRE Adapter validates Realm + Property
  │
  ▼
Check existing PropertyReference
  │
  ├── exists ──► return existing reference
  │
  └── missing
          │
          ▼
Create PropertyReference
          │
          ▼
Cache non-authoritative display metadata
          │
          ▼
Property available to DE domains
```

## Commands / Queries

Conceptually:

```text
queryMreProperties()
linkProperty()
refreshPropertyReference()
```

## Validation

- user has Realm access
- MRE Property exists
- same Realm + MRE Property is not already linked

## Idempotency

Linking the same MRE Realm + Property twice must return or resolve the same DE relationship rather than create duplicates.

## Failure Handling

### MRE unavailable

No PropertyReference is created from unverified input.

### Property deleted upstream after onboarding

Existing DE history remains valid.

PropertyReference state becomes equivalent to:

`DELETED_UPSTREAM` or `MISSING`

rather than cascading deletion.

## Audit / Provenance

Record:

- MRE Realm ID
- MRE Property ID
- link timestamp
- linking actor

## Postconditions

- PropertyReference exists
- no duplicate Property master exists
- DE domains use `propertyReferenceId`

---

# 6. WF-002 — Acquisition Onboarding

## Goal

Create a complete acquisition context for an owned Property.

## Trigger

User adds a purchase/acquisition.

## Participants

- User
- PropertyReference
- Party
- Ownership
- Acquisition
- AcquisitionCost
- Documents
- Financing

## Preconditions

- PropertyReference exists
- owner Party records exist or can be created

## Main Flow

```text
Select PropertyReference
      │
      ▼
Create Acquisition (Draft)
      │
      ├── purchase price
      ├── contract date
      ├── economic transfer date
      ├── buyers/sellers
      └── source documents
      │
      ▼
Add Acquisition Costs
      │
      ├── linked existing Transactions where available
      └── non-cash-known costs remain Acquisition data only
      │
      ▼
Create / link Ownership
      │
      ▼
Create / link Loan(s)
      │
      ▼
Optional Land/Building Allocation
      │
      ▼
Validate acquisition completeness
      │
      ▼
Confirm Acquisition
```

## Commands / Queries

```text
createAcquisition()
addAcquisitionCost()
createOwnership()
createLoan()
setLandBuildingAllocation()
confirmAcquisition()
```

## Validation

- PropertyReference exists
- purchase price > 0 for normal purchase
- Ownership structure is valid
- linked Transactions exist where referenced
- Land/Building Allocation reconciles if confirmed

## Partial Completion

The Acquisition may remain in a draft/contracted state while:

- not all costs are known
- financing is still incomplete
- land/building allocation is pending

## Important Rule

Incomplete acquisition data does **not** justify synthesizing Transactions.

## Audit / Provenance

Preserve:

- document references
- contract dates
- source of each acquisition cost
- actor confirming acquisition

## Postconditions

Acquisition is available to:

- Ownership
- Financing
- Taxation
- Depreciation
- Investment

---

# 7. WF-003 — Bank Transaction Import and Review

## Goal

Import actual bank cash movements and turn them into confirmed canonical Ledger Transactions.

## Trigger

User imports new bank data.

## Participants

- User
- FinancialAccount
- Bank Import Adapter
- ImportBatch
- Transaction
- TransactionSplit
- FinancialCategory
- optional AI / automation suggestions

## Preconditions

- FinancialAccount exists

## Main Flow

```text
Upload / Fetch Bank Data
      │
      ▼
Create ImportBatch
      │
      ▼
Normalize Records
      │
      ▼
Fingerprint / Duplicate Check
      │
      ├── duplicate ───► mark duplicate / skip (no Transaction)
      │
      ├── ambiguous ──► needs_review (no Transaction)
      │                      │
      │                      ▼
      │                 Human review
      │                      │
      │                      ├── SKIP ──► discard (no Transaction)
      │                      └── CREATE ─┐
      │                                  │
      └── new ─────────────────────────►│
                                         ▼
                                   Create Transaction
                                         │
                                         ▼
                                     IMPORTED
             │
             ▼
       Suggest classifications
             │
             ▼
       User review
             │
             ├── single meaning
             │      ▼
             │  classify
             │
             └── multiple meanings
                    ▼
                create splits
                    │
                    ▼
             Validate split total
                    │
                    ▼
                Confirm
```

## Commands / Queries

```text
importBankTransactions()
getImportBatch()
getImportReviewItems()
resolveImportReviewItem()
getReviewableTransactions()
replaceTransactionSplits()
confirmTransaction()
```

`resolveImportReviewItem()` resolves an ambiguous `needs_review` row with `CREATE` or `SKIP` (API §32.2). `getReviewableTransactions()` returns pre-classification transactions (`status` ∈ { `IMPORTED`, `UNREVIEWED` }) and replaces the former `getUnreviewedTransactions()`, whose name no longer matched the canonical import entry status.

## Idempotency

Import must be idempotent. The **binding** duplicate identity is defined in `data-model.md` §70: a stable external transaction id where present, otherwise a versioned, adapter-bound identity built from the **source statement identity plus a stable source-row identity** (source row id or ordinal position), always scoped to `(realm, financialAccountId)`. Re-importing the same file creates no duplicate canonical Transactions; two legitimately identical real payments in one source remain two Transactions (they are distinct source rows). Rows that only *look* similar across different sources without a stable identity are surfaced as an ambiguous review case — never silently merged and never silently duplicated. Do not invent an alternative here.

## Validation

- currency is valid
- FinancialAccount exists
- duplicate rules pass
- split total reconciles
- referenced entities exist

## Failure Handling

### One row malformed

Other valid rows may still import if batch semantics support partial success.

The batch must expose row-level errors.

### Import repeated

No duplicate canonical Transaction is created.

### Ambiguous cross-file row

An ambiguous cross-file match (`data-model.md` §70.4) is reported per row as `needs_review` with a reason and its `reviewItemId`, and creates **no** Transaction. It is recorded as an `ImportReviewItem` (`data-model.md` §20A) owned by the batch that first produced it and counted in that batch's `needsReviewCount`; open items are listed via `getImportReviewItems()` (API §32.3). A human resolves it via `resolveImportReviewItem()` — addressed by `reviewItemId` under the owning batch's path — to `CREATE` (exactly one `IMPORTED` Transaction) or `SKIP` (nothing). If a later import presents the same still-pending identity again, no second item is created: the row references the existing `reviewItemId` and its owning `importBatchId`, and the later batch's counter is unchanged (`data-model.md` §20A Ownership and Retry). No canonical Transaction — and no silent duplicate — exists before resolution.

Once the item is `RESOLVED`, a re-presented identical row is reported as a **structured `duplicate`** (`RESOLVED_REVIEW_ITEM`, API §32.1): it references the `reviewItemId`, the owning `importBatchId`, the stored `resolution`, and after `CREATE` the same `createdTransactionId` (after `SKIP` none exists) — the decision is never re-opened and no additional Transaction is created. The same source row imported under a **different `adapterVersion`** (fallback branch, no stable external id) is an **adapter-version conflict** (`data-model.md` §70.4): outcome `needs_review` with a new `ImportReviewItem` owned by the current batch and **no** automatic Transaction.

## Audit / Provenance

Every Transaction retains:

- ImportBatch
- external ID where available
- source
- original description/counterparty
- import timestamp

## Postconditions

Confirmed Transactions become available to:

- reconciliation
- Financing
- WEG
- Taxation
- Investment
- Reporting

---

# 8. WF-004 — Rent Payment Reconciliation

## Goal

Match an actual rent receipt to the relevant MRE rent obligation.

## Trigger

A Transaction is identified as possible Rental Income.

## Participants

- User
- Financial Ledger
- MRE Adapter
- RentalContractReference
- MRE rent state
- RentPaymentReconciliation

## Preconditions

- Transaction exists
- relevant PropertyReference exists
- RentalContractReference exists or can be resolved

## Main Flow

```text
Confirmed / reviewable Transaction
           │
           ▼
Resolve PropertyReference
           │
           ▼
Resolve candidate RentalContractReference(s)
           │
           ▼
Fetch MRE rent obligations
           │
           ▼
Matching engine
           │
           ├── amount
           ├── date
           ├── payer/reference
           └── rental history
           │
           ▼
Create reconciliation suggestion
           │
           ▼
User reviews
           │
           ├── reject
           │
           └── confirm
                  │
                  ▼
        Create RentPaymentReconciliation
                  │
                  ▼
       Optional explicit MRE write-back
```

## Matching Result

A successful reconciliation should identify:

- Transaction or TransactionSplit
- MRE Tenant
- MRE rent term
- matched amount
- reconciliation status

## Idempotency

The same cash amount must not be matched twice to the same obligation unless explicit split/partial semantics allow it.

MRE write-back must be separately idempotent.

## Failure Handling

### MRE unavailable during suggestion

Transaction remains valid.

Reconciliation may be retried later.

### MRE unavailable during write-back

DE reconciliation remains confirmed.

Write-back state becomes failed/pending.

Do not delete the reconciliation.

### MRE write-back already occurred

Retry must not duplicate operational payment state.

## Audit / Provenance

Record:

- matching actor
- matched amount
- MRE external references
- write-back result
- timestamps

## Postconditions

Operational settlement and cash truth are linked but remain independent.

---

# 9. WF-005 — Partial / Combined Rent Reconciliation

## Goal

Support non-1:1 relationships between actual cash and rent obligations.

## Supported Shapes

```text
1 Transaction → part of 1 obligation

many Transactions → 1 obligation

1 Transaction → many obligations

1 Transaction → rent + another economic purpose
```

## Main Flow

```text
Transaction(s)
     │
     ▼
Determine available cash amount
     │
     ▼
Select obligation(s)
     │
     ▼
Allocate match amounts
     │
     ▼
Validate:
- no double use of cash
- no hidden remainder
- no silent over-allocation
     │
     ▼
Create one or more reconciliations
     │
     ▼
Leave unresolved remainder visible
```

## Combined Payment

Example:

```text
Bank Transaction 1,350 EUR
├── 1,250 EUR rent
└──   100 EUR utility adjustment
```

Use TransactionSplits where the economic meaning differs.

Only the appropriate split is reconciled against the rent obligation.

## Overpayment

Do not mutate expected rent to make it fit.

Excess amount remains explicit.

## Partial Payment

The rent obligation remains partially unsettled.

## Postconditions

Every matched amount is traceable to both:

- cash source
- operational obligation

---

# 10. WF-006 — Mortgage Payment Processing

## Goal

Process one actual Loan payment into its financing components.

## Trigger

A mortgage payment Transaction is imported.

## Participants

- Financial Ledger
- Loan
- Loan Schedule
- LoanPaymentReconciliation
- Taxation
- Investment

## Preconditions

- Loan exists
- Transaction exists

## Main Flow

```text
Loan payment Transaction
      │
      ▼
Identify Loan
      │
      ▼
Resolve expected schedule entry
      │
      ▼
Determine components
      │
      ├── interest
      └── principal
      │
      ▼
Create / confirm TransactionSplits
      │
      ▼
Reconcile actual payment to Loan
      │
      ▼
Recalculate Remaining Debt
      │
      ├── interest → Tax interpretation
      └── principal → Financing / Equity
```

## Validation

- split total equals Transaction
- principal cannot silently exceed available outstanding principal
- Loan exists
- terms applicable to payment date are resolved

## Schedule Difference

If actual payment differs from expected:

- do not alter cash
- preserve difference
- allow reconciliation with explicit deviation

## Tax Boundary

Loan Interest may receive Tax Classification.

Loan Principal remains economically distinct.

## Postconditions

Financing history and Ledger remain synchronized through explicit reconciliation.

---

# 11. WF-007 — Security Deposit Lifecycle

## Goal

Manage Kaution from expectation through receipt, holding, and repayment.

## Participants

- MRE Tenant state
- RentalContractReference
- SecurityDeposit
- FinancialAccount
- Transactions
- Party

## Phase A — Establish Expected Deposit

```text
MRE rental relationship
       │
       ▼
Resolve RentalContractReference
       │
       ▼
Create SecurityDeposit
       │
       ├── expected amount
       ├── payer
       └── holding FinancialAccount
```

MRE `guaranty` may inform the expected amount.

It does not prove cash receipt.

## Phase B — Receive Deposit

```text
Actual Transaction
      │
      ▼
Identify SecurityDeposit
      │
      ▼
Link cash
      │
      ▼
Derive received amount
      │
      ▼
Derive outstanding amount
```

Multiple Transactions may be linked.

## Phase C — Repay Deposit

```text
Repayment Transaction
       │
       ▼
Link to SecurityDeposit
       │
       ▼
Derive returned amount
       │
       ▼
Update lifecycle state
```

## Mixed Payment

If one bank movement contains both rent and deposit:

use TransactionSplits.

## Invariants

- Security Deposit ≠ Rental Income
- expected amount ≠ received amount
- received/returned amounts derive from actual cash
- MRE guaranty fields remain operational context only

---

# 12. WF-008 — Hausgeld Processing

## Goal

Process an actual WEG Hausgeld payment into economically meaningful components.

## Participants

- Transaction
- TransactionSplit
- WEG
- WEG Membership
- WEG Economic Plan / Statement
- Taxation

## Preconditions

- WEG Membership exists
- Transaction exists

## Main Flow

```text
Hausgeld Transaction
      │
      ▼
Resolve PropertyReference + WEG
      │
      ▼
Load relevant WEG plan / known allocation
      │
      ▼
Propose split
      │
      ├── recoverable operating costs
      ├── non-recoverable costs
      ├── administration
      └── reserve contribution
      │
      ▼
User review
      │
      ▼
Confirm TransactionSplits
      │
      ▼
Tax / operating-cost interpretations remain separate
```

## Important Boundary

WEG classification may inform the split.

Do not flatten the entire WEG statement into one financial category.

## Failure Handling

If WEG classification is incomplete:

- cash Transaction remains valid
- classification can remain partial / needs review
- do not invent missing reserve information

---

# 13. WF-009 — WEG Annual Statement Processing

## Goal

Capture a Jahresabrechnung, classify its lines, and connect it to actual owner cash.

## Participants

- User
- Document
- WEGAnnualStatement
- WEGCostLine
- Transaction
- TransactionSplit
- Taxation
- Operating Cost Allocation

## Main Flow

```text
Receive Annual Statement
       │
       ▼
Create / link Document
       │
       ▼
Create WEGAnnualStatement
       │
       ▼
Record Cost Lines
       │
       ▼
Classify each line
       │
       ├── financial meaning
       ├── recoverability
       ├── reserve impact
       └── tax interpretation
       │
       ▼
Reconcile relevant actual Transactions
       │
       ▼
Confirm Statement
```

## Correction Flow

If the WEG later issues a corrected statement:

```text
Existing confirmed statement
       │
       ▼
Create corrected / superseding version
       │
       ▼
Preserve historical provenance
```

Do not silently overwrite a previously used statement if auditability matters.

## Incomplete Data

Incomplete reserve information is allowed to remain explicitly incomplete.

The system should not generate speculative values merely to make the dataset complete.

---

# 14. WF-010 — Tax-Year Preparation

## Goal

Prepare traceable owner-level rental tax information for a selected Tax Year.

## Participants

- Ownership
- Financial Ledger
- TaxClassification
- WEG
- Depreciation
- Acquisition
- Reporting

## Preconditions

Relevant canonical data exists.

## Main Flow

```text
Select Tax Year
      │
      ▼
Select PropertyReferences
      │
      ▼
Resolve valid Ownership for period
      │
      ▼
Collect actual Transactions / Splits
      │
      ▼
Apply confirmed Tax Classifications
      │
      ▼
Include WEG-related tax interpretations
      │
      ▼
Include Depreciation
      │
      ▼
Allocate by canonical Ownership Share
      │
      ▼
Detect missing / unresolved classifications
      │
      ▼
Generate Tax Preparation View / Report
```

## Validation

Flag:

- unclassified relevant Transactions
- unresolved WEG items
- missing depreciation inputs
- invalid Ownership periods
- missing tax rule version where required

## Important Rule

Missing tax treatment is surfaced as missing.

It is not guessed.

## Output

The result may include:

- taxable rental income support
- expense categories
- financing interest
- depreciation
- WEG-related values
- owner allocation
- supporting references

The report supports preparation; it does not constitute tax advice.

---

# 15. WF-011 — Depreciation Calculation

## Goal

Create a reproducible depreciation schedule from canonical acquisition data.

## Participants

- Acquisition
- LandBuildingAllocation
- DepreciationAsset
- TaxRuleVersion
- DepreciationScheduleVersion

## Preconditions

- Acquisition exists
- confirmed or usable Land/Building Allocation exists
- applicable depreciation rule is defined

## Main Flow

```text
Acquisition
    │
    ▼
Resolve allocable acquisition basis
    │
    ▼
Land / Building Allocation
    │
    ├── land → non-depreciable
    └── building → depreciable basis
                │
                ▼
        Create DepreciationAsset
                │
                ▼
        Resolve TaxRuleVersion
                │
                ▼
        Calculate Schedule
                │
                ▼
     Persist Schedule Version
```

## Recalculation

If basis/rule interpretation changes:

```text
Existing schedule version
      │
      ▼
Create new version
      │
      ▼
Mark previous version superseded if appropriate
```

Do not silently overwrite historical calculation state.

## Important Rule

Depreciation never creates Transactions.

---

# 16. WF-012 — Investment Metric Calculation

## Goal

Calculate reproducible Property investment metrics from canonical inputs.

## Participants

- Financial Ledger
- Financing
- MarketValuation
- Ownership
- Investment
- optional Scenario

## Main Flow

```text
Select PropertyReference
      │
      ▼
Select as-of date / period
      │
      ▼
Load canonical cash data
      │
      ▼
Load Financing state
      │
      ▼
Load required MarketValuation
      │
      ▼
Resolve metric definition/version
      │
      ▼
Calculate metric(s)
      │
      ▼
Return result + inputs + warnings
```

## Example Metrics

- NOI
- cashflow
- remaining debt
- Equity
- LTV
- Cash-on-Cash Return
- IRR

## Missing Inputs

If a metric requires missing input:

- do not silently substitute arbitrary values
- return explicit warning/error
- metric may remain unavailable

Example:

LTV without an accepted valuation should not silently use MRE Property.price.

## Scenario Calculation

If a Scenario is selected:

```text
Canonical actual base
       +
Scenario assumptions
       │
       ▼
Scenario result
```

Scenario outputs never modify Actual data.

## Optional Snapshot

After calculation:

```text
POST / snapshot
      │
      ▼
InvestmentMetricSnapshot
```

Snapshot retains formula/input metadata.

---

# 17. WF-013 — Transaction Correction

## Goal

Correct a confirmed financial record or classification while preserving history.

## Participants

- User
- Transaction
- TransactionSplit
- AuditRecord
- affected downstream domains

## Trigger

An error is discovered after confirmation.

## Two Correction Types

### Interpretation Correction

Cash movement is correct, but:

- Financial Category
- PropertyReference
- Party
- Loan link
- Tax Classification

is wrong.

Preferred action:

correct interpretation without changing cash fact.

### Cash Fact Correction

Imported/entered:

- amount
- booking date
- account
- other canonical cash field

is wrong.

Use explicit correction strategy according to the final mutability ADR.

## Main Flow

```text
Open confirmed record
      │
      ▼
Identify correction type
      │
      ├── interpretation
      │       ▼
      │   update through domain command
      │
      └── cash fact
              ▼
        explicit correction / replacement
              │
              ▼
        preserve old provenance
              │
              ▼
        invalidate/re-evaluate affected reconciliations
              │
              ▼
        recalculate derived outputs
```

## Important Rule

A correction must not make historical change invisible.

---

# 18. WF-014 — Shared Loan Allocation

## Goal

Apply one canonical Loan to multiple PropertyReferences.

## Participants

- Loan
- LoanAllocation
- PropertyReference
- Investment

## Main Flow

```text
Select Loan
    │
    ▼
Select PropertyReferences
    │
    ▼
Choose supported allocation basis
    │
    ▼
Enter / derive allocation shares
    │
    ▼
Validate total
    │
    ▼
Confirm LoanAllocation
    │
    ▼
Use allocations in property-level analytics
```

## Validation

For a fully allocated Loan:

```text
sum(active allocation shares) = 100%
```

## Stop Condition

If a requested metric requires an allocation method not defined by accepted documentation:

do not invent the method.

Surface the open decision.

---

# 19. WF-015 — MRE Tenant Change

## Goal

Preserve rental history when the operational tenant relationship changes.

## Trigger

- tenant moves out
- new tenant moves in
- MRE creates/changes rental relationship

## Participants

- MRE Tenant
- RentalContractReference
- Party mapping
- RentPaymentReconciliation
- SecurityDeposit

## Main Flow

```text
MRE rental relationship changes
       │
       ▼
Refresh integration state
       │
       ▼
Resolve old RentalContractReference
       │
       ├── keep historical validity
       │
       ▼
Create / resolve new RentalContractReference
       │
       ▼
Map Party identity where appropriate
       │
       ▼
Future rent reconciliations use new context
```

## Historical Rule

Existing:

- rent reconciliations
- Security Deposit history
- operating-cost history

remain attached to the historical rental relationship.

Do not reassign them to the new Tenant merely because the Property is the same.

---

# 20. Cross-Workflow Failure Rules

# 20.1 External System Failure

If MRE or another external dependency fails:

- preserve existing DE canonical state
- do not create fabricated fallback facts
- record or surface external failure
- retry only through idempotent operations

---

# 20.2 Partial Command Failure

If a workflow changes multiple domains:

- avoid partially confirmed canonical state where possible
- explicit intermediate states are preferable to hidden rollback assumptions
- compensation/retry behavior must be documented for external writes

---

# 20.3 Validation Failure

Validation errors must:

- identify the failing invariant
- leave authoritative existing data unchanged
- allow user correction where appropriate

---

# 20.4 Review Required

Uncertainty should result in:

`NEEDS_REVIEW`

or equivalent domain state.

It must not silently become Confirmed.

---

# 20.5 Duplicate Detection

Potential duplicates should be surfaced rather than silently merged unless a deterministic idempotency key proves identity.

---

# 21. Cross-Workflow Audit Requirements

The following actions should normally generate or update audit information:

- PropertyReference creation
- Ownership change
- Acquisition confirmation
- Transaction confirmation
- Transaction correction
- reconciliation confirmation
- MRE write-back
- Loan Terms change
- LoanAllocation change
- Security Deposit receipt/repayment linkage
- WEG statement confirmation
- Tax Classification confirmation
- Depreciation schedule version creation
- MarketValuation confirmation
- Investment Metric Snapshot creation

---

# 22. Cross-Workflow Idempotency Requirements

| Workflow | Idempotency Requirement |
|---|---|
| Property onboarding | same MRE Property must not create duplicate PropertyReference |
| Bank import | same source record must not create duplicate Transaction |
| Rent reconciliation | same matched cash must not be consumed twice |
| MRE payment write-back | retries must not duplicate MRE payment state |
| Loan reconciliation | same Transaction must not be counted twice |
| Security Deposit linkage | same cash movement must not be linked twice as new receipt |
| Document import | same external document should be detectable |
| Metric snapshot | duplicate semantics depend on requested snapshot policy |

---

# 23. Cross-Workflow State Dependencies

Conceptually:

```text
MRE Property
    │
    ▼
PropertyReference
    │
    ├── Ownership
    ├── Acquisition
    ├── WEG
    ├── MarketValuation
    └── Financing
          │
          ▼
FinancialAccount
    │
    ▼
Transaction
    │
    ▼
TransactionSplit
    │
    ├── RentPaymentReconciliation
    ├── Loan reconciliation
    ├── WEG classification
    └── Tax Classification
          │
          ▼
Depreciation / Tax / Investment
          │
          ▼
Reports / Snapshots
```

This graph describes dependency of interpretation.

It must not be implemented as uncontrolled cross-domain mutation.

---

# 24. Workflow Priorities

## P0 — Foundation

- WF-001 MRE Property Onboarding
- WF-002 Acquisition Onboarding
- WF-003 Bank Transaction Import and Review
- WF-004 Rent Payment Reconciliation
- WF-006 Mortgage Payment Processing

## P1 — German Owner Operations

- WF-005 Partial / Combined Rent Reconciliation
- WF-007 Security Deposit Lifecycle
- WF-008 Hausgeld Processing
- WF-009 WEG Annual Statement Processing
- WF-010 Tax-Year Preparation
- WF-011 Depreciation Calculation
- WF-013 Transaction Correction
- WF-014 Shared Loan Allocation
- WF-015 MRE Tenant Change

## P2 — Analysis

- WF-012 Investment Metric Calculation

Priorities are implementation sequencing guidance, not permanent architectural importance.

---

# 25. Workflow-to-Use-Case Mapping

| Workflow | Primary Use Cases |
|---|---|
| WF-001 | UC-001, UC-002 |
| WF-002 | UC-003, UC-004, UC-005 |
| WF-003 | UC-010, UC-011, UC-012, UC-013 |
| WF-004 | UC-014 |
| WF-005 | UC-015 |
| WF-006 | UC-005, UC-013 |
| WF-007 | UC-020, UC-021, UC-022 |
| WF-008 | UC-032 |
| WF-009 | UC-031, UC-033, UC-034 |
| WF-010 | UC-040, UC-044, UC-061 |
| WF-011 | UC-041, UC-042, UC-043 |
| WF-012 | UC-050, UC-051, UC-052, UC-053 |
| WF-013 | UC-016 |
| WF-014 | UC-006 |
| WF-015 | EC-002 and rental-history continuity |

---

# 26. Workflow-to-Domain Mapping

| Workflow | Domains |
|---|---|
| MRE Property Onboarding | MRE Integration |
| Acquisition Onboarding | Acquisition, Ownership, Party, Financing |
| Bank Import | Financial Ledger |
| Rent Reconciliation | MRE Integration, Financial Ledger |
| Mortgage Processing | Financial Ledger, Financing, Taxation |
| Security Deposit | Rental Finance, Financial Ledger, MRE Integration |
| Hausgeld | Financial Ledger, WEG, Taxation |
| WEG Annual Statement | WEG, Taxation, Rental Cost Allocation |
| Tax Year | Taxation, Ownership, WEG, Depreciation |
| Depreciation | Acquisition, Depreciation, Taxation |
| Investment Metrics | Investment, Financing, Financial Ledger |
| Transaction Correction | Financial Ledger + affected domains |
| Shared Loan Allocation | Financing, Investment |
| Tenant Change | MRE Integration, Party, Rental Finance |

---

# 27. Open Workflow Decisions

The workflows expose several remaining design decisions.

## WF-OPEN-001 — Automatic MRE Rent Write-Back

After a user confirms RentPaymentReconciliation:

Should MRE write-back:

- occur automatically
- require a second explicit confirmation
- depend on user configuration

The current API design supports explicit write-back.

---

## WF-OPEN-002 — Confirmed Transaction Mutability

**Resolved by ADR-037:** confirmed transactions are immutable; corrections use **reversal + replacement**. Draft (unconfirmed) transactions remain freely editable.

---

## WF-OPEN-003 — Shared Loan Allocation Basis

Workflow exists.

**Resolved by ADR-038:** one explicit percentage per PropertyReference (sum 100%), defaulted from financed amount, user-overridable, uniform across principal/interest/debt.

---

## WF-OPEN-004 — Security Deposit Specialized Account Rules

The lifecycle is clear.

**Resolved by ADR-039:** `FinancialAccount` stays generic with a `securityDeposit` purpose flag; deposit-specific facts live in the Security Deposit domain. Interest treatment is a minimal flag in the MVP.

---

## WF-OPEN-005 — WEG Structured Import

The workflow supports structured WEG data.

Still open:

- manual entry
- CSV import
- document extraction
- hybrid

OCR/extraction is not required for the initial workflow.

---

## WF-OPEN-006 — Metric Snapshot Trigger

Snapshot capability is accepted.

**Resolved by ADR-040:** snapshots are triggered **on-demand** and automatically **at tax-year end**; on-material-change and periodic snapshotting are deferred.

---

# 28. Implementation Guidance

A workflow should not become one giant application service.

Instead, implementation should coordinate explicit domain capabilities.

Example:

```text
RentReconciliationWorkflow

1. query Transaction
2. query RentalContractReference
3. query MRE rent state through adapter
4. run matching service
5. create suggestion
6. confirm reconciliation through domain command
7. optionally invoke MRE write-back
```

Each domain remains responsible for its own invariants.

Workflow orchestration may coordinate domains but must not become the new owner of their business rules.

---

# 29. Relationship to Data Flow

The next architecture-level document should describe the data movement behind these workflows.

Recommended first data-flow diagrams:

1. MRE Property → PropertyReference
2. Bank → ImportBatch → Transaction → TransactionSplit
3. Transaction ↔ RentPaymentReconciliation ↔ MRE rent state
4. Transaction → Loan reconciliation → Remaining Debt
5. WEG Annual Statement → WEGCostLine → Transaction / Tax interpretation
6. Acquisition → LandBuildingAllocation → DepreciationAsset → Tax Year
7. Financial Ledger + Financing + Valuation → Investment Metrics
8. Canonical inputs → Metric Snapshot / Reports

---

# 30. Final Workflow Principle

Every workflow should preserve the separation between:

```text
Operational truth
Financial truth
Interpretation
Derived analysis
```

The system may coordinate those layers.

It must not collapse them.

A good workflow makes the relationship between those layers explicit, auditable, and understandable to the landlord.
