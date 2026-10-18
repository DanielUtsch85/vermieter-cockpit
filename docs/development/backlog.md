# Implementation Backlog

**Project:** Vermieter Cockpit DE
**Version:** 0.1 (first draft)
**Status:** Living Document
**Document Type:** Implementation Backlog

---

# 1. Purpose & conventions

Concrete, agent-actionable work items, ordered to match `docs/roadmap.md`. This is a **living backlog** — items are added/split/closed as work proceeds.

Item format:

- **ID** `VC-<phase>-<n>` (e.g. `VC-1-03`).
- **Type:** `feature` · `infra` · `spec` · `decision` · `test`.
- **State:** `todo` · `blocked` · `in-progress` · `done`.
- Each item names its **exit** and its **dependencies/blockers**.

Definition of done for every item: see `docs/development/coding-guidelines.md` §14 and `AGENTS.md` §37.

Detailed epics below cover **Phase 0 and Phase 1** (the immediate build). Later phases are listed as epics only; their architecture ADRs are now resolved (ADR-037–042), and the German-domain phases (6–8) additionally require legal verification of the drafted `docs/germany/*` specs before coding (see `docs/roadmap.md` §5).

---

# 2. Phase 0 — Scaffold & compatibility baseline

| ID | Type | Item | Exit | Blockers |
|---|---|---|---|---|
| VC-0-01 | infra | **done** · `git init` DE repo; `.gitignore`; commit convention. **Deliberately deferred until the documentation-readiness gate is complete, then mandatory before any productive code** (first Phase-0 step) | Repo under version control; stray `.DS_Store` removed from the worktree and ignored; done before every other Phase-0 code item | — |
| VC-0-02 | decision | **done** · Pick PG access layer + migration tool; record in coding-guidelines §2 | Choice documented with rationale | — |
| VC-0-03 | decision | **done** · Pick decimal library, validation library, test runner | Choices documented | — |
| VC-0-04 | infra | **done** · Yarn workspace + TS strict config + module skeleton (domains/, integrations/, api/, shared/) | `yarn build`/typecheck pass on empty modules | VC-0-02/03 |
| VC-0-05 | feature | **done** · `Money` value object over `NUMERIC` + rounding policy | Round-trips exactly through PG; rounding tests green | VC-0-03 |
| VC-0-06 | feature | **done** · `MreClient` interface + auth adapter against pinned MRE baseline (`479d0ad…`) | Verifies MRE identity + Realm server-side | — |
| VC-0-07 | infra | **done** (health endpoints for orchestration only — the Phase-0 "health only for an authenticated Realm identity" exit is met by VC-0-08) · Docker Compose: MRE (MongoDB) + DE (PostgreSQL) up together | `docker compose up` yields both DBs + DE health endpoint | VC-0-04 |
| VC-0-08 | feature | **done** · Realm-isolation middleware for all DE endpoints (uses `verifyMrePrincipal`; policy: `administrator` full access, `renter` none — see `mre-integration.md` §47.1) | Requests without valid Realm membership are rejected | VC-0-06 |
| VC-0-09 | test | Contract test against MRE landlord `/api/v2` for the endpoints Phase 1 needs (start with signup → signin → `GET /api/v2/realms` against the compose stack, proving authenticator/api/Mongo/Redis of the pinned baseline actually work) | Contract test pins upstream shape | VC-0-06 |

**Phase 0 exit:** DE health endpoint responds only for a valid MRE-authenticated identity within a Realm; migrations run; `Money` exact; both DBs orchestrated.

---

# 3. Phase 1 — MRE anchor + minimal cash ledger *(First Vertical Slice)*

Reference: `docs/project-brief.md` §7, `api-design.md`.

| ID | Type | Item | API | Exit |
|---|---|---|---|---|
| VC-1-01 | feature | `PropertyReference` link to MRE `Property` | `POST /api/v1/property-references/link` | DE ref bound to `mrePropertyId` (+`mreRealmId`); MRE not duplicated |
| VC-1-02 | feature | Refresh cached, non-authoritative display data | `POST /api/v1/property-references/{id}/refresh` | Cached fields updated; authority stays in MRE |
| VC-1-03 | feature | `FinancialAccount` create/close | `POST /api/v1/financial-accounts` (+`/close`) | Bank/cash account persisted; distinct from MRE `Account` and from `Loan` |
| VC-1-04 | feature | Manual `Transaction` create | `POST /api/v1/transactions` | Cash-only Transaction with `Money`; provenance = manual |
| VC-1-05 | feature | Bank-CSV import → normalized records → `ImportBatch` → Transactions | `POST /api/v1/imports/bank-transactions` | CSV mapped via adapter; not coupled to one bank format |
| VC-1-06 | feature | Idempotent import (versioned dedup identity) | (same) | Duplicate identity per `data-model.md` §70; re-import creates **no** duplicates; ambiguous cross-file matches become `needs_review` (no Transaction), never auto-deduped or auto-created |
| VC-1-06a | feature | Ambiguous-match review path (`ImportReviewItem`) | `GET /api/v1/imports/{importBatchId}/review-items` · `POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve` | `needs_review` rows recorded as `ImportReviewItem` (`data-model.md` §20A) owned by their first-seen batch, adapter-versioned identity key; resolve `CREATE` → one `IMPORTED` tx, `SKIP` → none; no Transaction before resolution; re-presented pending identity references the existing item (no second item, owning-path resolve only); re-presented **resolved** identity → structured `duplicate` (`RESOLVED_REVIEW_ITEM`: `reviewItemId`, owning batch, `resolution`, `createdTransactionId` on `CREATE`, none on `SKIP`); differing `adapterVersion` → adapter-version conflict = `needs_review`, no auto-Transaction (API §32.1–32.3, `data-model.md` §70.4) |
| VC-1-07 | feature | `TransactionSplit` set + invariant | `PUT /api/v1/transactions/{id}/splits` | Non-negative split amounts, direction inherited; `sum(splits)==transaction` checked **exactly** (`data-model.md` §17.4/§18) |
| VC-1-08 | feature | Confirm a transaction | `POST /api/v1/transactions/{id}/confirm` | Allowed transitions + confirm preconditions per domain-model §21; immutable once `CONFIRMED` |
| VC-1-09 | test | Invariant suite | — | Split totals (exact), non-negative amount + direction, dedup + `needs_review`/resolve test cases incl. re-import of a still-`PENDING` ambiguous row, re-import after `CREATE` and after `SKIP` (structured `RESOLVED_REVIEW_ITEM` duplicate, no new decision/Transaction), and adapter-version conflict (`needs_review`, no auto-Transaction) (`data-model.md` §70.5), no silent merge/duplicate of ambiguous rows, monetary precision/scale rejection, Realm isolation |
| VC-1-10 | infra | Bank CSV adapter interface + first concrete format | — | New formats pluggable; ledger format-agnostic |

**Phase 1 exit:** see `docs/project-brief.md` §7 "Definition of done."

| VC-1-11 | feature | Correct a confirmed transaction via reversal + replacement | `POST /api/v1/transactions/{id}/correct` | Confirmed tx immutable; correction = linked reversal record + new corrected tx (ADR-037); full audit chain preserved |

**Note:** VC-1-11 is a **gated fast-follow and is not part of the Phase-1 exit** (see `api-design.md` §35 and `docs/roadmap.md` Phase 1). The behavior is fixed by **ADR-037** (confirmed transactions immutable; corrections use a linked reversal + replacement), but the full `correct` contract — reversal/replacement roles, chaining invariants, the `CORRECTED` transition, effect on splits/reconciliation, and idempotency identity — must be specified before it is implemented.

---

# 4. Later-phase epics (blocked or spec-gated)

Listed for visibility; expand into items when their blocker clears.

| Epic | Phase | Gate |
|---|---|---|
| Party + MRE external mappings | 2 | ready after Phase 1 |
| Temporal Ownership + share invariant | 2 | ready after Phase 1 |
| Acquisition + acquisition costs + land/building allocation | 2 | ready after Phase 1 |
| Loans + planned vs actual + `LoanAllocation` + remaining debt | 3 | ready (basis: ADR-038) |
| Rent reconciliation suggest/confirm/write-back | 4 | ready after Phase 1 |
| Security Deposit domain | 5 | ready (account model: ADR-039) |
| WEG (Wirtschaftsplan, Jahresabrechnung, Rücklage, Sonderumlage) | 6 | verify `germany/weg.md` |
| Taxation (Werbungskosten, classification, versioned rules) | 7 | verify `germany/taxation.md` + `germany/rent-and-operating-costs.md` (rules: ADR-041) |
| Depreciation (AfA schedules) | 8 | verify `germany/depreciation.md` |
| Investment metrics + snapshots + scenarios | 9 | ready (ADR-040 triggers, ADR-042 versioning) |
| Reports + dashboards | 9 | after 7–8; `product/reports.md`, `product/dashboards.md` |

---

# 5. Cross-cutting backlog (any phase)

| ID | Type | Item |
|---|---|---|
| VC-X-01 | spec | **Verify** the four drafted `docs/germany/*` specs against current law using `docs/germany/verification-checklist.md` (ideally a tax professional); replace `VERIFY` markers with confirmed, dated rules before Phases 6–8 |
| VC-X-02 | decision | ~~Resolve open ADRs 004/005/006/007/009/010~~ — **done** (ADR-037–042). Open new `ADR-OPEN-*` only if fresh architectural questions arise |
| VC-X-03 | infra | **in-progress** (build/typecheck/test on Node 24 since VC-0-04; lint + migration check still open) · CI: typecheck + lint + tests + migration check on every change |
| VC-X-04 | infra | Data export tooling (constitution Art. I; ADR-030 open formats) |
| VC-X-05 | decision | ~~Finalize `LICENSE`~~ — **done** (MIT, see README §License) |
| VC-X-06 | test | MRE-upgrade compatibility test suite (contract + integration) per ADR-036 |
| VC-X-07 | infra | Upgrade TypeScript from 5.6 to a current release (DefinitelyTyped drops TS versions after ~2 years, so later `@types/node@24` updates may require it) and raise `target`/`lib` in `tsconfig.base.json` from `ES2022` to what Node 24 supports (`ES2024`) |
| VC-X-08 | infra | Re-evaluate Node.js 26 LTS once Yarn 3.3.0 / TypeScript / Vitest are verified on it (ADR-032 Amendment) |
| VC-X-09 | infra | Pin container images by digest (`@sha256:…`) instead of tag — MRE images (ADR-036 pinned baseline) and `node:24-bookworm-slim` / `postgres:16` — with a documented update procedure |
| VC-X-10 | infra | Structured logging (incl. unexpected access-guard errors, MRE client failures, pool errors) and a per-token verification cache / rate limit for `/api/v1` (`mre-integration.md` §47.1) |

---

# 6. Notes

- This backlog intentionally front-loads Phases 0–1 in detail because they are the only fully unblocked work today.
- Do not pull a blocked item forward by inventing the missing ADR or German rule; open the decision first (`AGENTS.md` §32–33).
