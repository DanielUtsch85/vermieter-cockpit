# Product Use Cases

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Living Document  
**Scope:** MVP-oriented business use cases

---

# 1. Purpose

This document defines the primary user-oriented use cases for Vermieter Cockpit DE.

It translates the product specification, domain model, data model, MRE integration model, API design, glossary, and accepted architecture decisions into concrete landlord workflows.

The document answers:

> What must a private landlord be able to accomplish with the system?

It intentionally focuses on business outcomes rather than UI screens or technical implementation.

Detailed step-by-step system orchestration belongs in:

`docs/product/workflows.md`

Cross-domain technical movement of data belongs in:

`docs/architecture/data-flow.md`

---

# 2. Primary User

The primary user is a private residential landlord in Germany who:

- owns one or more residential properties
- uses MicroRealEstate for operational rental management
- wants a reliable view of actual cash movements
- wants to manage acquisition and financing information
- needs German WEG and tax-related information
- wants to evaluate property and portfolio performance
- prefers self-hosted software
- values traceability and reproducible calculations

The MVP is optimized for a small private portfolio rather than professional property-management companies.

---

# 3. Use Case Conventions

Each use case contains:

- **Goal**
- **Primary Actor**
- **Preconditions**
- **Trigger**
- **Main Flow**
- **Alternative / Error Flows**
- **Domains**
- **Sources of Truth**
- **Postconditions**
- **Important Invariants**
- **Scope**

Terminology follows `docs/glossary.md`.

In particular:

- `Property` means the MRE-owned rentable operational object.
- `PropertyReference` means the canonical DE-side reference to an MRE Property.
- `RentalContractReference` means the DE-side reference to the concrete MRE rental relationship.
- `FinancialAccount` means a DE bank/cash account.
- `Transaction` means actual cash movement.
- `RentPaymentReconciliation` connects MRE operational rent state with DE cash truth.
- no separate `Unit` entity exists in the MVP.

---

# 4. Use Case Map

```text
SETUP
├── UC-001 Connect MRE Property
├── UC-002 Establish Party and Ownership
├── UC-003 Record Acquisition
├── UC-004 Classify Acquisition Costs
├── UC-005 Record Financing
└── UC-006 Allocate Shared Loan

CASH & RENT
├── UC-010 Create Financial Account
├── UC-011 Import Bank Transactions
├── UC-012 Review and Classify Transaction
├── UC-013 Split Transaction
├── UC-014 Reconcile Rent Payment
├── UC-015 Handle Partial / Over / Combined Rent Payment
└── UC-016 Correct Financial Classification

SECURITY DEPOSIT
├── UC-020 Record Security Deposit
├── UC-021 Receive Security Deposit
└── UC-022 Repay Security Deposit

WEG & OPERATING COSTS
├── UC-030 Record WEG Membership
├── UC-031 Record Economic Plan
├── UC-032 Process Hausgeld Payment
├── UC-033 Record Annual WEG Statement
├── UC-034 Record Special Assessment
├── UC-035 Record Maintenance Project
└── UC-036 Prepare Operating-Cost Settlement Data

TAX & DEPRECIATION
├── UC-040 Classify Tax-Relevant Financial Facts
├── UC-041 Record Land / Building Allocation
├── UC-042 Create Depreciation Asset
├── UC-043 Calculate Depreciation
└── UC-044 Prepare Tax-Year Data

INVESTMENT
├── UC-050 Record Market Valuation
├── UC-051 Calculate Property Metrics
├── UC-052 Create Investment Scenario
├── UC-053 Persist Metric Snapshot
└── UC-054 Review Portfolio Performance

REPORTING
├── UC-060 Generate Property Report
├── UC-061 Generate Tax Preparation Report
└── UC-062 Export Traceable Supporting Data
```

---

# 5. Setup and Acquisition

# UC-001 — Connect an MRE Property

## Goal

Make an existing MRE Property available to DE investment, finance, WEG, tax, and reporting domains without duplicating the MRE Property.

## Primary Actor

Landlord.

## Preconditions

- MRE is configured and accessible.
- the Property exists in MRE.
- the user has access to the relevant MRE Realm.

## Trigger

The landlord wants to start managing the financial/investment lifecycle of an MRE Property.

## Main Flow

1. The system retrieves the relevant MRE Property.
2. The landlord selects the Property.
3. The DE integration layer creates or resolves a `PropertyReference`.
4. The reference stores the MRE Realm and MRE Property identity.
5. Optional cached display metadata is synchronized.
6. The PropertyReference becomes available to DE domains.

## Alternative / Error Flows

- Property cannot be resolved.
- MRE Realm is inaccessible.
- the same MRE Property is already referenced.
- cached metadata differs from current MRE data.
- the upstream Property is later deleted.

Historical DE data must remain valid even if the upstream Property later becomes unavailable.

## Domains

- MRE Integration

## Sources of Truth

- operational Property: MRE
- DE reference identity: PropertyReference

## Postconditions

A stable DE PropertyReference exists.

## Important Invariants

- no duplicate Property master is created
- `mrePropertyId` remains upstream identity
- DE entities use `propertyReferenceId`
- no Unit is introduced

## Scope

MVP.

---

# UC-002 — Establish Party and Ownership

## Goal

Record who legally owns a Property and in what proportion.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.

## Trigger

A Property is added to the DE Investment Layer or ownership changes.

## Main Flow

1. The landlord creates or selects the relevant Party records.
2. The landlord records an Ownership relationship for the PropertyReference.
3. Ownership shares are entered.
4. Validity dates are recorded.
5. The system validates the ownership structure.
6. Ownership becomes available for owner-level allocations.

## Alternative / Error Flows

- ownership shares are incomplete
- overlapping ownership periods conflict
- an ownership change occurs later
- one owner exits and another enters

## Domains

- Party
- Ownership

## Sources of Truth

- Party: DE Party domain
- Ownership: DE Ownership domain

## Postconditions

A temporal ownership structure exists.

## Important Invariants

- ownership is not stored as a static owner field on MRE Property
- legal ownership shares are the canonical owner-level allocation basis in current scope
- historical ownership remains preserved

## Scope

MVP.

---

# UC-003 — Record Property Acquisition

## Goal

Capture the economic acquisition of the real-world Property.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.
- relevant owner Party records exist.

## Trigger

The landlord purchases a Property or enters an existing acquisition into the system.

## Main Flow

1. The landlord creates an Acquisition.
2. The Acquisition references the PropertyReference.
3. Purchase price is recorded.
4. Acquisition date is recorded.
5. relevant source documents/references may be attached.
6. acquisition costs are entered or linked.
7. financing relationships may be linked.
8. the Acquisition is confirmed.

## Alternative / Error Flows

- some acquisition costs are not yet known
- financing is added later
- purchase price allocation is not yet available
- historical acquisition is entered after the fact

## Domains

- Acquisition
- Party / Ownership
- Financing
- Documents

## Sources of Truth

- acquisition facts: Acquisition Aggregate
- actual acquisition-related cash: Financial Ledger

## Postconditions

The acquisition exists as a first-class historical economic event.

## Important Invariants

- Acquisition is not embedded into MRE Property
- acquisition facts do not create fake cash Transactions
- actual cash movements remain Ledger Transactions

## Scope

MVP.

---

# UC-004 — Classify Acquisition Costs

## Goal

Capture and classify costs associated with acquiring the Property.

## Primary Actor

Landlord.

## Preconditions

- Acquisition exists.

## Trigger

An acquisition-related invoice, payment, or known cost is available.

## Main Flow

1. The user records or imports the actual payment where applicable.
2. The Transaction is linked to the Acquisition.
3. The relevant amount is classified as an Acquisition Cost.
4. Cost type is selected.
5. tax/acquisition treatment is assigned where known.
6. source provenance is retained.

## Alternative / Error Flows

- one Transaction contains several cost types
- use Transaction Splits
- treatment is not yet known
- classification remains reviewable
- cost is known economically but has not yet been paid
- record it in the Acquisition domain without fabricating a Transaction

## Domains

- Acquisition
- Financial Ledger
- Taxation

## Sources of Truth

- cash: Transaction / TransactionSplit
- acquisition classification: Acquisition
- tax interpretation: Taxation

## Postconditions

Acquisition costs are traceable and available for later tax/depreciation processing.

## Important Invariants

Cash fact and tax interpretation remain separate.

## Scope

MVP.

---

# UC-005 — Record Property Financing

## Goal

Record a Loan financing the acquisition or Property.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.
- lender Party may exist or be created.

## Trigger

The landlord has a mortgage or other relevant financing.

## Main Flow

1. The landlord creates the Loan.
2. Lender is linked.
3. principal and financing terms are entered.
4. relevant interest and repayment assumptions are entered.
5. the Loan is associated through LoanAllocation.
6. source documentation may be linked.
7. actual future payments are reconciled through the Ledger.

## Alternative / Error Flows

- financing terms change
- refinancing occurs
- interest rate changes
- a Loan covers several Properties

## Domains

- Financing
- Party
- Financial Ledger

## Sources of Truth

- financing contract: Loan
- actual payments: Financial Ledger

## Postconditions

The financing can be analyzed without treating the Loan itself as a FinancialAccount.

## Important Invariants

- Loan ≠ FinancialAccount
- payment schedule ≠ Transaction
- actual interest/principal payments come from actual cash records

## Scope

MVP.

---

# UC-006 — Allocate a Shared Loan Across Properties

## Goal

Represent one canonical Loan that finances or secures multiple Properties.

## Primary Actor

Landlord.

## Preconditions

- Loan exists.
- at least two PropertyReferences exist.

## Trigger

One financing arrangement relates to several Properties.

## Main Flow

1. The landlord selects the Loan.
2. multiple PropertyReferences are selected.
3. LoanAllocation records are created.
4. allocation values are entered according to the supported allocation basis.
5. the system validates the allocations.
6. property-level analytics use the allocations.

## Alternative / Error Flows

- allocation basis is not defined for the required metric
- system must not invent one
- allocation changes over time
- refinancing changes the relationship

## Domains

- Financing
- Investment

## Sources of Truth

- Loan: Financing
- allocation: LoanAllocation

## Postconditions

One Loan remains canonical while property-level financing analysis is possible.

## Important Invariants

Do not duplicate the Loan per Property.

## Scope

MVP model capability; exact allocation-basis rules may require further specification.

---

# 6. Cash and Rent

# UC-010 — Create a Financial Account

## Goal

Represent a bank or supported cash account used for actual financial movements.

## Primary Actor

Landlord.

## Preconditions

None.

## Trigger

The user wants to import or record cash movements.

## Main Flow

1. The user creates a FinancialAccount.
2. account type is selected.
3. external identifiers such as IBAN may be recorded.
4. ownership or purpose metadata is recorded where applicable.
5. the account becomes available to the Ledger.

## Alternative / Error Flows

- duplicate IBAN
- external identifier changes
- account is closed

## Domains

- Financial Ledger

## Sources of Truth

FinancialAccount.

## Postconditions

Cash Transactions can reference the account.

## Important Invariants

FinancialAccount ≠ MRE Account ≠ Loan.

## Scope

MVP.

---

# UC-011 — Import Bank Transactions

## Goal

Import actual cash movements from a bank source into the canonical Ledger.

## Primary Actor

Landlord.

## Preconditions

- FinancialAccount exists.

## Trigger

New bank data is available.

## Main Flow

1. The user initiates an import or provides supported bank data.
2. records are normalized.
3. external provenance is retained.
4. duplicate detection is performed.
5. new Transactions are created.
6. potential classifications and reconciliations may be suggested.
7. imported Transactions enter the review workflow.

## Alternative / Error Flows

- same import is submitted twice
- no duplicate Transaction may be created
- malformed record
- unsupported currency
- missing counterparty
- ambiguous duplicate

## Domains

- Financial Ledger
- Integration

## Sources of Truth

- external bank data: import provenance
- canonical actual cash: Transaction

## Postconditions

Actual cash movements exist exactly once in the Ledger.

## Important Invariants

- import is idempotent
- no forecast or expected payment becomes a Transaction
- provenance is preserved

## Scope

MVP.

---

# UC-012 — Review and Classify a Transaction

## Goal

Assign business meaning to an imported or recorded cash movement.

## Primary Actor

Landlord.

## Preconditions

- Transaction exists.

## Trigger

An unclassified Transaction requires review.

## Main Flow

1. The user opens the Transaction.
2. system displays available provenance.
3. user assigns Financial Category.
4. PropertyReference may be assigned.
5. Party may be assigned.
6. tax interpretation may be assigned or deferred.
7. classification is confirmed.

## Alternative / Error Flows

- Transaction has several meanings
- use TransactionSplit
- Property cannot be identified
- tax treatment is unknown
- classification is corrected later

## Domains

- Financial Ledger
- Taxation
- Party

## Sources of Truth

- cash: Transaction
- financial meaning: classification
- tax meaning: Tax Classification

## Postconditions

The Transaction is economically interpretable without altering the raw cash fact.

## Scope

MVP.

---

# UC-013 — Split a Transaction

## Goal

Represent several economic meanings within one actual cash movement.

## Primary Actor

Landlord.

## Preconditions

- Transaction exists.

## Trigger

One bank movement contains multiple components.

## Main Flow

1. The user chooses to split the Transaction.
2. split amounts are entered.
3. each split receives its own relevant classifications/references.
4. the system validates the split total.
5. the split structure is confirmed.

## Typical Examples

- mortgage payment → interest + principal
- Hausgeld → operating cost + reserve + administration
- contractor invoice → repair + capital improvement

## Alternative / Error Flows

- split total does not equal Transaction amount
- rounding conflict
- classification is incomplete

## Domains

- Financial Ledger
- Financing
- WEG
- Taxation

## Sources of Truth

Transaction and TransactionSplit.

## Postconditions

One cash movement remains one Transaction while its economic components are explicit.

## Important Invariants

The split total must reconcile to the Transaction according to defined sign/rounding rules.

## Scope

MVP.

---

# UC-014 — Reconcile a Rent Payment

## Goal

Connect an actual rent receipt with the corresponding MRE operational rent state.

## Primary Actor

Landlord.

## Preconditions

- MRE rental relationship exists.
- RentalContractReference exists or can be resolved.
- rent-related Transaction exists.

## Trigger

A likely rent receipt is imported or recorded.

## Main Flow

1. The system identifies possible RentalContractReferences.
2. relevant MRE rent obligations/settlement state are retrieved.
3. matching candidates are suggested.
4. the landlord reviews the suggestion.
5. the match is confirmed.
6. a RentPaymentReconciliation is created.
7. optional MRE write-back is performed explicitly according to supported workflow.

## Alternative / Error Flows

- no matching rent obligation
- multiple plausible tenants
- payment amount differs
- payment covers multiple periods
- payment is already reconciled
- MRE is temporarily unavailable
- MRE write-back fails after DE reconciliation

## Domains

- MRE Integration
- Financial Ledger
- Rental Operations

## Sources of Truth

- rent obligation/operational settlement: MRE
- actual cash: DE Ledger
- relationship between them: RentPaymentReconciliation

## Postconditions

Operational and financial truth are connected without being merged.

## Important Invariants

- MRE payment state does not become cash truth
- Transaction does not silently change MRE
- reconciliation is auditable
- duplicate reconciliation is prevented

## Scope

MVP.

---

# UC-015 — Handle Partial, Excess, or Combined Rent Payments

## Goal

Correctly reconcile rent when bank movements do not map one-to-one to one expected rent amount.

## Primary Actor

Landlord.

## Preconditions

Same as UC-014.

## Trigger

A non-standard rent payment occurs.

## Supported Scenarios

### Partial Payment

One obligation is only partly paid.

### Multiple Payments

Several Transactions settle one rent obligation.

### Combined Payment

One Transaction covers several periods or obligations.

### Overpayment

Received cash exceeds the expected obligation.

## Main Flow

1. Actual Transaction(s) remain unchanged.
2. user/system identifies relevant obligations.
3. matching amounts are allocated.
4. reconciliation records preserve the mapping.
5. unresolved remainder remains visible.
6. MRE write-back, where supported, follows confirmed reconciliation.

## Important Invariants

- never fabricate balancing cash
- reconciled amount cannot silently exceed available cash
- overpayments remain explicit
- partial settlement remains explicit

## Scope

MVP behavior.

---

# UC-016 — Correct a Financial Classification

## Goal

Correct business interpretation without rewriting historical cash movement.

## Primary Actor

Landlord.

## Preconditions

A Transaction or Split has already been classified.

## Trigger

The user discovers an incorrect category, PropertyReference, Party, or tax interpretation.

## Main Flow

1. The user opens the existing classification.
2. classification is changed through the supported command.
3. actual Transaction amount/date/provenance remain unchanged unless the cash fact itself was incorrect.
4. audit/version metadata is updated where required.
5. derived metrics become recalculable.

## Alternative / Error Flows

- confirmed reconciliation is affected
- tax-year output has already been generated
- concurrent edit exists

## Important Invariants

Do not mutate cash truth merely to fix interpretation.

## Scope

MVP.

---

# 7. Security Deposit

# UC-020 — Record a Security Deposit Obligation

## Goal

Record the expected rental security deposit.

## Primary Actor

Landlord.

## Preconditions

- RentalContractReference exists.

## Trigger

A rental relationship requires a Kaution.

## Main Flow

1. SecurityDeposit is created.
2. RentalContractReference is linked.
3. expected amount is recorded.
4. payer Party may be linked.
5. holding FinancialAccount may be selected.
6. relevant due/agreement dates are recorded.
7. MRE guaranty values may be referenced for reconciliation.

## Sources of Truth

- DE deposit lifecycle: SecurityDeposit
- operational MRE values: MRE Tenant guaranty fields
- actual cash: Ledger

## Important Invariants

Expected deposit ≠ cash received.

## Scope

MVP.

---

# UC-021 — Receive a Security Deposit

## Goal

Record actual receipt of deposit funds.

## Primary Actor

Landlord.

## Preconditions

- SecurityDeposit exists.
- actual Transaction exists or is imported.

## Trigger

Tenant pays some or all of the deposit.

## Main Flow

1. relevant Transaction is identified.
2. Transaction is linked to SecurityDeposit.
3. received amount is calculated from actual cash.
4. outstanding amount is updated as derived state.
5. partial payments remain visible.

## Alternative / Error Flows

- deposit paid in installments
- payment includes rent and deposit
- use TransactionSplit
- payment comes from another Party

## Important Invariants

MRE guaranty state is not evidence of actual cash receipt.

## Scope

MVP.

---

# UC-022 — Repay a Security Deposit

## Goal

Track actual repayment of deposit funds after or during termination of a rental relationship.

## Primary Actor

Landlord.

## Preconditions

- SecurityDeposit exists.
- repayment cash movement exists.

## Trigger

Deposit funds are returned.

## Main Flow

1. repayment Transaction is identified.
2. Transaction is linked to SecurityDeposit.
3. repayment state is updated.
4. remaining retained amount remains explicit.
5. relevant dates and provenance are preserved.

## Alternative / Error Flows

- partial repayment
- deductions
- multiple repayment Transactions

## Important Invariants

Repayment state must derive from actual cash where cash movement is claimed.

## Scope

MVP.

---

# 8. WEG and Operating Costs

# UC-030 — Record WEG Membership

## Goal

Represent the relationship between an owned condominium and its WEG.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.

## Trigger

A condominium is added to the system.

## Main Flow

1. WEG is created or selected.
2. WEGMembership is created.
3. PropertyReference is linked.
4. relevant membership/allocation information is recorded.
5. validity period is recorded where applicable.

## Domains

- WEG

## Sources of Truth

DE WEG domain.

## Scope

MVP.

---

# UC-031 — Record an Economic Plan

## Goal

Capture the WEG Wirtschaftsplan for a relevant period.

## Primary Actor

Landlord.

## Preconditions

- WEGMembership exists.

## Trigger

A new Wirtschaftsplan becomes available.

## Main Flow

1. plan period is recorded.
2. planned cost lines are entered/imported.
3. expected owner payments are represented as plan data.
4. source document provenance is retained.
5. plan becomes available for comparison with actual cash and later annual statement.

## Important Invariants

Planned WEG amounts are not Ledger Transactions.

## Scope

MVP.

---

# UC-032 — Process a Hausgeld Payment

## Goal

Classify an actual Hausgeld cash payment into economically meaningful components.

## Primary Actor

Landlord.

## Preconditions

- Transaction exists.
- WEG context exists.

## Trigger

A Hausgeld debit is imported.

## Main Flow

1. Transaction is linked to PropertyReference/WEG context.
2. applicable statement/plan information is reviewed.
3. Transaction is split where required.
4. components such as operating costs, reserve contribution, and administration are classified.
5. tax interpretations remain separately assignable.
6. the split is confirmed.

## Important Invariants

- one bank debit remains one Transaction
- economic components use TransactionSplits
- WEG structure/provenance is not lost

## Scope

MVP.

---

# UC-033 — Record an Annual WEG Statement

## Goal

Capture the WEG Jahresabrechnung and reconcile it with relevant financial facts.

## Primary Actor

Landlord.

## Preconditions

- WEGMembership exists.

## Trigger

The annual WEG statement is received.

## Main Flow

1. statement period is recorded.
2. statement source/document is retained.
3. relevant WEG Cost Lines are recorded.
4. cost lines are classified.
5. operating-cost and tax relevance may be assigned.
6. relevant actual Transactions can be reconciled to the statement.
7. resulting owner-level data becomes available for reporting.

## Alternative / Error Flows

- statement is incomplete
- cost classification is uncertain
- statement is corrected later
- reserve information is incomplete

Incomplete reserve information is an edge case and should not drive unnecessary MVP complexity.

## Scope

MVP.

---

# UC-034 — Record a Special Assessment

## Goal

Track a WEG Sonderumlage and its actual payments.

## Primary Actor

Landlord.

## Preconditions

- WEGMembership exists.

## Trigger

The WEG resolves a special assessment.

## Main Flow

1. SpecialAssessment is recorded.
2. amount and relevant dates are recorded.
3. PropertyReference/WEG relationship is linked.
4. actual payments are linked through Transactions.
5. tax/economic treatment remains separately classifiable.

## Important Invariants

Assessment obligation ≠ cash payment.

## Scope

MVP.

---

# UC-035 — Record a Maintenance Project

## Goal

Track a significant repair, renovation, or improvement project and its financial consequences.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.

## Trigger

A maintenance or renovation project begins.

## Main Flow

1. MaintenanceProject is created.
2. PropertyReference is linked.
3. project dates and description are recorded.
4. invoices/documents may be linked.
5. actual Transactions/Splits are associated.
6. tax and acquisition/improvement classifications remain explicit.
7. project totals are derived.

## Alternative / Error Flows

- project spans several tax years
- one invoice covers several categories
- treatment as repair vs improvement is unresolved

## Scope

MVP concept; detailed German tax treatment belongs in Germany-specific specifications.

---

# UC-036 — Prepare Operating-Cost Settlement Data

## Goal

Prepare traceable cost data for tenant operating-cost settlement without duplicating MRE rental operations.

## Primary Actor

Landlord.

## Preconditions

- RentalContractReference exists.
- relevant WEG/expense data exists.

## Trigger

Operating-cost settlement data is needed.

## Main Flow

1. eligible cost data is collected from canonical DE sources.
2. PropertyReference and rental context are resolved.
3. allocatable vs non-allocatable treatment is applied where defined.
4. relevant advance-payment/rental information is obtained from MRE where required.
5. settlement-supporting data is prepared.
6. provenance remains traceable.

## Important Invariants

Do not fabricate legal allocation rules where Germany-specific specification is incomplete.

## Scope

MVP domain capability; detailed rule set to be specified.

---

# 9. Tax and Depreciation

# UC-040 — Classify Tax-Relevant Financial Facts

## Goal

Assign German tax meaning to relevant financial facts.

## Primary Actor

Landlord.

## Preconditions

- Transaction/Split or other relevant canonical fact exists.

## Trigger

Tax preparation or transaction review requires classification.

## Main Flow

1. relevant financial fact is selected.
2. tax category/treatment is assigned.
3. applicable tax year is determined.
4. rule/source provenance is retained where supported.
5. owner allocation derives from Ownership where applicable.
6. classification remains reviewable.

## Important Invariants

- tax interpretation does not alter cash truth
- legal ownership share is current canonical owner-allocation basis
- unresolved legal/tax rules must not be guessed

## Scope

MVP framework; detailed rule catalogue belongs in `docs/germany/taxation.md`.

---

# UC-041 — Record Land / Building Allocation

## Goal

Record the allocation required to separate non-depreciable land from depreciable building value.

## Primary Actor

Landlord.

## Preconditions

- Acquisition exists.

## Trigger

A defensible land/building allocation is available.

## Main Flow

1. allocation method/source is recorded.
2. land value or share is recorded.
3. building value or share is recorded.
4. allocation is validated against relevant acquisition basis.
5. provenance/documentation is retained.
6. building allocation becomes available to depreciation.

## Important Invariants

Allocation is not a cash Transaction.

## Scope

MVP.

---

# UC-042 — Create a Depreciation Asset

## Goal

Create the canonical depreciation basis for a depreciable property component.

## Primary Actor

Landlord.

## Preconditions

- Acquisition exists.
- building allocation is available or sufficiently known.

## Trigger

The Property becomes relevant for depreciation calculations.

## Main Flow

1. DepreciationAsset is created.
2. PropertyReference and Acquisition are linked.
3. depreciable basis is determined from canonical inputs.
4. depreciation start date is recorded.
5. applicable rule/version is selected.
6. schedule can be generated.

## Important Invariants

Depreciation Asset does not replace Acquisition truth.

## Scope

MVP framework.

---

# UC-043 — Calculate Depreciation

## Goal

Calculate reproducible depreciation amounts for a Tax Year.

## Primary Actor

Landlord.

## Preconditions

- DepreciationAsset exists.
- applicable depreciation rule is defined.

## Trigger

Tax-year or investment reporting requires depreciation.

## Main Flow

1. applicable asset and rule version are selected.
2. calculation uses canonical basis and dates.
3. annual/period amount is calculated.
4. calculation metadata is retained.
5. result is available to tax reporting.

## Alternative / Error Flows

- rule is missing
- basis is incomplete
- asset changes
- correction is required

## Important Invariants

- depreciation is derived
- depreciation does not create Ledger cash
- calculations should be reproducible

## Scope

MVP framework; detailed German rules belong in `docs/germany/depreciation.md`.

---

# UC-044 — Prepare Tax-Year Data

## Goal

Assemble traceable owner-level information needed for rental-income tax preparation.

## Primary Actor

Landlord.

## Preconditions

Relevant financial and tax data exists.

## Trigger

A Tax Year is being prepared.

## Main Flow

1. relevant PropertyReferences are selected.
2. actual income and expenses are collected.
3. TransactionSplits and Tax Classifications are applied.
4. Ownership validity and shares are applied.
5. depreciation is included.
6. relevant WEG classifications are included.
7. warnings for missing/unclassified data are shown.
8. report/export is generated.

## Important Invariants

The system supports tax preparation but does not silently invent missing tax treatment.

## Scope

MVP.

---

# 10. Investment Analytics

# UC-050 — Record a Market Valuation

## Goal

Record a dated estimate of Property value.

## Primary Actor

Landlord.

## Preconditions

- PropertyReference exists.

## Trigger

A new valuation or user estimate is available.

## Main Flow

1. MarketValuation is created.
2. valuation date is recorded.
3. value is recorded.
4. valuation method/source is recorded.
5. confidence/provenance may be recorded.
6. valuation becomes available to metrics and scenarios.

## Important Invariants

- valuation ≠ acquisition price
- valuation ≠ MRE Property.price
- valuation ≠ cash

## Scope

MVP.

---

# UC-051 — Calculate Property Investment Metrics

## Goal

Evaluate current performance of a Property using canonical data.

## Primary Actor

Landlord.

## Preconditions

Sufficient canonical inputs exist.

## Trigger

The user opens investment analysis or requests recalculation.

## Main Flow

1. system resolves relevant PropertyReference.
2. actual Ledger data is collected.
3. financing data is collected.
4. valuation data is selected according to metric definition.
5. applicable calculation definitions are executed.
6. metrics are returned with as-of date and warnings.

## Example Metrics

- NOI
- cashflow
- equity
- LTV
- Cash-on-Cash Return
- IRR where applicable
- remaining debt

## Alternative / Error Flows

- required valuation missing
- financing incomplete
- insufficient history
- unclassified Transactions

## Important Invariants

Derived metrics do not become editable canonical facts.

## Scope

MVP.

---

# UC-052 — Create an Investment Scenario

## Goal

Evaluate future outcomes without changing actual data.

## Primary Actor

Landlord.

## Preconditions

PropertyReference and relevant baseline data exist.

## Trigger

The landlord wants to model a future assumption.

## Main Flow

1. scenario is created.
2. baseline PropertyReference(s) are selected.
3. assumptions are entered.
4. projection is calculated.
5. results are displayed separately from actuals.
6. scenario can be revised or compared.

## Example Assumptions

- rent growth
- vacancy
- appreciation
- refinancing
- interest rates
- maintenance
- exit value

## Important Invariants

Scenario assumptions never overwrite actual data.

## Scope

MVP / early post-MVP depending implementation sequence.

---

# UC-053 — Persist an Investment Metric Snapshot

## Goal

Preserve a historical calculated metric state for later comparison.

## Primary Actor

Landlord or system.

## Preconditions

Metrics have been calculated.

## Trigger

A snapshot is requested or generated at a supported milestone.

## Main Flow

1. current metric results are selected.
2. as-of date is recorded.
3. calculation/formula version is recorded.
4. relevant input references are retained.
5. warnings/confidence metadata are retained where applicable.
6. immutable snapshot is persisted.

## Important Invariants

Snapshot is persisted derived data, not editable financial truth.

## Scope

MVP model capability.

---

# UC-054 — Review Portfolio Performance

## Goal

Review aggregated performance across multiple PropertyReferences.

## Primary Actor

Landlord.

## Preconditions

At least two PropertyReferences or a Portfolio exist.

## Trigger

The landlord opens portfolio analytics.

## Main Flow

1. Portfolio scope is resolved.
2. canonical actual data is aggregated.
3. shared Loan allocations are applied where relevant.
4. property-level and portfolio-level metrics are calculated.
5. missing-data warnings remain visible.
6. user can drill down to underlying PropertyReferences and facts.

## Important Invariants

Aggregation must not hide unresolved allocation or missing-data issues.

## Scope

Post-core MVP / portfolio phase.

---

# 11. Reporting

# UC-060 — Generate a Property Report

## Goal

Produce a traceable summary of one Property's financial and investment state.

## Primary Actor

Landlord.

## Preconditions

PropertyReference exists.

## Trigger

The landlord requests a report.

## Main Flow

Report may include:

- ownership
- acquisition
- financing
- actual income/expenses
- WEG information
- current valuation
- investment metrics
- warnings/missing data

Each material figure should remain traceable to canonical inputs.

## Scope

MVP reporting phase.

---

# UC-061 — Generate a Tax Preparation Report

## Goal

Produce structured information supporting German rental-income tax preparation.

## Primary Actor

Landlord.

## Preconditions

Tax Year data has been prepared.

## Trigger

The landlord prepares information for personal review or a tax adviser.

## Main Flow

1. Tax Year and owner are selected.
2. relevant Properties are resolved.
3. income, expenses, classifications, ownership allocation, depreciation, and relevant WEG data are assembled.
4. missing/unreviewed classifications are flagged.
5. report is generated with provenance where practical.

## Important Invariants

The report supports preparation; it does not claim to replace professional tax advice.

## Scope

MVP.

---

# UC-062 — Export Traceable Supporting Data

## Goal

Export underlying information so a reported figure can be reviewed outside the application.

## Primary Actor

Landlord.

## Preconditions

Relevant canonical data exists.

## Trigger

The landlord, adviser, or reviewer needs supporting detail.

## Main Flow

1. user selects report/context.
2. system identifies underlying canonical records.
3. relevant provenance and classifications are included.
4. supported export is generated.

## Examples

- Transactions and Splits
- tax classifications
- WEG Cost Lines
- depreciation calculation inputs
- Loan data
- Ownership allocations

## Important Invariants

Export should preserve enough identifiers to trace figures back to the system.

## Scope

MVP reporting phase.

---

# 12. Cross-Cutting Edge Cases

The following scenarios must be supported by the architecture even where detailed workflows are specified later.

## EC-001 — Upstream MRE Property Deleted

Historical DE data remains valid.

PropertyReference changes upstream reference state rather than cascading deletion into financial history.

---

## EC-002 — Tenant Change

A new MRE rental relationship must result in a distinct RentalContractReference context where appropriate.

Historical rent reconciliations remain attached to the historical relationship.

---

## EC-003 — Partial Rent Payment

Actual cash remains unchanged.

Partial settlement is represented through reconciliation amounts/state.

---

## EC-004 — Rent Overpayment

Do not invent a balancing expense or modify the expected obligation.

The excess remains explicit until economically resolved.

---

## EC-005 — One Bank Transaction Covers Multiple Purposes

Use TransactionSplits.

Do not duplicate the bank Transaction.

---

## EC-006 — One Loan Covers Multiple Properties

Use one Loan plus LoanAllocations.

Do not duplicate the Loan.

---

## EC-007 — Security Deposit Paid in Installments

Multiple actual Transactions may relate to one SecurityDeposit.

Outstanding amount is derived.

---

## EC-008 — Ownership Changes

Close the previous temporal Ownership relationship and create the new valid structure.

Do not overwrite historical ownership.

---

## EC-009 — Transaction Classification Correction

Correct interpretation while preserving the underlying cash fact and provenance.

---

## EC-010 — Incomplete WEG Reserve Data

Allow the statement to remain incomplete or flagged.

Do not create speculative reserve data merely to satisfy a model.

---

## EC-011 — MRE Temporarily Unavailable

DE canonical historical financial data remains usable.

Operations requiring current MRE state may fail/retry explicitly rather than silently using stale data as authoritative.

---

## EC-012 — MRE Write-Back Failure

A confirmed DE reconciliation and an MRE write-back are distinct operations.

A failed write-back must remain visible and retryable without duplicating the DE reconciliation.

---

## EC-013 — Unknown Tax Treatment

Preserve the canonical financial fact and mark interpretation as unresolved.

Do not guess tax treatment.

---

## EC-014 — Missing Market Valuation

Metrics requiring a valuation must return a warning/error or omit the metric according to its definition.

Do not silently substitute acquisition price or MRE Property.price.

---

## EC-015 — Historical Data Entry

Historical acquisitions, ownership, Transactions, Loans, and valuations may be entered after their real-world date.

Business date and technical creation timestamp remain distinct.

---

# 13. MVP Priority

## P0 — Required to Establish Canonical Data

- UC-001 Connect MRE Property
- UC-002 Establish Party and Ownership
- UC-003 Record Acquisition
- UC-005 Record Financing
- UC-010 Create Financial Account
- UC-011 Import Bank Transactions
- UC-012 Review and Classify Transaction
- UC-013 Split Transaction
- UC-014 Reconcile Rent Payment

## P1 — Core German Landlord Capability

- UC-004 Classify Acquisition Costs
- UC-006 Allocate Shared Loan
- UC-015 Non-Standard Rent Payments
- UC-016 Correct Financial Classification
- UC-020 to UC-022 Security Deposit
- UC-030 to UC-034 WEG
- UC-040 to UC-044 Tax and Depreciation
- UC-050 Market Valuation
- UC-051 Property Metrics

## P2 — Extended Analysis and Reporting

- UC-035 Maintenance Project
- UC-036 Operating-Cost Settlement Data
- UC-052 Investment Scenario
- UC-053 Metric Snapshot
- UC-054 Portfolio Performance
- UC-060 to UC-062 Reporting

Priority describes implementation sequencing, not domain importance.

---

# 14. Use Cases Intentionally Not Defined Yet

The following areas are intentionally outside the current detailed use-case scope:

- full accounting / double-entry bookkeeping
- tax return filing
- automated legal advice
- automated tax advice
- generic multi-country tax support
- professional property-management company workflows
- supplier procurement
- tenant CRM beyond MRE
- generic building/floor/Unit hierarchy
- advanced document OCR/extraction workflows
- fully automated bank connectivity details
- advanced notification systems
- multi-organization SaaS administration

These may be revisited only when justified by product scope.

---

# 15. Validation Against Architecture

The use cases confirm several key architecture decisions.

## MRE remains operational owner

No use case requires duplicating MRE Property or Tenant rental state into a second property-management model.

## Unit is unnecessary for the MVP

The condominium can be represented by MRE Property plus PropertyReference.

## The cash-only Ledger is sufficient

Expected obligations, plans, depreciation, valuations, and scenarios remain outside the Transaction model.

## Reconciliation is necessary

Rent payment use cases require an explicit relationship between MRE operational settlement and DE cash truth.

## TransactionSplit is necessary

Loan payments, Hausgeld, mixed invoices, and combined payments require split-level economic interpretation.

## Acquisition must be independent

Acquisition and acquisition costs have a lifecycle that cannot cleanly live inside MRE Property.

## Ownership must be temporal

Ownership-change scenarios require historical validity.

## LoanAllocation is necessary

Shared financing cannot be represented correctly by duplicating Loans.

## SecurityDeposit requires its own lifecycle

Expected deposit, actual receipt, holding account, and repayment cannot be reduced to either MRE guaranty state or Rental Income.

## German domains remain specialized

WEG, taxation, depreciation, and operating-cost logic require dedicated domain models without contaminating generic MRE rental operations.

---

# 16. Open Questions Exposed by the Use Cases

The use cases deliberately expose several areas that still need specification before their full implementation.

## OQ-001 — Shared Loan Allocation Basis

Which allocation bases are supported for:

- principal
- interest
- remaining debt
- property-level LTV
- tax analysis

The existence of LoanAllocation is decided; the detailed allocation policy is not.

## OQ-002 — Security Deposit FinancialAccount Metadata

Determine whether deposit accounts require explicit metadata for:

- legal separation
- holder role
- interest
- multiple rental relationships

## OQ-003 — Confirmed Transaction Mutability

Define exactly which fields may change after confirmation and when reversal/correction records are required.

## OQ-004 — German Tax Rule Catalogue

The Tax domain framework exists, but concrete versioned rules must be specified in `docs/germany/taxation.md`.

## OQ-005 — Depreciation Rule Catalogue

Concrete German AfA rules and effective-date handling must be specified in `docs/germany/depreciation.md`.

## OQ-006 — WEG Classification Rules

Detailed mapping of Wirtschaftsplan/Jahresabrechnung components into economic, operating-cost, and tax classifications must be specified in `docs/germany/weg.md`.

## OQ-007 — Operating-Cost Allocation Rules

Detailed tenant allocation and settlement rules must be specified in `docs/germany/rent-and-operating-costs.md`.

## OQ-008 — Bank Import Technology

The business use case requires idempotent import, but concrete providers/file formats/connectivity belong to technology/integration design.

---

# 17. Relationship to Workflows

These use cases describe **what the user accomplishes**.

The next document, `docs/product/workflows.md`, should turn the most important use cases into explicit system workflows.

Recommended first workflows:

1. MRE Property onboarding
2. acquisition onboarding
3. bank transaction import and review
4. rent-payment reconciliation
5. partial/combined rent reconciliation
6. mortgage payment splitting
7. Security Deposit lifecycle
8. Hausgeld processing
9. WEG annual statement processing
10. tax-year preparation
11. depreciation calculation
12. investment-metric calculation

Each workflow should identify:

- participating domains
- commands and queries
- state transitions
- validation points
- idempotency boundaries
- failure/retry behavior
- external system interaction
- audit/provenance requirements

---

# 18. Final Product Principle

A successful Vermieter Cockpit DE use case should leave the user able to answer:

> What happened operationally?

through MRE,

> What cash actually moved?

through the DE Financial Ledger,

> What does that cash mean?

through financial, WEG, tax, and financing classifications,

and:

> What does this mean for my investment?

through reproducible analytics.

Those answers must remain connected, but they must not become competing or duplicated sources of truth.
