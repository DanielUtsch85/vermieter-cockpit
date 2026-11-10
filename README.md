# Vermieter Cockpit DE

A Germany-focused investment, finance, tax, and condominium-management extension for [MicroRealEstate](https://github.com/microrealestate/microrealestate).

> **Project status:** Phases 0–8 implemented and each exit shown end to end by an acceptance test (ACC to ACC8). Productive recording of AfA schedule versions is **disabled** and released in stages (`docs/development/freigabe-afa-erfassung.md`, VC-X-45); no stage is released yet, so the AfA in the tax-year view is a preview and no year with AfA is final. A [tax review of 2026-11-01](docs/germany/pruefbericht-2026-11-01.md) answered 24 questions; its corrections are implemented (VC-X-27, VC-X-34, VC-X-36 to VC-X-44, VC-X-52 to VC-X-57), 15 checklist points are confirmed orally by the tax advisor and the written confirmation is outstanding. A [run with real landlord data](docs/development/real-data-run.md) checked the bank import, the loan schedule and the rent reconciliation; its findings are implemented.  
> The DE cockpit UI ([`webapps/cockpit`](webapps/cockpit)) has its scaffold and the integration gate (sign-in, refresh and Realm choice through the MRE authenticator, ui-guide §10); its version-1 areas are not built yet. The [hand-over guide](docs/development/ui-guide.md) and its attachments are complete, and the [go-live checklist](https://github.com/DanielUtsch85/vermieter-cockpit/issues/281) names what the first productive installation still needs. The project is not yet in production use. See [Project Status](#project-status).

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

The target system follows a layered extension architecture; implementation progress is listed under [Project Status](#project-status):

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
| [`docs/product/business-rules.md`](docs/product/business-rules.md) | Business rules by domain (BR-…), referenced by the specifications and the invariant suite |
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
| [`docs/germany/verification-checklist.md`](docs/germany/verification-checklist.md) | Consolidated `VERIFY` points with their research result and, per point, who confirmed it ("Bestätigt durch": research, primary source or a professional) |
| [`docs/germany/beratungsfragen.md`](docs/germany/beratungsfragen.md) | The questions for the tax advisor, where money and uncertainty meet, with the spec's current state and the answers of the tax review of 2026-11-01 |
| [`docs/germany/pruefbericht-2026-11-01.md`](docs/germany/pruefbericht-2026-11-01.md) | The tax review of 2026-11-01 (24 questions) compared with what DE does: what matched, what had to change (the VC-X-27 to VC-X-44 items), the release stages it recommends |

### Development

| Document | Purpose |
|---|---|
| [`docs/development/coding-guidelines.md`](docs/development/coding-guidelines.md) | Implementation conventions and coding rules |
| [`docs/development/backlog.md`](docs/development/backlog.md) | Implementation backlog and item status |
| [`docs/development/phase-2-plan.md`](docs/development/phase-2-plan.md) | Party, Ownership and Acquisition implementation plan |
| [`docs/development/phase-3-plan.md`](docs/development/phase-3-plan.md) | Financing (Loans) implementation plan |
| [`docs/development/phase-4-plan.md`](docs/development/phase-4-plan.md) | Rent reconciliation and MRE write-back implementation plan |
| [`docs/development/phase-5-plan.md`](docs/development/phase-5-plan.md) | Security Deposit implementation plan (decisions P5-D1–D9 ahead of the item specs) |
| [`docs/development/phase-6-plan.md`](docs/development/phase-6-plan.md) | WEG implementation plan (decisions P6-D1–D9) |
| [`docs/development/phase-7-plan.md`](docs/development/phase-7-plan.md) | Taxation implementation plan (decisions P7-D1–D9: rules as versioned code, the tax year, WEG money when spent, owners' shares, the tax-year view) |
| [`docs/development/phase-8-plan.md`](docs/development/phase-8-plan.md) | Depreciation implementation plan (decisions P8-D1–D13) |
| [`docs/development/freigabe-afa-erfassung.md`](docs/development/freigabe-afa-erfassung.md) | Release protocol for the productive AfA recording: the three release stages, their prerequisites and the owner's decisions (none released yet) |
| [`docs/development/real-data-run.md`](docs/development/real-data-run.md) | Run of the implemented API with a real bank export, a real loan and real rent payments; findings F1–F11 and their follow-ups |
| [`docs/development/betrieb.md`](docs/development/betrieb.md) | Operations (German): daily backup of DE (PostgreSQL), MRE (MongoDB) and the MRE files, encryption before the off-site copy, retention, monitoring, restore step by step, restore rehearsals (`scripts/ops/`); reverse proxy (Caddy), access only over the VPN, TLS with the local CA, secrets (`deploy/caddy/`, `docker-compose.proxy.yml`, `.env.example`) |
| [`docs/development/invariant-suite.md`](docs/development/invariant-suite.md) | Implemented invariants and their test coverage |
| [`docs/development/ui-guide.md`](docs/development/ui-guide.md) | Hand-over guide for the first user interface (draft): information architecture, style guide, data contracts, view-by-view fit to the implemented API, open decisions |
| [`docs/development/api-inventory.md`](docs/development/api-inventory.md) | Generated list of the routes the backend registers (`yarn api:inventory`, checked in CI) |

Documents that no longer apply are kept under [`docs/archive/`](docs/archive/) with a note on what superseded them.

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

Phases 0–8 are implemented, each phase exit shown end to end through the API by an acceptance test (ACC to ACC8 in the [invariant suite](docs/development/invariant-suite.md)). The recording of AfA schedule versions ships off (`DEPRECIATION_RECORDING_ENABLED`) and is released in three stages by the owner's documented decision ([release protocol](docs/development/freigabe-afa-erfassung.md), VC-X-45; api-design §60 and §60A); the open tests of VC-X-35 are done. The [tax review of 2026-11-01](docs/germany/pruefbericht-2026-11-01.md) led to the items VC-X-27, VC-X-34, VC-X-36 to VC-X-44 and VC-X-52 to VC-X-57, all implemented except VC-X-56 (capitalising the anschaffungsnah share paid from the Hausgeld, planned, not specified). Interest booked via a Loan is attributed through the Loan's allocation set since VC-X-29, and flagged `LOAN_INTEREST_NOT_ATTRIBUTED` where no set covers its date. After Phase 4 the implemented API was run with real data ([real-data run](docs/development/real-data-run.md), #93): a real bank export imported twice, a real annuity loan's schedule, and six months of real rent inflows reconciled against MRE rent terms. The findings led to ADR-043 and to the items VC-1-12 to VC-1-14, VC-3-09 and VC-4-07, all done. The [implementation backlog](docs/development/backlog.md) tracks individual items, and the [roadmap](docs/roadmap.md) defines phase exits.

### Implemented

| Area | Available behavior |
|---|---|
| Backend foundation | Node.js 24, strict TypeScript, Yarn workspaces, PostgreSQL migrations and a Docker Compose stack with MRE |
| MRE access | Server-side identity and Realm membership verification; DE access for Realm administrators |
| Property references | Link an MRE Property and refresh its cached, non-authoritative display data |
| Financial accounts | Create and close accounts; validate and normalize IBANs |
| Cash ledger | Create, read and filter Transactions (reads include the counterparty name and IBAN); amend, ignore or restore unconfirmed entries; set categorized splits; confirm, correct or reverse confirmed entries, with reversals and replacements keeping the original's counterparty |
| Bank import | Generic CSV adapter in two versions: v1 with duplicate detection and explicit review of ambiguous rows; v2 (ADR-043) adds the bank's running balance as a row identity for overlapping exports with a continuity report, refuses a file whose own account IBAN differs from the FinancialAccount, and ships column-mapping presets per bank (first: `vr-banking` for BBBank, Volksbanken and Raiffeisenbanken) |
| Party management | Create, read, list, amend and deactivate persons and organizations; explicitly link and end MRE Tenant references |
| Ownership | Exact fractional shares, inclusive validity periods, close or void records, history and date-specific reads, and atomic ownership changes |
| Acquisition | Acquisition records with costs and linked payments, confirmation (requires the economic transfer date, which can be recorded later with evidence, VC-X-52), land/building allocation with a plausibility warning against a comparison (VC-X-44), acquisition costs in the basis only when classified (VC-X-42), the depreciation method status per purchase (VC-X-37), owners' Ownerships from the economic transfer on confirm and their alignment for legacy data (VC-X-55, VC-X-57) and owner-level allocation |
| Financing | Loans with terms and planned schedules (payment interval monthly to yearly, the balance at the end of the fixed-rate period, the plan rebased on the booked payments, VC-X-53), interest/principal splits into the ledger with `loanId` and a split proposal from the bank's purpose text, allocation across properties, derived remaining debt, lender balance statements, closing and refinancing |
| Taxation (Phase 7) | Versioned tax rules (`GET /tax-rules`); the default tax meaning of every split by its category; classifications of splits and of retained deposits with review states and history; the tax year by § 11 EStG with the 10-day rule, from the rent's due day on a minimal RentalContractReference, the Wirtschaftsplan's `advanceDueDay` and the loan schedule; refunds by year (VC-7-01, VC-7-02); reserve withdrawals and Sonderumlage uses classified when the WEG spends the money, § 82b distributions with their yearly parts, and the anschaffungsnahe check per Acquisition (VC-7-03); the tax-year view per PropertyReference and per owner (`GET /property-references/{id}/tax-years/{year}`): Einnahmen, Werbungskosten and the result before AfA, every line with its items, owners summed by largest remainder per item, § 82b parts folded per owner, retained deposits without a PropertyReference listed as not attributed, `ATTRIBUTION_INPUT_CHANGED` from the RentalContractReference history (VC-7-04); the Phase-7 exit shown end to end by ACC7 (VC-7-05), with interest booked via an allocated Loan flagged `LOAN_INTEREST_NOT_ATTRIBUTED`, not yet attributed (VC-X-29) |
| Depreciation (Phase 8) | The building as a `DepreciationAsset` with its completion year and rate (VC-8-01); the AfA schedule of each purchase derived on read from the Acquisition and its confirmed land/building allocation, per owner (VC-8-02); capitalised later costs and separate assets such as an Einbauküche (VC-8-03); recorded, append-only schedule versions, **disabled by default** (`409 RECORDING_NOT_ENABLED`, VC-8-04); the AfA lines and `result.basis` in the tax-year view (VC-8-05); the exit shown by ACC8 (VC-8-06). Until recording is enabled the AfA is a provisional preview and no year with AfA is final |
| Rent reconciliation | Match rent Transactions to MRE rent terms (by hand or from suggestions confirmed by a human, including tenants who pay before the month), coverage per term and per Transaction, release, write-back of DE's payment to MRE exactly once, and its removal after a release |
| Data export | The Realm's Kassenbuch as CSV (RFC 4180, or `dialect=excel-de`) and a PropertyReference with its Ownerships, Acquisitions, Loans, WEG memberships and deposits as JSON (VC-X-04; api-design §58S) |
| Operations | Daily backup of DE, MRE and the MRE files with an off-site copy, monitoring and a rehearsed restore (`scripts/ops/`), a reverse proxy as the one origin behind a VPN (`deploy/caddy/`, `docker-compose.proxy.yml`, `.env.example`), images pinned by digest and actions by commit SHA with a CI check (VC-X-09), idempotency keys expiring after 7 days (VC-X-12), pseudonymisation of personal data in `AMENDED` AuditRecords after ten years with an erasure procedure (VC-X-24); see [`betrieb.md`](docs/development/betrieb.md) |
| Integrity and audit | Exact Money arithmetic, Realm-scoped references, idempotency and version checks where specified, AuditRecords, and database constraints and triggers for financial and Ownership invariants |

The public business API is under `/api/v1`. Its contracts are documented in [API Design](docs/architecture/api-design.md); code is in [`services/de-backend`](services/de-backend).

### Next work and current limits

- **AfA recording, stage 1:** the four prerequisites in the [release protocol](docs/development/freigabe-afa-erfassung.md) are implemented (VC-X-34, VC-X-41 Part 2, VC-X-44, VC-X-52); open is api-design §60 "Turning it on" (the tax advisor's answers worked in, the owner's decision to start recording), then the owner's decision entry and `DEPRECIATION_RECORDING_ENABLED=true` with `DEPRECIATION_RECORDING_STAGE=1`; only then can a stage-1 year with AfA be final. Stages 2 and 3 follow by their own checklists (among them the written confirmation of the tax advisor and the owner's real annual statement run through Phases 6 to 8).
- **Go-live:** the first productive installation follows the [go-live checklist](https://github.com/DanielUtsch85/vermieter-cockpit/issues/281): backup rehearsed on the production machine, the proxy and VPN set up, a start with an empty database, and the go-live recorded in the release protocol as the freeze point of the Phase-7 rules (api-design §58F). The remaining item of the [real-data run](docs/development/real-data-run.md) is the productive start itself ([#93](https://github.com/DanielUtsch85/vermieter-cockpit/issues/93)); the first interest period (F9) is answered by VC-X-53 (api-design §58O, question 12).
- **Later domains:** investment analytics and reporting (Phase 9) are planned; their specifications do not imply implemented APIs.
- **User interface:** The cockpit UI lives in [`webapps/cockpit`](webapps/cockpit) (React 18, TypeScript, Tailwind, TanStack Query, Vite; ui-guide §7.1). Done: the scaffold and the integration gate of ui-guide §10, sign-in, refresh and Realm choice through the MRE authenticator behind Caddy, shown from the app shell, against a pinned backend state (`webapps/cockpit/src/gate/backend-pin.ts`). Next: the first usable slice, steps 1 to 7 of ui-guide §10. The [hand-over guide](docs/development/ui-guide.md) with the owner's decisions, the design tokens and the generated route inventory are complete; version 1 (transactions, import, rent reconciliation) can start, its routes have been stable since 30.10.2026. Backend work for it: unknown query parameters are refused on every route (VC-X-61, done); next unknown body fields (VC-X-69), then the UI; the pending major upgrades (VC-X-65 to VC-X-68) fill waiting times: „Reihenfolge: VC-X-61 → VC-X-69 → webapps/cockpit (Version 1) → die vier Hauptversionen.“ and „Die Majors füllen Wartezeiten.“ (Entscheidung des Projektinhabers, 2026-11-09; in full in api-design §58W).
- **Operational work:** structured logging and a rate limit (VC-X-10, once the service is reachable beyond the VPN), the MRE-upgrade compatibility suite (VC-X-06), large imports in chunks (VC-X-13) and a database role without `UPDATE`/`DELETE` on the audit table (VC-X-63) remain in the [cross-cutting backlog](docs/development/backlog.md#5-cross-cutting-backlog-any-phase). Dependency updates arrive weekly through Dependabot (minor and patch grouped; major versions as items of their own).
- **German rules:** The column "Bestätigt durch" of [the verification checklist](docs/germany/verification-checklist.md) shows who confirmed each point. Today 15 points are confirmed orally by the tax advisor through the [tax review of 2026-11-01](docs/germany/pruefbericht-2026-11-01.md) (`Fachperson`), 3 rest on a primary source (`Primärquelle`) and 28 are research (`Recherche`); the written confirmation is outstanding, and a result of `OK` is not an approval. Phases 6–7 were built on research and keep their VERIFY points and open flags; a point should be confirmed (`Fachperson, <date>`) before a year's figures are relied on for a tax return, and before the Phase 8 depreciation rules leave their VERIFY state; the open questions for the tax advisor are in [`beratungsfragen.md`](docs/germany/beratungsfragen.md).

### Continuous integration

[CI](https://github.com/DanielUtsch85/vermieter-cockpit/actions/workflows/ci.yml) runs build, typecheck and Vitest tests with PostgreSQL. A separate Compose job starts the DE/MRE stack, exercises the integration flow and runs the MRE contract tests against the pinned baseline. The cockpit UI (`webapps/cockpit`) runs in the same steps as the backend: build, typecheck, lint, format, file-size limit and its Vitest suite. On every change CI also runs ESLint and Prettier (`yarn lint`, `yarn format:check`), the file-size limit (`yarn size:check`, 600 lines of production code, 900 of tests), the route inventory check (`yarn api:inventory:check`) and the image and action pin check (`.github/scripts/image-pin-check.sh`). The Compose job additionally renders the proxy override, validates the Caddyfile in the Caddy image, and runs the backup and restore scripts against the real stack. The [invariant suite](docs/development/invariant-suite.md) maps business rules to tests, including Realm isolation and concurrent writes. Further migration checks remain open under VC-X-03.

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
yarn build         # compile all workspaces
yarn typecheck     # strict TypeScript check
yarn lint          # ESLint
yarn format:check  # Prettier (yarn format rewrites)
yarn size:check    # file-size limit
yarn api:inventory # regenerate docs/development/api-inventory.md
yarn test          # Vitest suites
```

Full local stack (DE backend + PostgreSQL, and MRE from the images of the pinned baseline commit; needs Docker):

```bash
docker compose up -d --build --wait
curl http://localhost:8090/health/ready   # DE backend
curl http://localhost:8080/health         # MRE gateway
```

The secrets in `docker-compose.yml` are development defaults; override them via `.env` (template: `.env.example`) and never use them in production. CI starts the same stack (`compose-smoke` job). For a productive installation (reverse proxy as the one origin, VPN, backups) see [`docs/development/betrieb.md`](docs/development/betrieb.md) and `docker-compose.proxy.yml`.

Database tests (e.g. the Money ↔ `NUMERIC` round-trip) run when `DE_TEST_DATABASE_URL` points to a PostgreSQL database, e.g. `DE_TEST_DATABASE_URL=postgres://de_test:de_test@localhost:5432/de_test yarn test`; otherwise they are skipped locally. CI always runs them.

MRE contract tests require a running MRE API. With the Compose stack above:

```bash
MRE_CONTRACT_API_URL=http://localhost:8080/api/v2 REQUIRE_MRE_CONTRACT=1 \
  yarn workspace @vermieter-cockpit/de-backend vitest run src/integrations/mre/mre.contract.test.ts
```

They run separately in CI's Compose job; the regular test job skips them.

The DE backend lives in `services/de-backend` (modular monolith, see `docs/development/coding-guidelines.md` §2–3).

#### Cockpit UI (`webapps/cockpit`)

The cockpit is a Vite app served under `/cockpit` ([ui-guide](docs/development/ui-guide.md) §7.1). It has no login of its own: sign-in, token refresh and the Realm list come from the MRE authenticator, the business data from the DE backend, all on one origin (`docs/architecture/mre-integration.md` §47.2). With the Compose stack above running:

```bash
yarn workspace @vermieter-cockpit/cockpit dev    # http://localhost:5173/cockpit/
```

The dev server is the one origin: it forwards `/api/v1` to the DE backend (`127.0.0.1:8090`) and `/api/v2` to the MRE gateway (`127.0.0.1:8080`); override with `COCKPIT_DE_URL` and `COCKPIT_MRE_URL`. Open it as `localhost`, the cookie domain of the refresh token in `docker-compose.yml`. A landlord account comes from MRE's sign-up (`POST /api/v2/authenticator/landlord/signup`, as in `.github/scripts/compose-auth-smoke.sh`), a Realm from MRE (`POST /api/v2/realms`); only an `administrator` of a Realm has DE access. `yarn workspace @vermieter-cockpit/cockpit build` writes `webapps/cockpit/dist` (base path `/cockpit/`), `… test` runs its Vitest suite (no database needed). Behind Caddy (`docker-compose.proxy.yml`) the UI is the upstream `COCKPIT_UI_UPSTREAM`; a container for it does not exist yet, so `/cockpit` answers `502` there until it does.

The design tokens come from `docs/development/design-tokens.css` (imported by `src/index.css`, named in `tailwind.config.ts`); the DTO types come from the backend as type-only exports (`@vermieter-cockpit/de-backend/client-contract`). `src/gate/backend-pin.ts` pins the backend state the UI is written against; its test fails when `docs/development/api-inventory.md` changes, so routes and DTOs are re-checked before the pin moves.

---

## License

The project is licensed under the MIT License. See the [`LICENSE`](LICENSE) file for details.
