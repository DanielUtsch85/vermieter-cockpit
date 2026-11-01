# Coding Guidelines

**Project:** Vermieter Cockpit DE
**Version:** 0.1 (first draft)
**Status:** Living Document
**Document Type:** Implementation Conventions

---

# 1. Purpose

Concrete implementation conventions for the DE Investment Layer. These translate the constitution, ADRs, and `AGENTS.md` into day-to-day coding rules. Where this document and an accepted ADR disagree, the ADR wins.

This document covers *how* to write code. It does **not** re-decide architecture — that lives in the ADRs.

---

# 2. Language, runtime, tooling

- **Node.js 24 LTS**, **TypeScript** in `strict` mode, **Yarn 3.3**-compatible workspaces (ADR-032).
- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride` are recommended for new DE code.
- No new runtime ecosystem (no second language) without an ADR.
- Implementation-level library choices (HTTP framework, PG access layer, validation, test runner, decimal lib) follow TECH-ADR §10 criteria: maintenance quality, TS support, low lock-in, deterministic behavior. Record the initial picks here once made.

**Initial library picks (Phase 0, VC-0-02/VC-0-03).** Compared per `technology-adrs.md` §11 against the §10 criteria (maintenance quality, TypeScript support, low lock-in, deterministic behavior, ecosystem maturity, Node 24 compatibility):

| Concern | Pick | Rejected alternatives (and why) |
|---|---|---|
| PG access layer | **Kysely** over `pg` (node-postgres) | **Prisma:** own schema language and generated client (high lock-in), `NUMERIC` mapped to its own `Decimal` runtime type; aggregates would be shaped by the ORM model. **Drizzle:** comparable typed SQL, but schema-as-code couples table definitions, migrations (drizzle-kit) and queries to one tool, and its 0.x line has shipped breaking changes in minor releases. **Plain `pg` + repository layer:** lowest lock-in, but every query is untyped string SQL and row mapping is hand-written; Kysely keeps that model (SQL-shaped queries, no entity runtime, repositories still own mapping) and only adds compile-time typing. Kysely sits on `pg`, so dropping it later means rewriting query builders, not the data layer. |
| Migration tool | **Kysely `Migrator`** (built-in, file-based) | **node-pg-migrate:** solid, but a second tool with its own conventions next to Kysely. **drizzle-kit / Prisma Migrate:** only with their ORMs (rejected above). **Plain SQL files + custom runner:** reinvents ordering/locking the `Migrator` already provides. |
| Decimal library | **decimal.js** | **big.js:** smaller, deliberately minimal API (division precision via `DP` only, four rounding modes); sufficient but no advantage. **bignumber.js:** functionally comparable (also supports isolated clones); tie broken in favour of decimal.js's explicit `toDecimalPlaces(dp, rounding)` API, which maps directly onto ADR-033 "rounding is explicit". |
| Validation | **Zod** | **Valibot:** smaller bundle (a frontend concern, not relevant for the backend) and a younger, less mature ecosystem. **TypeBox:** JSON-Schema-first and fast, but less ergonomic for refinements/transformations (e.g. decimal-string → `Money`). |
| Test runner | **Vitest** | **Jest:** needs a separate transform (ts-jest/babel) for TS + ESM and its ESM support is still experimental. **`node:test`:** Node 24 strips TS types natively, but only erasable syntax (no `enum`/parameter properties, no `tsconfig` paths), and its assertion/mocking API is thinner. |
| CSV parsing (VC-1-10) | **csv-parse** (7.x since VC-1-05, no transitive dependencies; `csv-parse/sync`), only in `integrations/bank-import/` | **Hand-written parser:** RFC 4180 quoting (delimiters and newlines inside quotes, doubled quotes) is easy to get subtly wrong on untrusted input. **papaparse:** browser-oriented, type coercion we would have to switch off. |
| Multipart uploads (VC-1-05) | **busboy** (1.x, one dependency `streamsearch`), only in `api/` | **multer:** wraps busboy and writes to disk or memory without a per-request streaming cap we control; we only need one bounded file part. **formidable:** temp files on disk by default — an uploaded statement must not touch the file system. |
| HTTP framework | **Express 4** (4.21.x, as pinned in MRE) | **Express 5:** native async-error propagation, but MRE services use Express 4; staying on 4 keeps middleware and auth code portable to/from MRE (TECH-ADR-003 "Backend Framework"; `technology.md` §6.2). Async handlers therefore go through an explicit error-forwarding wrapper. Revisit when MRE moves to 5. **Fastify:** good TS support, but a different plugin/middleware model than MRE. |

Binding consequences of these picks:

- **Migrations** are TypeScript files in `services/de-backend/src/infrastructure/postgres/migrations/` (`NNNN_snake_case.ts`, exporting `up`/`down`), compiled by `tsc` into `dist/` like all other code; no `tsx`/`ts-node` at runtime. They are registered in a static, ordered list (`migrations/index.ts`) instead of the `FileMigrationProvider` directory scan, so tests (from `src/`) and containers (from `dist/`) run exactly the same set. `migrateToLatest` (Kysely `Migrator`, database lock, history in `kysely_migration`) runs at backend start before the server listens; a failed migration aborts the start. Never edit or rename an applied migration — add a new one.
- **decimal.js is never configured globally, and is used only inside `shared/`.** `ExactDecimal` and `Money` (VC-0-05) use their own isolated constructor via `Decimal.clone({ ... })`; all other code — including domains — computes through `ExactDecimal`/`Money`, so the global decimal.js configuration never takes part in a calculation (enforced by the architecture test). Rounding is applied explicitly at the business boundary (TECH-ADR-004 "Rounding", §5 below), never through a global default.

Runtime dependencies are added to `services/de-backend` by the backlog item that first uses them, not up front.

**Repository layout (VC-0-04):** Yarn 3.3 workspace (pinned release in `.yarn/releases`, `nodeLinker: node-modules`, same as MRE). The DE backend is the workspace `services/de-backend` (ESM, `module: NodeNext`, relative imports use `.js` extensions). Shared compiler settings live in `tsconfig.base.json` with all recommended strict flags above enabled. Root scripts: `yarn build`, `yarn typecheck`, `yarn lint`, `yarn format:check`, `yarn test`; CI runs all five on Node 24 with a PostgreSQL 16 service (`.github/workflows/ci.yml`). Database tests read `DE_TEST_DATABASE_URL`; they are skipped locally when it is unset and fail the run in CI when it is missing. The §3 dependency direction for `domains/` and `shared/` is enforced by `src/architecture.test.ts` (relative imports per layer; third-party packages via an allowlist: `zod` for `domains/`, `decimal.js` and `zod` for `shared/`; `infrastructure/` may import `shared/` and `domains/` but not `application/`, `api/`, `integrations/` or `reporting/`, with packages unrestricted). Lint-based enforcement (e.g. `eslint-plugin-boundaries` or `dependency-cruiser`) can replace it once linting is set up (§15).

---

# 3. Module structure (modular monolith)

One deployable backend, strong internal boundaries (ADR-026). Conceptual layout (`technology.md` §5), the target structure; a module directory is created with the first feature that needs it, never as an empty placeholder:

```text
de-backend/
├── domains/{party,ownership,acquisition,ledger,financing,
│           security-deposit,weg,taxation,depreciation,investment,documents,
│           property-reference}/
├── integrations/{mre,bank-import,document-import}/
├── reporting/
├── application/    # workflows/use-cases orchestrating domains
├── api/            # HTTP controllers, DTOs, serialization
├── infrastructure/ # persistence adapters (e.g. postgres/), implementing domain ports
└── shared/         # Money, Percentage, IDs, dates, result types
```

Rules:
- **Dependency direction:** `api/application → domain → ports → infrastructure adapters`. Domain code must not import HTTP, DB drivers, the MRE client, CSV/PDF libs, or UI (`technology.md` §5.2).
- Cross-domain interaction goes through an application service, a domain interface, a reference, or an adapter — **never** direct cross-module DB access (`AGENTS.md` §26).
- No "god service" spanning multiple domains' business logic.
- `domains/property-reference/` holds the `PropertyReference` entity and its repository port (MRE Integration domain, api-design §23.1); the MRE client and DTOs stay in `integrations/mre/`, so application code reaches MRE only through ports wired in `src/wiring.ts`.
- Another module (another domain, or another top-level layer) is imported only through its public `index.js`; deep imports into its internals are rejected by `src/architecture.test.ts`.
- **File size** (issue #191): a production `.ts` file under `services/*/src` has at most **600 lines**, a test file (`*.test.ts`, `*.test-support.ts`) at most **900**; `migrations/` is not counted. `yarn size:check` (`scripts/file-size-check.mjs`, in CI after lint) enforces it. Files that were over the limit when the check came are on its exception list with their line count then: a listed file may not grow, and once split below the limit it is removed from the list (the check fails until it is). Permanently exempt, because they carry declarations only: `infrastructure/postgres/schema.ts`, `application/index.ts` and `domains/*/index.ts`. Split along ports or rules, as #91 and #104 did, not into numbered parts.

---

# 4. Domain types — no primitive obsession

Represent business concepts as explicit types/value objects, not raw primitives (ADR-032, `technology.md` §6.3):

- **Money** — value object over exact decimal, `NUMERIC` in PG, `{ "amount": "1250.00", "currency": "EUR" }` over the API (ADR-033). **Never** use JS `number` for canonical money arithmetic.
- **Percentage** — canonical `0.50 == 50%`; avoid ambiguous implicit scaling.
- **IDs** — opaque, branded types (`PropertyReferenceId`, `TransactionId`, …); do not reuse raw MRE IDs as DE primary keys (`technology.md` §11).
- **Business dates** — date-only where time-of-day has no meaning (acquisition date, tax year, rent period); distinct from technical timestamps (`createdAt`, `importedAt`, `reconciledAt`) which are UTC-aware (`AGENTS.md` §21).

---

# 5. Money & rounding

- All monetary arithmetic through the `Money` abstraction; mixing currencies is an error, never silent (`AGENTS.md` §20).
- **Ledger sign model (binding, `data-model.md` §17.4):** `Transaction.amount` and `TransactionSplit.amount` are **non-negative** Money; the cash sign is expressed by `Transaction.direction` (`INFLOW`/`OUTFLOW`). Splits inherit the Transaction's direction and never carry their own. A reversal uses the same amount with the opposite direction. Signed Money is not used for canonical ledger values.
- **Currency/scale:** only supported currencies are accepted (Phase 1: at least EUR, 2 decimals); amounts not representable in the currency's scale, or in an unsupported currency, are **rejected, never silently rounded**.
- The split invariant `sum(TransactionSplit.amount) == Transaction.amount` is checked **exactly** on canonical, currency-validated amounts — there is **no rounding tolerance** for canonical ledger values (`data-model.md` §18, domain-model §22–24, `AGENTS.md` §9).
- **Implementation (VC-0-05):** `shared/money.ts` and `shared/exact-decimal.ts`.
  - `Money.of(amount, currency)` accepts only canonical decimal strings (no exponent, no `+`, no leading zeros, no JS `number`) and rejects unsupported currencies and amounts exceeding the currency scale. `add`/`subtract`/`sum`/`compare` require the same currency (`CURRENCY_MISMATCH` otherwise). Amounts are bounded to 18 integer digits. Money itself may be negative (differences); non-negativity of ledger amounts is enforced by the ledger domain.
  - **Calculations** (shares, rates, interest, depreciation bases) use `ExactDecimal`, the only decimal type available outside `shared/`. `plus`/`minus`/`times` are exact and throw `PRECISION_EXCEEDED` instead of rounding; `dividedBy(divisor, decimalPlaces, mode)` rounds the exact quotient once (integer division + remainder); `toString()` is always plain notation, never an exponent.
  - **Rounding** happens only in `Money.rounded(value: ExactDecimal, currency, mode)`, `money.multiply(factor: ExactDecimal, mode)`, `ExactDecimal.rounded(...)` and `dividedBy(...)`; each requires an explicit `RoundingMode` (`HALF_UP`, `HALF_EVEN`, `UP`, `DOWN`, `CEIL`, `FLOOR`) — there is no default mode. `Money.rounded` does not accept strings, so a value computed elsewhere cannot enter Money without going through `ExactDecimal`.
  - Serialization: `toJSON()` → `{ "amount": "1250.00", "currency": "EUR" }`; persistence: see §8.
- Later calculations that can introduce rounding (ownership allocation, loan interest/principal, tax amounts, depreciation, metrics) round **explicitly at a documented business boundary** (`technology.md` §9.3); those rules live in their own domains and are not invented here. Allocation remainders are assigned deterministically, not dropped.

---

# 6. MRE integration (anti-corruption layer)

- All MRE access through the `MreClient` interface (`integrations/mre/`); domain code never builds MRE HTTP calls directly (`technology.md` §12). `HttpMreClient` uses Node's built-in `fetch` with a timeout, validates MRE responses with Zod and maps every failure to a typed `MreClientError` (`UNAUTHENTICATED`, `FORBIDDEN`, `UNAVAILABLE`).
- Authentication is delegated to MRE (`verifyMrePrincipal`, `mre-integration.md` §47.1): DE never holds MRE's token secret, and an unreachable MRE is a failure, never a pass.
- Translate MRE DTOs into DE integration models at the adapter boundary; never expose MRE persistence schemas through the DE public API.
- Use canonical terminology (`AGENTS.md` §27): `PropertyReference`/`propertyReferenceId`, `RentalContractReference`/`rentalContractReferenceId`, `FinancialAccount`, `RentPaymentReconciliation`. Never `Unit`/`unitId`, never a generic DE `propertyId`/`leaseId`.
- MRE identifiers carry Realm context where required. DE records must survive an upstream MRE entity being deleted/unavailable (`AGENTS.md` §5).

---

# 7. API design

- REST resources under `/api/v1` **plus explicit business commands** (`api-design.md`, `AGENTS.md` §25). Prefer intent-expressing commands (`confirm`, `classify`, `split`, `allocate`, `reconcile`) over generic CRUD that can bypass invariants.
- Requests validated at the boundary; domain invariants enforced in the domain, not only in the controller.
- Money serialized as decimal string + currency; dates as ISO-8601 (date-only where applicable).
- **Runtime wiring (VC-0-07):** `src/main.ts` is the composition root (config → infrastructure → `createApp`); `src/config.ts` validates environment variables with Zod at startup and fails fast without echoing values. The API layer receives infrastructure only through injected functions/ports.
- **Health endpoints:** `GET /health/live` (process up) and `GET /health/ready` (PostgreSQL reachable; 503 otherwise) are unauthenticated and return no data — they exist for container orchestration. Business endpoints under `/api/v1` always require a verified MRE principal: `api/access-middleware.ts` guards the whole router (also unknown routes), using the `PrincipalVerifier` port and the policy in `application/access.ts`; errors use the §12 error model (`UNAUTHORIZED` 401, `FORBIDDEN` 403, `EXTERNAL_SYSTEM_ERROR` 503). New business routes are added to that router only.

---

# 8. Persistence & migrations

- PostgreSQL, accessed through a **repository port**; domain services never expose DB-native objects (`technology.md` §8.3).
- No direct reads/writes of MRE MongoDB collections where an MRE API exists (`technology.md` §8.4).
- Every schema change ships a migration and checks aggregate boundaries, invariants, and data compatibility (`AGENTS.md` §28). Do not store unstructured blobs to avoid modeling.
- `NUMERIC` for money; timezone-aware timestamps; explicit date columns for business dates.
- **Money column convention (binding):** each Money value is a column pair
  `amount NUMERIC NOT NULL CHECK (scale(amount) <= 2 AND abs(amount) < 1e18)` and `currency TEXT NOT NULL CHECK (currency IN ('EUR'))`. Never `NUMERIC(p,s)`: PostgreSQL silently rounds on insert into a fixed-scale column (`'1.005'::numeric(20,2)` = `1.01`), which would contradict "rejected, never silently rounded" for writers that bypass `Money`. The CHECK makes the database reject such values. Bounds match `MAX_INTEGER_DIGITS` and the EUR scale; a second currency with another scale needs a per-currency check. Mapping: `infrastructure/postgres/money-column.ts` binds `money.amount` and refuses non-string driver values.

---

# 9. Correctness invariants

Idempotency, concurrency, provenance are first-class (`AGENTS.md` §22–24):

- **Idempotency:** retryable writes (bank import, MRE sync, reconciliation confirm, webhook processing) must not create duplicate financial records. Use fingerprints / natural keys / `ImportBatch`.
- **Concurrency:** honor optimistic-concurrency/versioning from the data model; conflicts are explicit, never a silent overwrite.
- **Provenance:** preserve external IDs, MRE Realm/entity references, bank import IDs, document/statement references, rule and calculation versions, timestamps, actor identity. Do not destroy source data because normalized data is easier to query.

---

# 10. Actuals vs derived vs scenario

- The ledger is **cash-only**. Never create Transactions for forecasts, expected rent, depreciation, valuations, schedules, tax calcs, WEG estimates, or scenarios (`AGENTS.md` §7).
- Derived values (remaining debt, NOI, AfA, metrics) are computed, never editable canonical state (`AGENTS.md` §16–18). `InvestmentMetricSnapshot` keeps enough metadata to be reproducible.
- Scenario output is interpretive and never overwrites actuals (`AGENTS.md` §19).

---

# 11. German rules as versioned domain knowledge

- Do not hardcode tax/AfA/WEG rules as unexplained constants (`AGENTS.md` §16, §30; ADR-022).
- Time-dependent rules carry applicability window + source/provenance and are versioned. See `docs/germany/*` and each doc's "rule representation" section.
- If a legally material rule is unspecified in the docs, **stop and surface it** — do not guess (`AGENTS.md` §33).

---

# 12. Testing

Business invariants require tests (`AGENTS.md` §29). At minimum: ownership shares; split totals; reconciliation uniqueness; idempotent imports; shared-loan allocation integrity; security-deposit cash references; actual/scenario separation; calculation reproducibility; date validity; monetary precision; Realm isolation/authorization.

- Bug fixes ship a regression test. Never weaken/delete a test to make a change pass.
- Prefer deterministic tests; no reliance on wall-clock or timezone of the host.
- **Timeouts under load.** The suite runs at Vitest's default parallelism, locally and in CI; tests are never skipped or quarantined for being slow. A database test file migrates a fresh schema in its `beforeAll`. Migrations run one at a time (`MIGRATION_ADVISORY_LOCK`), and Kysely's `Migrator` introspects every schema of the database, so a hook waits for the other workers' migrations and gets slower with each schema present. Hence `hookTimeout: 30_000` in `vitest.config.ts`. A test that migrates in its body, or runs a `down` under the lock, declares `{ timeout: 30_000 }`; any other test slower than about 1 s on its own (e.g. a large property run) declares its own timeout, with a comment saying why. Schemas left behind by aborted runs slow every migration. To clear them, use a fresh test database, or drop the `*_test_*`/`*_e2e_*` schemas while no run is active.

---

# 13. Naming & style

- Terminology from `docs/glossary.md` is mandatory; introducing a new domain term updates the glossary in the same change (`AGENTS.md` §27).
- Prefer explicit code, cohesive modules, small interfaces, documented invariants, narrow dependencies (`AGENTS.md` §35). Avoid hidden side effects, clever metaprogramming, broad shared utilities carrying business logic, magic constants.
- Match surrounding code's conventions once a baseline exists.
- **API errors:** a use case throws a typed error; its HTTP answer (status, code, message, details) is one entry of the central table in `api/error-answers.ts`, which the error handler applies. The table is composed of one table per module in `api/error-answers/` (the module whose use case throws the error; shared helpers in `answer.ts`); a new error goes into its module's table (#191). Routes pass errors on with `next(error)` and answer locally only where the answer depends on the request (field errors named after the request's body). One message per error class, worded for every route that can throw it (#89).
- ESLint is authoritative (`eslint.config.mjs`, `yarn lint`, run in CI, over `services/`, `scripts/` and the config itself; the `.mjs` files without type information and with Node's globals): typescript-eslint's type-checked recommendations plus no unused code, no floating promise and type-only imports; tests relax only the rules for untyped JSON and `async` test doubles. Prettier formats the code (`.prettierrc.json`: width 160, single quotes, trailing commas; `yarn format`, checked in CI by `yarn format:check`); style is not reviewed by hand.

---

# 14. Commits, scope, and "done"

- One coherent change per commit; no opportunistic unrelated refactors (`AGENTS.md` §36).
- Commit message convention: `<domain>: <imperative summary>` (e.g. `ledger: enforce split sum invariant`). Reference the ADR/phase where relevant.
- Before "done" (`AGENTS.md` §37): tests/lint/type/format pass; no obsolete terminology; no duplicate source of truth; financial invariants hold; MRE boundaries respected; docs updated; migrations included; no `.DS_Store` or unrelated files; scoped diff. Never claim a check passed unless it was run.

---

# 15. Open items for this document

- Error-handling convention: value objects in `shared/` throw typed errors carrying a stable `code` (e.g. `MoneyError` with `INVALID_AMOUNT`, `SCALE_EXCEEDED`, `UNSUPPORTED_CURRENCY`, `CURRENCY_MISMATCH`) that the API layer maps to `400`. This covers **both** `MoneyError` and `ExactDecimalError` (e.g. `money.multiply(...)` can throw `ExactDecimalError` with `PRECISION_EXCEEDED`); the error mapping of the first controller must handle both types. The convention for domain services/commands (exceptions vs result types) is still open and is decided with the first command (Phase 1).
