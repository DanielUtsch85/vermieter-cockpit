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
| VC-0-09 | test | **done** · Contract test against MRE landlord `/api/v2` for the endpoints Phase 1 needs (start with signup → signin → `GET /api/v2/realms` against the compose stack, proving authenticator/api/Mongo/Redis of the pinned baseline actually work) | Contract test pins upstream shape | VC-0-06 |
| VC-0-10 | infra | **done** · Migrations run: Kysely `Migrator` with a static migration list, baseline migration `0001_baseline`, applied at backend start (fail-fast) | Fresh DB migrates, second run is a no-op, failing migration aborts and is not recorded; compose-smoke checks `kysely_migration` in the stack | VC-0-02, VC-0-07 |

**Phase 0 exit:** DE health endpoint responds only for a valid MRE-authenticated identity within a Realm; migrations run; `Money` exact; both DBs orchestrated.

---

# 3. Phase 1 — MRE anchor + minimal cash ledger *(First Vertical Slice)*

Reference: `docs/project-brief.md` §7, `api-design.md`.

| ID | Type | Item | API | Exit |
|---|---|---|---|---|
| VC-1-01 | feature | **done** · `PropertyReference` link to MRE `Property` (validate `mrePropertyId` as 24-hex ObjectId at the API boundary → 400; resolve existence via `GET /properties`, not `GET /properties/:id` — see `mre-integration.md` §21.1) | `POST /api/v1/property-references/link` | DE ref bound to `mrePropertyId` (+`mreRealmId`); MRE not duplicated |
| VC-1-02 | feature | **done** · Refresh cached, non-authoritative display data (`MISSING` when MRE no longer lists the Property; `cachedSurface` exact; api-design §23.2) | `POST /api/v1/property-references/{propertyReferenceId}/refresh` | Cached fields updated; authority stays in MRE |
| VC-1-03 | feature | **done** · `FinancialAccount` create/close (IBAN normalized + mod-97; `Idempotency-Key` store shared by later commands; api-design §29.2) | `POST /api/v1/financial-accounts` (+`/close`) | Bank/cash account persisted; distinct from MRE `Account` and from `Loan` |
| VC-1-04 | feature | **done** · Manual `Transaction` create (closed account → 409; `rentalContractReferenceId` not supported yet; api-design §31.2) | `POST /api/v1/transactions` | Cash-only Transaction with `Money`; provenance = manual |
| VC-1-05 | feature | **done** · Bank-CSV import → normalized records → `ImportBatch` → Transactions | `POST /api/v1/imports/bank-transactions` | CSV mapped via adapter; not coupled to one bank format |
| VC-1-06 | feature | **done** · Idempotent import (versioned dedup identity) | (same) | Duplicate identity per `data-model.md` §70; re-import creates **no** duplicates; ambiguous cross-file matches become `needs_review` (no Transaction), never auto-deduped or auto-created |
| VC-1-06a | feature | **done** · Ambiguous-match review path (`ImportReviewItem`) | `GET /api/v1/imports/{importBatchId}/review-items` · `POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve` | `needs_review` rows recorded as `ImportReviewItem` (`data-model.md` §20A) owned by their first-seen batch, adapter-versioned identity key; resolve `CREATE` → one `IMPORTED` tx, `SKIP` → none; no Transaction before resolution; re-presented pending identity references the existing item (no second item, owning-path resolve only); re-presented **resolved** identity → structured `duplicate` (`RESOLVED_REVIEW_ITEM`: `reviewItemId`, owning batch, `resolution`, `createdTransactionId` on `CREATE`, none on `SKIP`); differing `adapterVersion` → adapter-version conflict = `needs_review`, no auto-Transaction (API §32.1–32.3, `data-model.md` §70.4) |
| VC-1-07 | feature | **done** · `TransactionSplit` set + invariant | `PUT /api/v1/transactions/{id}/splits` | Non-negative split amounts, direction inherited; `sum(splits)==transaction` checked **exactly** (`data-model.md` §17.4/§18) |
| VC-1-08 | feature | **done** · Confirm a transaction | `POST /api/v1/transactions/{id}/confirm` | Allowed transitions + confirm preconditions per domain-model §21; immutable once `CONFIRMED` |
| VC-1-09 | test | **done** · Invariant suite (`docs/development/invariant-suite.md`) | — | Split totals (exact), non-negative amount + direction, dedup + `needs_review`/resolve test cases incl. re-import of a still-`PENDING` ambiguous row, re-import after `CREATE` and after `SKIP` (structured `RESOLVED_REVIEW_ITEM` duplicate, no new decision/Transaction), and adapter-version conflict (`needs_review`, no auto-Transaction) (`data-model.md` §70.5), no silent merge/duplicate of ambiguous rows, monetary precision/scale rejection, Realm isolation |
| VC-1-10 | infra | **done** · Bank CSV adapter interface + first concrete format (`generic-csv` v1, api-design §32.4) | — | New formats pluggable; ledger format-agnostic |

**Phase 1 exit:** see `docs/project-brief.md` §7 "Definition of done."

| VC-1-11 | feature | **done** (api-design §35) · Correct a confirmed transaction via reversal + replacement | `POST /api/v1/transactions/{id}/correct` | Confirmed tx immutable; correction = linked reversal record + new corrected tx (ADR-037); full audit chain preserved |

**Note:** VC-1-11 is a **gated fast-follow and is not part of the Phase-1 exit** (see `api-design.md` §35 and `docs/roadmap.md` Phase 1). The behavior is fixed by **ADR-037** (confirmed transactions immutable; corrections use a linked reversal + replacement), and the full `correct` contract — reversal/replacement roles, chaining invariants, the `CORRECTED` transition, effect on splits/reconciliation, and idempotency identity — is specified in `api-design.md` §35 and implemented (§35.8, migration 0011).

---

# 3a. Phase 2 — Party, Ownership & Acquisition

Reference: `docs/roadmap.md` Phase 2, `docs/development/phase-2-plan.md` (decisions P2-D1…D11). Each item starts with a spec PR for its API section (as §35 for VC-1-11) unless the item says otherwise.

| ID | Type | Item | API | Exit |
|---|---|---|---|---|
| VC-2-01 | feature | **done** (api-design §19.1, migration 0016) · `Party` create, read, list, amend (also when inactive), deactivate (P2-D1; contract api-design §19.1; `name` filter literal, tested with `%` and `_`) | `POST/GET /api/v1/parties`, `GET /api/v1/parties/{id}`, `POST …/{id}/amend`, `POST …/{id}/deactivate` | A person or organization exists once in the Realm; deactivation keeps history; `Idempotency-Key`, `If-Match` |
| VC-2-02 | feature | **done** (api-design §20.1, migration 0017) · MRE tenant reference on a Party (P2-D2) | `POST /api/v1/parties/{id}/external-references` (+ `…/{refId}/end`, list on the Party) | Contract api-design §20.1. MRE Tenant checked in the caller's Realm via `GET /tenants` (mre-integration §20.1, pinned by the contract suite); one active (not ended) reference resolves to one Party (partial unique index; `409 REFERENCE_IN_USE` otherwise; `ON CONFLICT … DO NOTHING` + re-read, two-connection test with two different Parties); no new reference for an inactive Party, also when racing `deactivate`; with it, from the #39 review: the shared application errors (`VersionConflictError`, `IdempotencyKeyConflictError`) move to one module, and a two-connection lost-update test for Party `amend` |
| VC-2-03 | feature | **done** (api-design §26.1, migrations 0018, 0019) · `Ownership` create, close, void, history and `asOf` read (P2-D3, P2-D4; contract api-design §26.1) | `POST /api/v1/ownerships`, `POST …/{id}/close`, `POST …/{id}/void`, `GET /api/v1/property-references/{id}/ownerships[?asOf=]` | Reduced exact fractions; no overlap per Party; Σ ≤ 1 on every day, database-enforced and serialised per PropertyReference (two-connection test, RC and RR); `VOID` counts nowhere; `completeness` derived; the serialising trigger also covers `close` and `void`, each with its own concurrency test (review on #37); before Ownership relies on `ACTIVE`, the database also keeps `party_type` fixed and `INACTIVE` final (no reactivation), by trigger as the ledger's 0009/0013 (review on #39); new owners locked `FOR SHARE` and checked `ACTIVE` (racing `deactivate`); with it, from the #41 review: `MreUnavailableError` moves to `application/errors.ts`, and an exhausted claim retry answers `503` instead of `500` |
| VC-2-04 | feature | **done** (api-design §26.2) · Atomic ownership change (P2-D5; contract api-design §26.2) | `POST /api/v1/property-references/{id}/ownership-changes` | Close + create in one transaction; `422 INVALID_OWNERSHIP` cases; inactive owners may be closed; a complete ownership stays complete; history queryable by date; new owners locked `FOR SHARE` in a fixed order (by `id`) so no lock cycle can arise (review on #42); closes written before creates, tested with a sale to a third party at complete ownership and a share change of the same owner (review on #44) |
| VC-2-05 | feature | **done** (api-design §27.1, migration 0020) · `Acquisition` create, read, list, cancel a draft (P2-D6, P2-D8 `acquiredShare`; contract api-design §27.1) | `POST/GET /api/v1/acquisitions`, `GET …/{id}`, `POST …/{id}/cancel`, `GET /api/v1/property-references/{id}/acquisitions` | Draft with price, acquired share, dates, buyers, sellers; not tied to MRE `Property.price` (mre-integration §32); with it `ownership.acquisition_id` (column, composite FK to a same-Realm `DRAFT` Acquisition of the PropertyReference, in the frozen-fields trigger) and `acquisitionId` accepted on `POST /ownerships` and `ownership-changes` instead of `NOT_SUPPORTED` (review on #42) |
| VC-2-06 | feature | **done** (api-design §27.2, migration 0021) · `AcquisitionCost` and payment links (P2-D7; contract api-design §27.2) | `POST /api/v1/acquisitions/{id}/costs`, `POST …/costs/{costId}/void`; `POST …/{id}/payments`, `POST …/payments/{paymentId}/unlink`; `GET …/{id}/costs`, `GET …/{id}/payments` | Writes on `DRAFT` and `CONFIRMED`, none on `CANCELLED`; per cost and price Σ counting payments ≤ amount; Costs `EXPECTED`/`PARTIALLY_PAID`/`PAID` derived from links to current Transactions; per Transaction Σ links ≤ amount (database-enforced, concurrency test); corrected Transactions stop counting; ledger untouched; `unlink` and cancel take the same serialising path, with concurrency tests (review on #37) |
| VC-2-07 | feature | **done** (api-design §28.1, migration 0022) · Acquisition confirmation (P2-D8; contract api-design §28.1) | `POST /api/v1/acquisitions/{id}/confirm` | This Acquisition's Ownerships = buyers, sum = `acquiredShare`, from the transfer date; ownership `COMPLETE` then; confirmed is final; its Ownerships can no longer be voided; all failed requirements reported at once (`422 CONFIRMATION_BLOCKED`); database-enforced on the status step, an Acquisition only inserted as `DRAFT`; with it, from the review on #49: `version` + 1 exactly on every status step of Acquisition, cost and payment, a cost inserted only `ACTIVE`, a payment only not unlinked |
| VC-2-08 | feature | **done** (api-design §27.3, migration 0023) · Land/building allocation as entered, versioned (P2-D9; contract api-design §27.3) | `POST /api/v1/acquisitions/{id}/land-building-allocation` | `land + building = total` exactly; method + review state; a new one supersedes the old; also `GET …/land-building-allocations` (current and history); optimistic check by `supersedes`; writes on `DRAFT` and `CONFIRMED`, none on `CANCELLED`; one current per Acquisition and a consistent chain, database-enforced |
| VC-2-09 | feature | **done** (api-design §27.4) · Owner-level allocation read (P2-D10; contract api-design §27.4) | `GET /api/v1/acquisitions/{id}/owner-allocation` | Per buyer of this Acquisition: weight, price, costs, land, building; largest-remainder cents per component with a fixed tie-break, totals derived (`total_i = land_i + building_i`), no negative part (review counterexample tested, plus a property test over random fractions and amounts), sums exact (Phase 2 exit); `CONFIRMED` answers, a `DRAFT` only as `PROVISIONAL` when its Ownerships have the structure of requirements 2–5 of §28.1 (else `409 OWNERSHIP_BASIS_INCOMPLETE` with the violations), `CANCELLED` is `409`; costs per category over `ACTIVE` costs; one snapshot |
| VC-2-10 | test | Phase-2 invariant suite + acceptance test (Realm isolation, ownership over time, acquisition end to end) | — | `invariant-suite.md` §15 maps each exit claim to an ACC2 step and the sections that back it; `phase-2-acceptance.e2e.test.ts` (ACC2) runs the exit end to end through the API: acquisition with price, costs (one voided), a linked bank payment, a corrected allocation, confirmation, owner-level allocation exact to the cent; ownership over time (`asOf` before/on/after, history); share validation (over-share `422`, blocked confirm, no void after confirm); Realm isolation on every route of api-design §19–§28, iterated from a table; AuditRecords |

**Phase 2 exit:** `docs/roadmap.md` Phase 2 — VC-2-07 + VC-2-09 + VC-2-04 together.

---

# 4. Later-phase epics (blocked or spec-gated)

Listed for visibility; expand into items when their blocker clears.

| Epic | Phase | Gate |
|---|---|---|
| Party, Ownership, Acquisition | 2 | **expanded** into §3a (VC-2-01…10) |
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
| VC-X-07 | infra | Upgrade TypeScript from 5.6 to a current release (DefinitelyTyped drops TS versions after ~2 years, so later `@types/node@24` updates may require it) and raise `target`/`lib` in `tsconfig.base.json` from `ES2022` to what Node 24 supports (`ES2024`). (Kysely: done in VC-1-01, pinned to `0.29.6`; a 0.x minor upgrade is always a deliberate change) |
| VC-X-08 | infra | Re-evaluate Node.js 26 LTS once Yarn 3.3.0 / TypeScript / Vitest are verified on it (ADR-032 Amendment) |
| VC-X-09 | infra | Pin container images by digest (`@sha256:…`) instead of tag — MRE images (ADR-036 pinned baseline) and `node:24-bookworm-slim` / `postgres:16` — with a documented update procedure; likewise move GitHub Actions to current majors pinned by commit SHA (CI warns that `actions/checkout@v4` / `setup-node@v4` target the deprecated Node 20 runtime) |
| VC-X-10 | infra | Structured logging (incl. unexpected access-guard errors, MRE client failures, pool errors) and a per-token verification cache / rate limit for `/api/v1` (`mre-integration.md` §47.1) |
| VC-X-11 | infra | Observation order across instances: `PropertyReference` refresh orders MRE observations by the DE process clock (`observedAt`, api-design §23.2). Before running more than one DE backend instance, take the timestamp from PostgreSQL (`clock_timestamp()`) or otherwise synchronize it (review note on #10) |
| VC-X-12 | infra | Retention for `idempotency_key` (api-design §15): keys are currently kept forever, so a key can never be reused. Add a TTL (typically 24 h to a few days) with a cleanup job, and document what a request with an expired key does (treated as new: creates again). Review note on #11. Also version the stored result snapshots (or migrate them) before a stored entity's shape changes, since a replay re-reads them (second note on #11) |
| VC-X-13 | infra | Large bank imports (up to 10,000 rows) run in **one** transaction holding the account lock: lookups are already set-based, but inserts, the batch row and the lock span the whole file. Measure and, if needed, chunk the write phase or move imports to a job with progress (review note on #14) |
| VC-X-14 | api | **done** · Align the PropertyReference response to the other resources: `propertyReferenceId` instead of `id` (api-design §22–23). A breaking change, cheap only before the UI uses it (review note on #19) |
| VC-X-15 | feature | **done** (api-design §35.9, migration 0012) · Reverse a confirmed Transaction **without** a replacement (e.g. a confirmed duplicate manual entry): needs its own net-effect rule; deliberately left out of VC-1-11 (api-design §35.7) |
| VC-X-16 | feature | **done** (api-design §31.3–31.4) · Change or ignore an **unconfirmed** Transaction (cash fields, `IGNORED`): the states exist (domain-model §21) but no endpoint does yet; `correct` covers only confirmed ones (api-design §35.4). Must follow the anti-PATCH rule (api-design §3), i.e. explicit commands |
| VC-X-17 | test | **done** (api-design §35.6, migration 0014) · Check the **mirrored splits** of a reversal in the database too (review note on #22): the deferred chain trigger of 0011 compares only the header (account, amount, dates, direction). It could compare the split multiset (category, PropertyReference, amount) of reversal and original, since the net effect per category rests on it |
| VC-X-18 | api | **done** (api-design §33, §35) · Field path of a currency mismatch in `correct`: a split currency ≠ account currency is reported as `replacement.amount.currency` (review note on #22). Unreachable with EUR only; make it precise (`replacement.splits.<i>.amount.currency`) before a second currency |
| VC-X-19 | infra | **done** (api-design §30.1, migration 0015) · The Transaction DTO reads its reversal/replacement ids by two subqueries (`ledger_transaction_correction_key`). Check list endpoints with `EXPLAIN` once they exist (review note on #22). Now relevant: every row of `GET /transactions` runs both subqueries, 400 index lookups at `pageSize = 200` (review note on #26) |
| VC-X-20 | api | **done** (api-design §16.1) · Optimistic concurrency for field edits (api-design §16, review note on #23): `amend` is the first real field edit and is "last write wins" under the row lock. Accept `If-Match: <version>` (or `expectedVersion`) and answer `409 VERSION_CONFLICT` when it is stale, before a UI lets two people edit one draft |
| VC-X-21 | api | **done** (api-design §30.1; `current=true`, the property-reference alias, the financial-category and the provenance (source) filters done too; still open: counterparty, unreconciled, needs review) · Read a Transaction: `GET /api/v1/transactions/{id}` (and the list of api-design §30) with `ETag`, so a client can reload the current version after a `412 VERSION_CONFLICT` instead of retrying blindly with `details.currentVersion` (review note on #25) |
| VC-X-22 | infra | **done** (api-design §16.1, migration 0013) · Freeze `updated_at` and `version` of a confirmed Transaction too (review note on #27): today 0009/0011 leave them writable, and `version` is the `ETag` of §16.1, so a direct SQL update can fake or hide a version conflict. Rule: on a confirmed row `version` changes only with a status step (`RECONCILED`/`CORRECTED`) |
| VC-X-23 | infra | Invariant triggers added by a migration check only new writes (review note on #29): before the first production data, decide whether such migrations also check the existing rows once in `up` (e.g. reversals that do not mirror their original's splits for 0014) and abort instead of accepting an invariant that is already broken |
| VC-X-24 | infra | Personal data in AuditRecords (review note on #38): `AMENDED` records keep old and new values, so former e-mail addresses, phone numbers and names stay in the audit for good. Before production data, define retention and pseudonymisation of personal fields in AuditRecords (GDPR Art. 17 vs. traceability; technology.md §37) |

---

# 6. Notes

- This backlog intentionally front-loads Phases 0–1 in detail because they are the only fully unblocked work today.
- Do not pull a blocked item forward by inventing the missing ADR or German rule; open the decision first (`AGENTS.md` §32–33).
