# AGENTS.md

## Purpose

This file defines the operating rules for AI coding agents and automated contributors working on **Vermieter Cockpit DE**.

It is intentionally concise, normative, and implementation-oriented.

The repository contains detailed product, domain, architecture, and integration documentation. Agents must use those documents as the source of truth rather than inventing missing semantics from generic property-management knowledge.

The project is currently architecture-led. Correctness, maintainability, consistency, traceability, and compatibility with upstream MicroRealEstate (MRE) take priority over implementation speed.

---

# 1. Core Mission

Vermieter Cockpit DE extends MicroRealEstate with Germany-focused landlord, finance, tax, WEG, and investment capabilities.

The architectural direction is:

> Keep MicroRealEstate as the operational rental-management core, extend it through clearly separated modules and integration boundaries, and modify upstream MRE only where necessary.

Do not turn Vermieter Cockpit DE into:

- a replacement for MRE
- a generic ERP
- a generic bookkeeping system
- a full tax-advisory platform
- a speculative multi-country abstraction
- a new property-management platform built beside MRE

---

# 2. Mandatory Reading Order

Before making a significant change, read the relevant project documentation.

The canonical authority hierarchy (identical across `docs/project-brief.md`, `docs/architecture/architecture-decisions.md`, and `README.md`) is:

1. `docs/constitution.md` — Constitution
2. accepted decisions in `docs/architecture/architecture-decisions.md` — Accepted Architecture Decisions
3. `docs/architecture/domain-model.md` — Domain Model
4. `docs/architecture/data-model.md` — Data Model
5. `docs/glossary.md` — Glossary
6. `docs/architecture/api-design.md` — API Design
7. relevant domain- and product-specific specifications — including `docs/architecture/architecture-overview.md` and `docs/product/product-specification.md`
8. implementation documentation
9. existing code

For verified upstream MRE semantics, `docs/architecture/mre-integration.md` is the authoritative reference. This special authority never overrides the Constitution or any Accepted Architecture Decision; where a genuine conflict remains, do not silently choose an interpretation — §33 (Stop Conditions) applies.

The implementation does not override an explicit accepted architecture decision merely because existing code differs.

If documents conflict, do not silently choose one interpretation. Follow the hierarchy above and report the inconsistency if it remains material.

---

# 3. Read by Change Type

Do not read every document mechanically for every small change. Read the documents relevant to the task.

## Any domain-model change

Read:

- `docs/constitution.md`
- `docs/glossary.md`
- `docs/architecture/architecture-decisions.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/data-model.md`

## Any MRE integration change

Read:

- `docs/architecture/mre-integration.md`
- `docs/architecture/architecture-overview.md`
- `docs/architecture/architecture-decisions.md`
- `docs/architecture/api-design.md`
- relevant MRE source code

Never infer MRE semantics from generic real-estate terminology.

## Any financial-ledger change

Read:

- `docs/architecture/domain-model.md`
- `docs/architecture/data-model.md`
- `docs/architecture/api-design.md`
- relevant financial ADRs

## Any German tax, depreciation, WEG, rent, or operating-cost change

Read the relevant document under:

`docs/germany/`

and the applicable domain/data-model sections.

If the relevant Germany-specific document is still a placeholder, do not invent detailed legal or tax rules merely to complete an implementation.

## Any public API change

Read:

- `docs/architecture/api-design.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/data-model.md`
- relevant ADRs

## Any architecture-level change

Read:

- `docs/constitution.md`
- `docs/architecture/architecture-overview.md`
- `docs/architecture/architecture-decisions.md`

Architecture changes may require a new ADR before implementation.

---

# 4. MRE Is the Operational Core

MicroRealEstate remains authoritative for operational rental management.

Do not duplicate MRE-owned operational concepts inside the DE Investment Layer merely for convenience.

The inspected MRE model has specific semantics that must be preserved.

## Canonical MRE terminology

### Property

`Property` means the MRE-owned rentable operational object.

For the initial condominium use case, the MRE Property represents the apartment being rented and operationally managed.

DE domains reference it through:

`PropertyReference`

DE-owned entities should use:

`propertyReferenceId`

Raw upstream identity is represented as:

`mrePropertyId`

Do not introduce a generic DE `propertyId` when the intended identifier is a PropertyReference.

### Unit

There is no canonical separate Unit entity in the inspected MRE core.

The MVP must not introduce:

- `Unit`
- `UnitReference`
- `unitId`
- `unitIds`

merely to recreate the obsolete generic hierarchy.

If future requirements genuinely need a building/sub-asset hierarchy, stop and treat that as an architecture decision.

### Tenant

MRE `Tenant` is the central operational record for the concrete rental relationship.

Do not assume:

`MRE Tenant == canonical Party`

A Tenant may contain or reference occupants, Properties, rental state, payment state, and a Lease Definition.

DE identity requirements use `Party` plus explicit external mappings.

### Lease

MRE `Lease` is primarily a reusable rental-term/configuration model.

The canonical project term is:

`Lease Definition`

It is not the complete concrete tenant contract.

DE domains reference the concrete MRE rental relationship through:

`RentalContractReference`

Use:

`rentalContractReferenceId`

Do not introduce a generic DE `leaseId` for the concrete rental relationship.

### MRE Account

MRE `Account` means an authenticated application user.

It must never be confused with a bank or cash account.

DE financial accounts use:

`FinancialAccount`

---

# 5. Preserve the MRE Integration Boundary

The MRE integration layer is an anti-corruption layer.

Important integration concepts include:

- `PropertyReference`
- `RentalContractReference`
- Party external mappings
- `RentPaymentReconciliation`

Do not leak raw MRE persistence structures throughout DE domains.

Do not copy entire MRE entities into DE-owned collections merely to simplify queries.

References may contain deliberately cached, non-authoritative display data where the data model permits it.

MRE identifiers must include Realm context where required.

Historical DE records must not become invalid merely because an upstream MRE entity is later deleted or unavailable.

---

# 6. Do Not Modify Upstream MRE Without Justification

Prefer:

1. extension modules
2. integration adapters
3. additive APIs
4. independent DE persistence
5. composition around MRE

over direct modification of upstream MRE.

A direct MRE modification is acceptable only when the requirement cannot reasonably be implemented through the extension architecture.

Before making a significant upstream modification:

1. identify why the extension boundary is insufficient
2. check relevant ADRs
3. describe the required upstream change
4. assess upgrade/merge impact
5. keep the patch as small as possible

Do not casually refactor upstream MRE code to match DE coding preferences.

---

# 7. Canonical Financial Ledger

The DE Financial Ledger is the canonical source for actual cash movement.

The ledger is **cash-only**.

A `Transaction` represents actual cash movement.

Do not create Transactions for:

- forecasts
- expected rent
- depreciation
- valuations
- amortization schedules
- planned payments
- tax calculations
- WEG estimates
- scenario projections
- generated schedules

Non-cash concepts belong to their respective domains.

---

# 8. MRE Settlement Is Not Cash Truth

Keep these concepts distinct:

```text
MRE Rent Obligation
        │
        ▼
MRE Operational Settlement State
        │
        │ reconciliation
        ▼
DE Ledger Transaction
```

MRE operational payment state must not silently become a DE Transaction.

A DE Transaction must not silently rewrite MRE settlement state.

Use:

`RentPaymentReconciliation`

to connect the two.

Automated matching may create suggestions where supported.

Confirmation and MRE write-back must remain explicit and auditable according to the API and domain rules.

---

# 9. Transaction Splits Are First-Class

Do not duplicate a bank transaction merely because one cash movement has several economic meanings.

Use `TransactionSplit`.

Examples include:

- loan payment → interest + principal
- WEG payment → operating cost + reserve + administration
- mixed invoice → repair + improvement
- mixed tax treatment

Preserve:

`sum(TransactionSplit.amount) == Transaction.amount`

subject to the exact rounding and sign rules defined by the data model.

---

# 10. FinancialAccount Is Not Loan

`FinancialAccount` represents a source or destination of cash movement.

Examples:

- bank account
- Security Deposit account
- supported cash account

A `Loan` is a financing-domain entity.

Do not turn a Loan into a FinancialAccount merely because a bank provides a loan account number.

Cash payments related to a Loan are represented by Ledger Transactions and linked to the financing domain as defined by the model.

---

# 11. Acquisition Is a First-Class Aggregate

Do not attach acquisition-specific facts directly to MRE Property merely for convenience.

`Acquisition` is its own Aggregate Root.

It may contain or coordinate:

- purchase price
- acquisition date
- transaction costs
- acquisition-cost classification
- land/building allocation inputs
- financing relationships
- source references

The DE-side real-estate relationship is through `PropertyReference`.

---

# 12. Ownership Is Temporal

Ownership must support changes over time.

Do not model ownership as a static owner field on Property.

Use the canonical `Ownership` model.

For the current product scope, legal ownership shares are also the canonical basis for owner-level allocation of income, expenses, and tax interpretation.

Do not invent separate economic or tax ownership percentages unless a future accepted ADR explicitly introduces them.

---

# 13. Shared Loans Must Remain Canonical

One Loan may finance or secure multiple PropertyReferences.

Do not duplicate a Loan per Property.

Use:

`LoanAllocation`

for property-level allocation.

If the task requires choosing a new allocation basis for principal, interest, remaining debt, or another financing metric and the accepted documentation does not define it, stop and surface the open decision rather than inventing a rule.

---

# 14. Security Deposit

Security Deposit is a dedicated domain concept.

Use:

- `RentalContractReference`
- expected amount
- payer Party where applicable
- holding `FinancialAccount`
- actual receipt Transaction references
- actual repayment Transaction references
- relevant dates
- reconciliation state

MRE `Tenant.guaranty` and `guarantyPayback` are operational rental-management values.

They are not canonical evidence that cash moved.

Security Deposit is not Rental Income.

---

# 15. WEG Is a Dedicated Domain

German condominium ownership concepts must not be embedded directly into generic MRE Property structures.

The WEG domain may contain concepts such as:

- WEG
- WEG Membership
- Wirtschaftsplan
- Jahresabrechnung
- WEG Cost Line
- Erhaltungsrücklage
- Sonderumlage

Property relationships use `PropertyReference`.

Do not flatten WEG statements directly into Ledger Transactions without preserving statement structure and provenance where the model requires it.

---

# 16. Tax Is Interpretation, Not Cash

Tax classifications interpret financial or economic facts.

They do not replace those facts.

Keep separate:

```text
Transaction
        ↓
TransactionSplit
        ↓
Tax Classification
```

Do not encode tax meaning by mutating raw transaction data.

Do not hardcode German tax rules as unexplained constants.

Time-dependent rules should be versioned and carry applicability/provenance where required.

If a tax rule is legally material and not specified in project documentation, do not guess it.

---

# 17. Depreciation Is Derived

Depreciation schedules are derived from canonical acquisition and allocation inputs.

Do not store depreciation as fake cash movement.

Do not overwrite acquisition truth to make a depreciation calculation easier.

Calculation logic should be reproducible and version-aware where rules may change.

---

# 18. Investment Metrics Are Derived

Metrics such as:

- NOI
- cashflow
- equity
- LTV
- Cash-on-Cash Return
- IRR
- remaining debt
- portfolio performance

are derived results.

Do not make them editable canonical truth.

`InvestmentMetricSnapshot` may persist a historical calculated result for comparison and auditability.

A snapshot must retain enough calculation metadata to remain understandable and reproducible.

---

# 19. Actuals and Scenarios Must Stay Separate

Never overwrite actual financial or operational data with scenario assumptions.

Use explicit scenario models.

Examples of scenario assumptions:

- future rent
- vacancy
- interest rates
- refinancing
- appreciation
- maintenance
- exit price
- operating-cost growth

Scenario calculations may reference actual data as a starting point, but scenario output remains interpretive.

---

# 20. Money and Precision

Never use binary floating-point types for monetary persistence or domain calculations.

Use the project's approved decimal/money representation.

Every monetary value must have clear currency semantics.

Do not silently mix currencies.

Rounding must be deliberate and testable.

The canonical money representation is already decided (ADR-033 / TECH-ADR-004): a Money value object backed by exact decimal arithmetic, persisted as PostgreSQL `NUMERIC`, serialized as a decimal string plus currency. The concrete decimal library is an implementation-level choice, but it must preserve exact decimal semantics — do not substitute a representation that conflicts with this decision.

---

# 21. Dates and Time

Use explicit domain dates where business meaning is date-based.

Examples:

- acquisition date
- ownership validity
- tax year
- rent period
- valuation date
- depreciation start
- statement period

Do not replace domain dates with generic timestamps.

Use timestamps for technical events such as:

- createdAt
- updatedAt
- importedAt
- reconciledAt

Validity periods should follow the domain model and data model.

---

# 22. Provenance and Auditability

Financial, tax, WEG, and investment interpretations should be traceable to source data wherever practical.

Preserve relevant provenance such as:

- external identifiers
- MRE Realm and entity references
- bank import identifiers
- document references
- source statement references
- calculation versions
- rule versions
- timestamps
- actor/user identity where applicable

Do not destroy source information merely because normalized data is easier to query.

---

# 23. Idempotency

Import, reconciliation, and command workflows that may be retried must respect the idempotency strategy defined by the API design.

Do not implement retryable write flows that can silently create duplicate financial records.

Examples requiring particular care:

- bank transaction import
- MRE synchronization
- reconciliation confirmation
- document processing
- external webhook/event processing where introduced

---

# 24. Concurrency

Respect versioning and optimistic-concurrency rules defined by the API and data model.

Do not silently overwrite concurrent financial or classification changes.

Conflicts should be explicit.

---

# 25. API Design

The business API is not generic CRUD.

Prefer business commands that express domain intent.

Examples:

- import transactions
- classify transaction
- split transaction
- confirm reconciliation
- create acquisition
- allocate loan
- create valuation
- calculate scenario

Do not expose persistence structures merely because doing so is easier.

Do not bypass domain invariants through generic update endpoints.

---

# 26. Domain Boundaries

Maintain clear boundaries among:

- MRE Integration
- Party & Ownership
- Acquisition
- Financial Ledger
- Financing
- Security Deposit
- WEG
- Taxation
- Depreciation
- Investment
- Reporting / Analytics

Avoid direct cross-domain database access where a domain service, reference, command, query, or adapter is the intended boundary.

Do not create a giant shared service containing business logic from multiple domains.

---

# 27. Naming Is Architectural

Use terminology from:

`docs/glossary.md`

Canonical examples:

| Meaning | Required term |
|---|---|
| MRE rentable object | `Property` |
| DE reference to MRE Property | `PropertyReference` |
| MRE reusable rental-term model | `Lease Definition` |
| DE concrete-rental reference | `RentalContractReference` |
| DE bank/cash account | `FinancialAccount` |
| MRE authenticated user | `MRE Account` |
| MRE rent-state ↔ cash link | `RentPaymentReconciliation` |

Do not introduce synonyms casually.

Avoid ambiguous names such as:

- `Object`
- `Asset` when PropertyReference is intended
- `Account` when FinancialAccount is intended
- `Lease` when RentalContractReference is intended
- `propertyId` when propertyReferenceId is intended

If a new domain term is necessary, update the Glossary as part of the same architectural change.

---

# 28. Database Changes

Do not change persistence schemas without checking:

- `docs/architecture/data-model.md`
- relevant aggregate boundaries
- invariants
- migration impact
- compatibility with existing data

Schema changes must include an appropriate migration strategy once persistence technology and migration tooling are established.

Do not solve modeling uncertainty by storing arbitrary unstructured blobs unless explicitly justified.

---

# 29. Testing Expectations

Business invariants require tests.

At minimum, tests should cover applicable cases such as:

- ownership shares
- transaction split totals
- reconciliation uniqueness
- idempotent imports
- shared-loan allocation integrity
- Security Deposit cash references
- actual/scenario separation
- calculation reproducibility
- date validity
- monetary precision
- authorization / Realm isolation where applicable

Bug fixes should normally include a regression test.

Do not weaken or delete tests merely to make a change pass.

---

# 30. German Legal and Tax Logic

Treat German legal, tax, depreciation, and WEG logic as high-sensitivity domain logic.

Do not fabricate rules.

Do not assume a rule is timeless.

Do not encode a legal interpretation without a source/provenance strategy where the architecture requires one.

Where project documentation intentionally leaves a rule unresolved, surface the gap.

The application supports landlord administration and tax preparation. It is not a substitute for legal or tax advice.

---

# 31. Documentation Is Part of the Change

Update documentation when a code change alters:

- domain semantics
- canonical terminology
- API contracts
- persistence models
- architecture boundaries
- MRE integration behavior
- calculation definitions
- important workflows

Do not update documentation merely to rationalize an implementation that violates accepted architecture.

If a code change requires an architecture decision to change, update or add the ADR first.

---

# 32. Architecture Decision Rule

Create or update an ADR when a change:

- changes domain ownership
- introduces a new Aggregate Root
- changes source-of-truth semantics
- changes MRE integration boundaries
- introduces a major infrastructure dependency
- changes persistence strategy
- introduces a new canonical identity model
- changes financial-ledger semantics
- changes cross-domain communication architecture
- reverses an accepted decision

Do not create ADRs for trivial implementation details.

---

# 33. Stop Conditions

Stop and surface the issue instead of inventing a solution when:

- two authoritative documents materially conflict
- an implementation requires violating an accepted ADR
- the task requires a new domain concept not covered by the model
- a new Unit/building hierarchy appears necessary
- a new shared-loan allocation rule is required but undefined
- a German legal or tax rule is required but unspecified
- canonical ownership semantics would need to change
- MRE would need a substantial upstream modification
- a source-of-truth boundary would need to change
- the task would require silently losing financial provenance
- the requested behavior could create duplicate or fabricated cash records

When stopping, explain:

1. the blocking issue
2. the relevant existing rule
3. the smallest decision needed to proceed
4. reasonable options if they are clear from the existing architecture

Do not expand the scope unnecessarily.

---

# 34. Avoid Speculative Architecture

Do not add infrastructure or abstractions because they might someday be useful.

Examples requiring concrete justification include:

- event buses
- CQRS frameworks
- event sourcing
- generic rule engines
- plugin frameworks
- multi-country tax abstractions
- generic accounting engines
- complex asset hierarchies
- microservice decomposition
- additional databases
- distributed caches

Prefer the simplest architecture consistent with accepted requirements.

---

# 35. Maintainability

Maintainability is a primary project value.

Prefer:

- explicit code
- cohesive modules
- small interfaces
- domain-specific names
- deterministic calculations
- documented invariants
- narrow dependencies
- reversible technical decisions
- straightforward tests

Avoid:

- hidden side effects
- clever metaprogramming
- unexplained abstractions
- broad shared utility layers containing business semantics
- duplicated domain rules
- magic constants
- undocumented coupling

---

# 36. Scope Discipline

When implementing a task:

1. inspect the relevant code and documentation
2. identify the smallest coherent change
3. implement it
4. add/update tests
5. update directly affected documentation
6. run relevant checks
7. summarize the result

Do not opportunistically refactor unrelated areas.

Do not convert a focused task into a repository-wide rewrite.

---

# 37. Before Finishing a Change

Before presenting work as complete, verify as applicable:

- relevant tests pass
- lint/type checks pass
- formatting passes
- no obsolete canonical terminology was introduced
- no duplicate source of truth was created
- financial invariants still hold
- MRE boundaries remain respected
- documentation references remain valid
- migrations are included where required
- no `.DS_Store` or unrelated generated files were added
- the diff contains no unrelated changes

If a check cannot be run, state that clearly.

---

# 38. Change Summary

For non-trivial changes, provide a concise summary containing:

- what changed
- why
- important design decisions
- tests/checks run
- documentation updated
- migrations, if any
- unresolved issues or follow-up decisions

Do not claim checks passed unless they were actually run.

---

# 39. Repository-Specific Principle

The safest default when uncertain is:

> **Preserve MRE operational ownership, preserve DE canonical financial truth, preserve provenance, and avoid inventing new architecture.**

If a proposed shortcut violates one of those principles, it is probably the wrong shortcut.
