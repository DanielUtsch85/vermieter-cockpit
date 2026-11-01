# Domain Model

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.3  
**Status:** Living Document

**MRE Integration Revision:** Consolidated after the MRE deep dive and cross-checked against `mre-integration.md`, `data-model.md`, and `api-design.md`. Version 0.3 removes remaining legacy terminology from the pre-MRE model.

---

# 1. Purpose

This document defines the canonical business domain model of Vermieter Cockpit DE.

It describes:

- core business entities
- domain ownership
- entity relationships
- lifecycle concepts
- temporal behavior
- derived concepts
- business invariants
- boundaries between canonical and calculated data

This document is technology-independent.

It does **not** define:

- database tables or collections
- MongoDB documents
- SQL schemas
- API payloads
- serialization formats
- UI forms

The domain model represents business meaning rather than storage design.

---

# 2. Domain Modeling Principles

The domain model follows the project Constitution and Architecture Overview.

The most important rules are:

1. Every mutable business concept has one authoritative owner.
2. Financial facts exist exactly once.
3. Derived values are not competing sources of truth.
4. Historical information must remain reproducible.
5. Country-specific concepts remain separated from generic concepts.
6. Hypothetical data must never overwrite actual data.
7. References are preferred over duplication.
8. Business meaning must remain explicit.
9. MRE operational settlement state and DE cash truth remain separate and are connected through explicit reconciliation.
10. MRE-specific concepts are translated at the integration boundary rather than imposed on DE domains.

---

# 3. Domain Overview

The primary domain concepts are:

```text
MRE Operational Rental Management
│
├── Property
├── Tenant rental relationship
├── Lease Definition
├── Rent obligations / operational payment state
└── Documents
        │
        ▼
DE Integration Boundary
│
├── PropertyReference
├── RentalContractReference
├── Party external mappings
└── RentPaymentReconciliation
        │
        ▼
DE Investment Layer
│
├── Party
├── Ownership
├── Acquisition
├── Financial Ledger
├── Financing
├── Security Deposit
├── WEG
├── Taxation
├── Depreciation
├── Investment
└── Reporting / Analytics
```

MRE remains the operational rental-management core.

The DE Investment Layer adds the financial, ownership, German condominium, tax and investment domains without replacing MRE-owned operational concepts.

The integration boundary is an explicit anti-corruption layer: it maps MRE concepts into stable DE references and reconciliation records.

---

# 4. Entity Classification

The model distinguishes four types of domain objects.

## Entity

An object with persistent identity.

Examples:

- Property
- Loan
- Tenant
- Transaction

---

## Value Object

An immutable concept defined by its values rather than identity.

Examples:

- Money
- Percentage
- Address
- Date Range
- Ownership Share

---

## Event

A fact that occurred at a particular point in time.

Examples:

- Property Acquired
- Rent Received
- Loan Payment Made
- Ownership Changed

---

## Derived Value

A result calculated from canonical data.

Examples:

- NOI
- Remaining Debt
- Equity
- Cash-on-Cash Return

Derived values are not authoritative source data.

---

# 5. Portfolio

## Definition

A Portfolio represents a logical collection of properties whose performance may be viewed together.

## Domain Owner

Investment Domain.

## Responsibilities

A Portfolio groups:

- PropertyReferences
- Portfolio Scenarios
- Portfolio Metrics

## Important Rule

A PropertyReference may exist without a Portfolio.

Portfolio membership must not influence the canonical financial history of the Property.

---

# 6. Property

## Definition

Within the current MRE integration, `Property` is the MRE-owned rentable operational object.

For the initial condominium use case, an MRE Property represents the apartment that is rented and operationally managed.

## Domain Owner

MicroRealEstate Property Management.

## DE Representation

DE domains do not duplicate the full Property. They use `PropertyReference` as the canonical DE-facing reference to the MRE-owned Property. It preserves:

- MRE Realm identity
- MRE Property identity
- stable DE reference identity
- optional non-authoritative cached display metadata
- upstream reference state

## Important Rules

- `MRE Property.price` is rental pricing metadata. It is not acquisition price and not Market Valuation.
- acquisition, ownership, financing, tax and investment facts belong to DE domains.
- historical DE records remain valid if an upstream MRE Property later becomes unavailable.

---

# 7. Unit — Deferred

## Definition

A separate canonical `Unit` entity is **not part of the current MVP domain model**.

The inspected MRE core does not expose the previously assumed generic:

```text
Property → Unit
```

hierarchy.

MRE Property itself is the rentable operational object.

If future use cases require buildings containing multiple rentable objects, parking spaces or other sub-assets, a deliberate `Asset` / `Building` hierarchy should be designed through a separate domain decision rather than inferred from MRE.

---

# 8. Party

## Definition

Party is the conceptual representation of a person or organization interacting with the system.

Possible roles include:

- Owner
- Tenant
- Lender
- Property Manager
- Tax Advisor
- Contractor
- Supplier

A person or organization may hold multiple roles.

Example:

```text
Person A
├── Owner
└── Borrower
```

The architecture should avoid creating unrelated duplicate representations where one Party can fulfill multiple roles.

---

# 9. Ownership

## Definition

Ownership represents the legally documented ownership interest in a Property.

For the current product scope, legal ownership shares are also the canonical allocation basis for income, expenses and owner-level tax allocation. Separate economic or tax ownership percentages are intentionally not modeled.

## Domain Owner

DE Investment Layer / Ownership domain.

## Core Attributes

Conceptually:

- owner
- property
- ownership percentage
- valid-from date
- valid-until date
- ownership type
- source / legal evidence

## Relationship

```text
Party
  │
  └── Ownership
          │
          └── PropertyReference → MRE Property
```

---

# 10. Ownership Is Temporal

Ownership must be represented over time.

Incorrect:

```text
Owner A = 50 %
```

Preferred:

```text
Owner A
50 %
Valid from: 2026-08-01
Valid until: open
```

This allows historical reports to remain correct following:

- sale
- inheritance
- transfer
- ownership restructuring

---

# 11. Ownership Invariant

For any relevant date, active ownership shares of a fully modeled property should generally represent the complete ownership structure.

Where this is not known, the system must explicitly represent incomplete ownership information rather than silently assuming 100 percent.

---

# 12. Acquisition

## Definition

An Acquisition represents the economic acquisition of a Property referenced through `PropertyReference`.

## Domain Owner

Acquisition Domain.

Acquisition is a first-class Aggregate Root.

It exists independently from the Property because a Property may theoretically change ownership more than once during its lifetime in the system.

## Responsibilities

An Acquisition records the economic context of purchase including:

- purchase date
- purchase price
- economic transfer date
- acquisition-related costs
- financing relationships
- acquisition allocation

---

# 13. Acquisition Cost

## Definition

Acquisition Cost represents a cost economically associated with acquiring a Property.

Examples may include:

- purchase price
- transfer tax
- notary costs
- land registry costs
- broker costs
- other qualifying acquisition expenses

## Important Principle

Raw financial payments remain Transactions.

Acquisition Cost represents their economic or tax interpretation.

Therefore:

```text
Transaction
      │
      ▼
Acquisition Cost Classification
```

not:

```text
Independent manually duplicated purchase cost
```

whenever the cost originates from an actual payment.

In Phase 2 (P2-D7, api-design §27.2) the purchase price is entered once on the Acquisition, the costs are expected
amounts, and an AcquisitionPayment links a Transaction (or part of it) to the price or a cost. The paid state is
derived from these links; the link is the interpretation, the split stays the cash classification.

---

# 14. Land and Building Allocation

## Definition

Land and Building Allocation represents the allocation of acquisition cost between:

- non-depreciable land
- depreciable building

## Domain Owner

Depreciation / Taxation.

## Requirements

The allocation should preserve:

- method
- source
- date
- assumptions
- allocation amounts or percentages
- review status

## Principle

The system must preserve how the allocation was obtained.

A resulting building value without provenance is insufficient.

---

# 15. Tenant

## Definition

In MRE, `Tenant` is not merely a reusable person record. It is the central operational record for the concrete rental relationship and contains or references tenant occupants, rented Properties, lease-definition linkage, rent state and operational payment information.

## Domain Owner

MicroRealEstate.

## DE Relationship

The DE layer must not create a parallel canonical Tenant entity.

People or organizations are represented canonically as `Party` where DE domains need identity. MRE Tenant identities are linked through external Party mappings and `RentalContractReference`.

One MRE Tenant record must not be assumed to be permanently identical to exactly one Party.

---

# 16. Lease Definition and Rental Contract Reference

## MRE Lease Definition

MRE `Lease` is primarily a reusable definition of lease terms / contractual configuration.

It must not be interpreted as the complete concrete tenant contract.

## Concrete Rental Relationship

The concrete operational rental relationship is centered on MRE Tenant together with its referenced Lease definition and Property relationships.

The DE integration concept is therefore:

```text
RentalContractReference
├── MRE Realm
├── MRE Tenant
├── optional MRE Lease Definition
├── PropertyReference(s)
└── Party mapping(s)
```

## Domain Owner

Operational rental state remains owned by MRE.

`RentalContractReference` is owned by the DE Integration domain and contains references, not duplicated rental truth.

---

# 17. Rent Obligation and Operational Settlement

## Definition

A Rent Obligation represents an expected contractual payment arising from the MRE rental relationship.

Examples:

```text
Base Rent          1,000 EUR
Operating Costs      250 EUR
Total Due           1,250 EUR
```

## Important Distinction

Expected rent, MRE operational payment state and actual cash receipt are three related but distinct concepts.

```text
MRE Rent Obligation
        │
        ▼
MRE Operational Settlement State
        │
        │ reconciliation
        ▼
DE Financial Ledger Transaction
```

The Financial Ledger is the canonical source for actual cash movement.

MRE payment records answer whether an operational rent obligation is treated as settled in rental management. They do not replace the DE cash Transaction.

This separation supports:

- arrears
- partial payments
- overpayments
- reconciliation
- bank-import provenance
- explicit MRE write-back

---

# 18. Transaction

## Definition

A Transaction represents an actual cash movement.

The Financial Ledger is intentionally cash-only.

Non-cash economic interpretations, schedules, accrual-like concepts and estimates belong to their respective domains and must not be represented as fake Transactions.

Transaction is the primary canonical cash entity.

## Domain Owner

Financial Ledger.

## Examples

- rent receipt
- loan payment
- Hausgeld payment
- contractor invoice payment
- insurance payment
- purchase price payment
- tax payment where relevant

---

# 19. Transaction Attributes

Conceptually, a Transaction may contain:

- transaction date
- value date
- amount
- currency
- direction (`INFLOW` or `OUTFLOW`)
- FinancialAccount
- counterparty
- description
- provenance
- Property reference
- status
- external reference

The `amount` is a **non-negative** Money value; the cash sign is expressed by `direction`, never by a signed amount. The binding sign, currency and rounding model is defined in `data-model.md` §17.4.

Not every Transaction must belong to a Property.

Property-related transactions should be explicitly associated whenever possible.

---

# 20. Transaction Provenance

A Transaction must preserve its origin.

Possible provenance values include:

- manual
- bank CSV
- bank API
- imported migration
- external integration
- corrected transaction

Provenance supports:

- auditability
- debugging
- duplicate detection
- reconciliation

---

# 21. Transaction Status

Financial data must not silently move from an uncertain to an authoritative state. For the MVP the ledger distinguishes at least these states (aligned with `data-model.md` §17.5):

- `IMPORTED` — created by bank import, not yet reviewed
- `UNREVIEWED` — created manually, not yet classified
- `CLASSIFIED` — splits assigned so the split-sum invariant (§24) can hold
- `CONFIRMED` — accepted as authoritative cash truth
- `RECONCILED` — additionally matched to MRE rent state (Phase 4); additive, does not mutate cash fields
- `CORRECTED` — superseded by a reversal + replacement (ADR-037)
- `IGNORED` — deliberately excluded from ledger totals

Minimal allowed transitions for Phase 1:

- entry at `IMPORTED` (import) or `UNREVIEWED` (manual entry);
- `IMPORTED` / `UNREVIEWED` → `CLASSIFIED` → `CONFIRMED`;
- before `CONFIRMED`, any state may move to `IGNORED`, and back (`restore`) to `CLASSIFIED` if it kept its splits, else to its entry state (API §31.4);
- before `CONFIRMED`, fields may be amended (API §31.3); a changed amount drops the splits and returns a `CLASSIFIED` Transaction to its entry state; an imported Transaction keeps the values of its bank row, its description (Verwendungszweck) included;
- `confirm` requires a valid `amount` / `direction` (`data-model.md` §17.4) and complete split coverage (§24);
- `CONFIRMED` cash fields are never edited in place — a correction produces a reversal + replacement and moves the original to `CORRECTED` (ADR-037).

Correction (VC-1-11, API §35):

- `CONFIRMED` → `CORRECTED`, only through `correct`, which in the same step creates a confirmed **reversal** (same amount and dates, opposite direction, mirrored splits) and a confirmed **replacement** (the corrected values), both linked to the original;
- or only through `reverse` (API §35.9): the confirmed reversal without a replacement, for a Transaction that should not exist; the chain then has no current member;
- `CORRECTED` is terminal; a reversal is never corrected; a replacement can be corrected or reversed again, which extends or ends the chain;
- a `RECONCILED` Transaction is not correctable until Phase 4 specifies how its reconciliation is undone.

Transitions introduced by later phases (reconciliation) are defined in those phases and must not weaken these rules.

---

# 22. Transaction Split

## Definition

A Transaction Split represents an economically distinct component of a Transaction.

## Domain Owner

Financial Ledger.

## Relationship

```text
Transaction
    │
    ├── Transaction Split
    ├── Transaction Split
    └── Transaction Split
```

The sum of all active splits must equal the Transaction amount.

---

# 23. Transaction Split Examples

## Loan Payment

```text
1,200 EUR
│
├── Interest      600 EUR
└── Principal     600 EUR
```

## WEG Payment

```text
400 EUR
│
├── Recoverable Costs       240 EUR
├── Non-Recoverable Costs    80 EUR
└── Reserve Contribution     80 EUR
```

---

# 24. Transaction Split Invariant

For every completely classified Transaction:

```text
Transaction Amount == Sum(Transaction Splits)
```

- split amounts are **non-negative** and inherit the Transaction's `direction` (no per-split counter-direction);
- the equality holds **exactly** on canonical, currency-validated Money amounts, with no rounding tolerance (`data-model.md` §18 Invariants);
- no unexplained remainder may exist in a confirmed classification.

---

# 24A. Rent Payment Reconciliation

## Definition

`RentPaymentReconciliation` explicitly links an MRE rent obligation / operational payment state with an actual DE Ledger Transaction or Transaction Split.

## Domain Owner

Integration / Financial Ledger boundary.

## Purpose

It connects two sources of truth without merging them:

```text
MRE
Operational rent state
        │
        ▼
RentPaymentReconciliation
        │
        ▼
DE Ledger
Actual cash movement
```

## Important Rules

- reconciliation does not create cash truth
- MRE payment state does not become a Transaction
- one Transaction may require partial or multiple matches
- duplicate matching must be prevented
- suggested matches may be automated
- confirmation and MRE write-back are explicit, auditable actions
- MRE payment fingerprints are integration aids, not canonical DE identities

---

# 25. Financial Category

## Definition

A Financial Category describes the economic nature of a Transaction Split.

Examples:

- Rental Income
- Operating Expense
- Administration
- Maintenance
- Loan Interest
- Loan Principal
- Reserve Contribution

## Important Rule

Financial Category is an economic classification.

It is not automatically a tax classification.

---

# 26. FinancialAccount

## Definition

A `FinancialAccount` represents a source or destination of cash movements.

The name is intentionally distinct from MRE `Account`, which represents an authenticated application user.

Examples:

- bank account
- security-deposit account
- cash account where supported

A Loan is modeled separately in the Financing domain and should not be conflated with a FinancialAccount merely because a bank exposes a loan account number.

FinancialAccount exists primarily to support transaction reconciliation and financial provenance.

The system is not intended to become a general double-entry accounting platform unless explicitly decided later.

---

# 27. Loan

## Definition

A Loan represents a financing contract associated with an Acquisition or Property.

## Domain Owner

Financing.

## Conceptual Attributes

- lender
- borrowers
- principal
- disbursement date
- nominal interest rate
- repayment terms
- payment amount
- fixed-rate period
- maturity
- special repayment rules

---

# 28. Loan Relationship

```text
PropertyReference
   │
   └── Loan Allocation ─── Loan

Party
   │
   ├── Borrower
   └── Lender
```

A Property may have multiple Loans.

A Loan may finance or secure multiple Properties.

The relationship is modeled explicitly through Loan Allocations rather than by forcing a single Property foreign key onto the Loan.

---

# 29. Loan Schedule

## Definition

A Loan Schedule represents expected future debt-service behavior.

It contains or derives expected:

- payment
- interest
- principal repayment
- remaining debt

## Important Distinction

A Loan Schedule is a plan.

Actual payments belong to the Financial Ledger.

```text
Loan Schedule
      ↓
Expected Payment

Financial Ledger
      ↓
Actual Payment
```

These may be reconciled.

---

# 30. Remaining Debt

Remaining Debt is derived from financing facts.

It must not become an independently editable financial value.

It may be calculated from:

- original principal
- repayments
- special repayments
- corrections

If an external lender statement provides a different balance, that difference must be reconciled explicitly.

---

# 30A. Security Deposit

## Definition

Security Deposit represents the landlord-side economic state of a rental security deposit (`Kaution`).

## Domain Owner

DE Security Deposit / Financial boundary.

## Relationship

It references:

- RentalContractReference
- expected deposit amount
- FinancialAccount where held
- actual receipt Transaction(s)
- actual repayment Transaction(s)
- relevant dates

## MRE Relationship

MRE `Tenant.guaranty` and `guarantyPayback` remain operational rental-management values.

They may seed or reconcile expected deposit state, but they are not canonical evidence of actual cash receipt or repayment.

Actual cash remains represented by Ledger Transactions.

---

# 31. WEG

## Definition

WEG represents the German Wohnungseigentümergemeinschaft associated with a condominium Property.

## Domain Owner

WEG Domain.

## Conceptual Responsibilities

- association identity
- administrator
- ownership share
- financial year
- economic plans
- annual statements
- reserve information
- special assessments

---

# 32. WEG Membership

## Definition

WEG Membership represents the relationship between a Property and its condominium association.

Conceptually:

```text
PropertyReference
   │
   └── WEG Membership
            │
            └── WEG
```

It may contain:

- Miteigentumsanteil
- validity period
- allocation references

---

# 33. WEG Economic Plan

## Definition

A WEG Economic Plan (`Wirtschaftsplan`) represents planned WEG costs and contributions for a financial period.

It is planning data.

It does not represent actual cashflow by itself.

---

# 34. WEG Annual Statement

## Definition

A WEG Annual Statement (`Jahresabrechnung`) represents actual WEG cost allocation for a financial period.

The statement may contain multiple cost lines.

Example:

```text
Annual Statement
│
├── Heating
├── Water
├── Insurance
├── Administration
├── Maintenance
└── Other Costs
```

---

# 35. WEG Cost Line

## Definition

A WEG Cost Line represents one economically distinct element within an economic plan or annual statement.

It may contain classifications such as:

- recoverability to tenant
- economic category
- allocation key
- tax relevance
- reserve relevance

These interpretations may belong to separate domain classifications rather than being stored directly in the raw WEG source line.

---

# 36. Maintenance Reserve

## Definition

Maintenance Reserve represents the property's economic share in the WEG reserve where relevant.

Reserve contributions and reserve expenditures must remain distinct concepts.

The domain must not equate a payment into the reserve automatically with an immediate property expense.

Exact tax treatment belongs to the Taxation domain and applicable rule version.

---

# 37. Special Assessment

## Definition

A Special Assessment (`Sonderumlage`) represents an extraordinary WEG contribution outside normal recurring Hausgeld.

It may relate to:

- a specific measure
- emergency expenditure
- funding shortfall
- major investment

Actual payment is represented through the Financial Ledger.

The WEG domain represents its purpose and allocation.

---

# 38. Maintenance Project

## Definition

A Maintenance Project groups multiple related costs and activities into one economic measure.

Examples:

- bathroom renovation
- window replacement
- flooring replacement
- major repair

## Purpose

A single economic measure may produce multiple Transactions and Documents.

```text
Maintenance Project
│
├── Contractor Invoice
├── Material Purchase
├── Additional Work
└── Documents
```

Grouping provides better economic and tax interpretation than treating every invoice as unrelated.

---

# 39. Maintenance Project Status

Conceptually:

```text
Planned

Approved

In Progress

Completed

Cancelled
```

The exact workflow remains implementation-specific.

---

# 40. Document

## Definition

A Document represents a file with domain significance.

Examples:

- invoice
- lease
- WEG statement
- loan contract
- notarial contract
- bank statement
- tax evidence

## Architectural Principle

One Document may relate to multiple business entities.

---

# 41. Document Relationships

Example:

```text
Invoice.pdf
│
├── Property
├── Transaction
├── Maintenance Project
└── Tax Year
```

The file itself should not need to be duplicated for every relationship.

---

# 42. Document Provenance

Documents should preserve where practical:

- source
- upload date
- original filename
- document date
- content hash
- version
- classification state

This supports duplicate detection and auditability.

---

# 43. Tax Classification

## Definition

Tax Classification represents the tax interpretation of an existing financial or economic item.

## Domain Owner

Taxation.

Possible source objects include:

- Transaction Split
- Acquisition Cost
- Maintenance Project
- WEG Cost Line

---

# 44. Tax Classification Attributes

Conceptually:

- jurisdiction
- tax year
- category
- deductible status
- capitalization status
- depreciation relevance
- owner allocation
- rule version
- confidence/review status
- source reference

---

# 45. Tax Classification Review Status

The system should explicitly represent certainty.

Example:

```text
Unclassified

Suggested

User Confirmed

Advisor Confirmed

Needs Review
```

A complex tax position must not be presented with false certainty.

---

# 46. Tax Rule

## Definition

Tax Rule represents a versioned interpretation rule applicable within a jurisdiction and time period.

Conceptual attributes:

- jurisdiction
- rule category
- valid from
- valid until
- version
- source reference
- implementation reference

Tax Rules are not user Transactions.

They explain how Transactions may be interpreted.

---

# 47. Tax Year

Tax Year is a temporal grouping used by the Taxation domain.

It must not be confused with:

- calendar reporting period
- WEG financial year
- rental relationship period

Those periods may coincide but are distinct concepts.

---

# 48. Depreciation Asset

## Definition

A Depreciation Asset represents a depreciable economic basis.

Possible examples:

- building acquisition basis
- qualifying capitalized improvement
- separately depreciable component where supported

## Domain Owner

Depreciation.

---

# 49. Depreciation Asset Attributes

Stored (the canonical inputs; phase-8-plan P8-D1, api-design §59, VC-8-01):

- PropertyReference
- asset type (`BUILDING`; `SEPARATE_ASSET` with VC-8-03, api-design §59B: description, useful life with its basis, acquisition date, and the capitalised items it consists of)
- building completion year, with its sources (it selects the rate band; never guessed)
- depreciation method (`LINEAR_7_4`)
- an optional shorter useful life per Acquisition, with its evidence and its own review state (§ 7 Abs. 4 S. 2 EStG)
- review state, advisor
- status (`ACTIVE`, `VOID`)

Derived, never stored (AGENTS.md §17):

- depreciation basis (from the Acquisitions, their costs and their confirmed allocations; and the capitalised items, each in exactly one asset, api-design §59B)
- start date and the first year (the transfer of economic ownership)
- rate (the applicable Tax Rule's band, or the confirmed shorter life)
- owner allocation (each Acquisition's buyers, P8-D8)

---

# 50. Depreciation Schedule

## Definition

A Depreciation Schedule represents calculated depreciation over time.

It is derived from:

```text
Depreciation Asset
+
Applicable Rule
+
Relevant Dates
=
Depreciation Schedule
```

The schedule must be reproducible.

---

# 51. Depreciation Schedule Versioning

If an input or tax interpretation changes, historical calculations must remain auditable.

Therefore recalculation should produce explicit versions or equivalent historical traceability.

The exact persistence strategy remains an implementation decision.

**Decided for Phase 8** (phase-8-plan P8-D10, 2026-10-30; api-design §60, data-model §39–§40, VC-8-04): the schedule is computed on every read, and a person records a version of it per asset, with its inputs, its output and its rule versions, append-only and reproducible from what it stores. The tax-year view compares the derived schedule with the current recorded version; a year is final only once its AfA is recorded and unchanged.

---

# 52. Operating Cost Allocation

## Definition

Operating Cost Allocation represents the allocation of eligible operating costs to a Tenant context represented through `RentalContractReference`.

It is separate from:

- underlying Transaction
- WEG statement
- tax classification

This separation allows one WEG expense to have different meanings:

```text
WEG Cost
│
├── Financial meaning
├── Tenant recoverability
└── Tax meaning
```

---

# 53. Utility Settlement

## Definition

A Utility Settlement represents the annual or periodic operating-cost settlement between landlord and the Tenant context represented by `RentalContractReference`.

Inputs may include:

- RentalContractReference
- advance payments
- allocated costs
- occupancy period
- allocation keys

Outputs may include:

- tenant credit
- tenant payment due
- statement document

A Utility Settlement does not rewrite the underlying cost Transactions.

---

# 54. Market Valuation

## Definition

Market Valuation represents a valuation of the real-world Property referenced through `PropertyReference` at a specific date.

## Domain Owner

Investment.

Conceptual attributes:

- valuation date
- value
- methodology
- source
- confidence
- notes

---

# 55. Market Valuation Is Not Fact

Unlike a bank Transaction, market value is an estimate.

The domain must therefore distinguish:

```text
Measured Fact
vs.
Estimated Value
```

Historical estimates should not automatically be overwritten by later estimates.

---

# 56. Investment Scenario

## Definition

An Investment Scenario represents hypothetical assumptions applied to actual or planned investment data.

Possible assumptions:

- rent growth
- cost inflation
- vacancy
- property-value growth
- refinancing rate
- sale date
- sale costs

## Domain Owner

Investment.

---

# 57. Scenario Isolation

Scenario values must never overwrite canonical actual values.

```text
Actual Rent: 1,200 EUR

Scenario Rent in 2030: 1,350 EUR
```

Both may exist simultaneously.

They have different semantic meaning.

---

# 58. Scenario Types

The product may support scenario labels such as:

- Base
- Bear
- Bull
- Custom

These labels are descriptive rather than fundamental domain concepts.

---

# 59. Investment Metric

## Definition

Investment Metric represents a calculated financial measure.

Examples:

- NOI
- Cashflow
- Equity
- LTV
- DSCR
- Cash-on-Cash Return
- IRR
- net rental yield

## Important Rule

Investment Metrics are derived values.

They are not manually maintained canonical data.

---

# 59A. Investment Metric Snapshot

## Definition

An Investment Metric Snapshot preserves the calculated value of one or more Investment Metrics at a defined point in time together with sufficient calculation metadata for later comparison and audit.

## Domain Owner

Investment.

## Important Rule

Snapshots are persisted derived data, not new canonical financial truth.

A snapshot should preserve, where relevant:

- metric code
- value
- as-of date
- calculation timestamp
- formula version
- relevant input references
- warnings / confidence information

Snapshots must remain reproducible from canonical inputs and the applicable calculation definition.

---

# 60. Metric Calculation Definition

Every Investment Metric must have an explicit calculation definition.

Conceptually:

```text
Metric Definition
├── name
├── formula/version
├── required inputs
└── interpretation
```

This allows metrics to remain reproducible if formulas evolve.

---

# 61. Equity

## Definition

Equity represents the economic interest remaining after deducting applicable debt from asset value.

Conceptually:

```text
Equity
=
Selected Property Value
-
Relevant Debt
```

Because Property Value may be estimated, Equity may also be estimate-dependent.

The system must communicate this distinction.

---

# 62. NOI

Net Operating Income is a derived operating metric.

It should be computed from eligible property operating income and expenses before financing effects.

The exact canonical formula will be defined in the Investment Specification.

NOI must not be stored as manually editable source data.

---

# 63. Cashflow

Cashflow represents actual or projected financial movement over a defined period.

Different cashflow views may exist, for example:

- before financing
- after financing
- before tax
- after tax

Each view must have an explicit definition.

The term `Cashflow` without scope should be avoided where ambiguity exists.

---

# 64. Plan

## Definition

Plan represents intentionally entered expectations for a future period.

Examples:

- expected rent
- planned maintenance
- expected operating cost
- planned financing

Plan data is not Actual data.

---

# 65. Forecast

## Definition

Forecast represents a calculated future estimate based on current facts and assumptions.

It differs from Plan because it may be generated automatically.

---

# 66. Actual

Actual represents observed or confirmed historical reality.

Examples:

- actual bank Transaction
- confirmed MRE rental relationship
- paid invoice
- confirmed WEG Annual Statement

Actual values receive the strongest authority in reporting.

---

# 67. Plan vs. Actual Relationship

The system should enable:

```text
Plan
  │
  ▼
Compare
  ▲
  │
Actual
```

without mixing their respective data.

---

# 68. Automation Rule

## Definition

Automation Rule represents a deterministic rule that proposes or performs predefined workflow actions.

Examples:

- identify recurring Hausgeld payment
- map known counterparty
- match rent payment to obligation

Automation Rules must operate through domain interfaces.

They must not bypass domain invariants.

---

# 69. AI Suggestion

## Definition

AI Suggestion represents a non-authoritative machine-generated recommendation.

Possible targets:

- financial category
- tax classification
- document type
- transaction match

## Domain Status

AI Suggestion is never canonical business data until confirmed through an appropriate domain action.

---

# 70. Audit Record

## Definition

Audit Record represents traceability of significant changes to authoritative data.

Potentially audited actions include:

- transaction confirmation
- financial correction
- tax classification approval
- ownership modification
- depreciation basis change

The exact audit implementation will be specified separately.

---

# 71. Correction

## Definition

Correction represents an explicit amendment of previously confirmed information.

Financially significant historical facts should preferably be corrected through traceable correction behavior rather than silent mutation.

---

# 72. External Reference

Many entities may carry External References linking them to:

- MRE
- bank systems
- tax systems
- imported datasets
- upstream services

External references must not become the entity's sole internal identity.

---

# 73. Money

## Value Object

Money represents:

```text
Amount + Currency
```

Financial calculations must never operate on bare numbers where currency matters.

Currency handling rules will be specified separately.

---

# 74. Percentage

## Value Object

Percentage represents a bounded or unbounded rate depending on context.

Examples:

- ownership share
- interest rate
- depreciation rate
- rent increase assumption

The domain should avoid confusing percentages with decimal values at interfaces.

---

# 75. Date Range

## Value Object

Date Range represents temporal validity.

Conceptually:

```text
valid_from
valid_until
```

`valid_until` may be open.

This concept is heavily used for:

- Ownership
- RentalContractReference validity / rental relationships
- Tax Rules
- financing terms
- WEG allocations

---

# 76. Source Reference

## Value Object

Source Reference identifies the origin supporting a fact or interpretation.

Examples:

- Document
- bank entry
- tax rule reference
- user decision
- advisor decision

Important financial interpretations should preserve source references where feasible.

---

# 77. Review State

Many interpretive concepts require explicit review status.

Examples:

- AI classification
- tax classification
- imported WEG allocation
- acquisition allocation

A generic conceptual model may include states such as:

```text
Unreviewed
Suggested
Confirmed
Needs Review
```

Not all domains need identical workflows.

---

# 78. Aggregate Boundaries

The following conceptual aggregate boundaries are currently assumed.

## MRE Property Aggregate

Operational ownership remains with MRE.

MRE owns operational Property and rental-management state.

The DE layer holds `PropertyReference` and `RentalContractReference`; it does not recreate an MRE Property aggregate.

---

## Acquisition Aggregate

`Acquisition` is a first-class Aggregate Root.

Contains or coordinates:

- acquisition facts
- acquisition costs / classifications
- land/building allocation inputs
- financing relationships
- source references

Ownership remains a separate temporal domain relationship.

---

## Transaction Aggregate

Contains:

- Transaction
- Transaction Splits
- transaction-level provenance

Classification integrity belongs here.

`RentPaymentReconciliation` references the Transaction Aggregate but does not become part of the cash Transaction itself.

---

## Loan Aggregate

Contains:

- Loan
- financing terms
- Loan Allocations across one or more Properties
- schedule assumptions
- refinancing history

Actual payment remains externally referenced from the Ledger.

---

## Security Deposit Aggregate

Contains:

- expected deposit state
- RentalContractReference
- holding FinancialAccount reference
- receipt / repayment Transaction references
- reconciliation state

---

## WEG Aggregate

Contains:

- WEG
- Membership
- Economic Plans
- Annual Statements
- Cost Lines
- Special Assessments

---

## Depreciation Aggregate

Contains:

- Depreciation Asset
- allocation inputs
- schedule versions

---

## Scenario Aggregate

Contains:

- Investment Scenario
- assumptions
- calculated projections

Never contains actual financial truth.

---

# 79. High-Level Relationship Model

```text
MRE Realm
   │
   ├── MRE Property ───────────── PropertyReference
   │                                  │
   │                                  ├── Ownership ───── Party
   │                                  ├── Acquisition
   │                                  ├── Loan Allocation ─── Loan
   │                                  ├── WEG Membership ─── WEG
   │                                  ├── Maintenance Project
   │                                  ├── Market Valuation
   │                                  └── Investment Scenario
   │
   └── MRE Tenant
          │
          ├── MRE Lease Definition
          ├── MRE Rent State
          │
          └──────── RentalContractReference
                         │
                         ├── Party mapping
                         └── Security Deposit


MRE Rent State
      │
      ▼
RentPaymentReconciliation
      │
      ▼
Transaction
   │
   └── Transaction Split
          │
          ├── Financial Category
          └── Tax Classification


FinancialAccount
      │
      └── Transaction


Acquisition
     │
     └── Land / Building Allocation
               │
               └── Depreciation Asset
                         │
                         └── Depreciation Schedule


WEG Annual Statement
        │
        └── WEG Cost Line
                │
                ├── Operating Cost Allocation
                └── Tax Classification


Canonical Data
      │
      ▼
Investment Calculations
      │
      ├── Dynamic Metrics
      └── Investment Metric Snapshots
```

---

# 80. Canonical vs. Derived Data

The following concepts are canonical or authoritative references:

- MRE Property and MRE rental state *(owned by MRE)*
- PropertyReference *(canonical DE reference, not a duplicate Property master)*
- RentalContractReference
- Party
- Ownership
- Acquisition
- Transaction
- Transaction Split
- FinancialAccount
- RentPaymentReconciliation
- Loan
- Security Deposit
- WEG Statement
- Tax Classification
- Depreciation Asset
- Market Valuation
- Scenario Assumption

The following are generally derived:

- remaining debt
- NOI
- Cashflow
- Equity
- LTV
- IRR
- Cash-on-Cash Return
- annual depreciation amount
- portfolio performance

`InvestmentMetricSnapshot` is a persisted historical snapshot of derived data. Persisting a snapshot does not make the metric an editable source of truth.

Derived results may be cached or snapshotted but must remain reproducible.

---

# 81. Actual vs. Interpretive Data

The model distinguishes:

## Observed Facts

Examples:

- 1,250 EUR entered bank account.
- Invoice was paid.
- Loan payment occurred.

## Interpretations

Examples:

- 600 EUR of payment represents interest.
- Expense is tax deductible.
- WEG cost is recoverable from tenant.

## Estimates

Examples:

- Property is worth 310,000 EUR.
- Rent will rise by 2 percent annually.

These categories must not be treated as equivalent certainty.

---

# 82. Deletion Principle

Financially or legally relevant canonical history should rarely be physically deleted.

The system should prefer states such as:

- cancelled
- superseded
- corrected
- inactive

where historical auditability matters.

Exact retention requirements will be defined later.

---

# 83. Import Idempotency

Imported business facts should carry sufficient identity or fingerprint information to prevent accidental duplicate imports.

This is particularly relevant for:

- bank Transactions
- WEG statements
- documents
- external valuations

---

# 84. Domain Invariants

The following invariants apply across the domain model.

### INV-001

A canonical financial Transaction has one authoritative representation.

### INV-002

Confirmed Transaction Splits sum to the Transaction amount.

### INV-003

Derived Investment Metrics cannot modify source data.

### INV-004

Tax Classifications reference existing economic facts.

### INV-005

AI Suggestions are non-authoritative until reviewed.

### INV-006

Scenario assumptions never overwrite Actual values.

### INV-007

Historical validity must not be destroyed by replacing temporal facts.

### INV-008

MRE-owned operational entities are referenced rather than duplicated. MRE-specific semantics are translated through the integration boundary.

### INV-009

Every Depreciation Schedule must be reproducible from its inputs.

### INV-010

Every significant financial interpretation should have traceable provenance.

### INV-011

The Financial Ledger contains actual cash movements only.

### INV-012

MRE operational payment state cannot replace or silently create canonical DE cash Transactions.

### INV-013

Rent settlement across MRE and the DE Ledger is represented through explicit RentPaymentReconciliation.

### INV-014

For the current product scope, legal ownership shares are the canonical basis for owner-level allocation unless a future ADR explicitly changes this rule.

### INV-015

Investment Metric Snapshots are immutable historical calculation results and must remain reproducible.

---

# 85. Domain Decisions and Remaining Open Questions

Several questions listed in version 0.1 have now been resolved.

## Resolved — Party

Party is a shared canonical DE entity.

MRE identities are connected through external mappings rather than replacing Party.

---

## Resolved — Acquisition

Acquisition is a first-class Aggregate Root.

---

## Resolved — Ledger Scope

The Financial Ledger is cash-only.

Non-cash economic concepts belong to specialized domains.

---

## Resolved — Security Deposit

Security Deposit is modeled pragmatically as its own domain concept linked to:

- RentalContractReference
- expected amount
- holding FinancialAccount / IBAN context
- actual receipt Transaction
- actual repayment Transaction

---

## Resolved — Shared Financing

Loans may be allocated across multiple Properties.

Loan Allocation expresses the relationship.

---

## Resolved — Investment Metric Snapshots

Versioned / historical Investment Metric Snapshots are supported.

They remain derived data.

---

## Resolved — WEG Reserve Data

Incomplete WEG reserve information is treated as an edge case and is not a design driver for the initial model.

---

## Resolved — Ownership Allocation

For the current scope, legal ownership shares are the canonical allocation basis for income, expenses and owner-level tax interpretation.

Separate economic versus legal ownership percentages are not modeled.

---

## ODD-009 — Maintenance Project Scope

Should Maintenance Project be generic enough to also represent capital improvements and acquisition-related renovation packages?

---

## ODD-010 — Tax Rule Provenance

How granular should tax-rule provenance be?

---

## ODD-011 — Future Asset Hierarchy

If the product later manages buildings with multiple rentable objects, parking spaces or other sub-assets, should a generic `Asset` hierarchy be introduced above MRE Property?

This is intentionally deferred and must not reintroduce `Unit` into the MVP without an ADR.

---

# 85A. Terminology Lock

The following terminology is normative for future documentation and implementation:

- `Property` means the MRE-owned rentable operational object.
- `PropertyReference` means the DE-side canonical reference to that MRE Property.
- `Unit` is deferred and must not appear in MVP domain logic.
- `MRE Lease` means the reusable MRE Lease Definition.
- `RentalContractReference` means the DE integration reference to the concrete MRE rental relationship.
- `FinancialAccount` means a bank/cash account in the DE Ledger.
- `MRE Account` means an authenticated MRE user.
- `RentPaymentReconciliation` connects MRE operational rent state with DE canonical cash.

New documents and code should not reintroduce the superseded generic `Property → Unit → Lease → Tenant` vocabulary.

---

# 86. Domain Evolution Rule

Changes to the canonical meaning of a core entity require explicit documentation.

Examples include changing:

- what constitutes a Transaction
- what constitutes ownership
- how Property identity works
- whether a calculated value becomes canonical

Such changes should receive an ADR because they affect the integrity of all higher layers.

---

# 87. Domain Modeling Success Criteria

The domain model is successful when:

- each concept has a clear meaning
- every concept has one authoritative owner
- MRE data is not unnecessarily duplicated
- the model reflects actual MRE Property / Tenant / Lease semantics
- MRE settlement state and DE cash truth are reconciled rather than merged
- cash, tax and investment concepts remain separated
- historical states can be reconstructed
- hypothetical state remains isolated
- every financial metric can trace back to canonical inputs
- additional PropertyReferences can be introduced without redesign
- German concepts remain modular
- future country modules remain possible

---

# 88. Final Domain Principle

The model should preserve the distinction between:

```text
What happened
      │
      ▼
What it means financially
      │
      ▼
What it means legally or tax-wise
      │
      ▼
What it means for the investment
```

These are related questions.

They are not the same question.

The domain model must never collapse them into a single ambiguous data structure.

---

# Closing Statement

The central object of Vermieter Cockpit DE is not the property itself.

It is the **economic lifecycle of owning property**.

The MRE Property, referenced through PropertyReference, provides operational context.

Transactions describe financial reality.

Financing describes debt.

WEG describes condominium obligations.

Taxation provides jurisdiction-specific interpretation.

Investment analysis derives economic meaning.

All of these domains must remain connected without becoming entangled.

The resulting model should allow the platform to explain not only **what a property is**, but **what happened to it, how it was financed, what it cost, what it earned, how it was taxed, and whether it was a successful investment**.