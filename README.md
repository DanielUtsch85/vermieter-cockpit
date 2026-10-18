# Vermieter Cockpit DE

A Germany-focused investment, finance, tax, and condominium-management extension for [MicroRealEstate](https://github.com/microrealestate/microrealestate).

> **Project status:** Phase 0 (scaffold) in progress — specification baseline complete.  
> The project is not yet intended for production use.

## Vision

Vermieter Cockpit DE extends MicroRealEstate (MRE) into a self-hosted system for private residential landlords in Germany who want to manage not only rental operations, but also the financial and investment lifecycle of their properties.

The project is designed around a simple principle:

> **Use MicroRealEstate as the operational rental-management core, extend it where German landlord and investment requirements begin, and modify upstream MRE only where necessary.**

MRE remains responsible for operational rental management. Vermieter Cockpit DE adds dedicated domains for areas such as:

- acquisition and ownership
- financial cash ledger and bank reconciliation
- financing and loans
- rental security deposits
- German WEG / condominium administration
- tax classification and depreciation
- investment analytics and scenarios
- portfolio reporting

The goal is not to build a generic accounting system, tax-advisory product, or replacement property-management platform. The goal is a focused owner cockpit built on top of MRE.

---

## Architecture at a Glance

The system follows a layered extension architecture:

```text
┌─────────────────────────────────────────────┐
│           Vermieter Cockpit DE              │
│                                             │
│  Acquisition │ Finance │ WEG │ Tax │ Invest │
│                                             │
│        Canonical DE Cash Ledger             │
│                                             │
│          MRE Integration Layer              │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              MicroRealEstate                │
│                                             │
│ Property │ Tenant │ Lease Definitions       │
│ Rent Obligations │ Operational Rent State   │
│ Documents │ Rental Operations               │
└─────────────────────────────────────────────┘
```

The integration boundary is intentional.

MRE operational state is referenced rather than unnecessarily duplicated. DE-specific financial, ownership, tax, WEG, and investment concepts live outside the MRE core.

### Important MRE terminology

The project uses terminology based on the actual inspected MRE model:

- **`Property`** — the MRE-owned rentable operational object.
- **`PropertyReference`** — the canonical DE-side reference to an MRE Property.
- **`Tenant`** — the central MRE record for the concrete operational rental relationship.
- **`Lease Definition`** — the project term for MRE `Lease`, which primarily represents reusable rental terms/configuration.
- **`RentalContractReference`** — the DE-side reference to the concrete MRE rental relationship.
- **`Unit`** — not part of the MVP domain model; the inspected MRE core does not expose a separate canonical Unit entity.
- **`FinancialAccount`** — a DE bank/cash account; distinct from MRE `Account`, which represents an authenticated MRE user.
- **`RentPaymentReconciliation`** — connects MRE operational rent-payment state with canonical DE cash movements.

The superseded generic model `Property → Unit → Lease → Tenant` must not be reintroduced into MVP implementation.

---

## Core Design Principles

### Extend MRE, do not fork it conceptually

Upstream MRE should remain as intact as reasonably possible.

New capabilities should normally be implemented as extension modules and integration services. Direct changes to MRE are reserved for cases where extension is not practical.

### One canonical cash ledger

Actual cash movements have one canonical representation in the DE Financial Ledger.

The ledger is **cash-only**.

Forecasts, schedules, valuations, tax interpretations, MRE payment records, and other non-cash concepts must not become fake Transactions.

### Reconcile operational and financial truth

MRE answers operational questions such as whether a rent obligation is considered settled.

The DE Ledger answers whether cash actually moved.

These sources of truth remain separate and are connected explicitly through `RentPaymentReconciliation`.

### Preserve provenance

Imported and derived data should remain traceable to its source wherever practical.

Examples include:

- bank transactions
- MRE references
- WEG statements
- acquisition documents
- tax classifications
- valuations
- calculation assumptions

### German rules are versioned domain knowledge

Tax, depreciation, WEG, and similar German rules must not be scattered through application code as unexplained constants.

Where rules can change over time, their applicability and provenance should be explicit.

### Maintainability over cleverness

The architecture favors explicit domain boundaries, understandable models, controlled dependencies, and reproducible calculations over premature abstraction.

---

## Documentation

The repository documentation is part of the product specification and architecture.

Before implementing significant functionality, read the relevant documents rather than inferring domain behavior from names alone.

### Foundation

| Document | Purpose |
|---|---|
| [`docs/project-brief.md`](docs/project-brief.md) | Implementation kickoff: what's decided, what's open, what to build first — read this first |
| [`docs/constitution.md`](docs/constitution.md) | Non-negotiable project principles and governance |
| [`docs/vision.md`](docs/vision.md) | Product vision and long-term direction |
| [`docs/glossary.md`](docs/glossary.md) | Canonical terminology |
| [`docs/roadmap.md`](docs/roadmap.md) | Product and implementation roadmap |

### Product

| Document | Purpose |
|---|---|
| [`docs/product/product-specification.md`](docs/product/product-specification.md) | Product scope and requirements |
| [`docs/product/use-cases.md`](docs/product/use-cases.md) | User-oriented use cases |
| [`docs/product/workflows.md`](docs/product/workflows.md) | End-to-end product workflows |
| [`docs/product/dashboards.md`](docs/product/dashboards.md) | Dashboard definitions |
| [`docs/product/reports.md`](docs/product/reports.md) | Reporting requirements |

### Architecture

| Document | Purpose |
|---|---|
| [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) | System-level architecture |
| [`docs/architecture/architecture-decisions.md`](docs/architecture/architecture-decisions.md) | Accepted and open architecture decisions |
| [`docs/architecture/domain-model.md`](docs/architecture/domain-model.md) | Canonical domain concepts and invariants |
| [`docs/architecture/data-model.md`](docs/architecture/data-model.md) | Logical persistence-oriented data model |
| [`docs/architecture/api-design.md`](docs/architecture/api-design.md) | Business API design and contracts |
| [`docs/architecture/mre-integration.md`](docs/architecture/mre-integration.md) | MRE integration boundary and verified upstream semantics |
| [`docs/architecture/data-flow.md`](docs/architecture/data-flow.md) | Cross-domain and integration data flows |
| [`docs/architecture/technology.md`](docs/architecture/technology.md) | Technology choices and technical constraints |
| [`docs/architecture/technology-adrs.md`](docs/architecture/technology-adrs.md) | Detailed rationale for the accepted technology ADRs (merged into `architecture-decisions.md`) |

### Germany-specific domains

| Document | Purpose |
|---|---|
| [`docs/germany/taxation.md`](docs/germany/taxation.md) | German rental-tax domain |
| [`docs/germany/depreciation.md`](docs/germany/depreciation.md) | AfA and depreciation rules |
| [`docs/germany/weg.md`](docs/germany/weg.md) | WEG-specific concepts and processing |
| [`docs/germany/rent-and-operating-costs.md`](docs/germany/rent-and-operating-costs.md) | Rent, operating costs, settlement, and related financial treatment |
| [`docs/germany/verification-checklist.md`](docs/germany/verification-checklist.md) | Consolidated `VERIFY` points for a tax/legal professional to confirm before implementation |

### Development

| Document | Purpose |
|---|---|
| [`docs/development/coding-guidelines.md`](docs/development/coding-guidelines.md) | Implementation conventions and coding rules |
| [`docs/development/backlog.md`](docs/development/backlog.md) | Implementation backlog |

All documents now contain at least a first draft. The `docs/germany/*` domain documents are drafted as **versioned domain knowledge with statutory references and explicit `VERIFY` markers**; they are not legal or tax advice and must be verified against current law before implementation.

---

## Sources of Truth

When documents overlap, use the canonical authority hierarchy (identical across `docs/project-brief.md`, `AGENTS.md`, and `docs/architecture/architecture-decisions.md`):

1. `docs/constitution.md` — Constitution
2. accepted decisions in `docs/architecture/architecture-decisions.md` — Accepted Architecture Decisions
3. `docs/architecture/domain-model.md` — Domain Model
4. `docs/architecture/data-model.md` — Data Model
5. `docs/glossary.md` — Glossary
6. `docs/architecture/api-design.md` — API Design
7. relevant domain- and product-specific specifications — including `docs/architecture/architecture-overview.md` and `docs/product/product-specification.md`
8. implementation documentation
9. existing code

If two documents appear to contradict each other, do not silently choose whichever is easiest to implement. Resolve the inconsistency explicitly.

For verified upstream MRE semantics, `docs/architecture/mre-integration.md` is the authoritative reference. This special authority never overrides the Constitution or any Accepted Architecture Decision; where a genuine conflict remains, do not silently choose an interpretation — `AGENTS.md` §33 (Stop Conditions) applies.

---

## Major Domains

The current target model contains the following major domains:

```text
MicroRealEstate
├── Property Management
└── Rental Operations

Vermieter Cockpit DE
├── Integration
├── Party & Ownership
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

These domains should remain conceptually separated even when the UI presents them as one integrated owner cockpit.

---

## Financial Model

The DE Financial Ledger is the canonical source for actual cash movement.

Conceptually:

```text
FinancialAccount
      │
      ▼
Transaction
      │
      ▼
TransactionSplit
      │
      ├── Financial Category
      ├── PropertyReference
      └── Tax Classification
```

Important distinctions include:

```text
MRE Rent Obligation
        ≠
MRE Operational Settlement
        ≠
DE Ledger Cash Transaction
```

They can be connected, but they must not be collapsed into one entity.

---

## Ownership and Financing

Ownership is temporal and references the real-world property through `PropertyReference`.

For the current product scope, legal ownership shares are the canonical allocation basis for owner-level income, expenses, and tax interpretation.

`Acquisition` is a first-class Aggregate Root.

Loans are canonical financing entities and may finance or secure multiple properties. Property-level allocation is represented explicitly through `LoanAllocation` rather than duplicating Loan records.

---

## German Domain Extensions

German-specific functionality is intentionally modeled outside generic MRE rental operations.

Planned areas include:

- WEG membership
- Wirtschaftsplan
- Jahresabrechnung
- Hausgeld
- Erhaltungsrücklage
- Sonderumlagen
- Betriebskosten
- umlagefähige and nicht umlagefähige Kosten
- Werbungskosten classification
- acquisition-cost classification
- land/building allocation
- AfA / depreciation
- tax-year reporting
- owner-level allocation

The application supports tax preparation and analysis, but it is not intended to replace professional tax advice.

---

## Investment Analytics

Investment analytics are derived from canonical operational and financial inputs.

Planned metrics include, among others:

- NOI
- cashflow
- equity
- LTV
- Cash-on-Cash Return
- IRR
- remaining debt
- portfolio performance

Scenario calculations must remain separate from actual financial truth.

Historical `InvestmentMetricSnapshot` records may preserve derived results for comparison and auditability, but snapshots do not become editable source-of-truth data.

---

## Project Status

The project is currently focused on specification, architecture, and implementation planning.

The core documentation already defines:

- product direction
- project constitution
- canonical terminology
- MRE integration semantics
- domain boundaries
- logical data model
- business API
- major architecture decisions

A first draft now also exists for the implementation kickoff (`docs/project-brief.md`), roadmap, backlog, coding guidelines, reports, dashboards, and the German domain rules (taxation, depreciation, WEG, rent & operating costs). The next work is to verify the German rules against current law, resolve the remaining open ADRs (see `docs/architecture/architecture-decisions.md`), and begin implementation with the First Vertical Slice defined in `docs/project-brief.md`.

---

## Working on the Project

Coding agents and contributors should start with [`docs/project-brief.md`](docs/project-brief.md) for orientation, then [`AGENTS.md`](AGENTS.md) for operating rules.

At minimum, do not implement significant domain behavior without consulting:

1. `docs/constitution.md`
2. `docs/architecture/architecture-decisions.md`
3. `docs/glossary.md`
4. the relevant domain/architecture document
5. `docs/architecture/mre-integration.md` for anything involving MRE

Do not infer upstream MRE semantics from generic property-management terminology.

Do not introduce speculative abstractions merely because they are common in other property-management systems.

### Local development

Requires Node.js 24 LTS (see `.nvmrc`). Yarn is pinned in the repository (`.yarn/releases`), as in MRE.

```bash
yarn install
yarn build       # compile all workspaces
yarn typecheck   # strict TypeScript check
yarn test        # Vitest suites
```

Database tests (e.g. the Money ↔ `NUMERIC` round-trip) run when `DE_TEST_DATABASE_URL` points to a PostgreSQL database, e.g. `DE_TEST_DATABASE_URL=postgres://de_test:de_test@localhost:5432/de_test yarn test`; otherwise they are skipped locally. CI always runs them.

The DE backend lives in `services/de-backend` (modular monolith, see `docs/development/coding-guidelines.md` §2–3).

---

## License

The project is licensed under the MIT License. See the [`LICENSE`](LICENSE) file for details.
