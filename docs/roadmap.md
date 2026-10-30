# Roadmap

**Project:** Vermieter Cockpit DE
**Version:** 0.1 (first draft)
**Status:** Living Document
**Document Type:** Product and Implementation Roadmap

---

# 1. Purpose

This roadmap sequences the implementation of Vermieter Cockpit DE. It is **milestone/slice-based, not date-based**: each phase is a coherent vertical slice with an explicit exit condition. A phase is "done" when its exit criteria hold and its tests pass — not when a calendar date arrives.

The roadmap is derived from and must stay consistent with:

- `docs/project-brief.md` (First Vertical Slice)
- `docs/architecture/architecture-decisions.md`
- `docs/architecture/api-design.md`
- `docs/architecture/domain-model.md`

Where this roadmap and an accepted ADR disagree, the ADR wins and this document must be corrected.

---

# 2. Guiding sequencing rules

1. **Anchor before analytics.** The MRE integration boundary and the canonical cash ledger come first. Nothing derived (tax, investment, reporting) is built before the data it derives from exists.
2. **Cash before interpretation.** Actual cash movement (`Transaction`, `TransactionSplit`) precedes any interpretive layer (tax classification, depreciation, metrics).
3. **Do not build on an unverified rule.** A German-domain phase (WEG, Taxation, Depreciation) has a drafted `docs/germany/*` specification, but its `VERIFY`-marked rules must be confirmed against current law (ideally by a tax professional) before that rule is implemented.
4. **Do not build past an open ADR.** A phase that depends on an open decision (see §5) is blocked until that ADR is accepted. As of this version, the previously-open ADRs (004/005/006/007/009/010) are all resolved (ADR-037–042).
5. **Every phase ships tests** for its business invariants (`AGENTS.md` §29).

---

# 3. Phases

## Phase 0 — Project scaffold & compatibility baseline

**Goal:** an empty but runnable DE backend that authenticates against MRE.

Scope:
- `git init` and separate `vermieter-cockpit` repository (ADR-036).
- Node.js 24 LTS + TypeScript strict + Yarn workspace scaffold (ADR-032).
- Modular monolith skeleton with empty domain modules (ADR-026).
- PostgreSQL connection + migration tool selected and wired (ADR-031).
- Money value object over `NUMERIC` (ADR-033) with rounding tests.
- MRE API client behind an interface + auth adapter against the pinned MRE baseline (ADR-034; commit `479d0ad…`).
- Docker Compose bringing up MRE (MongoDB) + DE (PostgreSQL) together.

**Git gate (deliberately deferred, then mandatory):** `git init` and the initial specification-only commit are **intentionally deferred until the documentation-readiness gate is complete**, so the first commit captures a consistent specification baseline. Afterwards, `git init` — together with removing stray `.DS_Store` files from the worktree (keeping the ignore rule) — is **mandatory before any productive code** and is the first Phase-0 step (VC-0-01). No scaffold, `Money`, or adapter code is written before it.

**Exit:** a DE health endpoint responds only for a valid MRE-authenticated identity within a Realm; migrations run; `Money` round-trips exactly through PostgreSQL.

## Phase 1 — MRE anchor + minimal cash ledger *(First Vertical Slice)*

**Goal:** the core the rest of the system derives from. Full scope in `docs/project-brief.md` §7.

Scope: `PropertyReference` linking; `FinancialAccount`; manual `Transaction` + idempotent bank-CSV import (`ImportBatch`, fingerprinting); `TransactionSplit` with `sum(splits)==transaction`; `confirm`.

**Exit:** link an MRE property → create account → import a CSV twice without duplicates → split → confirm, all Realm-isolated, all exact money, all traceable to source. Invariant tests green.

**Correction flow (gated fast-follow, NOT part of the Phase-1 exit):** `transactions/{id}/correct` is unblocked by ADR-037 (confirmed transactions immutable; corrected via reversal + replacement), and its full contract is specified in `api-design.md` §35. It is explicitly excluded from the Phase-1 exit above and delivered as a gated fast-follow — consistent with `docs/project-brief.md` §7, `docs/development/backlog.md` (VC-1-11) and `api-design.md` §35.

## Phase 2 — Party, Ownership & Acquisition

**Goal:** *who owns what, since when, bought how*.

Scope: `Party` + MRE external mappings; temporal `Ownership` with the share invariant (ADR-011, ADR-012); `Acquisition` aggregate with acquisition costs and land/building allocation inputs (ADR-010).

**Exit:** an acquisition with purchase price + transaction costs + land/building split exists and drives owner-level allocation; ownership changes over time are queryable; ownership shares validated.

## Phase 3 — Financing

**Goal:** loans as canonical financing entities.

Scope: `Loan`; planned schedule vs actual payments kept separate (ADR-015); `LoanAllocation` across multiple `PropertyReference`s (ADR-014); derived remaining debt (ADR-016).

**Allocation basis (resolved, ADR-038):** one explicit percentage per `PropertyReference` (sum 100%), defaulted from financed amount, user-overridable, applied uniformly to principal, interest, and remaining debt.

**Exit:** a shared loan allocates to properties without duplication; interest/principal split flows into the ledger via `TransactionSplit`; remaining debt is derived, never stored as truth.

## Phase 4 — Rent reconciliation write-back

**Goal:** connect MRE operational rent state with DE cash truth.

Scope: `RentPaymentReconciliation` suggest → confirm → write-back-to-MRE (ADR-004A); idempotent, auditable write-back.

**Exit:** a bank transaction can be matched to an MRE rent obligation, confirmed by a human, and written back to MRE exactly once; MRE settlement and DE cash remain distinct records.

## Phase 5 — Security Deposit

Scope: dedicated Security Deposit domain (ADR-013): expected amount, holding `FinancialAccount`, receipt/repayment Transaction references, reconciliation.

**Account model (resolved, ADR-039):** generic `FinancialAccount` + `securityDeposit` purpose flag; deposit-specific facts live in the Security Deposit domain.

**Exit:** a deposit's expected vs actual cash is tracked without being mistaken for rental income.

## Phase 6 — WEG

**Goal:** German condominium administration as a first-class domain (ADR-017).

Scope: `WEG`, membership, Wirtschaftsplan, Jahresabrechnung, WEG cost lines, Erhaltungsrücklage, Sonderumlage; Hausgeld payments split into components.

**Prerequisite:** `docs/germany/weg.md` (verified 29.10.2026, v0.2); ADR-018 scope limits respected.

**Exit:** a Jahresabrechnung is represented with preserved statement structure and split into ledger effects without losing provenance.

## Phase 7 — Taxation

**Goal:** tax classification as interpretation over cash (ADR-006).

Scope: Werbungskosten classification, acquisition-cost classification, umlagefähig/nicht umlagefähig, versioned tax rules (ADR-022).

**Prerequisite:** `docs/germany/taxation.md` and `docs/germany/rent-and-operating-costs.md` (verified 29.10.2026, v0.2). Rule execution model resolved: **ADR-041** (versioned code modules).

**Exit:** a tax-year view derives Einkünfte aus Vermietung und Verpachtung from classified cash + AfA, every figure traceable, no cash mutated.

**Status:** met for the classified cash on the PropertyReference by ACC7 (`phase-7-acceptance.e2e.test.ts`, invariant-suite §45); interest booked via a Loan is not yet in the figures and is flagged `LOAN_INTEREST_NOT_ATTRIBUTED` until its attribution is decided (backlog VC-X-29); the AfA figure follows with Phase 8 (P7-D8, ACC8).

## Phase 8 — Depreciation (AfA)

**Goal:** derived depreciation schedules (ADR — depreciation is derived).

Scope: AfA schedules from acquisition + land/building allocation; version-aware AfA rules.

**Prerequisite:** `docs/germany/depreciation.md` (verified 29.10.2026, v0.2).

**Exit:** an AfA schedule is reproducible from acquisition truth, stored as derivation (not cash), and feeds the tax-year view.

**Status:** planning — decisions P8-D1…D14 and items VC-8-01…06 in `docs/development/phase-8-plan.md` (backlog §3g); its VERIFY points (plan §3) go to the tax advisor before the rule parameters are specified.

## Phase 9 — Investment analytics & scenarios + Reporting

**Goal:** derived metrics and reports; strict actual/scenario separation (ADR-020, ADR-007).

Scope: NOI, cashflow, equity, LTV, Cash-on-Cash, IRR, remaining debt, portfolio performance; `InvestmentMetricSnapshot`; scenario models; reports (`docs/product/reports.md`) and dashboards (`docs/product/dashboards.md`).

**Resolved:** **ADR-040** (snapshot triggers: on-demand + year-end) and **ADR-042** (formula versioning; snapshots pin their formula version).

**Exit:** every metric is explainable to its inputs; scenarios never overwrite actuals; reports are fully derived (ADR-027).

---

# 4. Dependency overview

```text
Phase 0 scaffold
   └── Phase 1 ledger (anchor)
         ├── Phase 2 ownership/acquisition
         │     ├── Phase 3 financing
         │     └── Phase 8 depreciation ── needs germany/depreciation
         ├── Phase 4 rent reconciliation
         ├── Phase 5 security deposit
         ├── Phase 6 WEG ── needs germany/weg
         └── Phase 7 taxation ── needs germany/taxation + rent-and-operating-costs
Phase 9 investment/reporting ── needs 1–3, 7, 8
```

---

# 5. Roadmap-level prerequisites

The architecture ADRs that previously blocked this roadmap are now **all resolved**, and the German-domain specs are **drafted**. The remaining prerequisites are legal verification of the drafted rules.

## 5.1 Resolved ADRs (no longer blocking)

| Former blocker | Was blocking | Resolved by |
|---|---|---|
| ADR-OPEN-004 Confirmed Transaction Mutability | correction flow (gated fast-follow, not Phase-1 exit) | ADR-037 |
| ADR-OPEN-005 Shared Loan Allocation Basis | Phase 3 | ADR-038 |
| ADR-OPEN-006 Security Deposit metadata | Phase 5 | ADR-039 |
| ADR-OPEN-007 Metric Snapshot persistence | Phase 9 | ADR-040 |
| ADR-OPEN-009 Rule Engine | Phase 7 | ADR-041 |
| ADR-OPEN-010 Investment Formula versioning | Phase 9 | ADR-042 |

## 5.2 Remaining prerequisites — legal verification of drafted specs

`docs/germany/verification-checklist.md` consolidates every `VERIFY` point across the four specs. It was filled on 29.10.2026 (v0.2), with a result and sources per point.

| Spec | Needed for | Status |
|---|---|---|
| `docs/germany/rent-and-operating-costs.md` | Phase 7 | **Verified** 29.10.2026 (v0.2, checklist D, E3, E4) |
| `docs/germany/taxation.md` | Phase 7 | **Verified** 29.10.2026 (v0.2, checklist A, E1, E2, E5, E6) |
| `docs/germany/depreciation.md` | Phase 8 | **Verified** 29.10.2026 (v0.2, checklist B) |
| `docs/germany/weg.md` | Phase 6 | **Verified** 29.10.2026 (v0.2) |

Phases 0–5 have **no remaining roadmap-level blocker** and can proceed once scaffolding (Phase 0) is done.

---

# 6. Out of scope for this roadmap

Multi-country abstraction, ELSTER submission, automated tax advice, provider bank-API integrations (file import first), and mobile apps are explicitly not on this roadmap. They may become future ADRs.
