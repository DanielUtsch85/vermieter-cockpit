# API Design

**Project:** Vermieter Cockpit DE *(working title)*  
**Version:** 0.1  
**Status:** Living Document  
**Document Type:** Business API Specification

---

# 1. Purpose

This document defines the API design principles and high-level business capabilities of Vermieter Cockpit DE.

The API is the primary contract between:

- frontend applications
- domain services
- MicroRealEstate integration
- automation
- AI assistance
- future external applications

This document intentionally focuses on **business capabilities**, not on raw persistence operations.

It defines:

- API design principles
- domain boundaries
- resource naming
- business commands
- query patterns
- integration contracts
- MRE adapter responsibilities
- reconciliation APIs
- idempotency
- concurrency
- validation
- authorization
- error semantics
- versioning
- auditability

This document does **not** define:

- final OpenAPI syntax
- concrete DTO schemas for every endpoint
- generated client code
- database implementation
- frontend component structure

Those may be derived later from this specification.

---

# 2. Governing Principles

The API must obey the project Constitution, Architecture Decisions, Domain Model, Data Model and MRE Integration specification.

The most important API principles are:

1. expose business capabilities, not database structure
2. preserve domain ownership
3. never duplicate financial truth
4. use explicit commands for state changes
5. make derived data read-only
6. prefer idempotent operations where possible
7. preserve auditability
8. make uncertainty and review state explicit
9. isolate MRE behind an integration boundary
10. prevent AI from silently writing canonical data

---

# 3. API Style

The API may use HTTP/JSON initially.

The exact implementation framework is not prescribed.

The recommended style is:

> REST-like resources for reads and simple lifecycle operations, combined with explicit domain actions for business state transitions.

Examples:

Preferred:

```text
POST /transactions/{id}/confirm
POST /transactions/{id}/split
POST /rent-reconciliations/{id}/confirm
POST /tax-classifications/{id}/confirm
POST /loans/{id}/recalculate-schedule
```

Discouraged:

```text
PATCH /transactions/{id}
{
  "status": "confirmed"
}
```

when `confirm` has business semantics, validation and audit behavior.

---

# 4. API Boundary Model

Conceptually:

```text
Frontend / External Client
          │
          ▼
      Public API
          │
          ├── Identity / Party
          ├── Ownership
          ├── Acquisition
          ├── Financial Ledger
          ├── Financing
          ├── Security Deposit
          ├── WEG
          ├── Taxation
          ├── Depreciation
          ├── Investment
          ├── Documents
          └── Reporting
                  │
                  ▼
          Domain Services
                  │
          ┌───────┴────────┐
          │                │
       DE Storage       MRE Adapter
                           │
                           ▼
                        MRE API
```

The public API must not expose raw MRE database structures directly.

---

# 5. API Versioning

Initial API namespace:

```text
/api/v1
```

Versioning is required for externally consumed contracts.

Internal service APIs may use separate versioning if needed.

Breaking API changes require:

- explicit version change or compatibility strategy
- migration notes
- updated integration tests

---

# 6. Resource Naming

Use plural nouns for collections.

Examples:

```text
/parties
/ownerships
/acquisitions
/transactions
/loans
/financial-accounts
/weg-associations
/tax-classifications
/depreciation-assets
/market-valuations
/investment-scenarios
```

Use explicit action subresources or verbs for business commands.

Examples:

```text
/transactions/{id}/confirm
/transactions/{id}/correct
/loans/{id}/recalculate-schedule
```

---

# 7. Identifier Rules

Every canonical DE entity uses its internal immutable ID.

MRE references must use explicit fields such as:

- `mreRealmId`
- `mrePropertyId`
- `mreTenantId`
- `mreLeaseDefinitionId`

Do not overload DE IDs with MRE IDs.

---

# 8. Authentication

The preferred architecture is to reuse MRE authentication and Realm authorization.

The DE API should accept an authenticated identity that can be mapped to:

- MRE Account
- MRE Realm membership
- DE access roles

Exact token format remains an implementation decision.

---

# 9. Realm Context

Any endpoint operating on MRE-linked data must execute inside an explicit authorized Realm context.

Realm context may be provided through:

- authenticated claims
- organization header
- route scope
- service context

The API must not allow cross-Realm data leakage.

---

# 10. Authorization

Authorization should be role- and domain-aware.

Potential roles include:

- Owner
- Co-Owner
- Administrator
- Tax Advisor
- Read-Only Advisor

Tenant-facing access remains within MRE tenant APIs and is outside the initial DE investor API.

---

# 11. API Response Envelope

The API should avoid unnecessary nesting.

Recommended normal response:

```json
{
  "id": "...",
  "..."
}
```

For paginated results:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 50,
  "total": 125
}
```

Metadata should only be added when useful.

---

# 12. Error Model

All domain errors should use a consistent machine-readable structure.

Example:

```json
{
  "error": {
    "code": "TRANSACTION_SPLIT_MISMATCH",
    "message": "Transaction splits do not equal the transaction amount.",
    "details": {
      "transactionId": "...",
      "difference": "25.00"
    },
    "traceId": "..."
  }
}
```

---

# 13. Error Categories

Recommended categories:

- `VALIDATION_ERROR`
- `NOT_FOUND`
- `CONFLICT`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `EXTERNAL_SYSTEM_ERROR`
- `REVIEW_REQUIRED`
- `INVARIANT_VIOLATION`
- `VERSION_CONFLICT`
- `IMPORT_ERROR`

---

# 14. HTTP Status Guidance

Recommended mapping:

| Situation | Status |
|---|---:|
| Success | 200 |
| Created | 201 |
| Accepted async-like processing if ever needed | 202 |
| No content | 204 |
| Invalid input | 400 |
| Unauthorized | 401 |
| Forbidden | 403 |
| Not found | 404 |
| Domain conflict | 409 |
| Stale `If-Match` (§16.1) | 412 |
| Validation/review issue | 422 |
| External dependency unavailable | 502/503 |

---

# 15. Idempotency

Commands that may be retried must support idempotency where duplicate execution would be harmful.

Important examples:

- bank import
- transaction creation from external source
- rent reconciliation confirmation
- payment write-back to MRE
- document import
- metric snapshot generation

Recommended mechanism:

```text
Idempotency-Key: <client-generated-key>
```

Implementation: one store for all commands (`idempotency_key`: Realm, command scope, key → fingerprint of the normalized payload, the created resource and its **result snapshot**), claimed and recorded in the same transaction as the resource. Same key and payload → the original result exactly as recorded then, **not** the resource's current state (a retried create after the resource changed still gets the original answer; the current state is a query's job). Same key, different payload → `409`. Keys are kept without expiry for now; retention is backlog VC-X-12.

---

# 16. Optimistic Concurrency

Mutable canonical entities should support version-based concurrency where appropriate.

Example:

```text
version = 12
```

Update command may require:

```text
If-Match: 12
```

or equivalent request field.

Conflict should return `VERSION_CONFLICT`: `412 Precondition Failed` when the version comes in `If-Match` (RFC 9110 §13.2.2, so generic HTTP clients and proxies read it right), `409` when it comes in a request field.

## 16.1 Implementation for Transactions (VC-X-20)

- **Where:** every command that changes a Transaction takes an optional `If-Match` header: `amend`, `PUT …/splits`, `confirm`, `ignore`, `restore` and `correct` (for `correct`, the original's version). The same rules apply to the Party commands `amend` and `deactivate` (§19.1), to ending an external reference (§20.1), and to every later resource whose spec says "`If-Match` as §16.1".
- **Format (RFC 9110 §13.1.1):** a list of entity tags, `If-Match: "3"` or `If-Match: "3", "4"`.
  - `*` or no header means no check.
  - `If-Match` compares strongly: a weak tag (`W/"3"`), or a tag that is not a version, never matches. A header with only such tags therefore fails the check.
  - A header that is not a list of quoted entity tags (`3`, `"3`) is `400 VALIDATION_ERROR` with `field = "If-Match"`.
- **Check:**
  - **Where:** under the Transaction's row lock, after reading it in a new statement, so a command that waited sees the version the other one wrote.
  - **Refusal:** if no tag of the list is the current version, the answer is **`412 Precondition Failed`** with `code = "VERSION_CONFLICT"`, `details.expectedVersions` (the versions of the list) and `details.currentVersion`. Nothing is written. For `correct` the `Idempotency-Key` claim is rolled back too.
- **Order:**
  - Domain refusals come first. A stale version on a confirmed Transaction still answers `NOT_AMENDABLE`.
  - A command that would change nothing is answered as before, whatever the version: an amend with the current values, the same split set, a repeated `confirm` or `ignore`. This is the 2xx exception of RFC 9110 §13.2.2 (the desired state is already there). It cannot lose an update, and a retry after a lost answer stays a retry.
  - An idempotent replay of `correct` (§15) answers before the lock.
- **`ETag`:**
  - The responses of create, `amend`, `PUT …/splits`, `confirm`, `ignore` and `restore` carry `ETag: "<version>"`, the value for the next `If-Match`; so does every single-Party response (create, read, `amend`, `deactivate`; §19.1).
  - `correct` returns three Transactions, each with its `version` in the body.
  - A **replayed** create (`Idempotency-Key`, §15) answers with the snapshot recorded then, its `ETag` included. That version is stale if the Transaction changed since; it is the original answer, not the current state.
- **In the database (VC-X-22, migration 0013):** on a confirmed Transaction (`CONFIRMED`, `RECONCILED`, `CORRECTED`), `version` and `updated_at` change only with a status step, and the step raises `version` by exactly one. A direct SQL write therefore can neither fake a conflict (a raised `version` without a change) nor hide one (a status step without a new `version`). A no-op write passes.
  - Phase 4 (reconciliation): matching data a reconciliation keeps without a status step (e.g. a match reference) belongs in its own table, not on the Transaction row, since the row of a confirmed Transaction cannot change without one (review note on #28).
- **Reading the current version:** `GET /transactions/{id}` (§30.1) answers with the current `ETag`. After a `412` a client must not simply retry with `details.currentVersion`, because that would defeat the check. It reads the Transaction again, shows what changed, and only then retries.
- **Parsing (RFC 9110 §5.6.1, §8.8.3):** the list is read tag by tag, so a tag may contain a comma, and empty list elements are allowed (`"3", , "4"`). A header without any tag (`,`) is `400`.
- **Optional for now:** there is no UI yet. A client that lets people edit should always send `If-Match`. Making it required (`428 Precondition Required`) is a later decision, and it applies to **all** changing commands at once, not per endpoint.

---

# 17. Audit Context

Commands changing canonical state should preserve:

- actor
- timestamp
- source
- reason where applicable
- prior version
- resulting version

---

# 18. Query vs Command Separation

Reads should not change domain state.

Commands should make state changes explicit.

Example:

```text
GET /transactions/{id}
```

must not automatically confirm or classify a Transaction.

---

# 19. Party API

## Purpose

Manage canonical shared Party identity (data-model §7, ADR-009; decisions P2-D1/P2-D2 of `docs/development/phase-2-plan.md`).

### Query

```text
GET /api/v1/parties
GET /api/v1/parties/{partyId}
```

### Commands

```text
POST /api/v1/parties
POST /api/v1/parties/{partyId}/amend
POST /api/v1/parties/{partyId}/deactivate
POST /api/v1/parties/{partyId}/external-references        (VC-2-02, §20)
POST /api/v1/parties/{partyId}/external-references/{externalReferenceId}/end
```

Avoid generic deletion where historical relationships exist.

## 19.1 Contract (VC-2-01, implemented: migration 0016)

- **Domain owner:** Shared Identity. **Authorization:** authenticated MRE identity; every Party belongs to the caller's Realm (`mreRealmId`); another Realm's Party is `404`, never visible.
- **Minimal identity (P2-D1):** DE stores what the user enters. Nothing is synchronised from MRE, and DE never merges or deduplicates Parties automatically: two Parties with the same name are allowed (avoiding duplicates is a review task, data-model §7.7).
- **Fields** (data-model §7.2–7.4, verbatim names), all strings trimmed; an empty optional string is stored as `null`:
  - `partyType`: `PERSON` | `ORGANIZATION` (required, fixed after creation; a wrong type is fixed by creating a new Party and deactivating the old one, deliberately).
  - `displayName`: required, 1–200 characters.
  - Person only: `firstName`, `lastName` (each ≤ 200).
  - Organization only: `legalName` (≤ 200), `registrationNumber` (≤ 100).
  - Not accepted yet, so unknown keys (`400`): `organizationType` (values undefined, data-model §7.4) and `dateOfBirth` (no Phase-2 use case; data minimization, technology.md §37; it comes with the use case that needs it).
  - Both: `email` (≤ 254, one `@` with text on both sides; no further validation), `phone` (≤ 50, free form).
  - A field of the other type is `400` with code `NOT_ALLOWED_FOR_TYPE` (e.g. `legalName` on a `PERSON`).
  - Unknown keys are `400`.
- **Response:** `partyId`, `mreRealmId`, `partyType`, `displayName`, the person or organization fields of its type (absent ones as `null`), `email`, `phone`, `status` (`ACTIVE` | `INACTIVE`), `deactivatedAt`, `deactivationReason`, `createdAt`, `version`; single-Party responses carry `ETag: "<version>"` (§16.1).

### `POST /api/v1/parties`

- `201` with the Party (`status = ACTIVE`, `version = 1`); AuditRecord `CREATED`.
- **Idempotency (§15):** `Idempotency-Key` with scope `party.create`, fingerprint of the normalized payload (trimmed, empty → `null`). A replay answers `201` with the recorded body and `Idempotent-Replayed: true`; the same key with another payload is `409`.

### `POST /api/v1/parties/{partyId}/amend`

- Changes the Party's data: the fields to change, at least one; `null` clears an optional field. `partyType` cannot change (`400`).
- Allowed for `INACTIVE` Parties too: correcting data creates no role (P2-D1), and a deceased owner's misspelt name must stay correctable in historical reports. `amend` never changes `status`.
- `200` with the Party (`version` + 1; AuditRecord `AMENDED` with each changed field's old and new value). Values equal to the current ones are a `200` no-op without a new version or AuditRecord.
- `If-Match` as §16.1 (`412 VERSION_CONFLICT`); a no-op answers regardless of the version.

### `POST /api/v1/parties/{partyId}/deactivate`

- Body `{ "reason": "..." }` (required, trimmed, 1–500). `200` with the Party (`status = INACTIVE`, `deactivatedAt`, `deactivationReason`, `version` + 1; AuditRecord `DEACTIVATED` with the reason).
- Deactivating an inactive Party is a `200` no-op, whatever the `reason`: the first reason and time stay, no new version or AuditRecord.
- `If-Match` as §16.1, with the same rule as `amend`: a no-op answers `200` regardless of the version (RFC 9110 §13.2.2, as §16.1 "Order").
- An inactive Party keeps every relationship (data-model §7.7). Later items refuse **new** roles for it (Ownership, buyer, external reference: P2-D1); ending or correcting existing ones stays allowed. Reactivation is not part of VC-2-01.

### `GET /api/v1/parties/{partyId}`, `GET /api/v1/parties`

- One Party with `ETag`; unknown, foreign or malformed id as §30.1 (`404` / `400`).
- The list: `{ items, page, pageSize, total }` (§11), ordered by `displayName` (case-insensitive), then `partyId`; count and page in one snapshot. Filters, combined with AND:
  - `partyType` (the field's name; §19 used to say `type`);
  - `status` (`ACTIVE` | `INACTIVE`);
  - `name`: substring of `displayName`, `legalName`, `firstName` or `lastName` (1–100 characters), matched **literally**: `%`, `_` and `\` in the input are escaped (`LIKE … ESCAPE '\'`), so `name=%` finds "100% Haus GmbH" and not every Party. Case-insensitive by `lower()` on both sides; no accent or `ß`/`ss` folding.
  - `externalSystem` / `externalId`: the Party holding an active external reference (§20.1, VC-2-02).
- `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`.

---

# 20. Party External References (VC-2-02)

Replaces the former "MRE Party Mapping API" (P2-D2): there is one external-reference command, no `mre-mappings` route. Data: data-model §8; MRE side: mre-integration §11, §20.1.

```text
POST /api/v1/parties/{partyId}/external-references
POST /api/v1/parties/{partyId}/external-references/{externalReferenceId}/end
GET  /api/v1/parties/{partyId}/external-references
```

## 20.1 Contract (VC-2-02, implemented: migration 0017)

- **Domain owner:** Shared Identity. **Authorization:** as §19.1; the Party and its references belong to the caller's Realm. An unknown, foreign or malformed `partyId` or `externalReferenceId` is answered as §30.1 (`404` / `400`); a reference of another Party is `404`.
- **Phase 2 scope:** `system = MRE`, `entityType = tenant` only; any other value is `400`. Owners and landlords have no MRE reference (P2-D2).
- **Response:** `externalReferenceId`, `partyId`, `system`, `mreRealmId`, `entityType`, `externalId`, `status` (`ACTIVE` | `ENDED`), `endedAt`, `createdAt`, `version`. Single-reference responses carry `ETag: "<version>"` (§16.1).
- **Active** means not ended (a status, not a period; data-model §8). `(system, mreRealmId, entityType, externalId)` is unique **among active references**, enforced by a partial unique index, so an MRE Tenant resolves to at most one Party. A Party may hold any number of references (one person, several MRE Tenant records over time).

### `POST …/external-references`

- **Body** (strict; unknown keys `400`): `system` (`"MRE"`), `entityType` (`"tenant"`), `mreRealmId` (required; another value than the verified Realm of the `organizationid` header is `403`, as §23.1), `externalId` (the MRE Tenant `_id`, `^[0-9a-f]{24}$`, else `400 INVALID_FORMAT` before MRE is called). `metadata` is not accepted yet.
- **Order of checks:**
  1. Party unknown or foreign → `404`.
  2. The same Party already holds an **active** reference with this key → `200` with that reference, without asking MRE (a documented success repeat, as §23.1; also for an `INACTIVE` Party, which keeps its references).
  3. Another Party holds it actively → `409 CONFLICT`, `reason = "REFERENCE_IN_USE"`, `details.partyId` (that Party; same Realm, so nothing leaks).
  4. Party `INACTIVE` → `409 CONFLICT`, `reason = "PARTY_INACTIVE"` (no new reference for an inactive Party, P2-D1).
  5. MRE: the Tenant is looked up in `GET /tenants` of the Realm, never `GET /tenants/:id` (mre-integration §20.1). Not listed → `404 NOT_FOUND` with `details.externalId`; MRE no longer grants the Realm → `403`; MRE unavailable → `503 EXTERNAL_SYSTEM_ERROR`. Nothing is written on any error (§77).
- **Success:** `201` with the reference (`status = ACTIVE`, `version = 1`); AuditRecord `CREATED` on entity `PartyExternalReference` with the key in its metadata. Nothing is copied from the MRE Tenant into the Party (P2-D1).
- **Exhausted retries:** if a claim loses to another Party three times and the winner is ended each time before it can be read, nothing is written and the answer is `503 CONCURRENT_UPDATE` with `Retry-After: 1` (review on #41), not a `500`.
- **Concurrency:** MRE is read outside any lock. The write then runs in one READ COMMITTED transaction that takes the Party's row lock (so it serialises with `deactivate` and with claims for the same Party) and re-checks steps 2–4 under it. A claim racing a `deactivate` either completes before it or sees `PARTY_INACTIVE`.
  - Claims for **different** Parties are not serialised by that lock; the partial unique index decides. The insert is `INSERT … ON CONFLICT (system, mre_realm_id, entity_type, external_id) WHERE status = 'ACTIVE' DO NOTHING RETURNING …`, its `WHERE` repeating the index predicate exactly so that the index is the arbiter. It never raises a unique violation (which would abort the transaction, `25P02`): under READ COMMITTED it waits for a concurrent inserter and then returns no row. A **new statement** in the same transaction then reads the now committed active reference and answers `200` (same Party) or `409 REFERENCE_IN_USE` (another Party).
  - Pinned by a two-connection test with two **different** Parties claiming one key: exactly one reference, the other claim `409`.
- **Idempotency:** by the natural key (step 2), as §23.1; no `Idempotency-Key`.
- **Upstream deletion:** a reference stays valid when the MRE Tenant is later deleted (DE records survive upstream deletion, §23.1). There is no refresh of references in Phase 2.

### `POST …/external-references/{externalReferenceId}/end`

- No body. `200` with the reference: `status = ENDED`, `endedAt` set, `version` + 1; AuditRecord `ENDED`. The row is kept.
- Ending an ended reference is a `200` no-op that keeps the first `endedAt`, without a new version or AuditRecord.
- `If-Match` as §16.1 (`412 VERSION_CONFLICT`); a no-op answers regardless of the version.
- Allowed for an `INACTIVE` Party: ending an existing relationship stays allowed (P2-D1).
- Once ended, the key is free again: the same or another Party may claim it with a new reference.

### `GET …/external-references`

- `{ items, page, pageSize, total }` (§11) of the Party's references, active and ended, ordered by `createdAt`, then `externalReferenceId`; count and page in one snapshot. Filter `status` (`ACTIVE` | `ENDED`); `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`.

### Party list by reference (§19.1)

- `GET /api/v1/parties?externalSystem=MRE&externalId=<MRE Tenant _id>` finds the Party holding that key **actively** in the caller's Realm (at most one, by the unique index); `entityType = tenant` is implied in Phase 2. The two parameters come together (one alone is `400`), and combine with the other filters by AND. Ended references do not match.
- Validated as the `POST`: `externalSystem` other than `MRE`, or `externalId` not matching `^[0-9a-f]{24}$`, is `400`, so a typo is an error, not an empty page.

### Schema (for the implementation)

- Composite foreign key `(party_id, mre_realm_id) → party (id, mre_realm_id)` (the key 0016 made for it): a reference is always in its Party's Realm.
- `status` in (`ACTIVE`, `ENDED`) and `CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))`.
- Partial unique index on `(system, mre_realm_id, entity_type, external_id) WHERE status = 'ACTIVE'`.
- `ENDED` is final, by trigger: an ended reference never becomes active again, and its key, Party and `endedAt` do not change (claiming again creates a new row).

---

# 21. MRE Discovery API

The DE layer may expose read-only convenience endpoints backed by the MRE adapter.

Examples:

```text
GET /api/v1/mre/realms
GET /api/v1/mre/properties
GET /api/v1/mre/properties/{mrePropertyId}
GET /api/v1/mre/tenants
GET /api/v1/mre/tenants/{mreTenantId}
GET /api/v1/mre/rents/{mreTenantId}
```

These endpoints should normalize integration data rather than leak raw MRE internals unnecessarily.

---

# 22. Property Reference API

Because MRE owns Property, the DE API should not provide full Property CRUD.

**Route convention:** the DE-side property resource is `property-references`. All property-scoped DE subresources use `/api/v1/property-references/{propertyReferenceId}/...` (e.g. ownerships, acquisitions, transactions, loans, weg, metrics). The generic `/api/v1/properties/...` form is not used for DE resources; only the explicit MRE integration passthrough under `/api/v1/mre/properties/...` refers to raw MRE Property identity.

Instead:

```text
GET  /api/v1/property-references
GET  /api/v1/property-references/{propertyReferenceId}
POST /api/v1/property-references/link
POST /api/v1/property-references/{propertyReferenceId}/refresh
```

---

# 23. Link Property Command

```text
POST /api/v1/property-references/link
```

Request:

```json
{
  "mreRealmId": "...",
  "mrePropertyId": "..."
}
```

Behavior:

1. validate Realm access
2. fetch MRE Property
3. prevent duplicate link
4. create DE PropertyReference
5. preserve MRE identifiers
6. optionally cache display metadata

## 23.1 Contract

- **Domain owner:** MRE Integration.
- **Authorization:** MRE identity; the caller must have access to the given `mreRealmId`; the resulting PropertyReference is scoped to that Realm.
- **Inputs:** `mreRealmId` (required), `mrePropertyId` (required).
- **Outputs:** `201 Created` with the new PropertyReference on first link; `200 OK` with the existing PropertyReference on a repeat of the same natural key (documented success repeat).
- **Response fields:** `propertyReferenceId` (the domain `id`, like `financialAccountId` and `transactionId`), `mreRealmId`, `mrePropertyId`, `externalReferenceState`, `displayName`, `cachedAddress`, `cachedSurface`, `lastRefreshedAt`, `lastObservedAt`, `createdAt`, `version`. The same shape is returned by refresh (§23.2).
- **Error codes:** `401/403` missing identity or no access to the Realm; `404` MRE Property not found for `(mreRealmId, mrePropertyId)`. There is no `409`: a repeat of the same natural key is a success, not a conflict.
- **Idempotency:** natural key `(mreRealmId, mrePropertyId)`; a repeat returns the existing PropertyReference (`200`), never a duplicate and never `409`.
- **Side effects:** creates one PropertyReference; reads MRE via the anti-corruption client (`mre-integration.md`); writes an AuditRecord. DE records remain valid if the upstream MRE Property is later deleted.
- **Implementation (VC-1-01):**
  - The Realm is taken from the `organizationid` header and verified by the access guard (§47.1 of `mre-integration.md`). A body `mreRealmId` other than the header's Realm is `403`.
  - `mrePropertyId` must match `^[0-9a-f]{24}$` and `mreRealmId` must be non-empty; otherwise `400 VALIDATION_ERROR` with `details.fields[]` (`REQUIRED` / `INVALID_FORMAT`), before MRE is called.
  - An existing link for the natural key is returned (`200`) **without** asking MRE, so a repeat stays a success after the upstream Property was deleted.
  - A new link resolves the Property via `GET /properties` in the Realm, never `GET /properties/:id` (`mre-integration.md` §21.1); unknown in the Realm → `404 NOT_FOUND`; MRE no longer grants the Realm (upstream 404 from `checkOrganization`, e.g. membership revoked after the access guard) → `403`; MRE unreachable → `503 EXTERNAL_SYSTEM_ERROR` and nothing is written (§77).
  - Cached on create: `displayName` (MRE `name`), `cachedAddress` and `cachedSurface`, with `lastRefreshedAt`; MRE `price` is never cached.
  - Concurrent links of the same natural key yield one PropertyReference (unique constraint, insert-or-return in one transaction pinned to `READ COMMITTED`, independent of the session default), with exactly one AuditRecord (`LINKED`, actor = verified MRE account email). An empty MRE `name` is cached as `null`.

---

## 23.2 Refresh Property Reference (VC-1-02)

```text
POST /api/v1/property-references/{propertyReferenceId}/refresh
```

- **Domain owner:** MRE Integration. No request body.
- **Authorization:** as §23.1; the reference must belong to the verified Realm. A reference of another Realm is `404`, the same as an unknown id, so existence does not leak across Realms.
- **Behavior:** re-reads the Property via `GET /properties` in the Realm (never `GET /properties/:id`, `mre-integration.md` §21.1):
  - **found:** `displayName`, `cachedAddress` and `cachedSurface` are replaced by MRE's values, the state becomes `ACTIVE` (also from `MISSING`), `lastRefreshedAt` is set;
  - **not listed:** the state becomes `MISSING`; cached values and `lastRefreshedAt` are kept and nothing is deleted. MRE cannot tell deletion from invisibility, so DE never sets `DELETED_UPSTREAM` from a refresh.
- **Outputs:** `200 OK` with the PropertyReference (including `version`, `lastRefreshedAt` = values last read from MRE, `lastObservedAt` = latest applied MRE lookup).
- **Error codes:** `400 VALIDATION_ERROR` for an id that is not a UUID; `401/403` as §23.1 (also when MRE no longer grants the Realm); `404` unknown reference in this Realm; `503 EXTERNAL_SYSTEM_ERROR` when MRE is unavailable. On any error nothing is changed (§77).
- **Ordering:** MRE is read outside the row lock, so refreshes can finish out of order. Each observation is stamped with the **start** of its MRE lookup (`observedAt`, taken before the request; a slow response may show an older MRE state). `lastObservedAt` records the latest applied observation, FOUND or NOT_FOUND. An observation with `observedAt <= lastObservedAt` is **stale** and discarded: nothing is written, no version bump, no AuditRecord, and the response is the current state. So an older observation never brings back old values, never moves `lastRefreshedAt` backwards and never sets `ACTIVE` over a newer `MISSING`.
- **Idempotency:** a refresh without news changes only `lastRefreshedAt` and `lastObservedAt`. `version` increases, and an AuditRecord (`REFRESHED` or `MARKED_MISSING`, with `previousVersion`/`newVersion` and the changed fields) is written, only when cached values or the state change. Concurrent refreshes serialize on the row (`SELECT … FOR UPDATE` under READ COMMITTED).
- **Representation:** `cachedSurface` is a decimal string (e.g. `"64.5"`), never a JSON number. MRE stores surface as a JS number; DE takes its shortest decimal text exactly and leaves out negative, non-finite or exponent values.

---

# 24. Rental Contract Reference API

Concrete rental relationship references MRE Tenant + Lease Definition.

### Queries

```text
GET /api/v1/rental-contract-references
GET /api/v1/rental-contract-references/{id}
```

### Commands

```text
POST /api/v1/rental-contract-references/link
POST /api/v1/rental-contract-references/{id}/refresh
```

---

# 25. Ownership API

Decisions P2-D3 (share as an exact fraction), P2-D4 (periods, close vs. void, completeness, serialisation) and P2-D5 (the atomic change, VC-2-04) of `docs/development/phase-2-plan.md`.

### Queries

```text
GET /api/v1/ownerships/{ownershipId}
GET /api/v1/property-references/{propertyReferenceId}/ownerships[?asOf=YYYY-MM-DD]
```

### Commands

```text
POST /api/v1/ownerships
POST /api/v1/ownerships/{ownershipId}/close
POST /api/v1/ownerships/{ownershipId}/void
POST /api/v1/property-references/{propertyReferenceId}/ownership-changes      (VC-2-04, §26.2)
```

A Realm-wide `GET /api/v1/ownerships` (all Ownerships of all PropertyReferences) is not part of Phase 2; it comes with a use case (an owner's portfolio) that needs it.

---

# 26. Ownership

## 26.1 Contract (VC-2-03, implemented: migrations 0018, 0019)

- **Domain owner:** Ownership. **Authorization:** as §19.1; every Ownership belongs to the caller's Realm, and so do its PropertyReference and owner Party (composite foreign keys). Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`).
- **An Ownership is a period** (data-model §12, §78): `validFrom` and an optional `validUntil`, both **inclusive** business dates (`YYYY-MM-DD`); the next period starts the day after. `share`, `ownerPartyId`, `propertyReferenceId` and `validFrom` never change.
- **Share (P2-D3):** a fraction string `"n/d"` with positive integers, `n ≤ d`, `d ≤ 10000`, as in the Grundbuch (`"1/2"`, `"1/3"`, `"7/10"`). Input may be unreduced; it is stored and returned **reduced** (`"2/4"` → `"1/2"`), and fingerprints compare the reduced form. Sums are exact rationals, never decimals: three Ownerships of `"1/3"` are exactly complete.
- **Status:** `VALID` | `VOID` (P2-D4). Only `VALID` Ownerships count anywhere (sums, overlap, `asOf`, completeness).
- **Response:** `ownershipId`, `mreRealmId`, `propertyReferenceId`, `ownerPartyId`, `share` (reduced), `validFrom`, `validUntil` (or `null`), `status`, `voidedAt`, `voidReason`, `acquisitionId` (the Acquisition this Ownership results from, or `null`; set at creation, fixed afterwards; P2-D8), `sourceReferences`, `notes`, `createdAt`, `version`. Single-Ownership responses carry `ETag: "<version>"` (§16.1).

### Invariants checked on every write (P2-D4)

Over the `VALID` Ownerships of one PropertyReference, for every day of the new or changed period:

- **No overlap per owner:** a Party never holds two overlapping Ownerships of the same PropertyReference → `422 OVERLAPPING_OWNERSHIP` with `details.ownershipId` (the one it overlaps).
- **Σ ≤ 1:** the shares covering a day sum to at most 1 → `422 OWNERSHIP_TOTAL_EXCEEDS_ONE` with `details.date` (the first day above 1) and `details.shareSum` (that day's sum of shares, a reduced fraction). It suffices to check the new period's `validFrom` and every `validFrom` of another `VALID` Ownership inside the new period: a sum only rises where a period starts.
- **Serialisation:** the checks run in a database trigger that first **writes the PropertyReference row** (`UPDATE property_reference SET version = version`, as the split trigger touches its Transaction in 0010). Under READ COMMITTED a second writer of the same PropertyReference waits there, and its trigger then sees the first writer's rows (each statement of the trigger takes a new snapshot). Under REPEATABLE READ it fails with a serialisation error instead of committing Σ > 1. The repository runs READ COMMITTED, touches the PropertyReference first itself and evaluates the same rules to answer the `422`s with their details; the trigger is the guarantee for every other writer. `close` and `void` touch it first too, and the trigger touches it on every write, a `void` included: one lock order on every path (PropertyReference, then Party, then the Ownership row), so no two writers deadlock, also once VC-2-04 locks a PropertyReference and the Ownerships it closes (review on #43).
- The sum is computed exactly: numerator and denominator as `numeric` integers, added by cross-multiplication and reduced by `gcd`, never `bigint` least common multiples (which overflow with several coprime denominators) and never decimal division.

### `POST /api/v1/ownerships`

- **Body** (strict; unknown keys are `400`):
  - `propertyReferenceId`, `ownerPartyId` (UUIDs);
  - `share` (format above; not a fraction → `INVALID_FORMAT`, `n > d` or `d > 10000` → `OUT_OF_RANGE`);
  - `validFrom` (required), `validUntil` (optional, `≥ validFrom`, else `400` `field = validUntil`, `BEFORE_VALID_FROM`);
  - `acquisitionId` (optional): the Acquisition this Ownership results from (WF-002, P2-D8; an Acquisition's confirmation checks exactly the Ownerships carrying its id). In VC-2-03 it is **`400 NOT_SUPPORTED`** (Acquisitions do not exist yet), as other references to not-yet-existing entities (§33.2); from VC-2-05 on it is accepted for a `DRAFT` Acquisition of the same Realm and PropertyReference. Fixed after creation.
  - `sourceReferences` (optional; up to 10 strings of 1–500 characters, e.g. "Grundbuch von Mitte Blatt 1234, Abt. I Nr. 2"; data-model §12.3), `notes` (optional, ≤ 2000). Both trimmed, empty → absent.
- **Order of checks:** `400` → PropertyReference unknown/foreign → `404` (`details.propertyReferenceId`) → Party unknown/foreign → `404` (`details.partyId`) → Party `INACTIVE` → `422 PARTY_INACTIVE` (P2-D5: new owners must be active) → overlap → Σ.
- **The inactive check holds under concurrency:** the write locks the Party row `FOR SHARE` (which conflicts with `deactivate`'s `FOR UPDATE`) and reads its status under that lock.
- **Success:** `201` with the Ownership (`status = VALID`, `version = 1`); AuditRecord `CREATED` with share and dates.
- **Idempotency (§15):** `Idempotency-Key` with scope `ownership.create`, fingerprint of the normalized payload (reduced share, trimmed texts). Replay `201` with the recorded body and `Idempotent-Replayed: true`; the same key with another payload is `409`. Without a key, a repeated create is refused as `OVERLAPPING_OWNERSHIP`, never a duplicate; so a client retrying after a lost answer cannot tell it from a real overlap. **Clients should always send an `Idempotency-Key` on create.**

### `POST /api/v1/ownerships/{ownershipId}/close`

- Body `{ "validUntil": "YYYY-MM-DD" }`: a real change (sale, inheritance; BR-OWN-005). History before it stays as it was.
- Allowed on a `VALID` Ownership, also of an inactive owner (inheritance, P2-D1). Refusals as `422 INVALID_OWNERSHIP` with `details.reason` (the reasons of P2-D5):
  - `VOID`;
  - `STARTS_ON_OR_AFTER_EFFECTIVE_DATE`: `validUntil < validFrom`;
  - `ALREADY_ENDED`: the Ownership already ends **before** the given day; a close never extends a period (history is never moved).
- A planned later end (`validUntil` after the given day) is shortened. The same `validUntil` again is a `200` no-op.
- `200` with the Ownership (`version` + 1; AuditRecord `CLOSED` with the old and new `validUntil`). Shortening never raises a sum; the trigger checks it anyway.
- Closing may leave the PropertyReference `INCOMPLETE` from the next day: allowed here (the next owner may be recorded later); the atomic change of VC-2-04 is the command that keeps it `COMPLETE`.
- `If-Match` as §16.1; a no-op answers regardless of the version.

### `POST /api/v1/ownerships/{ownershipId}/void`

- Body `{ "reason": "..." }` (required, trimmed, 1–500): a recording error ("1/3 entered instead of 1/2"; P2-D4). `200` with the Ownership: `status = VOID`, `voidedAt`, `voidReason`, `version` + 1; AuditRecord `VOIDED` with the reason. The record is kept and counts nowhere; the correct one is then created with the original dates.
- Voiding a `VOID` Ownership is a `200` no-op keeping the first reason and time.
- Allowed for an inactive owner. From VC-2-07 on, an Ownership referenced by a `CONFIRMED` Acquisition cannot be voided: `409 CONFLICT` with `reason = "ACQUISITION_CONFIRMED"` and `details.acquisitionId` (§28.1); closing it stays allowed.
- `If-Match` as §16.1; a no-op answers regardless of the version.

### Reads

- `GET /ownerships/{ownershipId}`: one Ownership with `ETag`.
- `GET /property-references/{id}/ownerships?asOf=YYYY-MM-DD`: `{ propertyReferenceId, asOf, completeness, shareSum, items }`, the `VALID` Ownerships covering that day, ordered by `validFrom`, then `ownershipId`. Not paged: `completeness` and `shareSum` describe the whole day.
  - `completeness` (derived, never stored; P2-D4): `COMPLETE` when the shares sum to exactly 1, `INCOMPLETE` when below, `NONE` without Ownerships that day. `shareSum` is the reduced sum of shares (`"0/1"` for `NONE`); `total` keeps its §11 meaning (a count) everywhere and is not used here.
- Without `asOf`: the full history `{ items, page, pageSize, total }` (§11), `VOID` included (marked by `status`), ordered by `validFrom`, then `createdAt`, then `ownershipId`; count and page in one snapshot; `page` from 1, `pageSize` 1–200 (default 50).
- An unknown or foreign PropertyReference is `404`; unknown parameters and a malformed `asOf` are `400`.

### In the database (VC-2-03)

- `CHECK`s: `1 ≤ numerator ≤ denominator ≤ 10000`, `gcd(numerator, denominator) = 1` (stored reduced), `valid_until ≥ valid_from`, and `VOID` exactly with `voided_at` and `void_reason`.
- Composite foreign keys to `property_reference (id, mre_realm_id)` and `party (id, mre_realm_id)`.
- A trigger keeps `share`, owner, PropertyReference, `valid_from`, `acquisition_id` (the column and its composite foreign key to a same-Realm Acquisition come with VC-2-05; until then the response field is always `null`) and the creation fields fixed, `VOID` final, and lets `valid_until` only be set or moved **earlier**, never later or cleared.
- With it, the Party guards of the #39 review (before Ownership relies on `ACTIVE`): `party_type` never changes, and `INACTIVE` is final with its `deactivated_at` and reason (no reactivation), by trigger as the ledger's 0009/0013.


## 26.2 Ownership change (VC-2-04, implemented)

```text
POST /api/v1/property-references/{propertyReferenceId}/ownership-changes
```

A sale, inheritance or transfer as **one atomic command** (P2-D5, BR-OWN-005): the listed Ownerships end on `effectiveDate − 1` and the new ones start on `effectiveDate`, in one transaction. Either everything is written or nothing is.

- **Domain owner:** Ownership. **Authorization:** as §26.1; the PropertyReference, the listed Ownerships and the new owners belong to the caller's Realm.
- **Body** (strict; unknown keys `400`):
  - `effectiveDate` (business date, required): the first day of the new ownership.
  - `reason` (required, trimmed, 1–500): why ownership changes ("Verkauf an B", "Erbfall"); recorded in every AuditRecord of the change.
  - `close`: the `ownershipId`s that end (UUIDs, no duplicates, up to 50).
  - `create`: the new Ownerships (up to 50), each `{ ownerPartyId, share, sourceReferences?, notes? }` with the fields as §26.1; `validFrom` is `effectiveDate`, `validUntil` open. One owner at most once (`400` `DUPLICATE` at `create.<i>.ownerPartyId`).
  - At least one of `close` and `create` is non-empty (`400` `REQUIRED`).
  - `acquisitionId` (optional): as §26.1, `400 NOT_SUPPORTED` until VC-2-05, then applied to every created Ownership.
- **Order of checks:** `400` → PropertyReference unknown/foreign → `404` → the listed Ownerships, in the order given → new owners, in the order given → the invariants → completeness. The first refusal answers; nothing is written.
  - **Listed Ownerships** (P2-D5): each must be `VALID`, belong to **this** PropertyReference, start **before** `effectiveDate` and still be valid on `effectiveDate − 1`. Otherwise `422 INVALID_OWNERSHIP` with `details.ownershipId` and `details.reason`: `NOT_FOUND` (unknown, another Realm or another PropertyReference), `VOID`, `STARTS_ON_OR_AFTER_EFFECTIVE_DATE` (closing would give `validUntil < validFrom`) or `ALREADY_ENDED` (`validUntil < effectiveDate − 1`; history is never moved). A planned later end is shortened to `effectiveDate − 1`; one already ending on that day stays as it is. Owners being closed may be **inactive** (inheritance).
  - **New owners:** unknown or foreign → `404` (`details.partyId`); inactive → `422 PARTY_INACTIVE` (`details.partyId`).
  - **Invariants** (§26.1) over the state after the change: `422 OVERLAPPING_OWNERSHIP` (e.g. a new Ownership for an owner whose current one is not closed) or `422 OWNERSHIP_TOTAL_EXCEEDS_ONE`, with their details.
  - **Completeness:** if the ownership was `COMPLETE` on `effectiveDate − 1`, it must be `COMPLETE` on `effectiveDate` too: a change moves shares, it does not lose them. Otherwise `422 OWNERSHIP_INCOMPLETE` with `details.date` (`effectiveDate`) and `details.shareSum` (that day's sum after the change). An ownership that was not complete before may stay incomplete.
- **Writes, in this order** (review on #44): first all closes (`valid_until = effectiveDate − 1`, in `id` order), then all creates (in the order given). The invariant trigger of 0019 is an immediate row trigger: it checks each statement against the state of the transaction so far, so a create written before the close it relies on would be refused (a sale of A's 1/2 to D while B keeps 1/2 would see 3/2; A buying B's half, close A 1/2 and B 1/2, create A 1/1, would overlap A's open 1/2). In this order every intermediate state satisfies the invariants whenever the final one does: closes only lower sums and shorten periods.
- **No-op:** a change with `create` empty whose listed Ownerships all end on `effectiveDate − 1` already changes nothing: `200` with the same body (`closed` as they are, `created` empty) and no AuditRecord, as every other no-op (e.g. the retry of a close-only change without a key).
- **Success:** `201` with `{ propertyReferenceId, effectiveDate, reason, closed: [Ownership…], created: [Ownership…], completeness, shareSum }` (the Ownerships as §26.1, in the order given; `completeness` and `shareSum` for `effectiveDate`).
  - AuditRecords: `CLOSED` on each closed Ownership (old and new `validUntil`; none for one already ending on `effectiveDate − 1`), `CREATED` on each new one, each with the `reason`; and one `OWNERSHIP_CHANGED` on the PropertyReference with `effectiveDate`, `reason` and the ids, so the change reads as one act.
- **Idempotency (§15):** `Idempotency-Key` with scope `ownership.change`, fingerprint of the normalized body (shares reduced, the `close` ids sorted). Replay `201` with the recorded body and `Idempotent-Replayed: true`; the same key with another payload is `409`. Without a key a retry is never applied twice: one with creates is refused (`OVERLAPPING_OWNERSHIP`), a close-only one answers as the `200` no-op above. Clients should always send one.
- **No `If-Match`:** the command names several Ownerships and checks each against its state under lock; a stale view of them is refused by the rules above, not silently applied.
- **Concurrency and locks:** one READ COMMITTED transaction takes the locks in the order of every Ownership writer (§26.1): the PropertyReference first (the no-op write), then the new owners `FOR SHARE` **in `id` order** (review on #42), then the listed Ownerships `FOR UPDATE` in `id` order. It then reads the Ownerships of the PropertyReference and evaluates the rules; the invariant trigger checks each written row again. So a change never deadlocks with a create, close or void of the same PropertyReference, and a concurrent `deactivate` of a new owner either comes first (`PARTY_INACTIVE`) or waits.
- **Reads:** "queryable over time" is §26.1's `GET …/ownerships?asOf=` (P2-D5); the history shows both the closed and the new Ownerships.

---

# 27. Acquisition API

Decisions P2-D6 (status vs. legal dates), P2-D7 (price once, payments link Transactions) and P2-D8 (confirmation, partial acquisitions) of `docs/development/phase-2-plan.md`.

### Queries

```text
GET /api/v1/acquisitions
GET /api/v1/acquisitions/{acquisitionId}
GET /api/v1/property-references/{propertyReferenceId}/acquisitions
GET /api/v1/acquisitions/{acquisitionId}/costs                      (VC-2-06)
GET /api/v1/acquisitions/{acquisitionId}/payments                   (VC-2-06)
```

### Commands

```text
POST /api/v1/acquisitions
POST /api/v1/acquisitions/{acquisitionId}/cancel
POST /api/v1/acquisitions/{acquisitionId}/costs                     (VC-2-06)
POST /api/v1/acquisitions/{acquisitionId}/costs/{costId}/void       (VC-2-06)
POST /api/v1/acquisitions/{acquisitionId}/payments                  (VC-2-06)
POST /api/v1/acquisitions/{acquisitionId}/payments/{paymentId}/unlink (VC-2-06)
POST /api/v1/acquisitions/{acquisitionId}/confirm                   (VC-2-07, §28)
POST /api/v1/acquisitions/{acquisitionId}/land-building-allocation  (VC-2-08, §27.3)
```

## 27.1 Contract (VC-2-05, implemented: migration 0020)

- **Domain owner:** Acquisition. **Authorization:** as §19.1; an Acquisition belongs to the caller's Realm, and so do its PropertyReference, buyers and sellers. Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`).
- **What it is:** the purchase of a **share** of a PropertyReference (`acquiredShare`, P2-D8): "B buys A's half" is an Acquisition with `acquiredShare = 1/2` and buyer B. It is not tied to MRE `Property.price` (mre-integration §32), and it never creates or changes Ownerships itself: WF-002 creates them with the Acquisition's id (§26.1, §26.2).
- **Status (P2-D6):** `DRAFT` → `CONFIRMED` (VC-2-07) and `DRAFT` → `CANCELLED`. Confirmed and cancelled are final in Phase 2. The legal milestones are **dates**, not states.
- **Response:**
  - `acquisitionId`, `mreRealmId`, `propertyReferenceId`, `status`;
  - `purchasePrice` (Money as §31), `acquiredShare` (reduced fraction, §26.1);
  - `contractDate`, `economicTransferDate`, `landRegistryTransferDate` and the derived `transferDate` (`economicTransferDate`, or `contractDate` while that is unset; P2-D6);
  - `buyerPartyIds`, `sellerPartyIds` (in the order given);
  - `sourceReferences`, `notes`;
  - `cancelledAt`, `cancellationReason`, `confirmedAt` (`null` until VC-2-07);
  - `createdAt`, `version`.
  - Single-Acquisition responses carry `ETag: "<version>"` (§16.1).

### `POST /api/v1/acquisitions`

- **Body** (strict; unknown keys `400`):
  - `propertyReferenceId` (UUID, required).
  - `purchasePrice` (Money as §31, required): the agreed price, **> 0** (`400` `NOT_POSITIVE`), in the Realm's currency (EUR in Phase 2). It is entered once here; there is no `PURCHASE_PRICE` cost (P2-D7).
  - `acquiredShare` (fraction as §26.1, optional, default `"1/1"`).
  - `contractDate` (business date, required; the notarial contract, UC-003's "acquisition date"); `economicTransferDate` and `landRegistryTransferDate` (optional; not before `contractDate`, else `400` `BEFORE_CONTRACT_DATE`). data-model §13.3's `possessionTransferDate` is merged into `economicTransferDate` and is an unknown key.
  - `buyerPartyIds` (1–20 UUIDs, required), `sellerPartyIds` (0–20 UUIDs). No duplicates within a list (`DUPLICATE`), and no Party is both buyer and seller (`400` `BUYER_IS_SELLER` at the seller's position).
  - `sourceReferences` (up to 10 strings of 1–500), `notes` (≤ 2000), trimmed as §26.1.
  - `notarialDocumentId`: `400 NOT_SUPPORTED` until documents exist (as §33.2).
- **Order of checks:** `400` → PropertyReference unknown or foreign → `404` (`details.propertyReferenceId`) → each buyer, then each seller, in the order given: unknown or foreign → `404` (`details.partyId`) → a buyer `INACTIVE` → `422 PARTY_INACTIVE` (`details.partyId`; P2-D1: no new buyer role for an inactive Party). A seller may be inactive (selling ends a relationship).
- **Success:** `201` with the Acquisition (`status = DRAFT`, `version = 1`); AuditRecord `CREATED` with the price, share, dates and parties.
- Several drafts of one PropertyReference may exist (alternatives under negotiation); nothing is unique.
- **Idempotency (§15):** `Idempotency-Key` with scope `acquisition.create`, fingerprint of the normalized body (share reduced, texts trimmed, party lists as given). Replay `201` with the recorded body and `Idempotent-Replayed: true`; another payload with the same key is `409`. Without a key a retry creates a second draft, so clients should always send one.
- **Changing a draft:** there is no `amend` in VC-2-05; a wrong draft is cancelled and created again. An `amend` of drafts comes with the use case that needs it.

### `POST /api/v1/acquisitions/{acquisitionId}/cancel`

- Body `{ "reason": "..." }` (required, trimmed, 1–500). `200` with the Acquisition (`status = CANCELLED`, `cancelledAt`, `cancellationReason`, `version` + 1); AuditRecord `CANCELLED` with the reason.
- Cancelling a cancelled Acquisition is a `200` no-op keeping the first reason and time. A `CONFIRMED` one is final: `409 CONFLICT` with `reason = "ACQUISITION_CONFIRMED"`.
- While `VALID` Ownerships carry its id, cancel is `409 CONFLICT` with `reason = "ACQUISITION_HAS_VALID_OWNERSHIPS"` and `details.ownershipIds` (review on #46): a share from a purchase that never happened must not keep counting. Void them first (§26.1), then cancel.
- **Locks:** the PropertyReference first (the no-op write of every Ownership writer), then the Acquisition `FOR UPDATE`, then its Ownerships are read. That is the order PropertyReference → Parties → Acquisition → Ownerships of every path, so cancel serialises with an Ownership create for the draft (which reads the Acquisition `FOR SHARE`) and with VC-2-06/VC-2-07, without a lock cycle.
- `If-Match` as §16.1; a no-op answers regardless of the version.
- Ownerships are never touched by an Acquisition (P2-D6); `VOID` ones keep the id, for the record. From VC-2-06 on, its costs and payment links stay readable but count nowhere (P2-D6), and cancel serialises with payment writes (P2-D7).

### Reads

- `GET /acquisitions/{id}`: one Acquisition with `ETag`.
- `GET /acquisitions` and `GET /property-references/{id}/acquisitions` (the latter `404` for an unknown or foreign PropertyReference): `{ items, page, pageSize, total }` (§11), ordered by `contractDate` (newest first), then `createdAt`, then `acquisitionId`; count and page in one snapshot. Filters: `status`; on `/acquisitions` also `propertyReferenceId` and `partyId` (buyer or seller). `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`.

### `acquisitionId` on Ownerships (lifting §26.1's `NOT_SUPPORTED`; review on #42)

- `POST /ownerships` and `POST …/ownership-changes` accept `acquisitionId` (UUID). It must name an Acquisition of the same Realm and the **same PropertyReference** (`404` with `details.acquisitionId` otherwise, also for another PropertyReference) whose status is `DRAFT` (`422 ACQUISITION_NOT_DRAFT` with `details.acquisitionId` and `details.status`). In `ownership-changes` it applies to every created Ownership.
- The Acquisition is read under `FOR SHARE`, so a concurrent cancel (which takes it `FOR UPDATE`) either comes first and is seen, or waits. Lock order on every path: PropertyReference, Parties, Acquisition, Ownerships.
- The response's `acquisitionId` is the stored value; it never changes afterwards (frozen-fields trigger).

### In the database (VC-2-05)

- `acquisition`:
  - composite foreign key to `property_reference (id, mre_realm_id)`, and `UNIQUE (id, mre_realm_id, property_reference_id)` for the Ownership link;
  - `status` in (`DRAFT`, `CONFIRMED`, `CANCELLED`); `CANCELLED` exactly with `cancelled_at` and `cancellation_reason`, `CONFIRMED` exactly with `confirmed_at`;
  - price `numeric` with `scale ≤ 2` and `> 0`, `currency` EUR (as the ledger's amounts);
  - `acquired_share` numerator and denominator reduced as `ownership`'s;
  - the transfer dates not before `contract_date`.
- `acquisition_party (acquisition_id, party_id, role, position)`: `role` `BUYER` | `SELLER`; composite foreign keys to the Acquisition and to `party (id, mre_realm_id)`; `UNIQUE (acquisition_id, party_id)` (nobody both buyer and seller).
- A trigger keeps an Acquisition's data fixed after creation: id, Realm, PropertyReference, price and currency, share, the three dates, `source_references`, `notes`, `created_at`, `created_by`. The status columns (`status`, `cancelled_at`, `cancellation_reason`, `confirmed_at`) change only with the transition out of `DRAFT`, and `version`/`updated_at` with it; after it the row is final. Its parties are written only with the draft and never changed or deleted.
- `ownership.acquisition_id`: a composite foreign key `(acquisition_id, mre_realm_id, property_reference_id)` to `acquisition`, so the link is in the Ownership's Realm and PropertyReference; added to `ownership_frozen`'s fixed fields. Both rules between the two hold past the repository too (review on #47): a trigger lets a new Ownership link only a `DRAFT` (status read `FOR SHARE`), and `acquisition_frozen` refuses `DRAFT` → `CANCELLED` while a `VALID` Ownership carries the id. With it, the `0019` trigger message shows sums as `n/d` integers instead of `numeric` decimals (review on #45).

## 27.2 Costs and payments (VC-2-06, implemented: migration 0021)

Decision P2-D7 of `docs/development/phase-2-plan.md`, with P2-D6 for cancelled Acquisitions.

- **What it is:** the purchase price is entered once, on the Acquisition (§27.1). An **AcquisitionCost** is an expected transaction cost (`REAL_ESTATE_TRANSFER_TAX`, `NOTARY`, `LAND_REGISTRY`, `BROKER`, `FINANCING_RELATED`, `OTHER`; there is no `PURCHASE_PRICE`). An **AcquisitionPayment** links a part of a ledger Transaction to the price (`acquisitionCostId = null`) or to one cost. Cash stays in the ledger untouched (ADR-001, ADR-037): no Transaction or split is written by these commands, and there is no `acquisitionId` on splits (§33.2 keeps its `NOT_SUPPORTED`).
- **Authorization:** as §27.1; costs and payments belong to their Acquisition's Realm, and so do the linked Transaction and the counterparty Party. Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`); a cost or payment of another Acquisition is `404` too.
- **Which Acquisitions take writes:** `DRAFT` and `CONFIRMED`. Bills and payments typically arrive after the contract and after the transfer (the tax assessment, the notary's and the land registry's invoices), so confirmation does not close them; "confirmed is final" (P2-D6) is about the Acquisition's own data and its Ownerships. A `CANCELLED` Acquisition takes none: every cost or payment write on it is `409 CONFLICT` with `reason = "ACQUISITION_CANCELLED"`. Its costs and payments stay readable and count nowhere (P2-D6).

### Costs

- **`POST /acquisitions/{id}/costs`**, body (strict):
  - `category` (one of the six above, required);
  - `amount` (Money as §31, required, **> 0** `NOT_POSITIVE`, EUR): the expected amount;
  - `incurredDate` (business date, optional), `counterpartyPartyId` (UUID, optional; a Party of the Realm, any status: the notary need not be active);
  - `sourceReferences`, `notes` as §27.1;
  - `documentId`, `taxClassificationId`: `400 NOT_SUPPORTED` (as §33.2); data-model §14's `transactionSplitId` is replaced by payments and is an unknown key.
- **Order of checks:** `400` → Acquisition unknown or foreign `404` → counterparty `404` (`details.partyId`) → Acquisition `CANCELLED` `409`.
- **Success:** `201` with the cost (`status = ACTIVE`, `version = 1`); AuditRecord `CREATED` on the cost. **Idempotency** as §15, scope `acquisition.cost.create`, fingerprint of the Acquisition id and the normalized body; without a key a retry creates a second cost.
- **`POST /acquisitions/{id}/costs/{costId}/void`**, body `{ "reason": "..." }` (1–500, trimmed): a wrong expected amount is voided and entered again; there is no `amend`. `200` with the cost (`status = VOID`, `voidedAt`, `voidReason`, `version` + 1); AuditRecord `VOIDED`. Voiding a `VOID` cost is a `200` no-op. While payments are linked to it and not unlinked, void is `409 CONFLICT` with `reason = "COST_HAS_PAYMENTS"` and `details.paymentIds`: unlink them first. A `VOID` cost counts nowhere (VC-2-09 leaves it out). `If-Match` on the cost's version as §16.1; a no-op answers regardless.
- **Response:** `costId`, `acquisitionId`, `category`, `amount`, `incurredDate`, `counterpartyPartyId`, `sourceReferences`, `notes`, `status` (`ACTIVE` | `VOID`), `voidedAt`, `voidReason`, the derived `paidAmount` and `paymentStatus`, `createdAt`, `version`; single-cost responses carry `ETag`.

### Payments

- **`POST /acquisitions/{id}/payments`**, body (strict): `transactionId` (UUID, required), `acquisitionCostId` (UUID or `null`, optional; absent or `null` = a payment of the price), `amount` (Money as §31, required, **> 0**, EUR). Installments are several payments; one Transaction may pay several costs (one payment each), and its remainder may stay unlinked.
- **Order of checks:**
  1. `400`;
  2. Acquisition unknown or foreign → `404`; the cost unknown or of another Acquisition → `404` (`details.acquisitionCostId`); the Transaction unknown or foreign → `404` (`details.transactionId`);
  3. Acquisition `CANCELLED` → `409 CONFLICT` `ACQUISITION_CANCELLED`; the cost `VOID` → `409 CONFLICT` `COST_VOID`;
  4. the Transaction not current (§35.3: `CONFIRMED` or `RECONCILED`, and not a reversal) → `422 TRANSACTION_NOT_CURRENT` with `details.status` and `details.correctionRole`; not `OUTFLOW` → `422 NOT_OUTFLOW`; another currency than the Acquisition's → `422 CURRENCY_MISMATCH`;
  5. the live payments of the Transaction plus this one above its amount → `409 INVARIANT_VIOLATION` with `reason = "PAYMENT_EXCEEDS_TRANSACTION"`, `transactionAmount`, `linkedAmount`, `available` (Money);
  6. the counting payments of the cost (or the price) plus this one above its amount → `409 INVARIANT_VIOLATION` with `reason = "PAYMENT_EXCEEDS_COST"` (or `"PAYMENT_EXCEEDS_PRICE"`), `expected`, `paid`, `remaining`.
- **Success:** `201` with the payment, AuditRecord `LINKED` on the payment. **Idempotency** as §15, scope `acquisition.payment.create`; a replay answers the recorded body. Without a key a retry links a second time if the caps allow it, so clients should always send one.
- **`POST /acquisitions/{id}/payments/{paymentId}/unlink`**, body `{ "reason": "..." }` (1–500): `200` with the payment (`unlinkedAt`, `unlinkReason`, `version` + 1); AuditRecord `UNLINKED`. Unlinking an unlinked payment is a `200` no-op. `If-Match` as for void. Allowed on a `DRAFT` or `CONFIRMED` Acquisition, also when the Transaction is no longer current (that is how the user cleans up after a ledger correction).
- **Response:** `paymentId`, `acquisitionId`, `acquisitionCostId`, `transactionId`, `amount`, `counting` (boolean), `notCountingReason` (`null`, or the first of `UNLINKED`, `ACQUISITION_CANCELLED`, `TRANSACTION_CORRECTED`), `transactionStatus`, `replacementTransactionId` (the Transaction's **direct** replacement when corrected, which may itself be corrected since: follow the chain of §35.3 to its current end; `null` after a `reverse`, §35.9), `unlinkedAt`, `unlinkReason`, `createdAt`, `version`; single-payment responses carry `ETag`.

### What counts (derived, never stored)

- A payment is **live** while it is not unlinked and its Acquisition is not `CANCELLED`; it is **counting** while it is live and its Transaction is current (§35.3).
- **Per Transaction:** the live payments sum to at most its amount. A payment of a Transaction corrected since still holds its part until it is unlinked, so the original cannot be linked twice over; the replacement is a new Transaction with its own amount.
- **Per cost and for the price:** `paidAmount` is the sum of the counting payments; `paymentStatus` is `EXPECTED` (no counting payment), `PARTIALLY_PAID` (below the amount) or `PAID` (equal). A sum above the amount is refused (step 6), so `OVERPAID` does not exist. A ledger correction lowers it silently in the ledger's terms but visibly here: the payment reads `TRANSACTION_CORRECTED` with the replacement's id, and the user re-links explicitly (unlink, then link the replacement). Nothing is moved by DE.
- On a `CANCELLED` Acquisition nothing counts: `paidAmount` is `0.00` and `paymentStatus` is `null` for its costs and its price. A `VOID` cost has `paymentStatus = null` too.

### Reads

- `GET /acquisitions/{id}/costs`: `{ items }` in `createdAt`, then `costId` order, `VOID` included; with `?status=ACTIVE|VOID`.
- `GET /acquisitions/{id}/payments`: `{ purchasePrice: { amount, paidAmount, paymentStatus }, items }` in `createdAt`, then `paymentId` order, unlinked included; with `?acquisitionCostId=` (a UUID, or the literal `null` for the price; an empty value is `400`) and `?counting=true|false`.
- Both are unpaged (an Acquisition has a handful of costs and payments) and read in one `REPEATABLE READ READ ONLY` transaction (as `transaction-query-repository.ts`), so the Acquisition, its costs, payments and the Transactions' statuses come from one snapshot. Unknown parameters are `400`.

### Concurrency and locks

- **One serialising path per Acquisition:** every cost or payment write (create, void, link, unlink) first writes the Acquisition's row (the no-op `UPDATE … SET version = version` that §26.1 uses for the PropertyReference), then reads it. Cancel takes the same row `FOR UPDATE` (§27.1), so cancel and every cost or payment write serialise: whichever waits sees the other's result (READ COMMITTED) or is aborted with a serialization failure (REPEATABLE READ), never acts on a stale status. The same holds for two payments of one cost or of the price.
- **Per Transaction:** a link then writes the Transaction's row the same way (the split trigger's touch of §34.2, which 0013 allows on a confirmed Transaction: no field, `version` or `updated_at` changes), and only then sums its live payments. So two links of one Transaction from two Acquisitions serialise, and so does a link with a `correct` or `reverse` of the Transaction (§35.5 locks it `FOR UPDATE`): a link that waited sees the Transaction `CORRECTED` and is refused; a correction that waited leaves the committed payment, which then stops counting.
- **Lock order:** Acquisition, then Transaction. Ownership writers take PropertyReference → Parties → Acquisition (`FOR SHARE`) and never a Transaction; the ledger takes Transaction → accounts and never an Acquisition; cancel and VC-2-07's confirm take PropertyReference → Acquisition. No path takes them the other way round, so there is no lock cycle.
- Each write runs in one READ COMMITTED transaction: claim the `Idempotency-Key` → lock and re-read the Acquisition (and the cost) → lock and read the Transaction → check → write → AuditRecord → record the key. A refusal rolls back the claim (§15).

### In the database (VC-2-06, migration 0021)

- `acquisition_cost`: composite foreign key `(acquisition_id, mre_realm_id)` to `acquisition`, `(counterparty_party_id, mre_realm_id)` to `party`; `UNIQUE (id, acquisition_id)` for the payment link; `category` CHECK; amount `numeric`, scale ≤ 2, `> 0`, `currency` EUR; `status` `ACTIVE` | `VOID`, `VOID` exactly with `voided_at` and `void_reason`.
- `acquisition_payment`: composite foreign keys `(acquisition_id, mre_realm_id)` to `acquisition`, `(acquisition_cost_id, acquisition_id)` to `acquisition_cost` (so the cost is of the same Acquisition), and `(transaction_id, mre_realm_id, currency)` to `ledger_transaction`'s existing `(id, mre_realm_id, currency)` key (so the Transaction is of the Realm and in the payment's currency); the ledger's tables are not altered. Amount as the cost's; unlinked exactly with `unlinked_at` and `unlink_reason`.
- **Frozen:** a cost's data never changes, its only step is `ACTIVE` → `VOID`; a payment's never changes, its only step is the unlink; `version`/`updated_at` move only with that step; neither is deleted.
- **Guards past the repository** (P2-D11), in triggers that take the locks above themselves:
  - every insert or step of a cost or payment writes the Acquisition's row first and refuses a `CANCELLED` one (`ACQUISITION_CANCELLED`);
  - a payment insert refuses a `VOID` cost, writes the Transaction's row and refuses a Transaction that is not current or not `OUTFLOW`, then checks both caps (per Transaction over the live payments, per cost or price over the counting ones);
  - a cost's void is refused while payments not unlinked are linked to it.
- Concurrency tests (two connections, RC and RR) per guard: two links exceeding one Transaction; two links exceeding one cost and the price; link against `cancel`; `unlink` and void against `cancel` (review on #37); link against `void` of the same cost (review on #48: without the Acquisition touch the void would not see the uncommitted payment, and the link's foreign key takes only `KEY SHARE` on the cost); link against a `correct` of the Transaction; and a counter-check that removes each lock and sees its test fail.

---

## 27.3 Land/building allocation (VC-2-08, contract)

Decision P2-D9 of `docs/development/phase-2-plan.md`. The allocation is recorded **as entered** (contract figure, BMF Arbeitshilfe, appraisal or advisor); Phase 2 does not compute the allocable basis from price and costs, since which costs enter it is a tax rule (`germany/taxation.md`, VERIFY, Phase 7). VC-2-09 distributes the current one among the buyers; depreciation (Phase 8) decides which review states it accepts.

```text
POST /api/v1/acquisitions/{acquisitionId}/land-building-allocation
GET  /api/v1/acquisitions/{acquisitionId}/land-building-allocations
```

- **Authorization:** as §27.1; the allocation and its advisor belong to the Acquisition's Realm.
- **Which Acquisitions take one:** `DRAFT` and `CONFIRMED`, since an allocation is not required to confirm (P2-D8) and often arrives later (an appraisal, the advisor); a `CANCELLED` one is `409 CONFLICT` with `reason = "ACQUISITION_CANCELLED"` (as §27.2).

### `POST …/land-building-allocation`

- **Body** (strict):
  - `totalAllocableAmount` (Money as §31, **> 0**), `landAmount` and `buildingAmount` (Money, **≥ 0**; a zero land part is an Erbbaurecht, a zero building part undeveloped land), all EUR. `landAmount + buildingAmount = totalAllocableAmount` **exactly**, else `400` with `ALLOCATION_SUM_MISMATCH` at `totalAllocableAmount` (no rounding tolerance, P2-D9).
  - `method`: `PURCHASE_CONTRACT` | `BMF_TOOL` | `APPRAISAL` | `ADVISOR` | `OTHER`.
  - `reviewState` (data-model §6.7, optional, default `UNREVIEWED`): `UNREVIEWED` | `NEEDS_REVIEW` | `CONFIRMED` | `ADVISOR_CONFIRMED`. `SUGGESTED` is reserved for machine suggestions and is `400`.
  - `effectiveDate` (business date, optional, default the Acquisition's transfer date, P2-D6).
  - `advisorPartyId` (UUID, optional; a Party of the Realm, any status), `sourceReferences`, `notes` as §27.1; `documentIds`: `400 NOT_SUPPORTED` (as §33.2). Percentages are not accepted (they are derived).
  - `supersedes` (UUID or `null`): the id of the current allocation this one replaces, `null` for the first. It is the optimistic check of this command, since allocations are never changed, only superseded (no `If-Match`).
- **Order of checks:** `400` → Acquisition unknown or foreign `404` → advisor unknown or foreign `404` (`details.partyId`) → `CANCELLED` `409` → `supersedes` is not the current allocation's id (or not `null` when there is none) `409 CONFLICT` with `reason = "CURRENT_ALLOCATION_CHANGED"` and `details.currentAllocationId` (the id or `null`).
- **Success:** `201` with the allocation; the previous current one gets `supersededAt` and `supersededById`. AuditRecords: `CREATED` on the new allocation (amounts, method, review state, `supersedes`), `SUPERSEDED` on the old one.
- **Idempotency** as §15, scope `acquisition.allocation.create`, fingerprint of the Acquisition id and the normalized body. Without a key a retry is safe anyway: after the first success `supersedes` no longer names the current allocation and the retry is `409 CURRENT_ALLOCATION_CHANGED`.
- **A correction** (other amounts, another review state, an advisor's confirmation) is a new allocation that supersedes the current one; nothing is edited in place, and the history stays readable.

### Response and read

- **Allocation:** `allocationId`, `acquisitionId`, the three amounts (Money), `method`, `reviewState`, `effectiveDate`, `advisorPartyId`, `sourceReferences`, `notes`, `supersedesId`, `supersededAt`, `supersededById`, `current` (boolean), `createdAt`, and the derived `landShare` and `buildingShare` (§87 decimal strings, `land / total` and `building / total` rounded half-even to four places, for display only: they need not add to exactly `1.0000`; the amounts are the record).
- `GET …/land-building-allocations`: `{ current, items }`: the current allocation or `null`, and the whole history newest first (`createdAt`, then id), in one `REPEATABLE READ READ ONLY` transaction; unpaged (a handful per Acquisition); unknown parameters are `400`.

### Concurrency and locks

- One READ COMMITTED transaction: claim the key → write the Acquisition row (the no-op of §27.2, so it serialises with cancel, confirm and cost or payment writes) → read the current allocation → check `supersedes` → set the old one's `supersededAt`/`supersededById` → insert the new one → AuditRecords → record the key. Two concurrent allocations of one Acquisition therefore run one after the other, and the second gets `409 CURRENT_ALLOCATION_CHANGED` (it names the replaced one); a cancel that comes first is seen.
- Lock order: Acquisition only (the advisor is read without a lock: an inactive advisor is allowed).

### In the database (migration 0023)

- `land_building_allocation`: composite foreign keys `(acquisition_id, mre_realm_id)` to `acquisition` and `(advisor_party_id, mre_realm_id)` to `party`; amounts `numeric`, scale ≤ 2, total `> 0`, land and building `≥ 0`, `land + building = total` (CHECK), EUR; `method` and `review_state` CHECKs; `effective_date` not null.
- At most one current allocation per Acquisition: a unique index on `acquisition_id` where `superseded_at IS NULL`.
- The chain stays in one Acquisition and is consistent: `supersedes_id` references `(id, acquisition_id)` of the same Acquisition and is unique (one successor at most); `superseded_by_id` and `superseded_at` are set together, once, and only to the row whose `supersedes_id` names this one; a deferred constraint trigger checks at commit that every superseded row has that successor, so no allocation is superseded without one.
- Frozen: data never changes, rows are never deleted; the only step is setting `superseded_at`/`superseded_by_id`. A new row is inserted only current (not superseded), and only for an Acquisition that is not `CANCELLED` (its row written first, `acquisition_touch_open` of 0021).
- Tests:
  - **Past the repository**, each with a counter-check: the sum CHECK; a second current row; a supersede without a successor (deferred); a successor in another Acquisition; a change of data; a delete; an insert on a `CANCELLED` Acquisition; an insert already superseded.
  - **Concurrency:** two allocations of one Acquisition (RC: the second is `CURRENT_ALLOCATION_CHANGED`; RR past the repository: `40001`); an allocation against a cancel (both orders).

# 28. Acquisition Confirmation

Confirmation should validate:

- PropertyReference exists
- Purchase Price exists
- Buyers exist
- ownership data is consistent
- required acquisition data is complete
- any configured review requirements are satisfied

## 28.1 `POST /api/v1/acquisitions/{acquisitionId}/confirm` (VC-2-07, implemented: migration 0022)

Decision P2-D8 of `docs/development/phase-2-plan.md`, with P2-D6 (status) and P2-D4 (completeness). The list above maps to it as: the PropertyReference and the price exist by construction (§27.1: foreign key, price > 0, both fixed); buyers exist and are active; the ownership data is the Ownership set below; Phase 2 has no further required data and no configured review requirements (a land/building allocation is **not** required, P2-D8).

- **Request:** no body (an empty object `{}` is accepted; any key is `400`). `If-Match` as §16.1 on the Acquisition's version; a no-op answers regardless of the version.
- **Order of checks** (as §27.2): `400` → unknown or foreign `404` → already `CONFIRMED`: `200` no-op, without a version check → `CANCELLED`: `409`, also with a stale `If-Match` (a final status answers before the version, as cancel in §27.1) → `If-Match` `412` → `422 CONFIRMATION_BLOCKED`.
- **Domain owner:** Acquisition. **Authorization:** as §27.1.
- **Status:**
  - `DRAFT` → `CONFIRMED`: `200` with the Acquisition (§27.1: `status = CONFIRMED`, `confirmedAt`, `version` + 1); AuditRecord `CONFIRMED` with the transfer date and the ids of the Ownerships it confirms.
  - Already `CONFIRMED`: `200` with the Acquisition unchanged, `Idempotent-Replayed: true`, no new version or AuditRecord (as §34.2).
  - `CANCELLED`: `409 CONFLICT` with `reason = "ACQUISITION_CANCELLED"`.
- **Requirements** (P2-D8), evaluated on the transfer date `d` (P2-D6) over the `VALID` Ownerships that carry this `acquisitionId` ("its Ownerships"); every one that fails is reported, in this order, as `422 CONFIRMATION_BLOCKED` with `details.violations` (a list of `{ code, … }`):
  1. `BUYER_INACTIVE` (`partyId`): each buyer must be an active Party (P2-D1);
  2. `OWNERSHIP_NOT_FROM_TRANSFER_DATE` (`ownershipId`, `validFrom`, `transferDate`): each of its Ownerships starts on `d`;
  3. `OWNER_NOT_A_BUYER` (`ownershipId`, `ownerPartyId`): each is held by a buyer;
  4. `BUYER_WITHOUT_OWNERSHIP` (`partyId`): every buyer holds one (also when it has none at all);
  5. `SHARE_SUM_MISMATCH` (`expected`, `actual`, reduced fractions as §26.1): their shares sum to exactly `acquiredShare`;
  6. `OWNERSHIP_INCOMPLETE` (`date`, `shareSum`): the PropertyReference's ownership is `COMPLETE` on `d` (§26.1, P2-D4), counting **all** its `VALID` Ownerships on that day, also those of other owners.
  Sellers are not checked: a seller's Ownership is closed or changed by WF-002 (§26.2), and requirement 6 catches a sum above or below one.
- **Effect:** status only. Confirmation never creates, closes or changes Ownerships (P2-D8); costs and payments stay writable (§27.2).
- **After confirmation:**
  - The Acquisition is final (P2-D6): cancel answers `409 ACQUISITION_CONFIRMED` (§27.1).
  - Its Ownerships can no longer be **voided**: `POST /ownerships/{id}/void` answers `409 CONFLICT` with `reason = "ACQUISITION_CONFIRMED"` and `details.acquisitionId` (§26.1). They can still be **closed**, directly or by an ownership change (§26.2): a later sale ends them, it does not undo the purchase.
  - New Ownerships cannot carry its id (`422 ACQUISITION_NOT_DRAFT`, §27.1).
  - Confirmation checks completeness at the time of confirming. A later void of **another** owner's recording error on the PropertyReference is not blocked (that Ownership belongs to no confirmed purchase); the read then shows `INCOMPLETE` as for any gap.
- **Concurrency and locks** (one READ COMMITTED transaction, in the order of every path, §27.1): the PropertyReference first (the no-op write of every Ownership writer), then the buyers `FOR SHARE` in id order (a concurrent `deactivate` comes first and is seen, or waits), then the Acquisition `FOR UPDATE`, then its Ownerships and the PropertyReference's Ownerships on `d` are read. So confirm serialises with every Ownership create, close, void and change of the PropertyReference (they take it first), with cancel (same Acquisition lock, same order) and with cost and payment writes (they write the Acquisition row, §27.2). A void of one of its Ownerships takes PropertyReference → Acquisition → Ownership `FOR UPDATE` and so sees a committed confirmation.
- **In the database (migration 0022):**
  - `acquisition_frozen` checks requirements 1–6 again on `DRAFT` → `CONFIRMED`, so a confirmation past the repository is held to the same rules; an Acquisition is only **inserted** as `DRAFT`, so the check cannot be bypassed by inserting a confirmed row (as 0011 refuses inserting `CORRECTED`).
  - `ownership_frozen` refuses `VALID` → `VOID` while the Ownership's Acquisition is `CONFIRMED`.
  - **Which locks the guards take (review on #50).** The confirm check does **not** write the PropertyReference. It holds the Acquisition row (the `UPDATE` locks it) and reads the buyers `FOR SHARE` and the Ownerships. This is enough because every concurrent write that confirmation would forbid already meets it on the Acquisition row. The others need no lock:
    - **Writes on the Acquisition row:** a new Ownership carrying the id, a void of one carrying it, a cancel. From 0022 the two Ownership triggers (`ownership_acquisition_draft` of 0020, and the void guard) write the Acquisition row with the no-op `UPDATE … SET version = version` instead of reading it `FOR SHARE`. The repository's own read of the Acquisition in §26.1/§27.1 becomes the same write, so it never upgrades a share lock. A `deactivate` of a buyer meets the buyers' `FOR SHARE`. So the confirm sees each of these (READ COMMITTED), or the later of the two fails to serialise (`40001`, REPEATABLE READ: a share lock alone would not abort a stale snapshot, a write does).
    - **Writes that need no lock:** a close of any Ownership, a void of another owner's, a create for another owner within Σ ≤ 1. They stay allowed after confirmation, so a confirm that misses one is equivalent to the serial order "confirm, then that write". Under REPEATABLE READ a raw confirm and a raw close of another owner both commit, and that is correct, not `40001`.
    - **No deadlock from the reverse order:** past the repository the trigger takes Acquisition → buyers `FOR SHARE`, the reverse of an Ownership create's Parties → Acquisition. Share locks on Parties do not conflict with each other, and the only exclusive Party lock (`deactivate`, `FOR UPDATE`) never takes an Acquisition. So this order cannot close a cycle. The repository path holds the buyers before the Acquisition anyway.
  - From the review on #49: every status step raises `version` by exactly one (Acquisition cancel and confirm, cost void, payment unlink; as 0013 for Transactions), and a cost is only inserted `ACTIVE`, a payment only not unlinked.
- **Schema tests past the repository** (as #47 and §27.2), each with a counter-check (the guard neutralised, the test red):
  - one raw `DRAFT` → `CONFIRMED` per requirement 1–6, refused with its code;
  - an insert as `CONFIRMED` or `CANCELLED`, refused;
  - a raw void of an Ownership of a `CONFIRMED` Acquisition, refused; a raw close of it, allowed;
  - from #49:
    - a status step whose `version` ≠ `OLD.version + 1` (cancel, confirm, cost void, unlink), refused;
    - an insert of a cost as `VOID`, refused;
    - an insert of a payment already unlinked, refused.
- **Concurrency tests:**
  - Through the repository (RC): confirm against an Ownership create, close and void on the same PropertyReference; confirm against `deactivate` of a buyer; confirm against cancel; confirm against a payment link; a void of its Ownership against confirm.
  - Past the repository (RR):
    - a raw confirm against a raw void of its Ownership, a raw insert carrying its id, and a raw `deactivate` of a buyer: `40001`;
    - a raw confirm against a raw close of another owner: both commit.
  - Each lock is counter-checked.

---

# 29. FinancialAccount API

Use `FinancialAccount`, not `Account`. DE references to a financial account use `financialAccountId`.

### Queries

```text
GET /api/v1/financial-accounts
GET /api/v1/financial-accounts/{financialAccountId}
```

### Commands

```text
POST /api/v1/financial-accounts
POST /api/v1/financial-accounts/{financialAccountId}/close
```

Account types (`accountType`, per `data-model.md` §16): `BANK`, `SECURITY_DEPOSIT`, `LOAN_SETTLEMENT`, `CASH`, `OTHER`. The MVP may support a narrower subset.

## 29.1 `POST /api/v1/financial-accounts` — contract

- **Domain owner:** Financial Ledger.
- **Authorization:** authenticated MRE identity; scoped to the caller's Realm; the account is created within that Realm.
- **Field mapping:** request/response fields match the domain model verbatim (`data-model.md` §16): `accountType`, `displayName`, `currency`, `status`, optional `iban`. The response id is `financialAccountId` (the domain `id`). A FinancialAccount has **no** `propertyReferenceId` — a cash account is not owned by one property; property associations live on Transactions/Splits, not on the account.
- **Inputs:**
  ```json
  {
    "accountType": "BANK",
    "displayName": "Girokonto ...",
    "currency": "EUR",
    "iban": "DE..."
  }
  ```
  `accountType` from the list above; `currency` must be supported (Phase 1: at least `EUR`); `iban` is optional and stored as an external identifier only, never as internal identity.
- **Outputs:** `201 Created` with the `FinancialAccount` (`financialAccountId`, `accountType`, `displayName`, `currency`, `status = OPEN`, Realm, timestamps).
- **Error codes:** `400` invalid/unsupported `accountType` or `currency`; `401/403` missing identity / wrong Realm; `409` an `Idempotency-Key` reused with a **different** payload.
- **Idempotency:** accepts an `Idempotency-Key`. The same key with a semantically identical payload returns the original account (idempotent replay, no second account created); the same key with a different payload returns `409`.
- **Side effects:** creates the account; writes an AuditRecord.

`POST /{financialAccountId}/close` sets `status = CLOSED`; historical Transactions remain valid (`data-model.md` §16). Rejected if the account is not in the caller's Realm.

## 29.2 Implementation (VC-1-03)

- **Validation (`400 VALIDATION_ERROR`, `details.fields[]` with `REQUIRED` / `INVALID_FORMAT`):** `accountType` from the five types; `displayName` trimmed, 1–200 characters; `currency` supported (Phase 1: `EUR`); `iban` optional, normalized (spaces removed, upper case) and checked for structure and the ISO 7064 mod-97 checksum. An `Idempotency-Key` must be 1–255 visible ASCII characters.
- **Idempotency:** the key is scoped to the Realm and the command. "Semantically identical" means the same **normalized** payload, so `DE89 3704 …` and `DE893704…` are one request. A replay answers exactly like the original (`201`, the same body as recorded at creation, e.g. still `OPEN` / `version 1` after the account was closed) with the header `Idempotent-Replayed: true`. Concurrent requests with the same key create exactly one account.
- **Close:** `200` with the account (`status = CLOSED`, `closedAt`, `version` +1, AuditRecord `CLOSED`). Closing a closed account is a `200` no-op without an AuditRecord. An id that is not a UUID is `400`; an unknown account or one of another Realm is `404`.
- **Response:** `financialAccountId`, `mreRealmId`, `accountType`, `displayName`, `currency`, `iban` (normalized or `null`), `status`, `createdAt`, `closedAt`, `version`.

---

# 30. Transaction API

### Queries

```text
GET /api/v1/transactions
GET /api/v1/transactions/{id}
GET /api/v1/property-references/{propertyReferenceId}/transactions
```

Useful filters:

- date range
- account
- property
- status
- `reviewable` (pre-classification transactions: `status` ∈ { `IMPORTED`, `UNREVIEWED` })
- financial category
- counterparty
- source
- unreconciled
- needs review

## 30.1 Implementation (VC-X-21)

- **`GET /api/v1/transactions/{id}`:** `200` with the Transaction (§31.2 plus the confirmation and correction fields) and its `splits` (as §33.2, in position order), with `ETag: "<version>"` for the next `If-Match` (§16.1). Both are read in one snapshot. Unknown or foreign → `404`, a malformed id → `400`.
- **`GET /api/v1/transactions`:** `200` with `{ items, page, pageSize, total }` (§11), newest booking first (then creation, then id). `items` are Transactions without their splits. Filters, all optional and combined with AND:
  - `financialAccountId`;
  - `status`: a comma-separated list, any of them;
  - `provenance` (the source of §30): a comma-separated list of `MANUAL`, `BANK_CSV`, `BANK_API`, `MIGRATION`, `CORRECTION`, any of them (e.g. `provenance=BANK_CSV` for imported ones); another value is `400`. A correction's reversal and replacement are `CORRECTION` (data-model §17.8): for a corrected import, `provenance=BANK_CSV` still lists the `CORRECTED` original but not its reversal and replacement, and with `current=true` the whole chain drops out (the original by status, the replacement by provenance; review notes on #35 and #36);
  - `reviewable=true`: `IMPORTED` or `UNREVIEWED`, and together with `status` both must hold;
  - `propertyReferenceId`: the Transaction's own **or** one of its splits';
  - `financialCategoryCode`: at least one split of that category (a code such as `RENT_BASE`). Unsplit Transactions never match. A deactivated category still matches its historical splits. An unknown code matches nothing, unlike in the split commands (§33), where it is `400 UNKNOWN_CATEGORY`: a read filter for a code that has no splits is an empty answer, not an error (review note on #34). A malformed code is `400`;
  - `bookingDateFrom` / `bookingDateTo`: inclusive, `400 INVALID_RANGE` when inverted;
  - `current=true`: only the current Transactions of §35.3, i.e. `CONFIRMED` or `RECONCILED` and not a reversal. A chain shows only its last member: neither the `CORRECTED` originals nor their reversals. Combined with `status` like the other filters, so `current=true&status=RECONCILED` lists the reconciled ones and `current=true&status=CORRECTED` lists nothing. Summing a `current=true` list (signed by `direction`, over all pages) gives the net effect of §35.3 per account and period; per category and PropertyReference the current Transactions' splits are needed, since the list items carry none (review note on #31).
- **`GET /api/v1/property-references/{propertyReferenceId}/transactions`:** the same list with `propertyReferenceId` taken from the path (the Transaction's own or one of its splits'), with the same filters and paging. A `propertyReferenceId` query parameter is unknown there (`400`). An unknown or foreign PropertyReference is `404 NOT_FOUND` with `details.propertyReferenceId`, not an empty page; a malformed id is `400`.
- **Paging:** `page` starts at 1. `pageSize` is 1–200, default 50. `total` and `items` come from the same snapshot.
- **Query plan (VC-X-19, migration 0015):** the page's ids are read in list order from the index `(mre_realm_id, booking_date DESC, created_at DESC, id DESC)`, and the scan stops at offset + limit. Only then is the DTO read for those rows, so the two link subqueries (`reversalTransactionId`, `replacementTransactionId`) run once per row of the page, each an index probe, and never for the rows the offset skips. A plan test (`EXPLAIN`) holds this. A deep page still walks its offset in the index; keyset paging is a later choice.
- **Refusals:** unknown parameters are `400`.
- **Realm:** only the caller's Realm is ever read; another Realm's ids simply match nothing.
- **No match possible:** `status` together with `reviewable=true` without a common status (e.g. `status=CONFIRMED&reviewable=true`) is an empty page, not an error.
- **Raw list:** without `status` or `current` the list also holds `CORRECTED` originals, reversals and `IGNORED` Transactions.
- **Not yet:**
  - The filters for counterparty (no counterparty fields on Transactions yet), unreconciled (Phase 4, reconciliation) and needs review (meaning still open).

---

# 31. Create Manual Transaction

```text
POST /api/v1/transactions
```

Manual creation should be allowed but provenance must be explicit.

Example:

```json
{
  "financialAccountId": "...",
  "bookingDate": "2026-09-01",
  "amount": {
    "amount": "1250.00",
    "currency": "EUR"
  },
  "direction": "INFLOW",
  "description": "Rent September",
  "propertyReferenceId": "...",
  "provenance": "MANUAL"
}
```

## 31.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped; the target `financialAccountId` must belong to that Realm.
- **Inputs:** `financialAccountId` (required), `amount` (non-negative Money + `currency`, required), `direction` `INFLOW|OUTFLOW` (required), `bookingDate` (required); optional `valueDate`, `description`, `propertyReferenceId`, `rentalContractReferenceId`; `provenance = MANUAL`.
- **Outputs:** `201 Created` with the Transaction (`status = UNREVIEWED`).
- **Error codes:** `400` negative amount, missing `direction`, amount not representable in the currency scale, or unsupported currency; `404` unknown / other-Realm `financialAccountId`; `409` an `Idempotency-Key` reused with a **different** payload.
- **Idempotency:** accepts an `Idempotency-Key`. The same key with a semantically identical payload returns the original Transaction (no duplicate); the same key with a different payload returns `409`.
- **Side effects:** creates one Transaction; writes an AuditRecord.

## 31.2 Implementation (VC-1-04)

- **Money:** `amount` is `{ "amount": "<decimal string>", "currency": "EUR" }`. A JSON number or exponent notation is `400` (no float in transit). Field codes: `NEGATIVE_AMOUNT`, `SCALE_EXCEEDED` (more than two decimals for EUR, never rounded), `UNSUPPORTED_CURRENCY`, `AMOUNT_OUT_OF_RANGE`; `CURRENCY_MISMATCH` when it differs from the account's currency (no FX, data-model §17.7). Zero is allowed (non-negative, §17.4).
- **Dates:** `bookingDate` (required) and `valueDate` are real calendar dates `YYYY-MM-DD` within 1900–2100 (§88); timestamps or impossible dates are `400 INVALID_FORMAT`, other years `400 OUT_OF_RANGE`. Stored as `date`, never as a timestamp.
- **Optional fields:** an explicit `null` for `valueDate`, `description` or `propertyReferenceId` means the same as omitting it.
- **References:** `financialAccountId` and the optional `propertyReferenceId` must exist **in the caller's Realm**, otherwise `404` (same answer for unknown and foreign). The schema enforces this too (composite foreign keys with the Realm).
- **Decisions not fixed by §31.1:**
  - **Closed account → `409 CONFLICT`** with `details.reason = "ACCOUNT_CLOSED"`. Earlier Transactions stay valid (data-model §16), only new ones are refused. The account is locked `FOR SHARE` while posting, so a concurrent close waits and cannot slip in between check and insert.
  - **`rentalContractReferenceId` → `400 NOT_SUPPORTED`** until `RentalContractReference` exists (VC later), instead of storing an unchecked id.
  - `provenance` may be omitted or `MANUAL`; anything else is `400` (other provenances come from imports).
- **Idempotency:** as §15. The fingerprint is the normalized payload (`"1250"` and `"1250.00"` are one request; id case is ignored). A replay answers with the Transaction as created, before any check, so it still succeeds after the account was closed. A **rejected** request rolls back its key claim: the client may fix the request and retry with the same key.
- **Response:** `transactionId`, `mreRealmId`, `financialAccountId`, `amount`, `direction`, `bookingDate`, `valueDate`, `description`, `propertyReferenceId`, `provenance`, `status`, `createdAt`, `version`.

## 31.3 Amend an unconfirmed Transaction (VC-X-16)

```text
POST /api/v1/transactions/{id}/amend
```

An explicit command, not a `PATCH` (§3). A confirmed Transaction is never amended; it is corrected (§35).

- **Body:** only the fields to change, at least one. The fields are `financialAccountId`, `amount`, `direction`, `bookingDate`, `valueDate`, `description` and `propertyReferenceId`, with the rules of §31.2. An explicit `null` clears `valueDate`, `description` or `propertyReferenceId`. Unknown keys and an empty body are `400`.
- **Amendable:** `IMPORTED`, `UNREVIEWED`, `CLASSIFIED`. Otherwise `409 CONFLICT` with `reason = "NOT_AMENDABLE"` and the `status`. For a confirmed Transaction use `correct`; for an `IGNORED` one, `restore` it first.
- **Imported Transactions** (`provenance` not `MANUAL`) keep the values of their bank row: account, amount, direction, dates **and `description`**.
  - Changing any of them is `409 CONFLICT` with `reason = "IMPORTED_FIELDS_FIXED"` and `fields`. Only `propertyReferenceId` changes. Repeating a current value is fine.
  - `description` is the bank's Verwendungszweck, and its only copy (AGENTS.md §22: source information is not destroyed). Review items compare it side by side (§32.3), and rent matching reads it (§38).
  - A note of the user's own comes later as a separate field.
  - A wrong bank row is ignored, or corrected after confirmation, which keeps the original and its import identity (§35.3).
- **Account:**
  - The target must be in the Realm (`404`) and in the amount's currency (`400 CURRENCY_MISMATCH`).
  - Moving to a **different, closed** account is `409 ACCOUNT_CLOSED`. The Transaction's own account may have been closed since, as in §35.2.
  - The account is locked `FOR SHARE` after the Transaction (lock order §35.5).
- **Splits:**
  - A changed amount invalidates the split set of a `CLASSIFIED` Transaction. The set is dropped, and the Transaction returns to `UNREVIEWED` (only manual Transactions can change their amount).
  - The response carries `splitsDropped: true` next to the Transaction's fields and the new `status`, and the AuditRecord carries `splitsDropped` too. Otherwise the response has `splitsDropped: false`.
  - Other changes keep the split set, and with it `CLASSIFIED`.
- **`200`** with the Transaction (version + 1, AuditRecord `AMENDED` with each changed field's old and new value) and `splitsDropped`. Values equal to the current ones are a `200` no-op without a new version or AuditRecord (naturally idempotent, like §33).
- **Concurrency:** the row lock serializes two amendments. With `If-Match` (§16.1) the second of two edits based on the same version gets `412 VERSION_CONFLICT` instead of silently overwriting the first; without it, the later one wins.

## 31.4 Ignore and restore (VC-X-16)

```text
POST /api/v1/transactions/{id}/ignore     { "reason": "…" }
POST /api/v1/transactions/{id}/restore
```

- **`ignore`:**
  - Takes an `IMPORTED`, `UNREVIEWED` or `CLASSIFIED` Transaction to `IGNORED` (domain-model §21). It is then excluded from ledger totals, not confirmable and not amendable. Its splits are kept and cannot be replaced through the API (§33 refuses `IGNORED`).
  - That freeze is enforced by the application, not the database: `transaction_split_frozen` (0009) covers only the confirmed states. `restore` therefore relies on the splits being unchanged, and a later confirmation still re-checks the sum (0010).
  - `reason` is required (trimmed, 1–500) and goes into the AuditRecord `IGNORED`.
  - Already `IGNORED` is a `200` no-op with `Idempotent-Replayed: true`.
  - A confirmed Transaction is `409 CONFLICT` with `reason = "NOT_IGNORABLE"`: it is corrected, not ignored.
  - An ignored imported row still counts for deduplication, so a re-import does not bring it back.
- **`restore`:**
  - Takes an `IGNORED` Transaction back to `CLASSIFIED` if it kept a split set. Those splits still cover its amount, which cannot change while ignored.
  - Otherwise it goes back to its entry status (`UNREVIEWED` for manual Transactions, `IMPORTED` for imported ones).
  - Writes the AuditRecord `RESTORED`. Anything not `IGNORED` is `409 CONFLICT` with `reason = "NOT_IGNORED"` and the `status`.
  - **Retry:** unlike `ignore`, a repeated `restore` is not a `200` no-op, because the target state is not known from the request alone. A client whose first answer was lost gets `409 NOT_IGNORED`. The `status` there is the state the first `restore` reached, so `NOT_IGNORED` with an unconfirmed `status` means "already restored".
- Both take the Transaction's row lock (§34.2) and answer `404` for an unknown or foreign Transaction.

---

# 32. Bank Import API

```text
POST /api/v1/imports/bank-transactions
GET  /api/v1/imports/{importBatchId}
GET  /api/v1/imports/{importBatchId}/review-items
POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve
```

Input may initially use CSV upload.

Responsibilities: parse, validate, normalize, fingerprint, detect duplicates, create `IMPORTED` Transactions for genuinely new rows, flag ambiguous cross-file matches for human review (creating no Transaction), preserve source metadata.

## 32.1 Contract

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the target `financialAccountId` must belong to that Realm.
- **Inputs:** multipart CSV upload plus:
  ```json
  {
    "financialAccountId": "...",
    "adapterId": "generic-csv",
    "adapterVersion": "1",
    "columnMapping": {
      "bookingDate": "Buchungstag",
      "amount": "Betrag",
      "counterpartyName": "Empfaenger",
      "counterpartyIban": "IBAN",
      "description": "Verwendungszweck"
    }
  }
  ```
  **Normalized row schema** (after mapping/normalization, per `data-model.md` §70.2–70.3): `bookingDate`, optional `valueDate`, non-negative `amount` + derived `direction`, `currency`, `counterpartyIbanRaw` / `counterpartyNameRaw`, `description`, optional `externalTransactionId`.
- **Outputs:** `201 Created` with an `ImportBatch` summary: `importBatchId`, `transactionCount`, `duplicateCount`, `needsReviewCount`, `errorCount`, and per-row results (`created` / `duplicate` / `needs_review` / `error`, each with a reason where applicable).
  - A `needs_review` result carries its **`reviewItemId`** and the **owning `importBatchId`** of that item (the `ImportReviewItem`, `data-model.md` §20A), plus the `conflictingTransactionIds`, so it can be listed (§32.3) and resolved (§32.2) under the correct path. An **adapter-version conflict** (`data-model.md` §70.4) is reported as `needs_review` with a **new** item owned by this batch.
  - A `duplicate` result is **structured by its cause** via a `duplicateOf` discriminator:
    - `TRANSACTION` — the row's identity matches an already-imported Transaction; the result references that `transactionId`;
    - `RESOLVED_REVIEW_ITEM` — the row re-presents a source identity whose `ImportReviewItem` is already `RESOLVED` (`data-model.md` §20A Ownership and Retry): the result carries the `reviewItemId`, its **owning `importBatchId`**, and the stored `resolution`; when `resolution = CREATE` it also carries the **same** `createdTransactionId`, and when `resolution = SKIP` the `createdTransactionId` field is **absent by definition** (no Transaction exists). In both variants **no new decision is made and no additional Transaction is created**.
  - `needsReviewCount` counts only the `PENDING` items **owned by this batch**: a row that re-presents a source identity whose item is still `PENDING` in an earlier batch references that existing item and does **not** increment this batch's counter (`data-model.md` §20A Ownership and Retry).
- **Error codes:** `400` unparseable file, missing mapping, unsupported `currency`, amount not representable; `404` unknown / other-Realm `financialAccountId`; `422` per-row normalization failures (reported per row; the batch still returns).
- **Idempotency:** duplicate detection uses the versioned identity in `data-model.md` §70 (stable external id, else adapter-bound source-statement + source-row identity), scoped to `(realm, financialAccountId)`. Re-importing the same file creates no duplicate Transactions and increments `duplicateCount`. Ambiguous cross-file matches are **not** auto-deduped — they become `needs_review` (see §32.2). A re-presented identity whose review item is already `RESOLVED` yields the structured `RESOLVED_REVIEW_ITEM` duplicate above — the stored decision is never re-opened and no additional Transaction is created. The same source row under a different `adapterVersion` (fallback branch) is an adapter-version conflict → `needs_review`, never an automatic Transaction (`data-model.md` §70.4).
- **Side effects:** creates `IMPORTED` Transactions for genuinely new rows only; **creates no Transaction for `needs_review` rows** — a newly ambiguous row creates an `ImportReviewItem` **owned by this batch** (resolved via §32.2), while a re-presented still-`PENDING` identity only references the existing item of its owning batch (no second item, `data-model.md` §20A); while own `PENDING` items remain, the batch `status` reflects it (e.g. `NEEDS_REVIEW`); creates one `ImportBatch`; writes an AuditRecord.

## 32.1a Implementation (VC-1-05 / VC-1-06)

- **Upload:** `multipart/form-data` with exactly two parts: `metadata` (a JSON string: `financialAccountId`, `adapterId`, `adapterVersion`, plus the adapter's own options such as `columnMapping` at the same level, §32.4) and `file`. The file is capped at **5 MiB** (`413` with `Connection: close`, nothing parsed): a declared `Content-Length` beyond the cap is refused before reading, otherwise reading stops at the cap; a missing or unexpected part, non-JSON metadata or a non-multipart body is `400 VALIDATION_ERROR`. An unknown adapter or version is `400` with field `adapterId` / `NOT_SUPPORTED`.
- **File-level errors** (§32.4: the file as a whole cannot be read) are `400 IMPORT_ERROR` with `details.reason` (e.g. `MISSING_COLUMN`); no batch is stored.
- **Per-row failures** do not fail the request: the batch is `201` and each such row has outcome `error` with field codes (the `422` of §32.1 is reported per row, not as the status). A sixth outcome `skipped` (`reason: ZERO_AMOUNT`) reports rows that move no cash, such as `0,00` balance lines; they are counted in `skippedCount`, not as errors.
- **Closed accounts:** an import may still post rows booked **up to and including the closing day** (the `Europe/Berlin` calendar day of `closedAt`) — statements usually arrive after an account was closed. Later rows are `error` with `bookingDate` / `ACCOUNT_CLOSED`. Manual Transactions stay refused on closed accounts (§31.2).
- **Duplicate rules** (`data-model.md` §70): a review item with the row's full source identity is always checked first (referenced while `PENDING`, structured duplicate once `RESOLVED`). A row with an external id is then decided by it, independent of adapter: same id **and** same content fingerprint → `duplicate/TRANSACTION`; same id, other content → new item `EXTERNAL_ID_CONTENT_CONFLICT`; no id match but the same content as an imported Transaction without id → new item `AMBIGUOUS_CROSS_FILE_MATCH`; else created. Otherwise the full source-row identity (adapter id + version, statement key = source statement id else `sha256:<content hash>`, row key = source row id else `pos:<n>`) decides: imported Transaction → `duplicate/TRANSACTION`; review item → referenced while `PENDING`, `duplicate/RESOLVED_REVIEW_ITEM` once resolved. The same row under another adapter version → new item `ADAPTER_VERSION_CONFLICT`. The same content fingerprint as an imported Transaction of **another** statement (including rows imported via external id) → new item `AMBIGUOUS_CROSS_FILE_MATCH`. Two identical rows **within one file** are two Transactions (their positions differ).
- **Concurrency:** the import locks the account row; two uploads of one file serialize, the second sees the first's rows as duplicates. Unique indexes on both identity branches and on the review-item identity back this up in the schema.
- **Response** (`201`, also `GET /imports/{importBatchId}`, `404` for unknown and foreign batches): `importBatchId`, `mreRealmId`, `financialAccountId`, `adapterId`, `adapterVersion`, `sourceFilename`, `contentHash`, `status` (`COMPLETED` | `NEEDS_REVIEW`), `transactionCount`, `duplicateCount`, `needsReviewCount`, `errorCount`, `skippedCount`, `importedAt`, `importedBy`, `rows` (in file order, each with `position`).
- **Audit:** one AuditRecord `IMPORTED` on the `ImportBatch` with the counts.

## 32.2 Resolve an ambiguous review item

```text
POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve
```

Resolves the `ImportReviewItem` (`data-model.md` §20A) identified by `reviewItemId`.

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the `ImportBatch` and the `ImportReviewItem` must belong to the caller's Realm.
- **Path validation:** the item must belong to the path batch — `ImportReviewItem.importBatchId == {importBatchId}` (the owning batch, `data-model.md` §20A). A `reviewItemId` that exists but is owned by a different batch is answered with `404` under this path.
- **Inputs:** `{ "resolution": "CREATE" | "SKIP" }`.
- **Outputs:** `200 OK` with the updated `ImportReviewItem` (`status = RESOLVED`, the stored `resolution`, `resolvedByAccountId`/`resolvedAt`, and on `CREATE` `createdTransactionId` = the single new `IMPORTED` Transaction); the **owning** batch's `needsReviewCount` (identical to the path batch, per path validation) is decremented.
- **Error codes:** `404` unknown / other-Realm `importBatchId` or `reviewItemId`, or a review item not owned by `{importBatchId}`; `409` item already `RESOLVED` with a **different** resolution; `422` invalid `resolution` value.
- **Idempotency:** resolving an already-`RESOLVED` item with the **same** resolution is a `200` no-op returning the prior outcome (including the same `createdTransactionId`); a **different** resolution returns `409` (a review decision is never silently reversed). Identity is the canonical `reviewItemId`.
- **Side effects:** on `CREATE`, exactly **one** `IMPORTED` Transaction is created (an explicit human decision — never treated as a duplicate of the conflicting row) and recorded in `createdTransactionId`; on `SKIP`, **no** Transaction is created; the item becomes `RESOLVED`; writes an AuditRecord.

## 32.3 List review items

```text
GET /api/v1/imports/{importBatchId}/review-items
```

- **Domain owner:** Financial Ledger (bank-import adapter).
- **Authorization:** MRE identity; Realm-scoped; the `ImportBatch` must belong to the caller's Realm.
- **Inputs:** path `importBatchId`; optional query filter `status` (`PENDING` | `RESOLVED`).
- **Outputs:** `200 OK` with the list of `ImportReviewItem`s **owned by** `{importBatchId}` (`ImportReviewItem.importBatchId == {importBatchId}`, `data-model.md` §20A): each with `reviewItemId`, `status`, `ambiguityReason`, `normalizedRow`, `conflictingTransactionIds`, and when resolved `resolution` / `resolvedByAccountId` / `resolvedAt` / `createdTransactionId`. Items owned by other batches are never listed here, even if a later import re-presented their identity.
- **Error codes:** `404` unknown / other-Realm `importBatchId`.
- **Idempotency:** safe, read-only, repeatable.
- **Side effects:** none (read-only).

## 32.3a Implementation (VC-1-06a)

- **List** (`GET …/review-items`, optional `status=PENDING|RESOLVED`, other values `400`): `200` with `{ importBatchId, items }`, the items **owned by** the batch in file order. Each item: `reviewItemId`, `importBatchId`, `financialAccountId`, `adapterId`, `adapterVersion`, `status`, `ambiguityReason` (`AMBIGUOUS_CROSS_FILE_MATCH` | `ADAPTER_VERSION_CONFLICT` | `EXTERNAL_ID_CONTENT_CONFLICT`), `normalizedRow` (with `position`, `statementKey`, `rowKey`), `conflictingTransactionIds` **and** `conflictingTransactions` — the conflicting Transactions themselves (dates, amount, direction, counterparty, description, external id, their batch), so the row and what it may duplicate can be shown side by side — `priorReviewItemIds`, `resolution`, `resolvedByAccountId` (the MRE email), `resolvedAt`, `createdTransactionId`, `createdAt`. Unknown and foreign batches are `404`.
- **Resolve** (`POST …/resolve`, body `{ "resolution": "CREATE" | "SKIP" }`): `200` with the item (as in the list, without `conflictingTransactions`). Missing or invalid `resolution` → `422 VALIDATION_ERROR`; malformed ids → `400`; an item not owned by the path batch, unknown or foreign → `404`.
  - **Same resolution again:** `200` no-op with `Idempotent-Replayed: true` and the same `createdTransactionId`. **Other resolution:** `409 CONFLICT`, `details.reason = "ALREADY_RESOLVED"`, `details.resolution` = the stored one.
  - **`CREATE`** creates exactly one `IMPORTED` Transaction from the stored normalized row: the batch's provenance, the owning batch as `importBatchId`, the row's source identity (adapter, statement, row, fingerprint) and a link to the item. It keeps the row's external id unless the reason was `EXTERNAL_ID_CONTENT_CONFLICT` or another Transaction of the account holds that id meanwhile (`data-model.md` §70.4). A row booked after the account's closing day (Europe/Berlin, as for imports, §32.1a) is `409 CONFLICT` with `reason = "ACCOUNT_CLOSED"`; `SKIP` is always possible.
  - The owning batch's `needsReviewCount` is decremented; at `0` its `status` becomes `COMPLETED`. Its stored per-row outcomes stay as the import answered them.
  - Resolves serialize with imports into the same account (account row lock, then item row lock); two concurrent `CREATE`s create one Transaction, the second is the replay.
  - One AuditRecord `RESOLVED` on the `ImportReviewItem` (resolution, reason, conflicts, created Transaction).

## 32.4 Adapter `generic-csv`, version 1 (VC-1-10)

The first adapter reads any bank's CSV export with a header row. The ledger only sees the normalized row (`domains/ledger/bank-statement.ts`); adapters live in `integrations/bank-import/` behind the `BankStatementAdapter` port and are selected by `adapterId` + `adapterVersion`.

- **Options** (the adapter-specific part of the import request, §32.1; all except `columnMapping` optional):
  - `columnMapping`: header names for `bookingDate` and `amount` (required) and optionally `valueDate`, `currency`, `counterpartyName`, `counterpartyIban`, `description`, `externalTransactionId`, `sourceRowId`. Unknown keys are refused.
  - `delimiter` `;` (default) | `,` | tab; `decimalSeparator` `,` (default) | `.`; `dateFormat` `DD.MM.YYYY` (default) | `DD.MM.YY` (e.g. Sparkasse CSV-CAMT; `YY` always means `20YY`, nothing inferred per row) | `YYYY-MM-DD`; `encoding` `utf-8` (default) | `windows-1252`; `skipLines` 0–50 (preamble lines before the header).
- **Amount:** one signed column. A leading `-` is `OUTFLOW`, otherwise `INFLOW`; the stored amount is non-negative (§17.4). Thousands separators are accepted only at every third digit. Anything ambiguous is a row error, never guessed; more decimals than the currency allows are `SCALE_EXCEEDED`, never rounded; a zero amount is `ZERO_AMOUNT` (no cash moved, no direction).
- **Currency:** the account's. A mapped currency column must match it (`CURRENCY_MISMATCH`, no FX).
- **Normalization (§70.3):** reference placeholders in `externalTransactionId` / `sourceRowId` (`NOTPROVIDED`, `NONREF`, `NONE`, `N/A`, dashes) become null; whitespace trimmed and collapsed, IBANs without spaces and upper case (kept raw, not validated), dates as `YYYY-MM-DD` within §88's range, amounts canonical.
- **Identity inputs (§70.2):** `contentHash` = SHA-256 of the raw file bytes; `sourceStatementId` = none (a CSV export has no statement id); `sourceRowPosition` = 1-based data-row ordinal; `sourceRowId` and `externalTransactionId` only if mapped. The content fingerprint is SHA-256 over field set v1 (booking and value date, amount, currency, direction, counterparty IBAN else name, description).
- **File-level errors (→ `400`, nothing imported):** `INVALID_OPTIONS`, `UNSUPPORTED_ENCODING` (UTF-8 is decoded strictly, so a Windows-1252 file is refused instead of garbling umlauts), `UNPARSEABLE` (e.g. a broken quote; the message names the line), `EMPTY`, `MISSING_COLUMN`, `AMBIGUOUS_COLUMN`, `TOO_MANY_ROWS` (more than 10,000).
- **Row-level errors (→ per-row `error`, the batch still returns):** `REQUIRED`, `INVALID_FORMAT`, `OUT_OF_RANGE`, `SCALE_EXCEEDED`, `AMOUNT_OUT_OF_RANGE`, `ZERO_AMOUNT`, `CURRENCY_MISMATCH`, `TOO_LONG` (over 2,000 characters), `COLUMN_COUNT`.
- **Untrusted input (technology.md §36):** cell values are parsed as data only; nothing is evaluated.

---

# 33. Transaction Split Command

Preferred:

```text
PUT /api/v1/transactions/{transactionId}/splits
```

Request (amounts are **non-negative**; splits inherit the Transaction's `direction`):

```json
{
  "splits": [
    {
      "amount": "600.00",
      "financialCategoryCode": "LOAN_INTEREST",
      "loanId": "..."
    },
    {
      "amount": "600.00",
      "financialCategoryCode": "LOAN_PRINCIPAL",
      "loanId": "..."
    }
  ]
}
```

The command replaces the current unconfirmed split proposal atomically.

## 33.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped; the Transaction must belong to the caller's Realm.
- **Inputs:** the full replacement list of splits; each `amount` is a **non-negative** Money in the Transaction's currency, plus `financialCategoryCode` and optional domain references. A split carries **no** `direction`.
- **Validation:** `sum(splits.amount) == transaction.amount` **exactly** (`data-model.md` §18).
- **Outputs:** `200 OK` with the updated split set.
- **Error codes:** `400` negative split amount, a split carrying a `direction`, or currency mismatch; `409` split sum ≠ transaction amount, or the Transaction is already `CONFIRMED` (splits are frozen — correct via reversal, ADR-037); `404` unknown / other-Realm transaction.
- **Idempotency:** naturally idempotent — a full atomic replacement of the unconfirmed proposal.
- **Side effects:** replaces the unconfirmed split proposal; writes an AuditRecord.

## 33.2 Implementation (VC-1-07)

- **Request:** `{ "splits": [ … ] }` with 1–100 splits, each `amount` (Money string pair, §86), `financialCategoryCode` (§36), optional `propertyReferenceId` and `description` (≤ 500 characters, trimmed; explicit `null` = omitted). Unknown keys are refused.
- **`400`:**
  - Per field: `NEGATIVE_AMOUNT`, `SCALE_EXCEEDED`, `INVALID_FORMAT` (also a JSON number as amount).
  - `NOT_ALLOWED` for a `direction` on a split.
  - `NOT_SUPPORTED` for references whose entities do not exist yet (`loanId`, `wegId`, `rentalContractReferenceId`, `maintenanceProjectId`, `acquisitionId`, `securityDepositId`, `taxClassificationId`): refused rather than stored unchecked. `acquisitionId` stays refused for good since VC-2-06: an Acquisition's payments link Transactions from the acquisition side (§27.2, P2-D7), not splits.
  - `UNKNOWN_CATEGORY` for an unknown or inactive code; `CURRENCY_MISMATCH` for a split currency other than the Transaction's, with the split's path (`splits.<i>.amount.currency`, VC-X-18).
- **`404`:** unknown or foreign Transaction; a `propertyReferenceId` not in the caller's Realm.
- **`409 INVARIANT_VIOLATION`**, `details.reason = "SPLIT_SUM_MISMATCH"`, with `expected`, `actual` and `difference` as Money: the sum differs from the Transaction amount by any amount, one cent included.
- **`409 CONFLICT`**, `reason = "TRANSACTION_FROZEN"`, with the `status`: the Transaction is `CONFIRMED`, `RECONCILED`, `CORRECTED` or `IGNORED`.
- **Status:** a valid set moves `IMPORTED` / `UNREVIEWED` to `CLASSIFIED` (domain-model §21); `CLASSIFIED` stays `CLASSIFIED`.
- **Replacement and idempotency:**
  - **Changed set:** replaced as a whole under the Transaction's row lock. The Transaction's `version` increases by 1, and one AuditRecord `SPLITS_REPLACED` is written.
  - **Same set again:** same order, same values (`"600"` equals `"600.00"`). Answered `200` with the stored set, no new version and no AuditRecord, even after confirmation. Only a **different** set is frozen.
- **Response `200`:** `transactionId`, `amount`, `direction`, `status`, `version`, `splits` (`splitId`, `position`, `amount`, `financialCategoryCode`, `propertyReferenceId`, `description`).
- **Category and direction are deliberately not cross-checked:** an `INCOME` category on an `OUTFLOW` (e.g. a refunded rent, `RENT_BASE` on the way out) or an expense category on an `INFLOW` (an insurance refund) is legitimate. The category says *what* the money is; `direction` says which way it moved. Do not add such a check.
- **Schema:** a split references its Transaction together with the Realm and the currency (composite foreign key), so it can never belong to another Realm's Transaction or carry another currency. Its amount is non-negative with at most two decimals.

---

# 34. Confirm Transaction

```text
POST /api/v1/transactions/{id}/confirm
```

## 34.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped.
- **Inputs:** none beyond the path `{id}`.
- **Validation:** transaction exists in the caller's Realm; valid `amount` / `direction` (`data-model.md` §17.4); complete split coverage with exact sum (`data-model.md` §18); references resolve; no blocking review state.
- **Outputs:** `200 OK` with the Transaction at `status = CONFIRMED`. Confirming an already-`CONFIRMED` transaction returns `200` with the existing confirmed Transaction (no-op).
- **Error codes:** `404` unknown / other-Realm transaction; `409` split sum ≠ amount; `422` unresolved references / blocking review. Already-confirmed is **not** an error — it is a `200` no-op (see idempotency).
- **Idempotency:** repeated `confirm` of the same transaction is a consistent `200` no-op returning the existing confirmed Transaction; confirmed cash fields are immutable thereafter (ADR-037).
- **Side effects:** status → `CONFIRMED`; AuditRecord created; downstream recalculation may be triggered.

## 34.2 Implementation (VC-1-08)

- **Confirmable:** a `CLASSIFIED` Transaction (VC-1-07) whose split set still sums exactly to its amount (re-checked under the Transaction's row lock, not taken from when it was stored) and whose splits use only active categories.
- **`200`:** the Transaction (as in §31.2) with `status = CONFIRMED`, `confirmedAt`, `confirmedBy` (the MRE email), `version` + 1; one AuditRecord `CONFIRMED`. Already `CONFIRMED` or `RECONCILED` → `200` with the Transaction unchanged and `Idempotent-Replayed: true`, no new version or AuditRecord.
- **`409`:**
  - `INVARIANT_VIOLATION` with `reason = "SPLITS_MISSING"`: no split set yet (`IMPORTED`/`UNREVIEWED`). The complete coverage of §24 is required.
  - `INVARIANT_VIOLATION` with `reason = "SPLIT_SUM_MISMATCH"`, `expected`/`actual`/`difference`.
  - `CONFLICT` with `reason = "NOT_CONFIRMABLE"` and the `status`: `CORRECTED` or `IGNORED`.
- **`422 REVIEW_REQUIRED`** with `reason = "INACTIVE_CATEGORY"` and `financialCategoryCodes`: a split's category was deactivated since the split was stored (an unresolved reference): split again before confirming. PropertyReferences are bound by foreign key and cannot be unresolved; there is no other blocking review state for an existing Transaction in Phase 1.
- **`404`:** unknown or foreign Transaction; `400` for a malformed id.
- **Concurrency:** confirm takes the same row lock as a split replacement, so a replacement that waited on a confirm finds the Transaction frozen; two confirms yield one confirmation and one no-op.
- **Immutability (ADR-037), enforced by the database** (migration 0009), once `CONFIRMED` (and in the later `RECONCILED`/`CORRECTED`):
  - **Frozen fields:** account, Realm, amount, currency, direction, booking and value date, `confirmedAt`/`confirmedBy`, and the provenance and import identity a re-import relies on (`provenance`, import batch, external id, adapter, source keys, content fingerprint, review item). From VC-1-11 on also `propertyReferenceId`, `description` and the correction link (§35.6), so every change of a confirmed Transaction goes through `correct`.
  - **Status only moves forward:** `CONFIRMED` → `RECONCILED` / `CORRECTED`, `RECONCILED` → `CORRECTED` (domain-model §21). `CORRECTED` is terminal; nothing returns to `CONFIRMED` or to an unconfirmed state, so a superseded Transaction cannot be revived and counted twice.
  - **No deletion**, and its splits cannot be inserted, changed or deleted. Before migration 0011 (VC-1-11) the database left `description` and `propertyReferenceId` editable; no endpoint ever changed them.
  - `confirmed_at`/`confirmed_by` are set exactly for the confirmed states (CHECK).
- **Split invariant in the database** (migration 0010, VC-1-09): a Transaction becomes `CONFIRMED` only with splits in its currency summing exactly to its amount, and none is inserted already confirmed, so "confirmed ⇒ covered exactly" holds for every row, not only for those confirmed through this endpoint. This includes two writers at once: the split trigger writes the Transaction row (a no-op update), so a split change and a confirmation in different sessions serialize instead of missing each other, under every isolation level.

---

# 35. Correct Transaction

```text
POST /api/v1/transactions/{id}/correct
```

**Phase-1 scope:** correction is **not part of the Phase-1 exit**; it is a gated fast-follow (VC-1-11, see `docs/roadmap.md` Phase 1). The behavior is fixed by ADR-037: the confirmed Transaction is never changed; a linked **reversal** negates it and a linked **replacement** carries the corrected values. The contract below is the specification VC-1-11 implements.

Example request:

```json
{
  "reason": "Incorrect booking date",
  "replacement": {
    "bookingDate": "2026-09-02"
  }
}
```

## 35.1 Contract

- **Domain owner:** Financial Ledger.
- **Authorization:** MRE identity; Realm-scoped, as §34.
- **Correctable:** a Transaction in status `CONFIRMED` that is not itself a reversal. A replacement is an ordinary confirmed Transaction and can be corrected again, which extends the chain (§35.3).
- **One step, all or nothing:** in one database transaction the command
  1. creates the **reversal**,
  2. creates the **replacement**, already `CONFIRMED`,
  3. moves the original `CONFIRMED` → `CORRECTED` (domain-model §21) and writes one AuditRecord.

  Either all three happen or nothing does. There is never a moment in which the original is `CORRECTED` but its replacement does not yet count, or in which both count.
- **Outputs:** `201 Created` with `{ "original": …, "reversal": …, "replacement": … }`, each a Transaction as §31.2 plus the correction fields (§35.4).

## 35.2 Request

- **`reason`** (required): trimmed, 1–500 characters. It is stored in the AuditRecord, not on the Transactions.
- **`replacement`** (required object): the fields that differ from the original. Omitted fields are copied from the original. Unknown keys are `400`.
  - `amount` (Money, §31.2 rules: non-negative, scale, currency of the account), `direction`, `bookingDate`, `valueDate`, `description`, `propertyReferenceId`. For the last three an explicit `null` clears the value.
  - `financialAccountId`: another account of the same Realm and currency (no FX, data-model §17.7). Moving the Transaction to a **different, closed** account is `409 ACCOUNT_CLOSED`, as for a new manual Transaction (§31.2).
  - `splits`: a full split set with the rules of §33. If omitted, the original's splits are copied (same positions, amounts, categories, PropertyReferences, descriptions).
- **Closed account of the original:** reversal and replacement may both be posted to the original's account even if it was closed since, with any of the changes above (amount, dates, direction, splits, …). They restate a movement already recorded on that account, they are not a new one, so a mistake on a closed account stays correctable.
- **Coverage:** the replacement is confirmed in the same step, so its splits must cover its amount exactly (`409 INVARIANT_VIOLATION`, `SPLIT_SUM_MISMATCH`). They must also use only active categories (`422 REVIEW_REQUIRED`, `INACTIVE_CATEGORY`), as §34.2. A changed `amount` therefore needs new `splits` unless the copied ones still sum exactly.
- **Must change something:** a request whose replacement equals the original in every field it can set (account, amount, direction, booking and value date, `description`, `propertyReferenceId`) and in its split set is `409 CONFLICT` with `reason = "NO_CHANGE"`. A change of `description` or `propertyReferenceId` alone is a correction like any other: a confirmed Transaction has no other way to change (§35.6), and an in-place edit would bypass the audit chain.
- **Bank transactions:** correcting amount, date or account of a `BANK_CSV`/`BANK_API` Transaction is allowed (e.g. after a parser error), with the required `reason`. The ledger then differs from the bank statement on purpose, and the original keeps the bank row. A later statement reconciliation should flag such replacements for review; it is not part of VC-1-11.

## 35.3 The records

| | Reversal | Replacement |
| --- | --- | --- |
| `correctionOfTransactionId` | the original | the original |
| `correctionRole` | `REVERSAL` | `REPLACEMENT` |
| account, currency, `amount` | as the original | from the request, else the original's |
| `direction` | the **opposite** of the original (data-model §17.4) | from the request, else the original's |
| `bookingDate`, `valueDate` | **as the original**, so every period the original counted in nets to zero | from the request, else the original's |
| `description`, `propertyReferenceId` | as the original | from the request, else the original's |
| splits | mirror of the original's (same positions, amounts, categories, PropertyReferences) | from the request, else copied |
| `provenance` | `CORRECTION` | `CORRECTION` |
| import identity (batch, external id, adapter, source keys, fingerprint, review item) | none | none |
| `status` | `CONFIRMED`; `confirmedAt` = time of the correction, `confirmedBy` = the acting MRE user's email | `CONFIRMED`; `confirmedAt` = time of the correction, `confirmedBy` = the acting MRE user's email |

- **The original keeps everything:** its fields, splits, `confirmedAt`/`confirmedBy`, provenance and import identity. Only its status changes, to `CORRECTED`. A re-import of its bank row is therefore still a duplicate of the original, also once it is `CORRECTED`, and never recreates it (data-model §70).
- **Closed account:** see §35.2. Neither record is refused because the original's account was closed since.
- **Chain:** an original has at most one reversal and one replacement. A later correction of the replacement links to the replacement, not to the first original, so the chain is a list `T₁ → T₂ → …`. In that list every member except the last is `CORRECTED` and the last is the current one. A reversal is never corrected (§35.4, `NOT_CORRECTABLE` with `correctionRole = "REVERSAL"`): a mistake in a correction is fixed by correcting its replacement.
- **Net effect (ADR-037, reporting):** per account, period (by `bookingDate`), category and PropertyReference, the sum over `CONFIRMED`, `RECONCILED` and `CORRECTED` Transactions with sign by `direction` equals the sum over the current ones alone. "Current" means `CONFIRMED` or `RECONCILED` and not a reversal. Each original and its reversal cancel exactly, so the full chain stays visible and nothing is counted twice. Category and PropertyReference mean the **split** level (each split's category and PropertyReference), which is what reports aggregate. The rule holds at Transaction level (`propertyReferenceId` of the Transaction) as well, since the reversal copies it.

## 35.4 Response and errors

- **Transaction fields added by correction** (in every Transaction response from VC-1-11 on): `correctionOfTransactionId` and `correctionRole` (both `null` on an ordinary Transaction), and on a `CORRECTED` original `reversalTransactionId` and `replacementTransactionId`.
- **AuditRecord:** one record `CORRECTED` on the original: actor (the MRE email), `reason`, the reversal and replacement ids, the changed fields with old and new values, `previousVersion`/`newVersion`. This is a deliberate exception to "one AuditRecord per new Transaction" (§31.1): reversal and replacement are created by this one act and get **no record of their own**. From either of them the record is found through `correctionOfTransactionId` (the original's record names both).
- **`400`:** malformed id or body (§31.2 / §33 field codes).
- **`404`:** unknown or foreign Transaction; a target account or PropertyReference not in the caller's Realm.
- **`409`:**
  - `CONFLICT` with `reason = "ALREADY_CORRECTED"` and `reversalTransactionId`/`replacementTransactionId`, so a client that lost the first answer can find the result.
  - `CONFLICT` with `reason = "NOT_CORRECTABLE"`, in the pattern of `NOT_CONFIRMABLE` (§34.2). `details` always carry the `status`, and for a reversal also `correctionRole = "REVERSAL"`:
    - `status` `IMPORTED`, `UNREVIEWED` or `CLASSIFIED`: not confirmed yet. Split and confirm it instead. Changing its cash fields before confirmation has no endpoint in Phase 1 (backlog VC-X-16);
    - `status` `IGNORED`;
    - `status` `RECONCILED` (see below);
    - `status` `CONFIRMED` with `correctionRole = "REVERSAL"`.
  - `CONFLICT` with `reason = "NO_CHANGE"` or `"ACCOUNT_CLOSED"`.
  - `INVARIANT_VIOLATION` with `SPLIT_SUM_MISMATCH`.
- **`422`:** `REVIEW_REQUIRED` with `INACTIVE_CATEGORY`.
- **Reconciled Transactions:** a `RECONCILED` Transaction is matched to MRE rent state, and correcting it must also undo or re-evaluate that match (workflows: "invalidate/re-evaluate affected reconciliations"). Until Phase 4 specifies that, correcting a `RECONCILED` Transaction is `409 CONFLICT` with `reason = "NOT_CORRECTABLE"` and `status = "RECONCILED"`. The status rule `RECONCILED → CORRECTED` (§34.2) stays in place for then. Phase 1 has no `RECONCILED` Transactions.

## 35.5 Idempotency and concurrency

- **`Idempotency-Key`** as §15, scoped to the Realm and the command. The fingerprint is the original's id plus the normalized request. A replay answers `201` with the result as recorded and `Idempotent-Replayed: true`. A rejected request rolls back its key claim.
- **Without a key** a retry is still safe: the original is `CORRECTED` by then, so the retry gets `409 ALREADY_CORRECTED` with the ids of the existing correction. It never creates a second one.
- **Locks:** the original is locked `FOR UPDATE`, the same lock as confirm and split replacement (§34.2). Of two concurrent corrections, one creates the chain and the other gets `ALREADY_CORRECTED`. A split replacement waiting on the lock finds the original frozen. The replacement's account is locked `FOR SHARE` as in §31.2.
- **Lock order (rule):** first the original `FOR UPDATE`, then the account(s) `FOR SHARE` (if two, in id order). Import and account close never take a Transaction lock after an account lock, so this order cannot deadlock with them; later commands must keep it.

## 35.6 Enforced by the database

- `correction_of_transaction_id` references a Transaction **of the same Realm** (composite foreign key, like the other references).
- `correction_role` and `correction_of_transaction_id` are both set or both `NULL`, and `provenance = 'CORRECTION'` exactly when they are set.
- At most one `REVERSAL` and one `REPLACEMENT` per original (unique index).
- A reversal matches its original: same Realm, account, currency, amount, booking and value date, and opposite direction.
- A reversal **mirrors the original's splits** (migration 0014, VC-X-17): both split sets are the same multiset of category, PropertyReference, amount and currency. Position and description may differ. Checked at commit, so the splits may be written after the reversal row.
- A Transaction is `CORRECTED` exactly when its reversal exists. The replacement is there for `correct` and absent for `reverse` (§35.9, migration 0012). This is checked by a deferred constraint trigger at commit, so the reversal may be written before or after the original's status change.
- A replacement can only be **inserted while its original is not yet `CORRECTED`** (migration 0012, checked at the insert). It therefore comes before the status change, and a reversed Transaction never gets one later. The check locks the original `FOR SHARE`, so it also waits for, and then sees, a concurrent reversal.
- `CORRECTED` is reached only from `CONFIRMED` or `RECONCILED`, never from an unconfirmed status, and no row is inserted as `CORRECTED`. Before migration 0011 a `CLASSIFIED` row whose splits covered it could be updated straight to `CORRECTED`; 0011 closes that.
- The target of a correction link is never a reversal.
- On a confirmed Transaction `propertyReferenceId`, `description` and the correction link are frozen too (extends the 0009 list, §34.2).
- The other triggers stay as they are: immutability (0009) and "confirmed ⇒ covered exactly" (0010). So reversal and replacement are written unconfirmed, get their splits and are then confirmed, all in the same transaction.

## 35.7 Out of scope for VC-1-11

- **A reversal without replacement:** done since as `reverse` (§35.9, VC-X-15).
- Correction of `RECONCILED` Transactions (Phase 4, see §35.4).
- Bulk corrections.
- **Closed periods:** the reversal takes the original's dates, so it changes the totals of the original's period. Phase 1 has no period close. When tax years or reports get closed (Phase 7/9), those phases decide how a correction into a closed period is handled (refused, or reversal dated in the open period).


## 35.8 Implementation (VC-1-11)

- **Migration 0011:** `correction_of_transaction_id` / `correction_role` with the composite foreign key, the CHECK and the unique index of §35.6. The immutability trigger of 0009 is extended in place, so the frozen fields stay one list: it now also freezes `property_reference_id`, `description` and the link, and refuses `CORRECTED` from an unconfirmed status. The chain itself is checked by the deferred constraint trigger `ledger_transaction_correction_chain`. It fires on the status change and on the linked inserts, only for rows in a chain, and re-reads the rows at commit.
- **Write order** inside one READ COMMITTED transaction:
  1. claim the `Idempotency-Key`;
  2. lock the original `FOR UPDATE`;
  3. **re-read it in a new statement**: a request that waited on a concurrent correction then sees its links, which a subquery of the locking statement would not;
  4. lock the accounts `FOR SHARE` in id order;
  5. check;
  6. reversal and replacement, each inserted `CLASSIFIED`, given its splits, then `CONFIRMED`;
  7. original → `CORRECTED` (version + 1);
  8. one AuditRecord `CORRECTED`;
  9. record the key.
- **Error mapping:**
  - Unknown or inactive categories in requested `splits` are `400 VALIDATION_ERROR` with `replacement.splits.<i>.financialCategoryCode` / `UNKNOWN_CATEGORY`, as §33. An inactive category in the *copied* splits is `422 INACTIVE_CATEGORY`.
  - A replacement in another currency than the target account is `400 CURRENCY_MISMATCH` with the field at fault (VC-X-18): `replacement.amount.currency` for a requested amount, `replacement.splits.<i>.amount.currency` for a requested split, and `replacement.financialAccountId` for a copied amount or split that no longer matches the changed account's currency.
- **Version:** reversal and replacement start at `version 1` and stay there; their confirmation is part of their creation.

## 35.9 Reverse without a replacement (VC-X-15)

```text
POST /api/v1/transactions/{id}/reverse     { "reason": "Duplicate manual entry" }
```

For a confirmed Transaction that should not exist at all, e.g. a duplicate manual entry or a payment booked to the wrong ledger. It is `correct` without a replacement: the same step, the same records and the same rules, except as listed here.

- **Effect:** in one transaction the command writes the confirmed **reversal** (§35.3: same account, amount and dates, opposite direction, mirrored splits; the original's closed account is fine) and moves the original to `CORRECTED`. There is **no replacement**: the original's `replacementTransactionId` stays `null`.
- **Net effect:** the rule of §35.3 holds unchanged, and needs no new one. The original and its reversal cancel exactly, and there is no current Transaction left, so both the chain's sum and the current sum are zero. Reversing the current replacement of a chain ends the chain the same way.
- **Final:** a reversed Transaction never gets a replacement later; reinstating it is a new Transaction. The database checks this (§35.6): a replacement can only be inserted while its original is not yet `CORRECTED`. The rule rests on the order of the writes, so neither a touched `updated_at` nor a savepoint changes it.
- **Request:** `reason` is required (trimmed, 1–500 characters). Nothing else, and unknown keys are `400`. `Idempotency-Key` (§15, own scope `transaction.reverse`) and `If-Match` (§16.1) work as for `correct`.
- **`201`:** `{ "original": …, "reversal": …, "replacement": null }`. AuditRecord **`REVERSED`** on the original, with `reason`, `previousStatus` and the reversal's id (§35.4: no record of its own for the reversal).
- **Refusals:** as `correct`: `404`; `409 ALREADY_CORRECTED`, where `replacementTransactionId` is `null` for a reversed original; `409 NOT_CORRECTABLE` (unconfirmed, `IGNORED`, `RECONCILED`, or a reversal itself); `412 VERSION_CONFLICT`. A reversed Transaction also answers `ALREADY_CORRECTED` to a later `correct`.
- **Not for unconfirmed Transactions:** use `ignore` there (§31.4); nothing was confirmed that needs reversing.

---

# 36. Financial Categories API

Mostly read-only reference data.

```text
GET /api/v1/financial-categories
GET /api/v1/financial-categories/{code}
```

Administrative extension, if allowed:

```text
POST /api/v1/financial-categories
```

Core category codes should remain stable.

**Implementation (VC-1-07):** `GET /financial-categories` → `{ items: [{ code, name, categoryType, active }] }`, active first, then by code; `GET /financial-categories/{code}` → one category, `404` if unknown, `400` for a malformed code. In Phase 1 the catalog is global (the same for every Realm) and seeded by migration 0008: the examples of `data-model.md` §19 plus common landlord categories (`RENT_OPERATING_COST_SETTLEMENT`, `INSURANCE`, `PROPERTY_TAX`, `BANK_FEES`, `SECURITY_DEPOSIT`, `OWNER_CONTRIBUTION`/`OWNER_WITHDRAWAL`, `TRANSFER`, …). Codes are deactivated, never reused; the administrative `POST` is not implemented.

---

# 37. Rent Reconciliation API

### Queries

```text
GET /api/v1/rent-reconciliations
GET /api/v1/rent-reconciliations/{id}
GET /api/v1/rent-reconciliations/suggestions
```

### Commands

```text
POST /api/v1/rent-reconciliations/suggest
POST /api/v1/rent-reconciliations/{id}/confirm
POST /api/v1/rent-reconciliations/{id}/reject
POST /api/v1/rent-reconciliations/{id}/write-back-to-mre
```

---

# 38. Rent Match Suggestion

A suggestion may use:

- amount
- booking date
- tenant Party
- MRE Tenant
- rent term
- bank reference
- historical match patterns

Suggestions remain non-authoritative.

---

# 39. Confirm Rent Reconciliation

Confirmation must:

1. validate Transaction
2. validate MRE rent term
3. validate matched amount
4. prevent duplicate matching
5. create reconciliation record
6. preserve actor and timestamp

MRE write-back should be a separate explicit command.

---

# 40. MRE Rent Write-Back

```text
POST /api/v1/rent-reconciliations/{id}/write-back-to-mre
```

Responsibilities:

- verify reconciliation confirmed
- build MRE payment payload
- call supported MRE API
- record MRE response
- ensure idempotency
- mark write-back state

---

# 41. Loan API

### Queries

```text
GET /api/v1/loans
GET /api/v1/loans/{id}
GET /api/v1/property-references/{propertyReferenceId}/loans
```

### Commands

```text
POST /api/v1/loans
POST /api/v1/loans/{id}/terms
POST /api/v1/loans/{id}/allocations
POST /api/v1/loans/{id}/recalculate-schedule
POST /api/v1/loans/{id}/reconcile-payment
POST /api/v1/loans/{id}/refinance
```

---

# 42. Create Loan

Example:

```json
{
  "lenderPartyId": "...",
  "borrowerPartyIds": ["..."],
  "principalOriginal": {
    "amount": "250000.00",
    "currency": "EUR"
  },
  "startDate": "2026-09-01",
  "acquisitionId": "..."
}
```

---

# 43. Loan Terms

```text
POST /api/v1/loans/{id}/terms
```

A new terms period should not overwrite historical terms.

---

# 44. Loan Allocation

```text
PUT /api/v1/loans/{id}/allocations
```

Request:

```json
{
  "allocations": [
    {
      "propertyReferenceId": "...",
      "share": "0.60"
    },
    {
      "propertyReferenceId": "...",
      "share": "0.40"
    }
  ]
}
```

Validation:

`sum(shares) = 100%`

for a fully allocated Loan.

---

# 45. Loan Schedule Query

```text
GET /api/v1/loans/{id}/schedule
```

Optional query:

- `from`
- `to`
- `version`

Schedule is read-only derived Plan/Forecast data.

---

# 46. Loan Payment Reconciliation

```text
POST /api/v1/loans/{id}/reconcile-payment
```

Request may reference:

- Transaction
- interest split
- principal split
- schedule entry

The command validates split semantics before reconciliation.

---

# 47. Security Deposit API

### Queries

```text
GET /api/v1/security-deposits
GET /api/v1/security-deposits/{id}
GET /api/v1/rental-contract-references/{id}/security-deposit
```

### Commands

```text
POST /api/v1/security-deposits
POST /api/v1/security-deposits/{id}/link-transaction
POST /api/v1/security-deposits/{id}/return
POST /api/v1/security-deposits/{id}/reconcile-with-mre
```

---

# 48. Security Deposit Creation

May initialize expected amount from MRE Tenant.guaranty.

The API must distinguish:

- expected amount
- actual received cash
- actual return cash

---

# 49. WEG API

### Queries

```text
GET /api/v1/weg-associations
GET /api/v1/weg-associations/{id}
GET /api/v1/property-references/{propertyReferenceId}/weg
```

### Commands

```text
POST /api/v1/weg-associations
POST /api/v1/weg-associations/{id}/memberships
POST /api/v1/weg-associations/{id}/economic-plans
POST /api/v1/weg-associations/{id}/annual-statements
POST /api/v1/weg-associations/{id}/special-assessments
```

---

# 50. WEG Annual Statement Import

```text
POST /api/v1/weg-associations/{id}/annual-statements
```

May initially accept:

- manual structured input
- imported CSV
- document reference + manual lines

OCR is future work.

---

# 51. WEG Cost Line Classification

```text
POST /api/v1/weg-cost-lines/{id}/classify
```

Classification may include:

- financial category
- recoverability
- reserve impact

Tax classification remains a separate Taxation command.

---

# 52. Maintenance Project API

### Queries

```text
GET /api/v1/maintenance-projects
GET /api/v1/maintenance-projects/{id}
```

### Commands

```text
POST /api/v1/maintenance-projects
POST /api/v1/maintenance-projects/{id}/link-transaction
POST /api/v1/maintenance-projects/{id}/link-document
POST /api/v1/maintenance-projects/{id}/complete
```

---

# 53. Document API

### Queries

```text
GET /api/v1/documents
GET /api/v1/documents/{id}
```

### Commands

```text
POST /api/v1/documents
POST /api/v1/documents/{id}/links
POST /api/v1/documents/import-mre-reference
```

---

# 54. MRE Document Reference

```text
POST /api/v1/documents/import-mre-reference
```

Request:

```json
{
  "mreRealmId": "...",
  "mreDocumentId": "..."
}
```

Should create metadata reference without duplicating binary content unnecessarily.

---

# 55. Tax Classification API

### Queries

```text
GET /api/v1/tax-classifications
GET /api/v1/tax-classifications/{id}
GET /api/v1/tax-years/{year}/classifications
```

### Commands

```text
POST /api/v1/tax-classifications
POST /api/v1/tax-classifications/{id}/confirm
POST /api/v1/tax-classifications/{id}/mark-needs-review
POST /api/v1/tax-classifications/{id}/advisor-confirm
```

---

# 56. Create Tax Classification

Request must reference an existing source entity.

Example:

```json
{
  "jurisdiction": "DE",
  "taxYear": 2026,
  "sourceEntityType": "TRANSACTION_SPLIT",
  "sourceEntityId": "...",
  "taxCategory": "LOAN_INTEREST",
  "ruleVersionId": "...",
  "reviewState": "SUGGESTED"
}
```

---

# 57. Tax Confirmation

Tax confirmation should:

- validate rule version
- validate tax year
- validate source
- preserve review actor
- create AuditRecord

---

# 58. Tax Rules API

Mostly read-only:

```text
GET /api/v1/tax-rules
GET /api/v1/tax-rules/{ruleCode}
GET /api/v1/tax-rules/{ruleCode}/versions
```

Rule administration should be restricted to trusted maintainer workflows.

---

# 59. Depreciation API

### Queries

```text
GET /api/v1/depreciation-assets
GET /api/v1/depreciation-assets/{id}
GET /api/v1/depreciation-assets/{id}/schedule
```

### Commands

```text
POST /api/v1/depreciation-assets
POST /api/v1/depreciation-assets/{id}/recalculate
POST /api/v1/depreciation-assets/{id}/correct-basis
```

---

# 60. Depreciation Recalculate

```text
POST /api/v1/depreciation-assets/{id}/recalculate
```

Must create a new schedule version rather than silently replace historical versions.

---

# 61. Market Valuation API

### Queries

```text
GET /api/v1/property-references/{propertyReferenceId}/market-valuations
GET /api/v1/market-valuations/{id}
```

### Commands

```text
POST /api/v1/market-valuations
POST /api/v1/market-valuations/{id}/confirm
```

Never expose:

```text
PATCH Property.currentMarketValue
```

---

# 62. Investment Metric API

### Queries

```text
GET /api/v1/property-references/{propertyReferenceId}/metrics
GET /api/v1/property-references/{propertyReferenceId}/metrics/{metricCode}
GET /api/v1/portfolios/{id}/metrics
```

Metrics are read-only derived outputs.

---

# 63. Metric Calculation

```text
POST /api/v1/investment/calculations
```

Request:

```json
{
  "scopeType": "PROPERTY",
  "propertyReferenceId": "...",
  "asOfDate": "2028-12-31",
  "metricCodes": ["NOI", "LTV", "CCR"]
}
```

Response should include:

- value
- formula version
- important input references
- warnings
- calculation timestamp

---

# 64. Investment Metric Snapshot API

### Queries

```text
GET /api/v1/investment-metric-snapshots
GET /api/v1/investment-metric-snapshots/{id}
```

### Commands

```text
POST /api/v1/investment-metric-snapshots
POST /api/v1/property-references/{propertyReferenceId}/snapshot-metrics
```

Snapshot generation is explicit.

Trigger policy may evolve later.

---

# 65. Investment Scenario API

Post-MVP or later MVP phase.

### Queries

```text
GET /api/v1/investment-scenarios
GET /api/v1/investment-scenarios/{id}
```

### Commands

```text
POST /api/v1/investment-scenarios
PUT  /api/v1/investment-scenarios/{id}/assumptions
POST /api/v1/investment-scenarios/{id}/calculate
```

---

# 66. Scenario Isolation

Scenario calculation endpoints must never update:

- actual rent
- actual Transactions
- actual Loan terms
- current Market Valuation

---

# 67. Reporting API

### Queries / Generation

```text
POST /api/v1/reports/property-summary
POST /api/v1/reports/tax-package
POST /api/v1/reports/annual-summary
POST /api/v1/reports/portfolio-summary
```

Report creation must call domain calculations.

It must not implement hidden formulas.

---

# 68. Tax Package

Example:

```text
POST /api/v1/reports/tax-package
```

Request:

```json
{
  "propertyReferenceId": "...",
  "taxYear": 2027,
  "ownerPartyIds": ["..."]
}
```

Output may provide:

- downloadable archive
- report manifest
- missing-review warnings

---

# 69. Dashboard Query API

Dashboards should use dedicated read models where performance requires.

Example:

```text
GET /api/v1/dashboard/properties/{id}
```

Response may aggregate:

- rent status from MRE
- cashflow from Ledger
- remaining debt from Financing
- tax status
- current valuation
- metrics

This is a read model only.

---

# 70. Composite Read Models

Composite API responses are allowed for UI efficiency.

They must not become canonical owners of data.

Example:

```text
PropertyDashboardView
```

may include copies of:

- Property name
- rent due
- cashflow
- debt
- valuation

but these fields remain derived/read-only.

---

# 71. Search API

A future cross-domain search may exist:

```text
GET /api/v1/search?q=...
```

Search results should return references, not independent domain state.

---

# 72. Automation API

### Queries

```text
GET /api/v1/automation-rules
```

### Commands

```text
POST /api/v1/automation-rules
POST /api/v1/automation-rules/{id}/enable
POST /api/v1/automation-rules/{id}/disable
POST /api/v1/automation-rules/{id}/test
```

Automation must invoke existing business commands.

---

# 73. AI Suggestion API

### Queries

```text
GET /api/v1/ai-suggestions
GET /api/v1/ai-suggestions/{id}
```

### Commands

```text
POST /api/v1/ai-suggestions/{id}/accept
POST /api/v1/ai-suggestions/{id}/reject
```

Acceptance must translate into a normal domain command.

---

# 74. AI Transaction Classification Flow

```text
Transaction
    ↓
POST /ai/classification-suggestions
    ↓
AISuggestion
    ↓
User accepts
    ↓
PUT /transactions/{id}/splits
    ↓
POST /transactions/{id}/confirm
```

AI never skips the canonical command path.

---

# 75. MRE Adapter API Responsibilities

The internal MRE adapter should expose capabilities such as:

```text
listRealms()
getProperty()
listProperties()
getTenant()
listTenants()
getTenantRents()
getRentTerm()
recordRentPayment()
getLeaseDefinition()
getDocument()
```

The rest of the DE system should not call arbitrary MRE endpoints directly.

---

# 76. MRE Adapter Anti-Corruption Layer

MRE-specific field names should be translated at the adapter boundary.

Example:

MRE:

```text
Occupant
guaranty
leaseId
properties[]
```

DE integration model:

```text
RentalContractReference
expectedSecurityDeposit
propertyReferences
```

The DE domain must not become polluted with MRE implementation naming.

---

# 77. External System Error Handling

If MRE is unavailable:

- DE canonical data remains accessible
- MRE-dependent operations fail visibly
- errors are marked external
- no partial canonical state should be silently written

Example:

`MRE_UNAVAILABLE`

---

# 78. MRE Write-Back Safety

Any DE command that writes to MRE should:

1. validate DE state
2. verify Realm
3. use idempotency
4. call MRE supported API
5. record result
6. create audit event
7. avoid direct DB write

---

# 79. Bank Adapter Boundary

Future bank APIs should also sit behind an adapter.

The Financial Ledger must not depend on one bank vendor.

Conceptual interface:

```text
listAccounts()
listTransactions()
getTransaction()
```

Initial implementation may be CSV-only.

---

# 80. Import API Semantics

Imported records begin as non-confirmed unless explicitly trusted.

Recommended flow:

```text
Imported
→ Unreviewed
→ Classified
→ Confirmed
→ Reconciled
```

---

# 81. Batch Commands

Batch endpoints are acceptable when they preserve individual validation results.

Example:

```text
POST /api/v1/transactions/batch-confirm
```

Response should report per-item success/failure.

Do not make partial failures invisible.

---

# 82. Pagination

Collection endpoints should support pagination.

Recommended query:

```text
?page=1&pageSize=50
```

Large transaction datasets should additionally support cursor-based pagination later if needed.

---

# 83. Sorting

Use explicit fields:

```text
?sort=bookingDate:desc
```

Only allow approved sortable fields.

---

# 84. Filtering

Prefer semantic query fields over arbitrary database query syntax.

Good:

```text
?status=CONFIRMED&propertyReferenceId=...
```

Avoid exposing raw Mongo operators or SQL fragments.

---

# 85. Date Range Filtering

Use:

```text
?from=2026-01-01&to=2026-12-31
```

Date semantics must be documented per endpoint.

---

# 86. Money Representation

JSON Money should not use binary floating values.

Preferred conceptual shape:

```json
{
  "amount": "1250.00",
  "currency": "EUR"
}
```

Exact serialization may be standardized later.

---

# 87. Percentage Representation

Use one consistent convention.

Recommended API representation:

```json
{
  "share": "0.50"
}
```

for 50%.

Documentation must state this globally.

**Exception: ownership shares** are exact fractions `"n/d"` (P2-D3, §26.1), never decimal strings: `1/3` has no exact decimal.

---

# 88. Dates and Timestamps

Business dates:

```text
YYYY-MM-DD
```

A business date must be a real calendar date with a year from **1900 to 2100**. Other years are refused as `OUT_OF_RANGE` (a typo such as `0202` would otherwise book into the year 202); malformed or impossible dates are `INVALID_FORMAT`.

System timestamps:

```text
RFC 3339 / ISO 8601
```

Avoid locale-formatted dates in DE API contracts.

MRE adapter is responsible for translating MRE-specific date formatting where necessary.

---

# 89. Review Warnings

Responses may include non-blocking warnings.

Example:

```json
{
  "warnings": [
    {
      "code": "TAX_CLASSIFICATION_NEEDS_REVIEW",
      "sourceEntityId": "..."
    }
  ]
}
```

Warnings must not be confused with errors.

---

# 90. Validation Error Detail

Example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed.",
    "details": {
      "fields": [
        {
          "field": "share",
          "code": "OUT_OF_RANGE"
        }
      ]
    }
  }
}
```

A rule over existing data is not a field error: a share that would raise a day's sum above 1 is `422 OWNERSHIP_TOTAL_EXCEEDS_ONE` with the day and its sum (§26.1).

---

# 91. Derived Data Traceability

Derived endpoints should expose enough metadata to explain results.

Example metric response:

```json
{
  "metricCode": "LTV",
  "value": "0.68",
  "formulaVersion": "1",
  "inputs": {
    "marketValuationId": "...",
    "loanIds": ["..."]
  }
}
```

---

# 92. Audit API

Read-only audit queries:

```text
GET /api/v1/audit-records
GET /api/v1/entities/{entityType}/{entityId}/audit-records
```

Audit history should not be editable through normal user APIs.

---

# 93. Health APIs

Operational endpoints:

```text
GET /health
GET /ready
```

May expose dependency status such as:

- database
- MRE
- document storage

Do not leak secrets.

---

# 94. Capability Discovery

Optional future endpoint:

```text
GET /api/v1/capabilities
```

May indicate:

- MRE connected
- banking import enabled
- OCR enabled
- AI enabled
- tax rules available

Useful for modular deployments.

---

# 95. API Documentation

The implementation should eventually provide machine-readable OpenAPI documentation.

Every public endpoint should document:

- authorization
- inputs
- outputs
- error codes
- idempotency
- side effects
- domain owner

---

# 96. API Test Strategy

Each business command requires tests for:

- success path
- validation
- authorization
- duplicate/idempotency
- concurrency
- audit creation
- domain invariants

Integration endpoints additionally require MRE contract tests.

---

# 97. Contract Tests Against MRE

At minimum:

- Property retrieval
- Tenant retrieval
- rent retrieval
- payment write-back
- Lease retrieval
- Realm access isolation

MRE version upgrades must run these tests.

---

# 98. API Anti-Patterns

## Anti-Pattern 1 — Generic CRUD Everywhere

Avoid:

```text
PATCH /entity/{id}
```

for domain transitions with important meaning.

---

## Anti-Pattern 2 — Raw Database API

Never expose:

```text
/query?filter={$and:[...]}
```

---

## Anti-Pattern 3 — UI-Owned Business Logic

The API must expose calculated business results rather than require the frontend to reproduce formulas.

---

## Anti-Pattern 4 — Derived Value Update

Never expose:

```text
PATCH /metrics/LTV
```

---

## Anti-Pattern 5 — Direct AI Write

Never expose an AI path that bypasses canonical commands.

---

## Anti-Pattern 6 — Direct MRE DB Write

All MRE mutations use supported adapter/API paths.

---

## Anti-Pattern 7 — Hidden Cross-Domain Mutation

A Tax command must not silently rewrite Financial Ledger data.

---

# 99. Initial MVP API Surface

The MVP should prioritize:

### Integration

- MRE Realm
- PropertyReference
- Party mapping
- RentalContractReference
- rent reads

### Financial

- FinancialAccount
- Bank import
- Transaction
- TransactionSplit
- confirmation
- correction
- rent reconciliation

### Acquisition

- Acquisition
- Acquisition Costs
- Ownership
- Land/Building Allocation

### Financing

- Loan
- Loan Terms
- Loan Allocation
- Loan Schedule
- payment reconciliation

### German Property

- WEG
- WEG Membership
- Economic Plan
- Annual Statement
- Cost Lines

### Tax

- Tax Classification
- Tax Rule reads
- Depreciation

### Investment

- Market Valuation
- metrics
- metric snapshots

### Reporting

- Property Dashboard
- annual tax package

---

# 100. Deferred API Surface

Initially defer:

- Portfolio APIs
- Open Banking
- OCR
- advanced Utility Settlement
- automated Scenario engine
- AI endpoints beyond basic suggestion architecture
- mobile-specific APIs
- external third-party developer API

---

# 101. Recommended API Module Layout

Conceptually:

```text
api/
├── integration/
│   └── mre/
├── parties/
├── properties/
├── ownership/
├── acquisitions/
├── ledger/
├── financing/
├── deposits/
├── weg/
├── maintenance/
├── documents/
├── taxation/
├── depreciation/
├── investment/
├── reporting/
├── automation/
└── ai/
```

This is logical module structure, not necessarily separate services.

---

# 102. Command Naming Rule

Commands should use domain language.

Preferred:

```text
confirmTransaction()
reconcileRentPayment()
closeOwnership()
recalculateDepreciation()
```

Avoid:

```text
updateRecord()
setStatus()
saveData()
```

---

# 103. Query Naming Rule

Queries should describe user intent.

Preferred:

```text
getPropertyDashboard()
getOutstandingRentReconciliations()
getTaxYearSummary()
```

Avoid exposing persistence terminology.

---

# 104. Internal vs External APIs

Not every internal capability must be publicly exposed.

Example:

`recalculateAllDerivedMetrics()` may remain an internal service operation.

Public API should remain intentionally small.

---

# 105. API Evolution Rule

When adding a new endpoint, contributors must verify:

- Which domain owns the operation?
- Is this a query or command?
- Does it duplicate an existing capability?
- Does it expose implementation details?
- Can it violate accepted ADRs?
- Is it idempotent where necessary?
- Is audit behavior defined?
- Are MRE dependencies isolated?

---

# 106. AI Coding Agent Guidance

AI coding agents implementing APIs must:

- follow business command semantics
- avoid generic CRUD shortcuts
- preserve domain ownership
- use FinancialAccount naming
- use RentalContractReference rather than assuming MRE Lease is the full contract
- use MRE adapter interfaces
- implement reconciliation explicitly
- never create Ledger Transactions from MRE payments without provenance
- never expose editable derived metrics
- include tests for invariants
- surface ADR conflicts instead of bypassing them

---

# 107. Open API Decisions

## API-OPEN-001 — Authentication Token Sharing

How exactly should the DE API validate or reuse MRE authentication tokens?

**Direction accepted (ADR-034):** reuse MRE authentication + Realm authority. The exact token validation/propagation mechanism is an implementation spike (per TECH-ADR-005), not a new architecture decision.

---

## API-OPEN-002 — Organization Context Transport

Should Realm context be encoded primarily in:

- token claims
- header
- route
- combination

Implementation-level under ADR-034 (Realm authority reused); Realm membership must be verified server-side regardless of transport.

**Resolved at implementation level (VC-0-08):** the Realm is sent in the `organizationid` request header — the same header the MRE landlord API uses — and verified server-side against MRE on every `/api/v1` request (`mre-integration.md` §47.1). Route scoping may be added later where a resource path naturally carries the Realm.

---

## API-OPEN-003 — MRE Payment ID Limitation

How should reconciliation fingerprints be represented until MRE has stable payment IDs?

---

## API-OPEN-004 — Correction Endpoint Semantics

Should correction create:

- replacement record
- reversal + replacement
- versioned mutation

**Resolved by ADR-037:** reversal + replacement (confirmed transactions are immutable).

---

## API-OPEN-005 — Async Jobs

Large reports, imports and OCR may eventually require job APIs.

The initial MVP should avoid asynchronous infrastructure unless necessary.

---

## API-OPEN-006 — GraphQL

No need exists currently.

REST-like business APIs are preferred for the MVP.

GraphQL may be reconsidered only if composite query requirements justify it.

---

# 108. Final API Principle

The API should expose the business model the user understands.

It should not expose the database model the developer happens to use.

The correct abstraction chain is:

```text
User Intent
   ↓
Business Capability
   ↓
Domain Command / Query
   ↓
Domain Model
   ↓
Persistence / MRE Adapter
```

Never reverse this chain.

---

# Closing Statement

The API of Vermieter Cockpit DE is not intended to be a thin CRUD layer over storage.

It is the executable contract of the domain model.

Its role is to protect:

- financial truth
- domain boundaries
- historical traceability
- MRE compatibility
- human review
- reproducible calculations

The best API endpoint is not the one that exposes the most flexibility.

It is the one that makes the correct business action explicit and the incorrect state difficult or impossible to create.

> Commands express intent.  
> Queries explain state.  
> Adapters isolate external systems.  
> Reconciliation connects realities without merging them.
