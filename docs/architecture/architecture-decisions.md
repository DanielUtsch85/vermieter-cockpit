# Architecture Decisions

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.3  
**Status:** Living Document

**MRE Integration Revision:** Consolidated after inspection of the actual MRE domain model and aligned with `mre-integration.md`, `domain-model.md`, `data-model.md`, `glossary.md`, `api-design.md`, `data-flow.md`, and `technology.md`.

**Technology Revision:** v0.3 closes the initial technology decisions for DE persistence, process structure, runtime/toolchain, Money representation, authentication, document storage, and repository/upstream strategy.

---

# 1. Purpose

This document records the major architectural and domain decisions of Vermieter Cockpit DE.

The purpose is to preserve the reasoning behind decisions so that future contributors, including AI coding agents, do not unknowingly reverse or bypass them.

Each decision contains:

- status
- context
- decision
- rationale
- consequences
- rejected alternatives where relevant

This document should be updated whenever a decision materially changes system structure, domain ownership, or long-term maintainability.

---

# ADR-001 — MicroRealEstate as Operational Core

**Status:** Accepted

## Context

The project requires mature operational rental-management capabilities including:

- rentable Properties
- Tenant-centered rental relationships
- reusable Lease Definitions
- rent tracking and operational settlement state
- tenant communication
- documents
- authentication
- tenant-facing functionality

MicroRealEstate already provides these capabilities as an open-source, self-hosted application.

Reimplementing them would add significant development and maintenance effort without contributing to the project's differentiating value.

## Decision

MicroRealEstate (MRE) is the operational rental-management core of the platform.

The project builds on top of MRE rather than replacing it.

## Rationale

The project's primary innovation lies in:

- financial transparency
- financing
- German condominium logic
- taxation
- depreciation
- investment analytics

not in recreating generic rental-management functionality.

## Consequences

MRE remains authoritative for operational rental entities and state.

The inspected MRE core does not expose a separate canonical Unit entity. MRE `Property` is the rentable operational object, MRE `Tenant` centers the concrete rental relationship, and MRE `Lease` is primarily a reusable Lease Definition.

New domains reference MRE-owned entities through an explicit integration boundary rather than creating competing copies.

Upstream compatibility becomes an explicit architectural concern.

---

# ADR-002 — Extend MRE Before Modifying It

**Status:** Accepted

## Context

Direct changes to upstream application code increase:

- merge conflicts
- maintenance burden
- upgrade complexity
- long-term divergence

## Decision

The project follows:

> Prefer extension over modification.

New capabilities should be implemented using, in order of preference:

1. existing MRE interfaces
2. extension modules
3. adapter layers
4. new services
5. new UI modules
6. minimal core modifications where unavoidable

## Allowed Core Modifications

Direct changes to MRE are acceptable when:

- the required extension is technically impossible otherwise
- a defect requires fixing
- a missing generic extension point must be introduced
- the change can reasonably be contributed upstream

## Consequences

Convenience alone is not sufficient justification for changing MRE core behavior.

---

# ADR-002A — Explicit MRE Anti-Corruption Layer

**Status:** Accepted

## Context

The actual MRE domain model differs from the generic rental model originally assumed by the project.

Directly leaking MRE-specific identifiers and semantics into DE domains would tightly couple tax, financing and investment logic to upstream implementation details.

## Decision

The DE Investment Layer uses an explicit MRE integration / anti-corruption boundary.

Canonical DE integration concepts include:

- `PropertyReference`
- `RentalContractReference`
- Party external mappings
- `RentPaymentReconciliation`

MRE identifiers are Realm-scoped where applicable.

## Consequences

DE domains do not directly model MRE internals.

Raw MRE Property identity is stored inside PropertyReference as `mrePropertyId`; DE-owned entities use `propertyReferenceId`.

The integration boundary owns translation, validation and reconciliation semantics.

---

# ADR-002B — No Unit Entity in MVP

**Status:** Accepted

## Context

Earlier project drafts assumed a generic hierarchy:

```text
Property → Unit → Lease → Tenant
```

Inspection of MRE showed that its core does not expose a separate canonical Unit entity. MRE Property itself is the rentable operational object.

## Decision

The MVP does not introduce:

- `Unit`
- `UnitReference`
- `unitId`
- `unitIds`

merely to preserve the earlier abstract model.

## Consequences

For the initial condominium use case, MRE Property represents the rented apartment.

If future multi-asset or building hierarchy requirements emerge, they require a deliberate future `Asset` / `Building` design and ADR.

---

# ADR-002C — MRE Lease Is a Lease Definition

**Status:** Accepted

## Context

MRE `Lease` was initially interpreted as the concrete rental contract.

Inspection showed that MRE Lease is primarily a reusable rental-term / contractual configuration, while the concrete operational rental relationship is centered on MRE Tenant.

## Decision

The canonical project term for MRE `Lease` is `Lease Definition`.

DE domains that need to reference the concrete MRE rental relationship use `RentalContractReference`, centered on:

- MRE Realm
- MRE Tenant
- optional MRE Lease Definition
- relevant PropertyReference(s)
- relevant Party mapping(s)

## Consequences

New DE documentation and code must not use generic `Lease` or `leaseId` to represent the concrete rental relationship.

---

# ADR-003 — One Canonical Financial Ledger

**Status:** Accepted

## Context

Property management, taxation and investment analysis often represent the same monetary events independently.

This creates duplicate data and inconsistent results.

## Decision

The Financial Ledger is the sole canonical source of actual cash movements.

Every actual monetary movement is represented once.

Other domains interpret or derive information from the Ledger.

## Consequences

Taxation does not maintain an independent expense ledger.

Investment analytics does not maintain independent cashflow data.

Reports do not maintain independent totals.

---

# ADR-004 — Ledger Contains Cash Movements Only

**Status:** Accepted

## Context

A broader accounting model could represent both cash and non-cash economic events.

However, the initial product is intended for private real estate investors rather than full double-entry accounting.

## Decision

The canonical Financial Ledger records **actual cash movements only**.

Examples:

- rent received
- Hausgeld paid
- loan installment paid
- contractor invoice paid
- purchase price transferred
- security deposit transferred

Non-cash concepts remain in their owning domains.

Examples:

- depreciation
- unrealized property appreciation
- projected interest
- accrued but unpaid amounts

## Rationale

This keeps the ledger understandable, bank-reconcilable and operationally simple.

## Consequences

Taxation and Investment may calculate non-cash values independently from cash transactions.

The Ledger must not be expanded into a general accounting system without a future ADR.

---

# ADR-004A — MRE Operational Settlement and DE Cash Truth Are Reconciled, Not Merged

**Status:** Accepted

## Context

MRE stores operational rent obligations and payment/settlement state as part of rental management.

The DE Financial Ledger is the canonical source of actual cash movement.

Treating either model as a duplicate of the other would create competing truth.

## Decision

MRE operational rent-payment state and DE Ledger cash movements remain separate.

They are connected through explicit `RentPaymentReconciliation`.

Conceptually:

```text
MRE Rent Obligation / Settlement State
                │
                ▼
     RentPaymentReconciliation
                │
                ▼
DE Transaction / Transaction Split
```

## Consequences

An MRE payment record does not silently create a canonical DE Transaction.

A DE Transaction does not silently rewrite MRE operational settlement state.

Matching suggestions may be automated, but confirmation and MRE write-back are explicit, auditable actions.

Generated schedules, forecasts and other non-cash projections must never create Ledger Transactions.

---

# ADR-005 — Transaction Splits Are First-Class Domain Objects

**Status:** Accepted

## Context

One bank movement may represent several economically different components.

Examples include:

- loan installment = interest + principal
- Hausgeld = operating costs + administration + reserve
- combined rent transfer = base rent + operating-cost advance

## Decision

A Transaction may contain one or more Transaction Splits.

Transaction Splits are first-class canonical financial objects.

## Invariant

For a confirmed Transaction:

> Sum of Transaction Splits = Transaction Amount

## Consequences

Tax and Investment logic operate primarily on classified splits rather than forcing one meaning onto the entire transaction.

---

# ADR-006 — Taxation Interprets; It Does Not Create Financial Facts

**Status:** Accepted

## Context

Tax logic frequently requires a different interpretation of the same financial event.

Examples:

- loan principal is cash outflow but not a deductible financing expense
- depreciation is tax-relevant but not a cash movement
- reserve contributions may differ in economic and tax treatment

## Decision

The Taxation domain references and interprets canonical economic facts.

It does not create duplicate financial transactions.

## Consequences

A tax classification may reference:

- Transaction Split
- Acquisition Cost
- WEG Cost Line
- Maintenance Project
- Depreciation Asset

Tax calculations remain reproducible from source data and rule versions.

---

# ADR-007 — Investment Metrics Are Derived

**Status:** Accepted

## Context

Metrics such as NOI, IRR and Cash-on-Cash Return depend on underlying financial facts and assumptions.

Allowing manual metric values would create competing truth.

## Decision

Investment metrics are always derived from canonical source data.

Examples:

- NOI
- Cashflow
- Equity
- LTV
- DSCR
- IRR
- Cash-on-Cash Return

## Consequences

Metrics cannot be manually edited as source facts.

---

# ADR-008 — Persist Versioned Investment Metric Snapshots

**Status:** Accepted

## Context

Although investment metrics are derived, historical analysis may require understanding what the system calculated at a specific time using a specific valuation, formula version or data state.

## Decision

The platform may persist **versioned Investment Metric Snapshots**.

A snapshot is not a new source of financial truth.

It records a reproducible calculation result together with sufficient provenance.

## Snapshot Requirements

Where applicable, snapshots should contain references to:

- calculation date
- metric definition/version
- source-data version or relevant period
- valuation reference
- scenario reference
- assumptions

## Consequences

Current metrics can be recalculated while historical calculation states remain inspectable.

---

# ADR-009 — Shared Party Entity

**Status:** Accepted

## Context

A person or organization may appear in several business roles.

Examples:

- property owner
- borrower
- landlord
- tenant
- lender
- contractor
- tax advisor

Creating unrelated copies introduces identity duplication.

## Decision

The domain model contains a shared `Party` concept.

A Party may be:

- Person
- Organization

and may hold multiple roles.

## Consequences

Domain-specific roles reference Party.

MRE-specific identities are mapped to Party through stable external references scoped by MRE Realm where applicable.

An MRE Tenant record must not be assumed to be permanently identical to exactly one canonical Party.

---

# ADR-010 — Acquisition Is a First-Class Aggregate Root

**Status:** Accepted

## Context

Acquisition contains important information that is conceptually distinct from the Property itself.

It connects:

- purchase
- acquisition costs
- ownership transition
- financing
- land/building allocation
- depreciation basis

## Decision

`Acquisition` is modeled as its own Aggregate Root.

## Consequences

A real-world Property, identified in DE through `PropertyReference`, may theoretically have multiple acquisitions across its history.

Acquisition-related tax and financial interpretations reference the Acquisition aggregate.

---

# ADR-011 — One Canonical Ownership Share

**Status:** Accepted

## Context

Legal, economic and tax allocations can theoretically differ.

Supporting all theoretical possibilities from the beginning would significantly increase model complexity.

For the intended German private-investor use case, the legal ownership share recorded in the acquisition/legal structure is the default basis for all owner allocations.

## Decision

The MVP stores one canonical `Ownership Share`.

Examples:

- 50 / 50
- 80 / 20
- 100 / 0

This share represents the legal ownership structure.

All default owner-level allocations derive from this share.

Examples:

- rental income
- expenses
- financing views
- equity
- depreciation
- tax reports
- investment performance

## No Separate Default Fields

The MVP does not maintain independent:

- economic ownership share
- tax ownership share
- beneficial ownership share

## Future Exceptions

If a verified real-world use case later requires a different allocation, it may be introduced explicitly through a future override model and ADR.

## Guiding Principle

> Model common real-world practice first. Extend only when actual requirements demand it.

---

# ADR-012 — Ownership Is Temporal

**Status:** Accepted

## Context

Ownership may change through:

- sale
- transfer
- inheritance
- restructuring

Replacing the current ownership percentage would destroy historical correctness.

## Decision

Ownership relationships contain validity periods.

Conceptually:

```text
Party / Owner
PropertyReference
Ownership Share
Valid From
Valid Until
```

## Consequences

Historical reports use the ownership structure valid for the relevant period.

---

# ADR-013 — Security Deposit Is a Dedicated Domain Concept

**Status:** Accepted

## Context

A rental security deposit represents actual cash movement but is economically distinct from rental income.

The platform must track both:

- the deposit obligation
- the actual movement of funds

## Decision

A dedicated `SecurityDeposit` entity is introduced.

## Initial Scope

The model should pragmatically support:

- `RentalContractReference`
- required / expected deposit amount
- payer / source Party
- holding `FinancialAccount`
- IBAN / external account identifiers where available
- actual receipt Transaction reference(s)
- actual repayment Transaction reference(s)
- relevant dates
- outstanding amount
- repayment / reconciliation state

## Relationship to Ledger

Actual deposit transfers are represented as canonical Ledger Transactions.

The SecurityDeposit entity references those Transactions.

MRE `Tenant.guaranty` and `guarantyPayback` may seed or reconcile expected operational deposit state, but they are not canonical evidence of actual cash receipt or repayment.

## Critical Rule

A security deposit must never be classified as ordinary rental income.

---

# ADR-014 — Loans May Finance Multiple Properties

**Status:** Accepted

## Context

Financing arrangements may use several properties as collateral or finance multiple assets.

Restricting a Loan to exactly one Property would create an unnecessary structural limitation.

## Decision

A Loan may finance or secure one or multiple real-world Properties.

DE-side relationships are expressed through `PropertyReference`.

An explicit `LoanAllocation` mechanism represents allocation of one canonical Loan across one or more PropertyReferences.

## Consequences

The Loan remains one canonical entity.

Property-level financing and analytics use LoanAllocation rather than duplicating the Loan or forcing a single Property foreign key.

The exact allocation basis and treatment of principal, interest and remaining debt remain a separate open decision.

---

# ADR-015 — Planned Loan Schedule and Actual Payments Are Separate

**Status:** Accepted

## Context

A financing contract predicts future payments.

Real bank transactions represent what actually occurred.

The two may differ because of:

- special repayments
- payment changes
- refinancing
- corrections
- timing differences

## Decision

The Financing domain owns expected Loan Schedules.

The Financial Ledger owns actual Loan-payment cash movements.

These may be reconciled but must remain distinct.

---

# ADR-016 — Remaining Debt Is Derived

**Status:** Accepted

## Context

Remaining debt can be calculated from financing terms and actual repayment activity.

Allowing it to become an arbitrary manually maintained number would create duplicate truth.

## Decision

Remaining Debt is a derived financing value.

External lender balances may be imported as reconciliation evidence.

They do not silently replace the calculated debt state.

---

# ADR-017 — WEG Is a Dedicated German Domain

**Status:** Accepted

## Context

German condominium ownership introduces concepts that are not generic rental-management concepts.

Examples:

- WEG
- Miteigentumsanteil
- Wirtschaftsplan
- Jahresabrechnung
- Erhaltungsrücklage
- Sonderumlage

## Decision

WEG logic is implemented in a dedicated German domain.

It is not embedded into MRE Property models; DE WEG entities reference `PropertyReference`.

## Consequences

Future country-specific property-ownership concepts can be implemented separately.

---

# ADR-018 — Ignore Incomplete WEG Reserve Edge Cases in MVP

**Status:** Accepted / Deferred Complexity

## Context

Some WEGs may provide incomplete information regarding maintenance reserve balances or historical development.

Supporting every incomplete-data scenario adds complexity.

## Decision

The MVP assumes sufficient WEG reserve information is available for the supported workflow.

Special handling of incomplete reserve datasets is deferred.

## Consequences

The first implementation does not need a sophisticated uncertainty model for WEG reserves.

The issue may be revisited if real-world use requires it.

---

# ADR-019 — Maintenance Projects Group Related Costs

**Status:** Accepted

## Context

One renovation or repair measure often creates multiple:

- invoices
- payments
- documents
- contractors

Treating each payment as an unrelated economic event makes tax and investment interpretation harder.

## Decision

Related expenditures may be grouped under a `MaintenanceProject`.

## Consequences

Transactions remain canonical cash facts.

The Project provides economic context.

Tax treatment may reference the entire Project where appropriate.

---

# ADR-020 — Actual, Plan, Forecast and Scenario Are Separate Concepts

**Status:** Accepted

## Context

Historical facts, management plans and hypothetical investment assumptions answer different questions.

Mixing them causes incorrect reporting.

## Decision

The platform explicitly distinguishes:

- Actual
- Plan
- Forecast
- Scenario

## Consequences

Scenario or forecast data may never overwrite Actual data.

Plan-vs-Actual comparison becomes possible without ambiguity.

---

# ADR-021 — Estimated Market Value Is Explicitly Non-Canonical

**Status:** Accepted

## Context

A Property valuation is not directly observed in the same way as a bank transaction.

It is an estimate based on a method and source.

## Decision

`MarketValuation` is stored as a dated estimate including provenance.

It does not become unquestioned financial truth.

## Minimum Provenance

Where available:

- valuation date
- estimated value
- method
- source
- notes
- confidence/review state

---

# ADR-022 — Country-Specific Rules Are Versioned

**Status:** Accepted

## Context

Tax and legal rules change over time.

Hardcoding current German rules into generic business code would make historical calculations unreliable.

## Decision

Country-specific rules must be explicitly versionable where material.

Conceptually a Rule should identify:

- jurisdiction
- validity period
- version
- rule category
- source reference

## Consequences

Historical calculations should continue using historically applicable rule versions.

---

# ADR-023 — Prefer Defaults Before Overrides

**Status:** Accepted

## Context

Highly configurable systems often become difficult to understand and maintain.

Many theoretically possible exceptions are irrelevant to the common use case.

## Decision

The product should implement sensible domain defaults first.

Overrides should only be introduced for demonstrated real-world needs.

## Examples

Ownership allocation defaults to legal ownership share.

Investment metrics use canonical definitions.

Country rules use documented defaults.

## Guiding Principle

> Start with the simplest model that correctly represents common real-world practice.

---

# ADR-024 — Domain Model Represents Common Practice, Not Every Theoretical Possibility

**Status:** Accepted

## Context

Attempting to model every legally or economically conceivable structure from the beginning would lead to premature complexity.

## Decision

The domain model prioritizes common use cases of private residential real-estate investors.

Edge cases are introduced only when:

- a verified use case exists
- the existing model cannot represent it correctly
- the added complexity remains justified

## Consequences

The system may intentionally reject unsupported edge cases in early versions.

This is preferred to silently modeling them incorrectly.

---

# ADR-025 — Self-Hosting Is a First-Class Architecture Requirement

**Status:** Accepted

## Context

The platform stores sensitive:

- financial
- tenant
- tax
- property
- personal

information.

Long-term ownership of data is a foundational product principle.

## Decision

The complete platform must remain deployable in a self-hosted environment.

Containerized deployment is preferred.

## Consequences

Core product functionality may not depend exclusively on proprietary hosted infrastructure.

Optional cloud integrations remain possible.

---

# ADR-026 — Modular Domain Boundaries Are Mandatory; Microservices Are Not

**Status:** Accepted

## Context

MRE uses several services, but blindly extending that pattern could introduce unnecessary operational complexity.

## Decision

Clear domain boundaries are mandatory.

The initial DE Investment Layer is implemented as a **modular monolith**.

Separate operating processes are not introduced merely because domain boundaries exist.

A module may be extracted into a separate deployable service later only when a demonstrated operational, scaling, security, or ownership requirement justifies the additional complexity.

Such extraction requires a future ADR.

## Principle

> Domain boundaries are mandatory. Process boundaries are optional.

For the initial implementation:

> Modular monolith first.

---

# ADR-027 — Reporting Contains No Authoritative Business Logic

**Status:** Accepted

## Context

Reports and dashboards are presentation layers.

Embedding financial formulas in reporting components creates hidden duplicated logic.

## Decision

Reports consume calculated domain outputs.

They do not own canonical financial calculations.

## Consequences

NOI is calculated by the Investment domain.

Remaining Debt is calculated by Financing.

Depreciation is calculated by Depreciation.

Reporting only presents these values.

---

# ADR-028 — AI Suggestions Require Human Confirmation

**Status:** Accepted

## Context

AI may assist with:

- transaction categorization
- document classification
- tax classification
- matching
- explanations

However, AI is probabilistic.

## Decision

AI-generated output is non-authoritative.

AI may suggest changes but must not silently modify canonical financial, tax or ownership records.

## Flow

```text
Source Data
    ↓
AI Suggestion
    ↓
Human Review
    ↓
Canonical Domain Action
```

---

# ADR-029 — Corrections Prefer Traceability Over Silent Mutation

**Status:** Accepted

## Context

Financial and tax history must remain explainable.

Silent editing of previously confirmed historical facts can destroy auditability.

## Decision

The platform should prefer explicit correction or supersession workflows for materially important historical data.

The exact immutability model remains an implementation detail.

---

# ADR-030 — Open Data Formats and Exportability

**Status:** Accepted

## Context

User ownership of data requires practical portability.

## Decision

Core data must remain exportable using documented and broadly accessible formats.

Preferred formats include:

- CSV
- JSON
- PDF for human-readable documents

## Consequences

Proprietary export-only formats are not acceptable as the sole portability mechanism.

---

# ADR-031 — Separate PostgreSQL Database for the DE Investment Layer

**Status:** Accepted

## Context

MRE uses MongoDB for its operational rental-management model.

The DE Investment Layer has materially different persistence needs, including:

- canonical Financial Ledger Transactions and Transaction Splits
- relational reconciliation relationships
- temporal Ownership
- LoanAllocation
- tax classifications
- depreciation schedules
- versioned Investment Metric Snapshots
- deterministic financial reporting

The DE layer must remain loosely coupled to MRE persistence internals.

## Decision

The DE Investment Layer uses **PostgreSQL as its separate canonical datastore**.

MRE continues to own and persist its operational data in its existing MongoDB datastore.

The two systems integrate through supported APIs and explicit integration references rather than shared database collections.

## Rationale

PostgreSQL provides a strong fit for the DE model through:

- transactional integrity
- foreign-key constraints
- precise `NUMERIC` values
- relational querying
- temporal/history-oriented modeling
- mature migration, backup and restore tooling
- straightforward self-hosting

The separation also protects MRE upgradeability.

## Consequences

A normal self-hosted deployment contains both:

```text
MRE MongoDB
+
DE PostgreSQL
```

No distributed transaction is created between the two datastores.

Cross-system consistency uses explicit reconciliation, synchronization status and retryable integration workflows.

DE domains must not directly mutate MRE MongoDB collections.

---

# ADR-032 — Node.js 24 LTS, TypeScript and Yarn 3.3-Compatible Tooling

**Status:** Accepted (amended 2026-10-18: runtime raised from Node.js 20 to Node.js 24 LTS, see "Amendment" below)

## Context

The inspected MRE baseline uses the Node.js ecosystem and Yarn workspaces, with TypeScript already present in shared/common components.

Introducing another runtime ecosystem would increase development, deployment and maintenance cost without a demonstrated architectural benefit.

## Decision

The DE Investment Layer uses:

- **Node.js 24 (LTS)** (originally Node.js 20 to match the MRE baseline; see "Amendment")
- **TypeScript**
- **Yarn 3.3-compatible workspace tooling**

New DE backend and domain code is TypeScript-first.

Where the DE frontend integrates with MRE, it should remain compatible with MRE's existing React/Next ecosystem rather than introducing an unrelated frontend stack.

## Type Safety

New DE code should use strict static typing.

Important domain concepts should be modeled explicitly rather than passed throughout the codebase as unstructured primitives.

Examples include:

- Money
- Percentage
- Entity IDs
- `PropertyReference` IDs
- Currency
- business dates
- status values

## Consequences

The DE layer remains within the same primary runtime ecosystem as MRE while allowing stronger typing for newly implemented domain logic.

The choice of HTTP controller library remains an implementation-level decision unless it materially changes the architecture.

## Amendment (2026-10-18) — Node.js 24 LTS instead of Node.js 20

Node.js 20 reached end-of-life on 2026-04-30, before the first line of DE code was written. Building a new financial system on an unsupported runtime (no security fixes) is not acceptable.

The candidates were judged on **end-of-life date** and **toolchain compatibility**, not on the current release phase (active vs. maintenance LTS), because the phase changes within weeks while EOL dates are fixed:

| Version | EOL | Decision |
|---|---|---|
| Node.js 22 | 2027-04-30 | Rejected: forced upgrade within ~6 months of the decision. |
| **Node.js 24** | **2028-04-30** | **Chosen.** LTS line (active LTS until 2026-10-20, maintenance thereafter); the pinned toolchain (Yarn 3.3.0, TypeScript 5.6, Vitest 2) is verified on it by CI. |
| Node.js 26 | 2029-04-30 | Not chosen: not yet LTS at decision time (LTS from ~2026-10-28), and the pinned toolchain is unverified on it. Re-evaluate once the toolchain is confirmed on 26. |

- The DE backend pins Node.js 24 (`.nvmrc`, `engines: "^24"`, CI, Docker base images).
- **MRE compatibility:** the pinned MRE baseline still runs on Node.js 20. This does not conflict: DE is a separately deployed service (ADR-026, ADR-036) that talks to MRE only over HTTP (ADR-034), so the runtimes are independent. Code shared with MRE packages (if ever needed) must not rely on Node-24-only APIs.
- The decision's intent (stay in MRE's Node/TypeScript/Yarn ecosystem) is unchanged; only the major version moves.
- Future runtime upgrades follow the Node.js LTS schedule and are recorded here as further amendments.

---

# ADR-033 — Exact Decimal Money Representation

**Status:** Accepted

## Context

The DE Investment Layer performs financially sensitive calculations including:

- Transaction Split reconciliation
- Loan interest and principal allocation
- Ownership allocation
- WEG allocation
- depreciation
- tax calculations
- investment metrics

JavaScript binary floating-point arithmetic is unsuitable as the canonical representation for monetary calculations.

## Decision

The DE layer uses a dedicated **Money value abstraction backed by exact decimal arithmetic**.

PostgreSQL persists monetary decimal values using `NUMERIC`.

Canonical APIs serialize monetary amounts without binary floating-point loss, preferably as decimal strings together with currency.

Conceptually:

```json
{
  "amount": "1250.00",
  "currency": "EUR"
}
```

## Rounding

Rounding is explicit at the relevant domain boundary.

The system must not rely on implicit JavaScript floating-point rounding for canonical financial results.

## Consequences

Raw JavaScript `number` must not be used for canonical Money arithmetic.

A concrete decimal library may be selected during implementation if it satisfies this ADR and does not alter the domain model.

---

# ADR-034 — Reuse MRE Authentication and Realm Authorization

**Status:** Accepted

## Context

MRE already owns operational user Accounts, authentication and Realm membership.

Introducing an independent DE username/password identity system would create duplicate identities and additional credential/security handling.

## Decision

The integrated Vermieter Cockpit DE reuses **MRE authentication as the primary user identity and Realm-access authority**.

The DE layer does not introduce a separate username/password identity system for the integrated application.

Conceptually:

```text
MRE authenticated user
        │
        ▼
Verified identity
        │
        ▼
MRE Realm membership
        │
        ▼
DE authorization policy
```

## Authorization Boundary

The DE backend remains responsible for DE-specific authorization.

Possession of an MRE entity identifier or Realm identifier does not establish authorization.

Realm membership and relevant access rights must be verified server-side.

Owner-only DE data must not become accessible through tenant-facing MRE functionality merely because authentication is shared.

## Integration Detail

The precise token/session propagation mechanism is an implementation decision to be verified against the supported MRE baseline.

It must not require copying MRE user passwords into DE persistence.

---

# ADR-035 — Pluggable Document Storage with Local Filesystem Default

**Status:** Accepted

## Context

The platform handles supporting documents including:

- purchase agreements
- invoices
- Loan agreements
- WEG statements
- tax evidence
- maintenance documentation

Self-hosted installations should remain simple, while domain entities should not depend directly on filesystem paths.

## Decision

Document binary storage uses a **storage abstraction**.

The initial/default implementation stores binaries on a local persistent filesystem volume.

Canonical document metadata remains in PostgreSQL.

Conceptually:

```text
Domain Document Metadata
          │
          ▼
DocumentStorage Port
          │
          ├── LocalFilesystemStorage
          └── additional adapter (future)
```

An S3-compatible or other storage adapter may be introduced later without changing the owning domains.

## Metadata

Where relevant, document metadata includes:

- document ID
- content type
- original filename
- size
- checksum
- storage key
- provenance

Existing MRE documents may be referenced instead of copied where practical.

## Consequences

The default self-hosted deployment remains operationally simple while document storage remains replaceable.

---

# ADR-036 — Separate Vermieter Cockpit Repository and Pinned MRE Compatibility

**Status:** Accepted

## Context

The project must extend MRE while minimizing upstream divergence.

Deeply embedding DE functionality into an MRE fork would increase:

- merge conflicts
- upgrade difficulty
- ownership ambiguity
- temptation to modify MRE core for convenience

## Decision

`vermieter-cockpit` remains a **separate repository** containing the DE-specific:

- backend
- frontend/extensions
- integration adapters
- documentation
- migrations
- tests
- deployment additions

MRE remains an upstream dependency/system.

The project records an explicitly supported MRE baseline or compatible version/commit range.

## MRE Modifications

Where MRE core modifications are unavoidable, they should:

1. remain minimal
2. preferably be generic and upstream-worthy
3. be isolated and documented
4. be contributed upstream where appropriate
5. have explicit compatibility tests or patch documentation

## Consequences

Separate repositories do not imply a separate user experience.

Deployment may orchestrate MRE and DE components together.

MRE upgrades require integration/contract compatibility verification.

---

# ADR-037 — Confirmed Transactions Are Immutable; Corrections Use Reversals

**Status:** Accepted
**Resolves:** ADR-OPEN-004

## Context

Confirmed Ledger Transactions are canonical cash truth. Article II (Financial Truth) and Article III (Transparency) require that every value remain reconstructible, and ADR-029 already states that corrections prefer traceability over silent mutation. A confirmed transaction that can be edited in place destroys the audit trail.

## Decision

A Ledger Transaction is freely editable while in draft/unconfirmed state. Once **confirmed**, it becomes **append-only (immutable)**. A mistake in a confirmed transaction is corrected by:

1. an explicit **reversal record** that reverses the original, plus
2. a new corrected Transaction,

with both linked to the original for a complete, auditable chain. `POST /api/v1/transactions/{id}/correct` implements this reversal+replacement flow; it never mutates the confirmed record in place.

## Consequences

- The data model needs a correction/reversal linkage (original ↔ reversal ↔ replacement).
- The First Vertical Slice may implement `confirm` now; the `correct` flow is unblocked and follows this reversal model.
- Reporting must present net effect while preserving the full chain.

---

# ADR-038 — Shared Loan Allocation Uses One Overridable Percentage Basis

**Status:** Accepted
**Resolves:** ADR-OPEN-005

## Context

ADR-014 accepts that one canonical `Loan` may finance or secure several `PropertyReference`s via `LoanAllocation`, but left the allocation *basis* open. Allowing a different basis per metric (principal vs interest vs remaining debt) multiplies complexity against ADR-024 (common practice, not every theoretical possibility) and ADR-023 (defaults before overrides).

## Decision

Shared-loan allocation uses **one explicit percentage allocation per `PropertyReference`**, where the allocations for a Loan **sum to 100%**. This single basis applies uniformly to **principal, interest, and remaining debt**. The percentages are **defaulted** from the financed purchase amount per property and are **user-overridable**. The Loan remains one canonical entity; it is never duplicated per property.

## Consequences

- The common single-property case is allocation = 100% to one `PropertyReference`.
- Property-level financing analytics derive from this one basis; no separate per-metric schemes in MVP.
- A future need for a materially different basis requires a superseding ADR (`AGENTS.md` §13).
- Unblocks roadmap Phase 3 (Financing).

---

# ADR-039 — Security Deposit Uses a Generic FinancialAccount with a Purpose Flag

**Status:** Accepted
**Resolves:** ADR-OPEN-006

## Context

Security Deposit is a dedicated domain (ADR-013). German law requires a deposit to be held separately from the landlord's assets and to bear interest (§ 551 BGB), but ADR-OPEN-006 asked to keep initial scope pragmatic and confirmed IBAN is an external identifier, not internal identity.

## Decision

`FinancialAccount` **remains generic**, carrying only an account **purpose/type flag** (e.g. `securityDeposit`). Deposit-specific facts — holder role, linkage to one or more rental relationships, and interest treatment — live in the **Security Deposit domain** (ADR-013), not as columns on `FinancialAccount`. Interest treatment is represented minimally (a flag) in the MVP; detailed interest accounting is deferred.

## Consequences

- The domain boundary between generic cash accounts and deposit semantics stays clean.
- Legal-separation and interest detail can grow in the Security Deposit domain without reshaping `FinancialAccount`.
- Unblocks roadmap Phase 5 (Security Deposit).

---

# ADR-040 — Investment Metric Snapshots Are Triggered On-Demand and at Year-End

**Status:** Accepted
**Resolves:** ADR-OPEN-007

## Context

Versioned `InvestmentMetricSnapshot`s are accepted (ADR-008); metrics are otherwise reproducible from source data (ADR-007). Aggressive automatic snapshotting (periodic, or on every material source change) adds moving parts against `AGENTS.md` §34 (avoid speculative architecture).

## Decision

Snapshots are created **on-demand** (explicit user action) and **automatically at tax-year end**. Periodic and change-triggered snapshotting are **deferred** and require a future ADR if a concrete need appears.

## Consequences

- MVP snapshot logic is minimal and predictable.
- Because live metrics are always derivable from source, the absence of frequent snapshots loses no truth.
- Unblocks the snapshot portion of roadmap Phase 9.

---

# ADR-041 — Country Rules Are Versioned Code Modules, Not a Generic Rule Engine

**Status:** Accepted
**Resolves:** ADR-OPEN-009

## Context

Article VII and ADR-022 require versioned, country-specific rules. ADR-OPEN-009 asked whether these are code-based, declarative, configuration-driven, or hybrid, and stated correctness and testability outrank configurability. `AGENTS.md` §34 explicitly lists "generic rule engines" as speculative architecture to avoid without concrete justification.

## Decision

German (and future country) rules are implemented as **versioned, unit-tested code modules (TypeScript)** — not a generic/declarative rule engine. Each RuleSet carries `legalBasis`, `effectiveFrom`, optional `effectiveTo`, `parameters`, `source/provenance`, and `version`, per the rule-representation schema in `docs/germany/taxation.md` §9. Rules are selected by applicability (date/jurisdiction) and every derived figure records the applied rule version.

## Consequences

- Rules are testable and explainable (constitution Art. III); each statutory change is a new versioned module, old versions preserved for reproducibility.
- No configuration language or engine to maintain.
- Unblocks roadmap Phase 7 (Taxation) and the German-rule parts of Phases 6/8.

---

# ADR-042 — Investment Formulas Are Versioned; Snapshots Pin Their Formula Version

**Status:** Accepted
**Resolves:** ADR-OPEN-010

## Context

Because snapshots are persisted (ADR-008), a later change to a metric formula must not silently alter or invalidate historical snapshots. This mirrors the rule-versioning approach in ADR-041.

## Decision

Each investment formula has an explicit **version id**. Every `InvestmentMetricSnapshot` **records the formula version(s)** used to produce it. Historical snapshots are **never silently recalculated**: a recalculation produces a **new snapshot** under the new formula version, and prior snapshots are preserved unchanged.

## Consequences

- Metric history stays comparable and reproducible (constitution Art. III).
- Formula evolution is deliberate and traceable, consistent with ADR-041.
- Unblocks the metric-formula portion of roadmap Phase 9.

---

# ADR-043 — Overlapping CSV Exports Dedupe by the Bank's Running Balance, Guarded by a Continuity Check

**Status:** Accepted
**Origin:** Real-data run #93, finding F1 (`docs/development/real-data-run.md`)

## Context

`data-model.md` §70 dedupes a re-imported row by a stable external transaction id or by its source-row identity (statement identity + row position). A real bank CSV export (BBBank, #93) has neither an id column nor a statement id: the file is its own statement identity (`contentHash`). Two monthly exports that overlap by a few days therefore share rows under **different** statement identities, and every shared row is an ambiguous cross-file match (§70.4) that a human resolves by hand. With real exports, overlap is the normal case, so the review queue fills with rows that are plainly the same booking.

The export does carry the account's **running balance after each booking** (`Saldo nach Buchung`). For one booking it is the same number in every export; two equal payments on the same day leave different balances. Four options were weighed: A (non-overlapping exports as a workflow rule), B (SEPA end-to-end reference as external id), C (balance-aware row identity), D (balance continuity check).

## Decision

1. **C — balance identity.** The `generic-csv` adapter gets an optional `balanceAfter` column (**version 2**). A row with a balance has the **balance identity** `(realm, financialAccountId, bookingDate, amount, direction, balanceAfter)`. It ranks between the stable external id and the fallback source-row identity (§70.1) and, like the external id, is **adapter-independent**. A balance-identity match is a duplicate **only with a matching content fingerprint** (§70.2); a match with other content is `needs_review`, never a duplicate.
2. **Never drop a payment.** A balance identity that occurs **more than once in one file** is not unique: none of those rows uses it, they keep the fallback identity. This is the risk case of C (below).
3. **D — continuity check.** Within a file, consecutive rows must chain: `balance before + signed amount = balance after`, in the file's own order (oldest-first or newest-first, detected). A file whose chain breaks uses **no** balance identity at all (every row on the fallback) and the batch reports the break. Across files, the oldest new row is checked against the account's known balances; a gap or an overlap that does not chain is **reported on the batch**, not refused.
4. **A and B are not adopted.** A stays a tip in the import guide, not a rule. B is left to a later adapter option: EREF covers direct debits only and is the external id's job anyway (§70.1).

## Risk analysis (C)

Two real bookings get the same balance identity only if they have the same day, amount, direction **and** balance after, i.e. the movements between them on that day sum to zero. Example: a direct debit, its return, the same debit again. Where both bookings can be seen:

- **Both in one file:** the identity repeats in the file → rule 2, both rows on the fallback, the cross-file match makes them `needs_review`. Nothing is dropped.
- **Only the first of them in an earlier file** (exported during that day): the next export that covers the day holds both, so its identity repeats in the file → first case; its first copy is not taken for the earlier one.
- **Only the second of them in a later file:** possible only for an export that starts inside that day instead of at a date boundary. Its chain closes on the balance before the first booking, so neither rule catches it; with the same description and counterparty, the second booking would be taken for the first.
- **Bank corrects a booking later** (other description, same balance): the content fingerprint differs → `needs_review`.

Residual risk: the last case. It needs an export cut inside a day, plus a debit, its return and the same debit again on that day with identical text. Bank exports are cut by booking date (BBBank: a date range), and the case was not observed. Accepted; the import guide says to export whole days, and a bank whose export cuts inside a day must not use the balance column.

## Consequences

- Overlapping exports of a bank with a balance column dedupe without review; the batch says whether the exports chain.
- `data-model.md` §70.1 gets the balance identity as priority 2 and §70.6 its rules and test cases; `api-design.md` §32.4 gets `generic-csv` v2 when it is implemented (backlog VC-1-11).
- Transactions imported with a balance store it (`sourceBalanceAfter`, raw bank value, not a ledger balance; DE never derives account balances from it).
- Rows imported under `generic-csv` v1 carry no balance: the first v2 import that overlaps them gives `needs_review` for the shared rows once (§70.4), as any adapter change does.
- A bank export without a balance column keeps the v1 behaviour.

## Rejected Alternatives

- **Balance as a mapped external id** (the #93 experiment): deduped the overlap, but takes a balance for a unique id with no in-file uniqueness rule and no chain check; the risk case above would silently drop a payment.
- **Only A (workflow):** period filters and late bookings make gaps and overlaps easy, and a gap would go unnoticed.

---

# Open Decisions

All decisions originally recorded here have been resolved (see the "Resolved by" status on each). The entries are retained as a historical record of the open questions and their resolutions. Should new architectural questions arise, add them here as `ADR-OPEN-*` with status `Open` until a resolving ADR is accepted.

---

# ADR-OPEN-001 — Storage Technology for New Domains

**Status:** Resolved by ADR-031

The DE Investment Layer uses a separate PostgreSQL datastore.

MRE retains its existing MongoDB persistence.

The systems integrate through APIs and explicit references rather than shared persistence.

---

# ADR-OPEN-002 — Application Process Structure

**Status:** Resolved by ADR-026

The initial DE Investment Layer is implemented as a modular monolith.

Domain boundaries remain mandatory; separate deployment boundaries require a demonstrated need and a future ADR.

---

# ADR-OPEN-003 — Party-to-MRE Identity Mapping

**Status:** Resolved by ADR-002A and ADR-009

The MRE deep dive established that Party mappings use stable external references with Realm context where applicable.

MRE Tenant identity is not treated as synonymous with one canonical Party.

Detailed persistence schema remains an implementation concern rather than an unresolved architecture decision.

---

# ADR-OPEN-004 — Confirmed Transaction Mutability

**Status:** Resolved by ADR-037

**Resolution:** Confirmed transactions are immutable (append-only); corrections use a linked reversal record plus a new corrected Transaction. Draft transactions remain editable. The original open question is retained below for context.

Question:

Should confirmed Ledger Transactions become technically append-only?

Possible strategies include:

- strict immutability
- reversible correction records
- controlled audited editing

Auditability must remain guaranteed.

---

# ADR-OPEN-005 — Shared Loan Allocation Basis

**Status:** Resolved by ADR-038

**Resolution:** One explicit percentage allocation per PropertyReference (summing to 100%), defaulted from financed purchase amount, user-overridable, applied uniformly to principal, interest, and remaining debt. The original open question is retained below for context.

`LoanAllocation` itself is accepted by ADR-014.

The original open question was which allocation basis should be used when one Loan finances or secures several PropertyReferences, particularly for:

- principal
- interest
- remaining debt
- financing cashflow

between PropertyReferences for property-level analytics?

Possible allocation bases may include:

- explicit percentage
- financed purchase amount
- collateral value
- user-defined allocation

The Loan itself must remain a single canonical entity.

---

# ADR-OPEN-006 — Security Deposit FinancialAccount Metadata

**Status:** Resolved by ADR-039

**Resolution:** FinancialAccount stays generic with a purpose/type flag (`securityDeposit`); deposit-specific facts live in the Security Deposit domain (ADR-013). Interest treatment is a minimal flag in the MVP. The original open question is retained below for context.

Security Deposit accounts use the canonical `FinancialAccount` entity.

The original open question was whether FinancialAccount requires specialized Security Deposit metadata for:

- deposit-holder role
- legal separation
- interest treatment
- multiple rental relationships

IBAN remains an external account identifier, not internal entity identity.

Initial scope should remain pragmatic.

---

# ADR-OPEN-007 — Metric Snapshot Persistence Strategy

**Status:** Resolved by ADR-040

**Resolution:** Snapshots are triggered on-demand and automatically at tax-year end; periodic and change-triggered snapshotting are deferred. The original open question is retained below for context.

The decision to store versioned Investment Metric Snapshots is accepted.

The original open question was how snapshots are triggered:

- periodic
- on-demand
- after material source-data changes
- at year-end
- combination

---

# ADR-OPEN-008 — Document Storage

**Status:** Resolved by ADR-035

Document binaries use a storage abstraction.

The initial/default implementation uses a local persistent filesystem volume, while canonical metadata remains in PostgreSQL.

Additional storage adapters may be introduced later without changing the domain model.

---

# ADR-OPEN-009 — Rule Engine Implementation

**Status:** Resolved by ADR-041

**Resolution:** Country rules are versioned, unit-tested code modules (TypeScript), not a generic rule engine, consistent with `AGENTS.md` §34. The original open question is retained below for context.

The need for versioned country rules is accepted.

The original open question was:

- code-based rule packages
- declarative rules
- configuration-driven rules
- hybrid approach

Correctness and testability are more important than configurability.

---

# ADR-OPEN-010 — Investment Formula Versioning

**Status:** Resolved by ADR-042

**Resolution:** Each formula carries a version id; every snapshot pins the formula version(s) used; historical snapshots are never silently recalculated (recalculation creates a new snapshot). The original open question is retained below for context.

Because metric snapshots are persisted, calculation formula changes need explicit versioning.

The platform must define how:

- formula versions
- historical snapshots
- recalculation

interact.

---

# Normative Integration Terminology

The following terminology is architectural, not stylistic:

| Meaning | Required Term |
|---|---|
| MRE rentable operational object | `Property` |
| DE reference to MRE Property | `PropertyReference` |
| Separate rentable sub-unit | Deferred; no MVP `Unit` |
| MRE reusable rental-term model | `Lease Definition` |
| DE reference to concrete MRE rental relationship | `RentalContractReference` |
| DE bank/cash account | `FinancialAccount` |
| Authenticated MRE user | `MRE Account` |
| MRE rent-state ↔ DE cash matching | `RentPaymentReconciliation` |
| DE canonical datastore | PostgreSQL |
| MRE operational datastore | existing MRE MongoDB |
| DE runtime | Node.js 24 LTS + TypeScript |
| Canonical monetary arithmetic | exact Decimal / Money abstraction |
| DE binary document storage | `DocumentStorage` abstraction |

DE-owned entities use `propertyReferenceId` rather than generic `propertyId`.

This terminology must remain aligned with the Domain Model, Data Model, Glossary and API Design.

---

# Decision Hierarchy

In case of conflict, project decisions should be interpreted using the canonical authority hierarchy (identical across `docs/constitution.md` governance, `docs/project-brief.md`, `AGENTS.md`, and `README.md`):

1. `docs/constitution.md` — Constitution
2. accepted decisions in `docs/architecture/architecture-decisions.md` — Accepted Architecture Decisions
3. `docs/architecture/domain-model.md` — Domain Model
4. `docs/architecture/data-model.md` — Data Model
5. `docs/glossary.md` — Glossary
6. `docs/architecture/api-design.md` — API Design
7. relevant domain- and product-specific specifications — including `docs/architecture/architecture-overview.md` and `docs/product/product-specification.md`
8. implementation documentation
9. existing code

For verified upstream MRE semantics, `docs/architecture/mre-integration.md` is the authoritative reference. This special authority never overrides the Constitution or any Accepted Architecture Decision; where a genuine conflict remains, do not silently choose an interpretation — `AGENTS.md` §33 (Stop Conditions) applies.

A lower-level entry must not silently violate a higher-level accepted decision.

---

# Amendment Rule

An Accepted ADR may be changed.

It must not simply be deleted or rewritten as though the previous decision never existed.

A replacement decision should:

- reference the superseded ADR
- explain why circumstances changed
- document migration consequences
- preserve historical reasoning

Suggested status progression:

```text
Proposed
    ↓
Accepted
    ↓
Deprecated
    ↓
Superseded
```

where appropriate.

---

# AI Contributor Instruction

AI coding agents working on this repository must treat all `Accepted` decisions as constraints.

They must not:

- redesign an accepted domain boundary without explicit instruction
- introduce duplicate financial state
- modify MRE core merely for implementation convenience
- convert derived metrics into manually editable state
- bypass human confirmation for AI suggestions
- add speculative complexity for unsupported edge cases
- reintroduce `Unit` into MVP domain logic
- treat MRE `Lease` as the concrete rental contract
- use generic DE `propertyId` instead of `propertyReferenceId`
- use `Account` for DE financial-account semantics
- merge MRE operational settlement state with DE canonical cash
- replace PostgreSQL with MRE MongoDB for DE canonical persistence without a superseding ADR
- introduce microservices merely to mirror domain boundaries
- use binary floating-point arithmetic for canonical Money calculations
- introduce a second independent username/password identity system for the integrated DE application
- make DE domain entities depend directly on local filesystem paths
- deeply modify MRE core when the capability can remain in the separate `vermieter-cockpit` repository

If an implementation appears to require violating an Accepted ADR, the agent should surface the conflict rather than silently implementing around it.

---

# Closing Principle

Architecture is not the collection of technologies used by the project.

Architecture is the collection of constraints that keep the system coherent as it evolves.

The purpose of these decisions is therefore not to prevent change.

It is to ensure that change remains deliberate.

> Extend before modifying.  
> Reference before duplicating.  
> Derive before storing.  
> Default before overriding.  
> Explain before automating.