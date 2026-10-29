# Project Brief — Vermieter Cockpit DE

**Version:** 0.1
**Status:** Living Document
**Document Type:** Implementation Kickoff / Orientation
**Audience:** Human contributors and AI coding agents (Codex, Claude Code) starting implementation

---

## 0. How to use this document

This is the **first document to read before writing any code**. It is a compact orientation, not a replacement for the detailed specs. It tells you *what* is being built, *what is already decided*, *what is deliberately still open*, and *what to build first*.

For anything beyond orientation, follow the canonical authority hierarchy (identical across `docs/constitution.md` governance, `AGENTS.md`, `docs/architecture/architecture-decisions.md`, and `README.md`):

1. `docs/constitution.md` — Constitution
2. accepted decisions in `docs/architecture/architecture-decisions.md` — Accepted Architecture Decisions
3. `docs/architecture/domain-model.md` — Domain Model
4. `docs/architecture/data-model.md` — Data Model
5. `docs/glossary.md` — Glossary
6. `docs/architecture/api-design.md` — API Design
7. relevant domain- and product-specific specifications — including `docs/architecture/architecture-overview.md` and `docs/product/product-specification.md`
8. implementation documentation
9. existing code

Operating rules for agents live in `AGENTS.md`.

For verified upstream MRE semantics, `docs/architecture/mre-integration.md` is the authoritative reference. This special authority never overrides the Constitution or any Accepted Architecture Decision; where a genuine conflict remains, do not silently choose an interpretation — `AGENTS.md` §33 (Stop Conditions) applies.

---

## 1. What this is, in one paragraph

Vermieter Cockpit DE is a **self-hosted, open-source investment/finance/tax/WEG cockpit for private residential landlords in Germany**, built as an **extension layer on top of [MicroRealEstate](https://github.com/microrealestate/microrealestate) (MRE)**. MRE stays the operational rental-management core (properties, tenants, leases, rents). Vermieter Cockpit DE adds the domains MRE does not cover: ownership, acquisition, a canonical cash ledger with bank reconciliation, financing/loans, security deposits, German WEG administration, tax classification and depreciation (AfA), and investment analytics. Everything derives from **one financial truth**, entered once.

## 2. Who it is for

**In scope:** private real-estate investors, owners of rented apartments and small multi-family houses, buy-and-hold / long-term holders.
**Out of scope:** brokers, professional property managers, developers, holiday-rental/hotel operators. See `docs/vision.md`.

**Explicit non-goals** (`AGENTS.md` §1, `docs/vision.md`): this is not a replacement for MRE, not a generic ERP, not a generic bookkeeping system, not a full tax-advisory platform, not ELSTER software, not a speculative multi-country abstraction.

## 3. The non-negotiables (from the Constitution)

These shape every design decision. Violating one usually means the design is wrong.

- **Single source of financial truth.** Financial information exists exactly once; reports are derived, never hand-maintained. Duplicate financial data == incorrect architecture.
- **Cash-only ledger.** A `Transaction` represents *actual cash movement only*. Forecasts, expected rent, depreciation, valuations, amortization schedules, tax calculations, WEG estimates, and scenario projections must **never** become Transactions.
- **Reconcile, don't merge.** MRE operational rent state and DE cash truth stay separate, connected only through `RentPaymentReconciliation`.
- **Actuals ≠ scenarios.** Scenario assumptions never overwrite actual data.
- **Explainability / provenance.** Every number is reconstructible to its source. Preserve bank import IDs, MRE references, statement structure, rule/calculation versions.
- **AI assists, humans decide.** AI produces reviewable suggestions; it never silently writes financial records.
- **Extend MRE, don't fork it conceptually.** Prefer extension modules and adapters over upstream MRE changes.

## 4. Technology baseline (decided — do not re-litigate)

Recorded canonically in `docs/architecture/architecture-decisions.md`; detailed rationale in `docs/architecture/technology-adrs.md`.

| Concern | Decision | ADR |
|---|---|---|
| Runtime / language | Node.js 24 LTS + TypeScript (strict) | ADR-032 |
| Package tooling | Yarn 3.3-compatible workspaces | ADR-032 |
| Backend shape | Modular monolith (module boundaries mandatory, process split not) | ADR-026 |
| DE persistence | **PostgreSQL**, separate from MRE's MongoDB | ADR-031 |
| Money | Money value object, exact decimal, PostgreSQL `NUMERIC`, API = decimal string + currency | ADR-033 |
| Auth | Reuse MRE authentication + Realm authorization (no second credential store) | ADR-034 |
| Documents | Pluggable `DocumentStorage` port, local filesystem default; metadata in PostgreSQL | ADR-035 |
| Repository | Separate `vermieter-cockpit` repo, pinned MRE compatibility baseline | ADR-036 |
| Public API | HTTP + JSON under `/api/v1`, REST resources + explicit business commands | api-design |

MRE reference baseline is pinned: commit `479d0ad703436071b64dfdf4e48321c121d8efb5`, landlord API `/api/v2` (see `docs/architecture/mre-integration.md`). Implementation-level choices still free to pick during scaffolding: HTTP framework, PG access layer (Prisma/Drizzle/Kysely/node-postgres), migration tool, decimal library, validation library, test runner.

## 5. MRE integration boundary (read `mre-integration.md` before touching this)

The integration layer is an **anti-corruption layer**. Canonical terminology (`AGENTS.md` §27, `docs/glossary.md`) — using the wrong term is an architectural error:

| Meaning | Required term | DE identifier |
|---|---|---|
| MRE rentable object | `Property` | referenced via `PropertyReference` (`propertyReferenceId`; raw = `mrePropertyId`) |
| MRE reusable rental-term model | `Lease Definition` | — |
| Concrete MRE rental relationship | — | `RentalContractReference` (`rentalContractReferenceId`) |
| DE bank/cash account | `FinancialAccount` | — |
| MRE authenticated user | `MRE Account` | (never confused with a bank account) |
| MRE rent-state ↔ cash link | `RentPaymentReconciliation` | — |

**Forbidden in the MVP:** any `Unit` / `UnitReference` / `unitId` (MRE has no canonical Unit — `AGENTS.md` §4, ADR-002B); a generic DE `propertyId` where a `PropertyReference` is meant; treating `MRE Tenant` as the canonical `Party`.

## 6. Domain map

MRE owns: Property Management, Rental Operations.
Vermieter Cockpit DE owns these separated modules: MRE Integration · Party & Ownership · Acquisition · Financial Ledger · Financing · Security Deposit · WEG · Taxation · Depreciation · Investment · Reporting/Analytics. Keep them conceptually separate even when the UI presents one cockpit (`AGENTS.md` §26).

## 7. First Vertical Slice (build this first)

**Goal:** the smallest end-to-end slice that exercises the core non-negotiables and everything else builds on — MRE anchor + canonical cash ledger. Do **not** start with tax, WEG, depreciation, or investment analytics; they depend on this and on domain rules that are not yet written (see §8).

**Slice 1 — MRE anchor + minimal cash ledger**

Scope:
1. **MRE auth adapter** — verify an MRE-authenticated identity and Realm membership server-side; enforce Realm isolation on every DE endpoint (ADR-034, TECH-ADR-005). Owner-only DE data must never be reachable via the MRE *tenant* API.
2. **PropertyReference** — `POST /api/v1/property-references/link` to bind an MRE `Property` to a DE `PropertyReference`; `.../refresh` for cached display data. This is the anti-corruption layer in miniature.
3. **FinancialAccount** — `POST /api/v1/financial-accounts`.
4. **Cash ledger core** — `POST /api/v1/transactions` (manual entry) and `POST /api/v1/imports/bank-transactions` (CSV), with:
   - Money value object over PostgreSQL `NUMERIC`;
   - **idempotent import** via transaction fingerprint / `ImportBatch` (no duplicate cash records on retry — `AGENTS.md` §23);
   - provenance preserved (bank import IDs, source references).
5. **Transaction splits** — `PUT /api/v1/transactions/{id}/splits`, enforcing the invariant `sum(splits.amount) == transaction.amount` under the model's sign/rounding rules (`AGENTS.md` §9, domain-model §22–24).
6. **Confirm** — `POST /api/v1/transactions/{id}/confirm`.

Deferred out of the core Slice 1: rent reconciliation write-back, loans, ownership allocation. `transactions/{id}/correct` is a **gated fast-follow, not part of the Phase-1 exit**: its behavior is fixed by **ADR-037** (confirmed transactions immutable; corrected via reversal + replacement), and its full contract is specified in `api-design.md` §35.

**Definition of done for Slice 1:** a user can link an MRE property, create a financial account, import a bank CSV twice without duplicates, split a transaction so totals reconcile, and confirm it — all Realm-isolated, all monetary values exact, all records traceable to source. Tests cover: split totals, idempotent import, monetary precision, Realm isolation (`AGENTS.md` §29).

**Suggested slice order after that:** (2) Ownership (temporal) + Acquisition + land/building allocation → (3) Financing/Loans with `LoanAllocation` + planned-vs-actual → (4) Rent reconciliation write-back to MRE → (5) Security Deposit → then the German rule domains (6 WEG, 7 Taxation, 8 Depreciation) once their drafted specs are legally verified → (9) Investment analytics + scenarios. The authoritative order is in `docs/roadmap.md`.

## 8. Known guardrails

Before implementing anything that touches these, **stop and surface the gap** rather than inventing an answer (`AGENTS.md` §33).

**Architecture ADRs — all previously-open decisions are now resolved** (`architecture-decisions.md`):
- **ADR-037** Confirmed transactions are immutable; corrections use reversal + replacement (was ADR-OPEN-004).
- **ADR-038** Shared-loan allocation: one overridable percentage basis, uniform across principal/interest/debt (was ADR-OPEN-005).
- **ADR-039** Security Deposit uses a generic `FinancialAccount` + purpose flag; specifics in the domain (was ADR-OPEN-006).
- **ADR-040** Metric snapshots triggered on-demand + at year-end (was ADR-OPEN-007).
- **ADR-041** Country rules are versioned code modules, not a generic rule engine (was ADR-OPEN-009).
- **ADR-042** Investment formulas are versioned; snapshots pin their formula version (was ADR-OPEN-010).

**German specs — verified 29.10.2026** (per `AGENTS.md` §30; a rule that is still case-dependent is listed in its spec's open points and is not implemented as a fixed rule):
- `docs/germany/taxation.md`, `docs/germany/depreciation.md`, `docs/germany/weg.md`, `docs/germany/rent-and-operating-costs.md` — the product differentiator; versioned domain knowledge with `§` references, **verified** on 29.10.2026 (v0.2) against `verification-checklist.md` v0.2.

All other former stubs (`roadmap`, `reports`, `dashboards`, `coding-guidelines`, `backlog`) now have first drafts.

## 9. Definition of "done" for any change

From `AGENTS.md` §37: relevant tests/lint/type/format pass; no obsolete canonical terminology introduced; no duplicate source of truth created; financial invariants hold; MRE boundaries respected; affected docs updated; migrations included where required; no `.DS_Store` or unrelated files; diff scoped to the task. Do not claim checks passed unless they were actually run.

---

## 10. One-line summary

> Keep MicroRealEstate as the operational rental core; extend it with a separate, PostgreSQL-backed, exact-money DE investment layer that treats one cash ledger as the single financial truth and derives finance, tax, WEG, and investment views from it — building the MRE anchor and cash ledger first.
