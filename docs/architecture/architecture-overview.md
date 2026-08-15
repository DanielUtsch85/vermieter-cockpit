# Architecture Overview

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.1  
**Status:** Living Document

---

# 1. Purpose

This document describes the high-level system architecture of Vermieter Cockpit DE.

It defines

- the architectural role of MicroRealEstate
- the major application domains
- system boundaries
- data ownership
- allowed and prohibited dependencies
- high-level data flows
- extension principles
- deployment principles
- architectural constraints

This document intentionally does **not** define

- database schemas
- collection structures
- concrete API endpoints
- UI component details
- exact technology choices for new modules

Those concerns are specified in dedicated documents.

---

# 2. Architectural Objective

Vermieter Cockpit DE shall extend an existing open-source rental management platform into a financial operating system for residential real estate investors.

The architecture must support four distinct perspectives of the same property:

1. Rental Operations
2. Financial Reality
3. Tax Interpretation
4. Investment Analysis

These perspectives must remain logically separate while sharing the same underlying source data.

The architecture therefore follows one central rule:

> Operational events create facts.  
> Financial systems record facts.  
> Tax systems interpret facts.  
> Investment systems analyze facts.  
> Reporting systems present facts.

Higher-level domains must not silently rewrite lower-level facts.

---

# 3. Architectural Foundations

The architecture is governed by the project Constitution.

The most relevant principles are:

- Single Source of Truth
- Extension over modification
- Explicit domain boundaries
- Long-term maintainability
- Transparency
- Reproducibility
- Human review of AI-generated proposals
- Self-hosting
- Modular country-specific logic

---

# 4. MicroRealEstate as Upstream Core

MicroRealEstate (MRE) is the operational rental-management foundation of the platform.

MRE already provides capabilities such as

- landlord interface
- tenant interface
- authentication
- property management
- tenant management
- lease management
- rental payment tracking
- document generation
- email communication
- REST APIs
- PDF generation
- Docker-based deployment

The project shall reuse these capabilities rather than reimplement them.

---

# 5. Upstream Preservation Principle

MicroRealEstate should remain as close to upstream as reasonably possible.

The project shall prefer:

1. extension
2. integration
3. adapter layers
4. additional services
5. additional UI modules

before modifying existing MRE functionality.

Direct modifications to MRE core components should only be introduced when one of the following applies:

- an extension is technically impossible
- the upstream implementation contains a defect
- a required integration point does not exist
- a generic improvement can reasonably be contributed upstream

Changes should never be made merely because modifying upstream code appears faster in the short term.

---

# 6. High-Level Architecture

The platform consists of two conceptual layers:

```text
┌──────────────────────────────────────────────────────────────┐
│                    Vermieter Cockpit DE                      │
│                                                              │
│  ┌──────────────────────┐   ┌─────────────────────────────┐  │
│  │    MRE CORE          │   │     DE INVESTMENT LAYER     │  │
│  │                      │   │                             │  │
│  │ Property Management  │   │ Financial Ledger            │  │
│  │ Units                │   │ Financing                   │  │
│  │ Tenants              │   │ WEG                         │  │
│  │ Leases               │   │ Taxation                    │  │
│  │ Rent Tracking        │   │ Depreciation                │  │
│  │ Documents            │   │ Investment                  │  │
│  │ Communication        │   │ Reporting                   │  │
│  │ Tenant Portal        │   │ Automation                  │  │
│  │                      │   │ AI Assistance               │  │
│  └──────────────────────┘   └─────────────────────────────┘  │
│               │                           │                  │
│               └────────── Integration ────┘                  │
└──────────────────────────────────────────────────────────────┘
```

MRE manages rental operations.

The DE Investment Layer manages the financial and investment lifecycle of the property.

---

# 7. Architectural Domains

The architecture is divided into explicit business domains.

Each domain owns a clearly defined set of concepts and responsibilities.

---

# 8. Property Management Domain

## Owner

MicroRealEstate.

## Responsibilities

The domain owns operational rental-management concepts including:

- properties
- rental units
- tenants
- leases
- recurring rent obligations
- tenant communication
- lease-related documents
- rent payment status

## Architectural Rule

Other modules may reference property-management entities.

They must not create parallel copies of those entities.

---

# 9. Financial Ledger Domain

## Purpose

The Financial Ledger represents the financial truth of the platform.

## Responsibilities

It owns:

- financial transactions
- transaction splits
- bank-imported entries
- manual financial entries
- transaction categorization
- payment matching
- receipt associations
- transaction status

## Core Principle

Every real-world financial event should ultimately be represented by exactly one canonical financial transaction.

---

# 10. Transaction Split Architecture

A financial transaction may contain multiple economically different components.

Examples include:

### Loan payment

```text
Loan Payment
├── Interest
└── Principal
```

### WEG payment

```text
Hausgeld
├── Recoverable operating expenses
├── Non-recoverable expenses
└── Reserve contribution
```

Therefore the Financial Ledger must support first-class transaction splitting.

Derived domains operate on transaction splits rather than forcing one classification onto an entire bank movement.

---

# 11. Financing Domain

## Purpose

Represent debt contracts and their evolution over time.

## Responsibilities

The Financing domain owns:

- loans
- loan terms
- interest rates
- repayment schedules
- fixed-interest periods
- special repayments
- refinancing events
- calculated remaining debt

## Relationship to Financial Ledger

The Financing domain predicts expected debt-service transactions.

The Financial Ledger records actual payments.

The system may reconcile expected and actual payments.

Neither system duplicates the other's responsibility.

---

# 12. WEG Domain

## Purpose

Represent German condominium ownership and related financial structures.

## Responsibilities

The domain owns:

- WEG-specific property information
- administrator information
- ownership shares
- Wirtschaftspläne
- Jahresabrechnungen
- reserve information
- special assessments
- cost allocation information

## Architectural Constraint

WEG-specific rules belong outside the generic MRE core.

They must not be embedded inside generic property-management entities unless required for a reference.

---

# 13. Taxation Domain

## Purpose

Interpret existing economic events under tax rules.

## Responsibilities

It owns:

- tax classifications
- tax rule references
- tax periods
- ownership-related tax allocation
- tax review state
- tax reporting metadata

## Critical Rule

The Taxation domain does not create financial transactions.

It interprets financial transactions and related acquisition data.

---

# 14. Depreciation Domain

Depreciation is closely related to taxation but sufficiently important to be modeled explicitly.

## Responsibilities

It owns:

- depreciable assets
- acquisition-cost basis
- land/building allocation
- depreciation start dates
- depreciation methods
- depreciation schedules
- historical calculation versions

## Architectural Principle

A depreciation result must always be reproducible from its stored inputs and applicable rule set.

---

# 15. Investment Domain

## Purpose

Interpret operational and financial facts from the perspective of an investor.

## Responsibilities

The domain calculates:

- cashflow
- NOI
- equity
- leverage
- Loan-to-Value
- Cash-on-Cash Return
- internal rate of return
- debt-service metrics
- investment performance
- portfolio performance
- scenario projections

## Critical Rule

Investment metrics are derived.

They do not become independent sources of financial truth.

---

# 16. Reporting Domain

## Purpose

Transform domain data into human-readable outputs.

## Responsibilities

- dashboards
- summaries
- CSV exports
- PDF reports
- tax-advisor packages
- portfolio reports

## Architectural Rule

Reporting contains presentation logic.

It must not own business calculations that belong to another domain.

For example:

Incorrect:

```text
Dashboard calculates remaining debt.
```

Correct:

```text
Financing calculates remaining debt.
Dashboard displays remaining debt.
```

---

# 17. Automation Domain

## Purpose

Automate deterministic repetitive processes.

Examples include:

- recurring transaction creation
- bank matching rules
- payment reconciliation
- reminder generation
- document generation
- scheduled reporting

Automation should call existing domain capabilities.

It must not implement competing business logic.

---

# 18. AI Assistance Domain

## Purpose

Provide probabilistic assistance where deterministic automation is insufficient.

Possible capabilities:

- transaction categorization suggestions
- receipt classification suggestions
- document summaries
- anomaly explanations
- investment commentary
- suggested mappings

## Architectural Boundary

AI output is advisory state.

AI-generated suggestions must remain separate from canonical business data until confirmed.

Example:

```text
Bank Transaction
       │
       ▼
AI Suggestion
       │
       ▼
User Review
       │
       ▼
Canonical Classification
```

Direct AI-to-ledger writes are prohibited.

---

# 19. Layered Dependency Model

The application follows a directional dependency model.

```text
PROPERTY OPERATIONS
        │
        ▼
FINANCIAL FACTS
        │
        ├─────────────┐
        ▼             ▼
    TAXATION       FINANCING
        │             │
        └──────┬──────┘
               ▼
          INVESTMENT
               │
               ▼
           REPORTING
```

AI and Automation operate alongside these layers and interact only through explicit interfaces.

---

# 20. Dependency Rules

Allowed dependency examples:

```text
Financial Ledger → Property reference

Taxation → Financial Ledger

Investment → Financial Ledger

Investment → Financing

Reporting → Investment

Reporting → Taxation

Automation → Financial Ledger API
```

Prohibited dependency examples:

```text
Financial Ledger → Investment metrics

Property Management → Tax rules

MRE tenant model → German depreciation logic

Reporting → writes to ledger

AI Assistant → directly changes financial records

Investment → modifies tax classification
```

---

# 21. Domain Ownership Rule

Every mutable business concept must have exactly one authoritative owner.

Examples:

| Concept | Owner |
|---|---|
| Tenant | MRE Property Management |
| Lease | MRE Property Management |
| Transaction | Financial Ledger |
| Loan | Financing |
| WEG Statement | WEG |
| Tax Classification | Taxation |
| Depreciation Schedule | Depreciation |
| Investment Scenario | Investment |

Other domains store references, not competing copies.

---

# 22. Integration with MRE

Integration should preferably occur through stable interfaces.

Preferred integration order:

1. existing MRE API
2. explicit new internal API
3. shared identifier/reference
4. upstream-compatible extension
5. direct MRE code modification as last resort

New modules should not read undocumented internal MRE database structures when a service interface can reasonably be used.

---

# 23. Service-Oriented Extension Strategy

MRE already uses separate backend services and frontend applications.

New major domains should therefore preferably be implemented as clearly isolated services or modules.

A conceptual future service structure may resemble:

```text
services/
├── gateway/
├── authenticator/
├── api/
├── tenantapi/
├── emailer/
├── pdfgenerator/
│
├── finance/
├── financing/
├── weg/
├── tax-de/
├── investment/
├── reporting/
└── automation/
```

This structure is conceptual.

The final service boundaries should be chosen based on domain cohesion rather than creating unnecessary microservices.

---

# 24. Modular Monolith vs. Microservices

The project must not adopt microservices merely because MRE contains multiple services.

Long-term maintainability is more important than architectural fashion.

New domains may initially be implemented as a modular backend application if this reduces operational complexity.

The deciding principle is:

> Domain boundaries are mandatory.  
> Process boundaries are optional.

A clean modular monolith is preferable to poorly separated microservices.

---

# 25. Data Storage Strategy

The platform should not require all domains to use a single physical database.

However, each domain must clearly own its data.

Direct cross-domain database writes are prohibited.

Preferred interaction occurs through:

- service interfaces
- domain APIs
- explicitly versioned events
- controlled shared identifiers

Whether new domains use the existing MRE MongoDB infrastructure or a separate datastore remains an implementation decision.

---

# 26. Financial Immutability

Financial records require stronger integrity guarantees than ordinary application data.

The architecture should prefer correction workflows over silent historical mutation.

For example:

Instead of:

```text
Edit historical transaction amount
```

prefer:

```text
Original transaction
+
Correction / adjustment
```

The exact immutability policy will be defined later.

The architecture must nevertheless preserve auditability.

---

# 27. Temporal Data

Many relevant facts change over time.

Examples:

- ownership percentages
- interest rates
- leases
- tax rules
- WEG allocations
- market values
- property use

Where historical correctness matters, data should be modeled with validity periods rather than replacing historical state.

Example:

```text
Ownership

Owner A
50 %
valid from 2026-08-01
valid until open
```

Historical reports must remain reproducible.

---

# 28. Rule Engine Principle

German legal and tax logic must not be hardcoded indiscriminately into generic domain code.

Country-specific rules should be represented through explicit, versioned rule sets where practical.

Conceptually:

```text
Rule
├── jurisdiction
├── category
├── valid_from
├── valid_until
├── version
├── implementation
└── source_reference
```

Historic calculations must continue to use the rule version applicable at the relevant date.

---

# 29. Auditability

Every economically relevant derived result should support traceability.

For example:

```text
Cash-on-Cash Return
        │
        ├── Cashflow
        │     ├── Rent transactions
        │     ├── Operating expenses
        │     └── Debt service
        │
        └── Invested Equity
              ├── Purchase price
              ├── Acquisition costs
              └── Initial financing
```

The user should be able to move from a calculated metric back to the underlying source data.

---

# 30. Event Provenance

Financial and business facts should record their provenance where relevant.

Possible provenance types include:

- manual entry
- bank CSV import
- API import
- MRE event
- generated schedule
- user-approved AI suggestion
- migration
- correction

This supports transparency and debugging.

---

# 31. UI Architecture

The existing MRE landlord interface should remain the primary operational interface where practical.

New sections may be introduced for:

```text
Rental
├── Properties
├── Tenants
├── Leases
└── Rent

Finance
├── Transactions
├── Loans
├── WEG
└── Documents

Tax
├── Acquisition
├── Depreciation
├── Classifications
└── Annual Reports

Investment
├── Dashboard
├── Performance
├── Financing
└── Scenarios
```

Business logic must remain outside UI components.

---

# 32. API Architecture

All major business operations should ultimately be accessible through explicit programmatic interfaces.

This enables:

- frontend independence
- automation
- testing
- AI assistance
- future mobile applications
- external integrations

APIs should expose business capabilities, not raw database access.

Example:

Preferred:

```text
POST /transactions/{id}/classify
```

rather than:

```text
PATCH arbitrary database fields
```

Concrete API design is defined separately.

---

# 33. Document Architecture

Documents may originate from different domains.

Examples:

- lease documents
- invoices
- WEG statements
- loan documents
- tax evidence
- maintenance receipts

Documents should be referenced through shared metadata rather than duplicated across modules.

A single document may have multiple domain relationships.

Example:

```text
Invoice.pdf
├── Property
├── Transaction
├── Maintenance Project
└── Tax Year
```

---

# 34. Reporting Architecture

Reports must be generated from canonical domain data at request time or through reproducible snapshots.

Reports must never become the only location where financial calculations exist.

Export formats should favor openness and longevity.

Preferred formats include:

- CSV
- JSON
- PDF
- other documented standard formats

---

# 35. External Integrations

Future integrations may include:

- banks
- tax software
- market-data providers
- document storage
- OCR providers
- email systems
- calendars

External systems must be accessed through adapter boundaries.

Vendor-specific logic must not leak into core business domains.

---

# 36. Self-Hosting Architecture

Self-hosting is a first-class requirement.

The application should support containerized deployment.

A typical deployment may consist of:

```text
Reverse Proxy / Gateway
        │
        ├── Landlord UI
        ├── Tenant UI
        │
        ├── MRE Services
        ├── DE Investment Services
        │
        ├── Database(s)
        └── Document Storage
```

Deployment should remain understandable by technically capable private users.

---

# 37. Backup and Portability

The architecture must allow complete backups of:

- application data
- financial records
- documents
- configuration
- rule versions

Recovery procedures must be documented.

A user should be able to move the application to another compatible environment without losing domain information.

---

# 38. Security Principles

Financial and tenant information is sensitive.

The architecture must therefore support:

- authentication
- authorization
- least privilege
- encrypted transport
- secure secret management
- audit trails for critical actions
- protected financial operations

Security requirements will be specified separately.

---

# 39. Multi-User Architecture

The system should support more than one participant.

Examples:

- co-owner
- spouse
- tax advisor
- administrator

Permissions should ultimately be role-based and domain-aware.

Possible future examples:

```text
Owner
Full access

Co-Investor
Own-property access

Tax Advisor
Read access to tax and financial reports

Tenant
Tenant-specific operational access
```

---

# 40. Portfolio Architecture

The architecture must support one property first but must not assume that only one property exists.

Core financial entities therefore require explicit property relationships where applicable.

Future portfolio aggregation must be possible without redesigning the ledger.

---

# 41. Scenario Architecture

Forecasts and scenarios represent hypothetical state.

They must never overwrite actual state.

The system must distinguish:

```text
Actual

Plan

Forecast

Scenario
```

Investment scenarios should reference real base data and apply isolated assumptions.

---

# 42. Plan vs. Actual

The platform should eventually support comparison between:

- acquisition assumptions
- operating plans
- actual results

Architecturally, planning data must remain distinct from canonical actual transactions.

Example:

```text
Expected Maintenance 2028: 1,500 €

Actual Maintenance 2028: 2,300 €
```

Both values are useful.

They are not the same kind of fact.

---

# 43. Observability

New services and modules should provide sufficient operational visibility.

At minimum:

- structured logs
- meaningful errors
- health checks
- migration visibility
- import diagnostics

Financial errors should fail visibly rather than silently.

---

# 44. Testing Architecture

Business rules require automated testing.

The architecture should support:

- unit tests for financial formulas
- domain tests
- integration tests
- migration tests
- end-to-end workflows
- historical regression fixtures

Tax and financial calculations should use deterministic test cases.

---

# 45. Migration Strategy

Schema and rule changes are inevitable.

All persistent changes must use explicit migrations.

Migration design must preserve:

- financial history
- tax history
- ownership history
- auditability

Destructive migrations should be avoided whenever possible.

---

# 46. Architectural Anti-Patterns

The following patterns are explicitly discouraged.

## Duplicate Financial State

Example:

```text
Transaction amount in Ledger
+
separate manually maintained amount in Tax
```

---

## Business Logic in UI

Example:

```text
React component calculates depreciation.
```

---

## Country Logic in MRE Core

Example:

```text
Generic Lease contains German tax-specific fields.
```

---

## Report-Owned Calculations

Example:

```text
PDF generator implements NOI formula.
```

---

## Silent AI Actions

Example:

```text
AI categorizes and books transaction without review.
```

---

## Shared Database Ownership

Example:

```text
Multiple services update the same domain records directly.
```

---

## Hardcoded Regulations

Example:

```text
if year == 2027 then taxRate = ...
```

without an explicit rule abstraction.

---

# 47. Open Architectural Decisions

The following questions remain intentionally unresolved.

## OAD-001

Should new financial domains use MongoDB or another datastore?

---

## OAD-002

Should the DE Investment Layer begin as a modular monolith or multiple services?

---

## OAD-003

How should MRE entity identifiers be referenced across new domains?

---

## OAD-004

Should financial transactions become append-only after confirmation?

---

## OAD-005

How should documents be stored and versioned?

---

## OAD-006

What event mechanism, if any, should connect MRE operational changes to the financial layer?

---

## OAD-007

How should country-specific rule packages be loaded and versioned?

These decisions must be documented through ADRs before implementation where they materially affect long-term architecture.

---

# 48. Architectural Decision Process

Significant architectural changes require an Architecture Decision Record.

An ADR should document:

- context
- options
- decision
- rationale
- consequences
- alternatives rejected

Architecture should not evolve through undocumented implementation accidents.

---

# 49. Initial Target Architecture

The first production-capable version should prioritize simplicity.

Conceptually:

```text
                    Browser
                       │
                MRE Gateway / UI
                       │
           ┌───────────┴───────────┐
           │                       │
      MRE Services          Investment Backend
           │                       │
           │             ┌─────────┼─────────┐
           │             │         │         │
           │          Finance     Tax    Investment
           │             │         │         │
           └────── references / APIs ────────┘
                         │
                    Data Stores
```

This target architecture should remain operationally simple enough to run through Docker Compose.

---

# 50. Evolution Strategy

The architecture should evolve incrementally.

## Phase 1

Preserve and deploy MRE.

## Phase 2

Introduce Financial Ledger.

## Phase 3

Introduce Financing and WEG.

## Phase 4

Introduce Taxation and Depreciation.

## Phase 5

Introduce Investment Analytics.

## Phase 6

Introduce advanced reporting and planning.

## Phase 7

Introduce external automation.

## Phase 8

Introduce AI assistance.

Later phases must not bypass foundational domains.

---

# 51. Architectural Success Criteria

The architecture is successful when:

- MRE can still be updated without extensive merge conflicts
- financial data exists exactly once
- tax calculations can be traced to source transactions
- investment metrics can be reproduced
- modules have clear ownership
- German rules do not contaminate generic domains
- historical results remain reproducible
- users can export their data
- AI remains optional
- the system remains understandable to new contributors

---

# 52. Final Architectural Principle

The system should behave like a chain of increasingly sophisticated interpretations:

```text
Reality
   ↓
Operational Events
   ↓
Financial Facts
   ↓
Tax Interpretation
   ↓
Investment Analysis
   ↓
Reports and Decisions
```

Each layer adds meaning.

No layer should rewrite reality.

---

# Closing Statement

Vermieter Cockpit DE is not intended to replace MicroRealEstate.

It is intended to build upon it.

MicroRealEstate remains the operational rental-management foundation.

The project adds the financial, German regulatory and investment intelligence required to understand residential real estate as a long-term investment.

The architecture must protect this separation.

Whenever possible:

**extend rather than modify, reference rather than duplicate, derive rather than store, explain rather than hide.**