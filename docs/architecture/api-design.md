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
POST /loans/{id}/terms/{termsId}/void
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
/loans/{id}/terms/{termsId}/void
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
GET /api/v1/acquisitions/{acquisitionId}/land-building-allocations  (VC-2-08, §27.3)
GET /api/v1/acquisitions/{acquisitionId}/owner-allocation           (VC-2-09, §27.4)
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

## 27.3 Land/building allocation (VC-2-08, implemented: migration 0023)

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
- **Success:** `201` with the allocation; the previous current one gets `supersededAt` (its `supersededById` is derived, see below). AuditRecords: `CREATED` on the new allocation (amounts, method, review state, `supersedes`), `SUPERSEDED` on the old one.
- **Idempotency** as §15, scope `acquisition.allocation.create`, fingerprint of the Acquisition id and the normalized body. Without a key a retry is safe anyway: after the first success `supersedes` no longer names the current allocation and the retry is `409 CURRENT_ALLOCATION_CHANGED`.
- **A correction** (other amounts, another review state, an advisor's confirmation) is a new allocation that supersedes the current one; nothing is edited in place, and the history stays readable.

### Response and read

- **Allocation:** `allocationId`, `acquisitionId`, the three amounts (Money), `method`, `reviewState`, `effectiveDate`, `advisorPartyId`, `sourceReferences`, `notes`, `supersedesId`, `supersededAt`, `supersededById` (derived: the id of the allocation whose `supersedesId` names this one, `null` while current), `current` (boolean), `createdAt`, and the derived `landShare` and `buildingShare` (§87 decimal strings, `land / total` and `building / total` rounded half-even to four places, for display only: they need not add to exactly `1.0000`; the amounts are the record).
- `GET …/land-building-allocations`: `{ current, items }`: the current allocation or `null`, and the whole history newest first (`createdAt`, then id), in one `REPEATABLE READ READ ONLY` transaction; unpaged (a handful per Acquisition); unknown parameters are `400`.

### Concurrency and locks

- One READ COMMITTED transaction: claim the key → write the Acquisition row (the no-op of §27.2, so it serialises with cancel, confirm and cost or payment writes) → read the current allocation → check `supersedes` → set the old one's `supersededAt` → insert the new one with `supersedes_id` → AuditRecords → record the key. Two concurrent allocations of one Acquisition therefore run one after the other, and the second gets `409 CURRENT_ALLOCATION_CHANGED` (it names the replaced one); a cancel that comes first is seen.
- Lock order: Acquisition only (the advisor is read without a lock: an inactive advisor is allowed).

### In the database (migration 0023)

- `land_building_allocation`: composite foreign keys `(acquisition_id, mre_realm_id)` to `acquisition` and `(advisor_party_id, mre_realm_id)` to `party`; amounts `numeric`, scale ≤ 2, total `> 0`, land and building `≥ 0`, `land + building = total` (CHECK), EUR; `method` and `review_state` CHECKs; `effective_date` not null.
- At most one current allocation per Acquisition: a unique index on `acquisition_id` where `superseded_at IS NULL`.
- **Write order (review on #52):** the old row's `superseded_at` is set **first**, then the new row is inserted with `supersedes_id`. The other order cannot work: the partial unique index cannot be `DEFERRABLE`, so inserting a second current row first fails at once (`23505`). There is therefore **no stored back-pointer**: a `superseded_by_id` would name a row that does not exist yet at the update. The successor is derived from its `supersedes_id`, so the rows form no cycle and need no deferred foreign key.
- The chain stays in one Acquisition and is consistent: `supersedes_id` references `(id, acquisition_id)` of the same Acquisition (composite foreign key, immediate: the row it names exists) and is unique (one successor at most). A **deferred constraint trigger** checks at commit, for every row written in the transaction, both directions: a row with `superseded_at` has a successor whose `supersedes_id` names it, and a row with `supersedes_id` names a row with `superseded_at` set. So no allocation is superseded without a successor, and none supersedes a row that is still current.
- Frozen: data never changes, rows are never deleted; the only step is setting `superseded_at`, once. A new row is inserted only current (not superseded), and only for an Acquisition that is not `CANCELLED` (its row written first, `acquisition_touch_open` of 0021).
- Tests:
  - **Past the repository**, each with a counter-check: the sum CHECK; a second current row; a supersede without a successor and a successor naming a current row (both at commit); a successor in another Acquisition; a change of data; a delete; an insert on a `CANCELLED` Acquisition; an insert already superseded.
  - **Concurrency:** two allocations of one Acquisition (RC: the second is `CURRENT_ALLOCATION_CHANGED`; RR past the repository: `40001`); an allocation against a cancel (both orders).

## 27.4 Owner-level allocation (VC-2-09, implemented; a read, no migration)

Decision P2-D10 of `docs/development/phase-2-plan.md`, with the rule of data-model §61. A read: it stores nothing and changes nothing.

```text
GET /api/v1/acquisitions/{acquisitionId}/owner-allocation
```

- **Authorization:** as §27.1. Unknown or foreign `404`, malformed `400`, unknown query parameters `400`.
- **Basis (P2-D10):** the Acquisition is split among **its own buyers**, not among all owners of the PropertyReference. The basis is the `VALID` Ownerships carrying its `acquisitionId` (P2-D8). An Ownership closed since still counts: closing ends it later, it does not undo the purchase. Each owner's **weight** is its share divided by `acquiredShare`, an exact reduced fraction (`"n/d"`, §26.1). In a partial acquisition the buyer of `1/2` has weight `1/1` and carries 100 % of price and costs.
- **When it answers:**
  - `CONFIRMED`: `basis = "CONFIRMED"`. P2-D8 guarantees one Ownership per buyer from the transfer date, with shares summing to `acquiredShare`, so the weights sum to exactly `1`.
  - `DRAFT`: `basis = "PROVISIONAL"` only when its Ownerships already have the **structure** confirmation requires, that is requirements 2–5 of §28.1 (all start on the transfer date, held only by buyers, every buyer holds one, shares sum to exactly `acquiredShare`). This is a preview while WF-002 is under way, and it never feeds anything; only `CONFIRMED` does (Phase 7/8). Requirements 1 (buyers active) and 6 (the PropertyReference `COMPLETE`) are not needed for a split among the buyers. Otherwise the answer is `409 CONFLICT` with `reason = "OWNERSHIP_BASIS_INCOMPLETE"` and `details.violations` in the format of `CONFIRMATION_BLOCKED` (§28.1, codes 2–5). So a non-buyer never receives a part, and every owner appears once (review on #54): a buyer with a second Ownership carrying the id fails requirement 2, since two of one owner cannot both start on the transfer date (no overlap, P2-D4).
  - `CANCELLED`: `409 CONFLICT` with `reason = "ACQUISITION_CANCELLED"`.
- **Amounts distributed** (each separately, P2-D10):
  - the purchase price;
  - the expected amount of each cost **category**: the sum of its `ACTIVE` costs (§27.2); `VOID` costs count nowhere; categories without costs are left out;
  - when a current land/building allocation exists (§27.3): `landAmount` and `buildingAmount`. Paid amounts are not distributed: the read is about the acquisition's economics, not the cash.
- **Deterministic cents (P2-D10, F4):** for an amount of `A` cents and weights `w_i`, every owner first gets `floor(A × w_i)` cents. The remaining `A − Σ floor(A × w_i)` cents (fewer than the number of owners) go one each to the owners with the largest fractional remainder `A × w_i − floor(A × w_i)`, ties broken by `ownerPartyId` ascending. All of it is computed exactly (integers and fractions, no floating point). So every part is ≥ 0 and every column sums to its amount.
- **Totals are derived, never distributed (F4b):** an owner's `costsTotal` is the sum of their category parts, their `totalAllocableAmount` is `land_i + building_i`. Largest remainder is not monotone (Alabama paradox), so distributing a total separately could give a negative difference. This way every per-owner identity holds by construction. A derived total may differ by at most one cent per component from distributing the total directly; that is intended.
- **Response:**
  - `acquisitionId`, `status`, `basis`, `acquiredShare`, `allocationId` (the current land/building allocation, or `null`);
  - `owners` in `ownerPartyId` order, each with:
    - `ownerPartyId`, `ownershipId`, `share`, `weight`;
    - `purchasePrice` (Money);
    - `costs` (`{ category: Money }` for the categories present) and `costsTotal`;
    - `landAmount`, `buildingAmount`, `totalAllocableAmount` (all `null` without an allocation);
  - `totals`: the undistributed amounts, the same shape, for the reader's check; every column of `owners` sums to them.
- **Snapshot:** one `REPEATABLE READ READ ONLY` transaction reads the Acquisition, its Ownerships, its costs and its current allocation, so the parts always come from one state.
- **Tests:**
  - the review counterexample: weights `3/7, 3/7, 1/7`, land 0.10 €, building 0.01 € → land 4/4/2 ct, building 1/0/0 ct, total 5/4/2 ct;
  - ties broken by `ownerPartyId`;
  - a single buyer gets everything;
  - a partial acquisition (weight `1/1` for a share of `1/2`);
  - `VOID` costs left out;
  - no allocation gives `null` parts;
  - the three status answers, and a `DRAFT` refused as `OWNERSHIP_BASIS_INCOMPLETE` for a non-buyer holding an Ownership with the id and for a buyer holding two (one from the transfer date, one later);
  - a **property test** over random fractions (up to 20 owners, denominators up to 10 000) and random amounts (0 to 10¹⁵ cents): every part ≥ 0, every column sums exactly, each per-owner total equals its parts, and every part is within one cent of `A × w_i`.
- Docs: data-model §61 names this read as the acquisition-side application of its rule.

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
- **The file's own account** (#107, `generic-csv` v2 with `columnMapping.accountIban`, §32.5): checked against the FinancialAccount before anything is written; a refusal is `422 ACCOUNT_IBAN_MISMATCH` with `details.reason` — `ACCOUNT_IBAN_MISMATCH` (another account), `MIXED_ACCOUNT_IBANS` (the rows name several), `ACCOUNT_IBAN_MISSING` (the column is mapped but empty), `ACCOUNT_HAS_NO_IBAN` (the FinancialAccount has none to compare with: drop the mapping to import without the check) — plus `accountIban` and `fileIbans`; no batch is stored.
- **Per-row failures** do not fail the request: the batch is `201` and each such row has outcome `error` with field codes (the `422` of §32.1 is reported per row, not as the status). A sixth outcome `skipped` (`reason: ZERO_AMOUNT`) reports rows that move no cash, such as `0,00` balance lines; they are counted in `skippedCount`, not as errors.
- **Closed accounts:** an import may still post rows booked **up to and including the closing day** (the `Europe/Berlin` calendar day of `closedAt`) — statements usually arrive after an account was closed. Later rows are `error` with `bookingDate` / `ACCOUNT_CLOSED`. Manual Transactions stay refused on closed accounts (§31.2).
- **Duplicate rules** (`data-model.md` §70): a review item with the row's full source identity is always checked first (referenced while `PENDING`, structured duplicate once `RESOLVED`). A row with an external id is then decided by it, independent of adapter: same id **and** same content fingerprint → `duplicate/TRANSACTION`; same id, other content → new item `EXTERNAL_ID_CONTENT_CONFLICT`; no id match but the same content as an imported Transaction without id → new item `AMBIGUOUS_CROSS_FILE_MATCH`; else created. A row with a balance whose balance identity is unique in its file (`generic-csv` v2, `data-model.md` §70.6) is then decided by it, independent of adapter: one Transaction of the account with that identity and the same content fingerprint → `duplicate/TRANSACTION`; one with other content → new item `BALANCE_IDENTITY_CONTENT_CONFLICT`; several → new item `AMBIGUOUS_CROSS_FILE_MATCH` naming all; none → the rules below. Otherwise the full source-row identity (adapter id + version, statement key = source statement id else `sha256:<content hash>`, row key = source row id else `pos:<n>`) decides: imported Transaction → `duplicate/TRANSACTION`; review item → referenced while `PENDING`, `duplicate/RESOLVED_REVIEW_ITEM` once resolved. The same row under another adapter version → new item `ADAPTER_VERSION_CONFLICT`. The same content fingerprint as an imported Transaction of **another** statement (including rows imported via external id) → new item `AMBIGUOUS_CROSS_FILE_MATCH`. Two identical rows **within one file** are two Transactions (their positions differ).
- **Concurrency:** the import locks the account row; two uploads of one file serialize, the second sees the first's rows as duplicates. Unique indexes on both identity branches and on the review-item identity back this up in the schema.
- **Response** (`201`, also `GET /imports/{importBatchId}`, `404` for unknown and foreign batches): `importBatchId`, `mreRealmId`, `financialAccountId`, `adapterId`, `adapterVersion`, `sourceFilename`, `contentHash`, `status` (`COMPLETED` | `NEEDS_REVIEW`), `transactionCount`, `duplicateCount`, `needsReviewCount`, `errorCount`, `skippedCount`, `importedAt`, `importedBy`, `rows` (in file order, each with `position`), `continuity` (VC-1-12, `data-model.md` §70.6; `null` unless the file has a balance column with at least one value): `order` (`OLDEST_FIRST` | `NEWEST_FIRST`), `breaks` (each `{ position, expectedBalanceAfter, balanceAfter }`: where the balance does not follow from the previous row, e.g. in a filtered export) and `previousExport` (`OVERLAPS` the oldest row is already imported with its balance identity, `CHAINS` it continues from a balance of its own day or of the last earlier day with a balance, `GAP` earlier balances exist but none of those it continues from, `NO_EARLIER_BALANCE`). The report never refuses a file or changes a row's outcome.
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

- **List** (`GET …/review-items`, optional `status=PENDING|RESOLVED`, other values `400`): `200` with `{ importBatchId, items }`, the items **owned by** the batch in file order. Each item: `reviewItemId`, `importBatchId`, `financialAccountId`, `adapterId`, `adapterVersion`, `status`, `ambiguityReason` (`AMBIGUOUS_CROSS_FILE_MATCH` | `ADAPTER_VERSION_CONFLICT` | `EXTERNAL_ID_CONTENT_CONFLICT` | `BALANCE_IDENTITY_CONTENT_CONFLICT`), `normalizedRow` (with `position`, `statementKey`, `rowKey`), `conflictingTransactionIds` **and** `conflictingTransactions` — the conflicting Transactions themselves (dates, amount, direction, counterparty, description, external id, their batch), so the row and what it may duplicate can be shown side by side — `priorReviewItemIds`, `resolution`, `resolvedByAccountId` (the MRE email), `resolvedAt`, `createdTransactionId`, `createdAt`. Unknown and foreign batches are `404`.
- **Resolve** (`POST …/resolve`, body `{ "resolution": "CREATE" | "SKIP" }`): `200` with the item (as in the list, without `conflictingTransactions`). Missing or invalid `resolution` → `422 VALIDATION_ERROR`; malformed ids → `400`; an item not owned by the path batch, unknown or foreign → `404`.
  - **Same resolution again:** `200` no-op with `Idempotent-Replayed: true` and the same `createdTransactionId`. **Other resolution:** `409 CONFLICT`, `details.reason = "ALREADY_RESOLVED"`, `details.resolution` = the stored one.
  - **`CREATE`** creates exactly one `IMPORTED` Transaction from the stored normalized row: the batch's provenance, the owning batch as `importBatchId`, the row's source identity (adapter, statement, row, fingerprint) and a link to the item. It keeps the row's balance (§70.6) and the row's external id unless the reason was `EXTERNAL_ID_CONTENT_CONFLICT` or another Transaction of the account holds that id meanwhile (`data-model.md` §70.4). A row booked after the account's closing day (Europe/Berlin, as for imports, §32.1a) is `409 CONFLICT` with `reason = "ACCOUNT_CLOSED"`; `SKIP` is always possible.
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

## 32.5 Adapter `generic-csv`, version 2 (VC-1-12, ADR-043)

Version 1 plus the bank's running balance (`data-model.md` §70.6). Select it with `adapterVersion: "2"`; version 1 stays available and refuses the new mapping key.

- **Options:** as §32.4, and `columnMapping.balanceAfter` (optional): the header of the column with the balance after each booking (BBBank, Volksbank: `Saldo nach Buchung`); `columnMapping.accountIban` (optional, #107): the header of the column with the file's own account (BBBank, Volksbank: `IBAN Auftragskonto`), normalized like a counterparty IBAN and checked against the FinancialAccount (§32.1a); it changes no row. Rows with an empty account cell (e.g. a sum or footer line) are not counted; all filled cells must name the same account.
- **Presets** (#108, VC-1-14): `preset` in place of `columnMapping` selects a mapping shipped with the adapter version; the other options (format, `skipLines`) stay as usual. A preset never changes under a released version; a changed mapping is a new name. A preset together with a `columnMapping`, or an unknown name, is `INVALID_OPTIONS`; version 1 has no presets.
  - `vr-banking`: the export of the cooperative banks' online banking (BBBank, Volksbanken, Raiffeisenbanken) — `Buchungstag`, `Valutadatum`, `Betrag`, `Waehrung`, `Name Zahlungsbeteiligter`, `IBAN Zahlungsbeteiligter`, `Verwendungszweck`, `Saldo nach Buchung` (balance), `IBAN Auftragskonto` (the file's own account); `;`, decimal comma, `DD.MM.YYYY` (the defaults). The account needs an IBAN (§32.1a, `ACCOUNT_HAS_NO_IBAN`); without one, use a `columnMapping` without `accountIban` — an IBAN cannot be added to an existing FinancialAccount.
- **Balance:** parsed like the amount (sign, decimal separator, thousands separators), kept signed in the account currency's scale; an empty cell is no balance. A malformed or too precise balance is a row error on `balanceAfter` (`INVALID_FORMAT`, `SCALE_EXCEEDED`, `AMOUNT_OUT_OF_RANGE`).
- **Identity inputs:** as §32.4; the content fingerprint keeps field set v1 (the balance is not part of it), so v1 and v2 rows of one booking have the same fingerprint. A row's balance identity is `(booking date, amount, direction, balance)`, used only when unique in its file.
- **Stored:** every Transaction created from a row with a balance keeps it (`source_balance_after`, fixed after creation, migration 0034); it is import evidence, never a ledger balance, and not part of the Transaction responses.
- **Switching from v1:** rows imported under v1 carry no balance; the first v2 file that overlaps them sends the shared rows to review once (§70.4).

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
  - `NOT_SUPPORTED` for references whose entities do not exist yet (`wegId`, `rentalContractReferenceId`, `maintenanceProjectId`, `acquisitionId`, `taxClassificationId`; `securityDepositId` until VC-5-02): refused rather than stored unchecked. `acquisitionId` stays refused for good since VC-2-06: an Acquisition's payments link Transactions from the acquisition side (§27.2, P2-D7), not splits. `loanId` is accepted from VC-3-05 under the rules of §41.5. `securityDepositId` is accepted from VC-5-02 under the rules of §47.2.
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
| counterparty (`counterpartyNameRaw`, `counterpartyIbanRaw`, #111) | as the original | as the original |
| `status` | `CONFIRMED`; `confirmedAt` = time of the correction, `confirmedBy` = the acting MRE user's email | `CONFIRMED`; `confirmedAt` = time of the correction, `confirmedBy` = the acting MRE user's email |

- **The original keeps everything:** its fields, splits, `confirmedAt`/`confirmedBy`, provenance and import identity. Only its status changes, to `CORRECTED`. A re-import of its bank row is therefore still a duplicate of the original, also once it is `CORRECTED`, and never recreates it (data-model §70).
- **Closed account:** see §35.2. Neither record is refused because the original's account was closed since.
- **Chain:** an original has at most one reversal and one replacement. A later correction of the replacement links to the replacement, not to the first original, so the chain is a list `T₁ → T₂ → …`. In that list every member except the last is `CORRECTED` and the last is the current one. A reversal is never corrected (§35.4, `NOT_CORRECTABLE` with `correctionRole = "REVERSAL"`): a mistake in a correction is fixed by correcting its replacement.
- **Net effect (ADR-037, reporting):** per account, period (by `bookingDate`), category and PropertyReference, the sum over `CONFIRMED`, `RECONCILED` and `CORRECTED` Transactions with sign by `direction` equals the sum over the current ones alone. "Current" means `CONFIRMED` or `RECONCILED` and not a reversal. Each original and its reversal cancel exactly, so the full chain stays visible and nothing is counted twice. Category and PropertyReference mean the **split** level (each split's category and PropertyReference), which is what reports aggregate. The rule holds at Transaction level (`propertyReferenceId` of the Transaction) as well, since the reversal copies it.

## 35.4 Response and errors

- **Transaction fields added by correction** (in every Transaction response from VC-1-11 on): `correctionOfTransactionId` and `correctionRole` (both `null` on an ordinary Transaction), and on a `CORRECTED` original `reversalTransactionId` and `replacementTransactionId`.
- **Counterparty** (in every Transaction response from #109 on): `counterpartyNameRaw` and `counterpartyIbanRaw`, read-only, as the bank file named them (data-model §70.2; IBAN as normalized on import). `null` when the file had no such column or value, and on manual Transactions. A reversal or replacement keeps the counterparty of the Transaction it corrects (#111, migration 0035 for earlier corrections): a correction changes amount, dates, description or splits, never who paid; its import identity stays `none` (§35.3).
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
- **Reconciled Transactions:** a `RECONCILED` Transaction is matched to MRE rent state, and correcting it must also undo or re-evaluate that match (workflows: "invalidate/re-evaluate affected reconciliations"). Until Phase 4 specifies that, correcting a `RECONCILED` Transaction is `409 CONFLICT` with `reason = "NOT_CORRECTABLE"` and `status = "RECONCILED"`. The status rule `RECONCILED → CORRECTED` (§34.2) stays in place for then. Phase 1 has no `RECONCILED` Transactions. Phase 4 does not use `RECONCILED`: rent reconciliation is a record of its own (§37.1, P4-D3), and a Transaction with a `CONFIRMED` one is refused with `TRANSACTION_RENT_RECONCILED` instead.

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

Decisions: `docs/development/phase-4-plan.md` (P4-D1…D8). Data: data-model §18A. Items: backlog §3c. The route list below is refined by those items' spec PRs.

### Queries

```text
GET /api/v1/rent-reconciliations                                    (VC-4-01, §37.1)
GET /api/v1/rent-reconciliations/{id}                               (VC-4-01, §37.1; ?checkMre=true VC-4-04, §37.4)
GET /api/v1/rent-reconciliations/suggestions                        (VC-4-03, §37.3: ?status=SUGGESTED)
GET /api/v1/rent-reconciliations/terms/{mreTenantId}/{mreRentTerm}  (VC-4-02, §37.2)
GET /api/v1/transactions/{transactionId}/rent-reconciliations       (VC-4-02, §37.2)
```

### Commands

```text
POST /api/v1/rent-reconciliations                                   (VC-4-01, §37.1: manual match)
POST /api/v1/rent-reconciliations/{id}/release                      (VC-4-01, §37.1)
POST /api/v1/rent-reconciliations/suggest                           (VC-4-03, §37.3)
POST /api/v1/rent-reconciliations/{id}/confirm                      (VC-4-03, §37.3)
POST /api/v1/rent-reconciliations/{id}/reject                       (VC-4-03, §37.3)
POST /api/v1/rent-reconciliations/{id}/write-back-to-mre            (VC-4-04, §37.4)
POST /api/v1/rent-reconciliations/{id}/remove-from-mre              (VC-4-05, §37.5)
```

## 37.1 Manual match, read, list, release (VC-4-01, implemented: migration 0030)

Decisions P4-D1, P4-D2, P4-D3 and P4-D7 (release and the correction rule) of `docs/development/phase-4-plan.md`. A `RentPaymentReconciliation` links counted rent cash of one DE Transaction to one MRE rent term (ADR-004A). It never creates or changes a Transaction, and it never changes MRE: write-back is VC-4-04.

- **Domain owner:** Integration / Financial Ledger. **Authorization:** as §19.1. The reconciliation, its Transaction and the MRE Tenant belong to the caller's Realm. Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`).
- **Status (P4-D2):**
  - `CONFIRMED` → `RELEASED` (here; final);
  - `SUGGESTED` → `CONFIRMED` | `REJECTED` comes with VC-4-03. In VC-4-01 a reconciliation is created `CONFIRMED` by a human and never `SUGGESTED`.
- **Fixed after creation:** Realm, `transactionId`, `mreTenantId`, `mreRentTerm`, `matchedAmount`, `notes`. A wrong match is released and matched again.
- **Response:**
  - `reconciliationId`, `mreRealmId`, `status`;
  - `transactionId`, `mreTenantId`, `mreRentTerm`;
  - `matchedAmount` (Money as §31);
  - `confidence`, `suggestionReason` (`null` until VC-4-03);
  - `confirmedAt`, `confirmedBy` (the acting MRE user's email);
  - `releasedAt`, `releasedBy`, `releaseReason` (`null` unless `RELEASED`);
  - `notes`;
  - `mreWriteBackState`: `NOT_WRITTEN` in VC-4-01. VC-4-04 adds the other states and their fields (P4-D6);
  - `createdAt`, `version`.
  - Single-reconciliation responses carry `ETag: "<version>"` (§16.1).

### The cash rules (P4-D3)

- **Counted:** the Transaction is `CONFIRMED` or `RECONCILED`, and not a reversal (§35.3's "current").
- **`INFLOW`.**
- **Rent cash** = the sum of its splits with category `RENT_BASE`, `RENT_OPERATING_COST_ADVANCE` or `RENT_OPERATING_COST_SETTLEMENT`. A counted Transaction's splits are frozen (§34.2), so its rent cash never changes.
- **Available** = rent cash − Σ `matchedAmount` of its `CONFIRMED` reconciliations.
- **At most one `CONFIRMED` reconciliation per Transaction, `mreTenantId` and `mreRentTerm`.** Several Transactions may match one term (a rent paid in two transfers), and one Transaction may match several terms (two months in one transfer, BR-RENT-008), each with its own `matchedAmount`.

### `POST /api/v1/rent-reconciliations`

- **Body** (strict; unknown keys `400`):
  - `transactionId` (UUID, required);
  - `mreTenantId` (required): an MRE id, `^[0-9a-f]{24}$` as §20.1;
  - `mreRentTerm` (required): MRE's term key `YYYYMMDDHH` as a 10-digit string. Its date must exist and its hour be `00`–`23` (`400 INVALID_TERM`). MRE's monthly terms end in `0100`, but other frequencies exist, so DE checks only the form and leaves the rest to MRE;
  - `matchedAmount` (Money as §31, required): **> 0** (`400 NOT_POSITIVE`), EUR;
  - `notes` (optional, trimmed, ≤ 2000).
- **Order of checks:**
  1. `400`;
  2. the Transaction unknown or foreign → `404` (`details.transactionId`);
  3. the Transaction not counted → `409 CONFLICT` with `reason = "TRANSACTION_NOT_COUNTED"` and `details.status`, `details.correctionRole`;
  4. `OUTFLOW` → `422 TRANSACTION_NOT_INFLOW`;
  5. no rent cash (no split in the rent categories) → `422 NO_RENT_CASH`;
  6. a `CONFIRMED` reconciliation for the same Transaction and term exists → `409 CONFLICT` with `reason = "ALREADY_MATCHED"` and `details.reconciliationId`;
  7. `matchedAmount` > available → `409 CONFLICT` with `reason = "RENT_CASH_EXCEEDED"` and `details.rentCash`, `details.available`;
  8. **the MRE term**, read live with the caller's token (`GET /rents/tenant/:id/:term`, P4-D1):
     - the Tenant or the term unknown in the Realm (MRE `404`) → `422 MRE_RENT_TERM_NOT_FOUND` with `details.mreTenantId`, `details.mreRentTerm`. At the baseline MRE also answers `404` when its own database read fails (`_findOccupants(...).catch(logger.error)` in `_rentOfOccupant`), so the code means "MRE did not return this term", and the message says so (review on #76);
     - MRE refuses the token → `401`, refuses the caller → `403`, as the access guard (§47.1 of mre-integration);
     - MRE unavailable, or an unexpected answer → `503 EXTERNAL_SYSTEM_ERROR`, as every other MRE call (§20.1, §23.1). Nothing is written (BR-MRE-004: only the match waits, the ledger stays available).
- **Where the MRE read sits:** checks 2–7 are read first in one snapshot, so a request DE refuses anyway never calls MRE. The MRE read then runs **outside** any database transaction (P4-D8). The write transaction repeats checks 2–7 under its locks, so a change in between answers as above.
- **Success:** `201` with the reconciliation (`status = CONFIRMED`, `confirmedAt`, `confirmedBy`, `mreWriteBackState = NOT_WRITTEN`, `version = 1`).
  - AuditRecord `CONFIRMED` with the Transaction, the Tenant, the term, `matchedAmount` and `manual = true`.
  - Only ids are stored and audited. The MRE answer is parsed to the term's existence and not kept; the Tenant's name and contact data never leave the client (mre-integration §20.1).
- **Idempotency (§15):** `Idempotency-Key` with scope `rent-reconciliation.create`, fingerprint of the normalized body. A replay answers `201` with the recorded body and `Idempotent-Replayed: true`, without an MRE call; the same key with another payload is `409`.
- **Locks (P4-D8):** the Transaction row first, written with P3-D8's no-op `UPDATE ledger_transaction SET version = version` (0013 allows it on a confirmed row), then the Transaction's `CONFIRMED` reconciliations are read. Nothing else is locked.

### `POST /api/v1/rent-reconciliations/{reconciliationId}/release`

- **Body:** `{ "reason": "..." }` (required, trimmed, 1–500).
- **Order of checks:**
  1. `400`;
  2. unknown or foreign → `404`;
  3. `RELEASED` → `200` no-op keeping the first reason and time, answered regardless of `If-Match` (as §41.1's void);
  4. `SUGGESTED` or `REJECTED` → `409 CONFLICT` with `reason = "NOT_RELEASABLE"` and `details.status`;
  5. `If-Match` → `412`.
- **Success:** `200` with the reconciliation (`status = RELEASED`, `releasedAt`, `releasedBy`, `releaseReason`, `version` + 1); AuditRecord `RELEASED` with the reason and `matchedAmount`. Its cash is available again.
- **DE-only (P4-D7):** release never calls MRE, so it works during an MRE outage. Its effect on a reconciliation already written back (`REMOVAL_REQUIRED`) and the refusal while a write-back runs come with VC-4-04; in VC-4-01 nothing is written back.
- **Locks:** the Transaction row first, as on create, then the reconciliation `FOR UPDATE`. A release and a create on the same Transaction serialise on it.

### Reads

- `GET /rent-reconciliations/{reconciliationId}`: one reconciliation with `ETag`.
- `GET /rent-reconciliations`: `{ items, page, pageSize, total }` (§11), newest `createdAt` first, then `reconciliationId`; count and page in one snapshot.
  - Filters, all optional and combined with AND: `status` (a comma-separated list, any of them), `transactionId`, `mreTenantId`, `mreRentTerm`.
  - `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`. An unknown or foreign `transactionId` filter is an empty page, not `404`, as a read filter (§30.1).
  - `…/suggestions` of the route list above is `?status=SUGGESTED` (VC-4-03) and gets no route of its own.
- Reads never call MRE. The coverage of a term and of a Transaction (P4-D5) is VC-4-02 (§37.2).

### Corrections of a matched Transaction (P4-D7)

- **`POST /transactions/{id}/correct` (§35) and `…/reverse` (§35.9)** gain a refusal right after `NOT_CORRECTABLE`: the Transaction has a `CONFIRMED` reconciliation → `409 CONFLICT` with `reason = "TRANSACTION_RENT_RECONCILED"` and `details.reconciliationIds` (in id order). The user releases first; the match then never points at cash that no longer counts (ADR-004A).
- **`RECONCILED` (§35.4) is unchanged:** rent reconciliation never sets it (P4-D3), so correcting a `RECONCILED` Transaction stays `NOT_CORRECTABLE` until a later item gives that status a meaning.
- A replacement can be matched again after its release. Nothing is carried over: the original's reconciliations stay `RELEASED`.

### In the database (migration 0030)

- **`rent_payment_reconciliation`:**
  - `id uuid`, `mre_realm_id text`, `status text` in (`SUGGESTED`, `CONFIRMED`, `REJECTED`, `RELEASED`);
  - `transaction_id uuid` with a composite foreign key `(transaction_id, mre_realm_id)` to `ledger_transaction`;
  - `mre_tenant_id text` (`^[0-9a-f]{24}$`), `mre_rent_term text` (`^[0-9]{10}$`);
  - `matched_amount numeric` (scale ≤ 2, > 0, < 1e18, as the ledger) and `currency text = 'EUR'`;
  - `confidence`, `suggestion_reason` (VC-4-03; `NULL` here);
  - `confirmed_at`, `confirmed_by`, `released_at`, `released_by`, `release_reason` (1–500), `notes` (≤ 2000);
  - `mre_write_back_state text` with `CHECK (mre_write_back_state = 'NOT_WRITTEN')`, which VC-4-04 widens;
  - `created_at`, `created_by`, `version`.
- **CHECKs:**
  - `(status IN ('CONFIRMED', 'RELEASED')) = (confirmed_at IS NOT NULL)`, the same for `confirmed_by`;
  - `(status = 'RELEASED') = (released_at IS NOT NULL)`, the same for `released_by` and `release_reason`.
- **Partial unique index** `(transaction_id, mre_tenant_id, mre_rent_term) WHERE status = 'CONFIRMED'`. Under it two concurrent creates of the same match cannot both commit; the repository answers the loser `ALREADY_MATCHED` (`ON CONFLICT … DO NOTHING` and a re-read).
- **`rent_payment_reconciliation_frozen`** (before update): the fixed fields above never change; the status steps are only `SUGGESTED` → `CONFIRMED` | `REJECTED` and `CONFIRMED` → `RELEASED`, each raising `version` by one. No `DELETE` (a trigger refuses it).
- **`rent_payment_reconciliation_cash`** (before insert, and before update when `NEW.status = 'CONFIRMED'` and `OLD.status <> 'CONFIRMED'`):
  - an insert is only `SUGGESTED` or `CONFIRMED` with `version = 1`, as `loan_initial` (0024). `REJECTED` and `RELEASED` are reached only by the steps, so no row is born past the cash guard or with another version (review on #77);
  - writes the Transaction row first (the no-op of P3-D8, `RETURNING status, direction, correction_role`), so every confirm serialises on the Transaction;
  - refuses a Transaction not counted (`TRANSACTION_NOT_COUNTED`), not `INFLOW` (`TRANSACTION_NOT_INFLOW`), or without rent cash (`NO_RENT_CASH`);
  - refuses when the sum of `matched_amount` over the Transaction's `CONFIRMED` reconciliations plus this one exceeds its rent cash (`RENT_CASH_EXCEEDED`). The guard re-reads both sums after the Transaction write, so under READ COMMITTED it sees every confirm that committed before it.
- **`ledger_transaction_rent_reconciled`** (before update of `status` on `ledger_transaction`, when it becomes `CORRECTED`): refuses while a `CONFIRMED` reconciliation names the Transaction (`TRANSACTION_RENT_RECONCILED`). The correction path holds the Transaction `FOR UPDATE` (§35.5), so this guard and the cash guard serialise on the same row.
- Not in the database: the MRE check (P4-D1), the order of checks, and the reads.

### Concurrency (RC and RR, each with a counter-check)

- **Two creates on the same Transaction** (different terms) whose amounts together exceed the rent cash: they serialise on the Transaction row. Under READ COMMITTED the second sees the first and answers `RENT_CASH_EXCEEDED`; under REPEATABLE READ it fails to serialise (`40001`). Counter-check: the guard's Transaction write → `FOR SHARE` lets both commit under RR.
- **Two creates of the same match:** the partial unique index; the loser answers `ALREADY_MATCHED`.
- **Create against a correction:** a create that waited sees `CORRECTED` (`TRANSACTION_NOT_COUNTED`) under RC, or fails with `40001` under RR; a correction that waited sees the reconciliation and answers `TRANSACTION_RENT_RECONCILED`, or fails with `40001`.
- **Release against a create:** after the release commits, its cash is available to a create that waited (RC).

### Tests (VC-4-01)

- **Domain:** the cash rules (counted, `INFLOW`, rent categories, available with released ones not counting); the term key's form; the order of checks.
- **Repository:**
  - Realm isolation (a Transaction of another Realm is `404`);
  - each refusal of the cash rules, with a reversal, a `CORRECTED` original, an unconfirmed Transaction, an `OUTFLOW`, and a Transaction whose only split is `INSURANCE`;
  - one Transaction over two terms; two Transactions over one term; a release making cash available again;
  - the AuditRecords `CONFIRMED` and `RELEASED`.
- **The correction rule:** `correct` and `reverse` refused while `CONFIRMED`, allowed after release, each through the API and past the repository; counter-check: the trigger dropped turns the past-the-repository test red.
- **Concurrency** as above, under RC and RR, each with its counter-check.
- **Schema past the repository**, each with a counter-check: every CHECK; the frozen fields and status steps; `DELETE`; the cash guard's four refusals; the unique index.
- **MRE client:** `rentTermExists(token, realm, tenantId, term)` parsed to existence only (the term key must come back); MRE `404` → not found, `401` / `403` / other as the existing client. The fake MRE gains Tenants with rent terms (the term read only; the PATCH is VC-4-04). `mre.contract.test.ts` pins the term read against the baseline: a known term, an unknown term and an unknown Tenant are `404`.
- **API:** every `400` code above; the error mapping (`422 MRE_RENT_TERM_NOT_FOUND`, `503 EXTERNAL_SYSTEM_ERROR`, nothing written on either, end to end against the fake MRE); idempotent replay and a refusal without an MRE call; release no-op, `412`, `NOT_RELEASABLE`; the list filters and order; Realm isolation end to end.

## 37.2 Coverage reads: per term and per Transaction (VC-4-02, implemented)

Decision P4-D5 of `docs/development/phase-4-plan.md`, BR-RENT-006/007. Two derived reads that show MRE's operational state and DE's cash **next to each other, never merged** (ADR-004A, the Phase-4 exit's "distinct records"). Nothing is stored; a read never writes, in DE or in MRE.

- **Domain owner:** Integration / Financial Ledger. **Authorization:** as §37.1. Reads use one `REPEATABLE READ READ ONLY` snapshot for the DE side; the MRE read runs outside it (P4-D8).

### `GET /api/v1/rent-reconciliations/terms/{mreTenantId}/{mreRentTerm}`

- **Path:** `mreTenantId` as §37.1 (`^[0-9a-f]{24}$`), `mreRentTerm` a term key (`400 INVALID_TERM` as §37.1). No query parameters (`400`).
- **DE side** (from DE alone, always answered): every reconciliation of the Realm for this Tenant and term, in `createdAt` order, each as §37.1's response; `matchedTotal` = Σ `matchedAmount` of the `CONFIRMED` ones (Money, `0.00` when none). A term without any reconciliation is not `404`: its DE side is empty.
- **MRE side**, read live with the caller's token (`GET /rents/tenant/:id/:term`, as §37.1):
  - `mreStatus`:
    - `AVAILABLE`: `mre` = `{ amountDue, payments }`;
    - `NOT_RETURNED`: MRE answered `404` (an unknown or deleted Tenant or term, or MRE's swallowed database error, §37.1); `mre` = `null`;
    - `UNAVAILABLE`: MRE down or an unexpected answer; `mre` = `null`. The DE side is still answered (BR-MRE-004): an outage never hides DE's matches. A refused token or caller is still `401` / `403` (§37.1): access is not degraded silently.
  - `amountDue`: MRE's amount due for the term **without** the carried balance (`totalWithoutBalanceAmount`, P4-D4), as Money.
  - `payments`: MRE's own payment records of the term, each `{ date, amount, type, reference }` in MRE's order. `date` is converted from MRE's `DD/MM/YYYY` to a business date, `null` when it does not parse; `description` is not read (MRE's own form drops it, P4-D6's MRE facts). They are **MRE settlement, not cash** (BR-RENT-001) and never enter `matchedTotal` or the coverage.
  - **MRE amounts are floats.** Every **finite** amount is taken exactly from its shortest round-trip decimal text, **exponent notation included**, and rounded half-up to the cent, the precision MRE's own UI shows. Only a non-finite amount or one outside Money's range (§31) is an unexpected answer (`UNAVAILABLE`).
    - Exponent notation is a real answer at the baseline (review on #78): `totalWithoutBalanceAmount` is `grandTotal − balance`, where `grandTotal` is rounded to the cent (`7_total.js`) but the carried `balance` is not (`5_balance.js`). A term whose own amount is 0 with a balance that is no exact cent float gives e.g. `2.831068712794149e-15`, which is `0.00` due, not an outage.
    - Unlike the cached `surface` (mre-integration §21.1), where leaving a malformed value out is enough, an amount due cannot be left out: the coverage needs it.
    - A negative half cent rounds away from zero (`-0.005` → `-0.01`, decimal.js' HALF_UP), and a rounded negative zero is `0.00`, never `-0.00` (review on #78).
  - The Tenant's name and contact data are not read (mre-integration §20.1); the client parses the term to these fields only.
- **`coverage`** (derived, BR-RENT-006/007), from `matchedTotal` against `amountDue`; `null` unless `mreStatus = AVAILABLE`:
  - `UNMATCHED`: `matchedTotal` = 0 and `amountDue` > 0;
  - `PARTIALLY_MATCHED`: 0 < `matchedTotal` < `amountDue`;
  - `MATCHED`: `matchedTotal` = `amountDue` (also 0 = 0);
  - `OVERPAID`: `matchedTotal` > `amountDue`;
  - `openAmount` = `amountDue` − `matchedTotal`, signed (negative when overpaid). The overpaid rest stays visible until its meaning is decided (BR-RENT-007); nothing is carried to another term.
- **Response:** `{ mreTenantId, mreRentTerm, reconciliations, matchedTotal, mreStatus, mre, coverage, openAmount }`.
- **Realm isolation:** the DE side is filtered to the caller's Realm; the MRE read carries the caller's Realm in `organizationid`, so another Realm's Tenant is `NOT_RETURNED`.

### `GET /api/v1/transactions/{transactionId}/rent-reconciliations`

- **Path:** a Transaction id (`400` malformed). No query parameters.
- Unknown or foreign Transaction → `404` (`details.transactionId`), as §30.1. Never calls MRE.
- **Response:**
  - `transactionId`, `status`, `direction`, `correctionRole`;
  - `counted`: the cash rules' "counted" (§37.1: `CONFIRMED` or `RECONCILED`, not a reversal);
  - `rentCash`: Σ of its `RENT_*` splits (Money), `null` without one;
  - `matchedTotal`: Σ `matchedAmount` of its `CONFIRMED` reconciliations (Money, `0.00` when none);
  - `available`: `rentCash` − `matchedTotal` when `counted` and `rentCash` ≠ `null`, else `null` (cash that is not counted is not available to match);
  - `reconciliations`: every reconciliation of the Transaction, any status, in `createdAt` order, each as §37.1's response.
- A Transaction that is not rent (no `RENT_*` split) answers with `rentCash = null` and its (empty) list, not `404`: the read describes, the match refuses (§37.1).
- The rest after the matches (`available` > 0) stays visible: it is the "unresolved" part of BR-RENT-007 until it is matched or its meaning is decided.

### In the code

- **Domain:** `coverageOf(amountDue, matchedTotal)` → `{ coverage, openAmount }`; the cash view of §37.1 (`MatchCash`, `availableOf`) reused for the Transaction read.
- **MRE client:** `readRentTerm(token, realm, tenantId, term)` → `{ amountDue, payments }` or `undefined` on `404`; `rentTermExists` (§37.1) becomes `readRentTerm(…) !== undefined`, so both parse one shape. The manual match therefore also answers `503` when the term's amount due or a payment amount is malformed, not only the coverage read `UNAVAILABLE`. That cannot happen at the baseline, whose `update` keeps only `Number(amount) > 0` payments and whose totals are numbers (review on #79). The fake MRE gains `totalWithoutBalanceAmount` and payments per term; `mre.contract.test.ts` pins both fields against the baseline (a Tenant with rent 800: `totalWithoutBalanceAmount` 800, `payments` an array, a payment written through MRE's own `PATCH` coming back with `date`, `amount`, `type` and `reference`).
- **No migration.**

### Tests (VC-4-02)

- **Domain:** `coverageOf` at each boundary (0 of 0, 0 of due, a cent short, exact, a cent over), `openAmount` signed.
- **MRE client:** the fields parsed and nothing else (a body with a name and contacts leaves no trace in the result or an error message); float amounts (`799.9999999999999` → `800.00`, `0.1 + 0.2` → `0.30`, `2.831068712794149e-15` → `0.00`, `-1e-14` → `0.00`) rounded half-up; a non-finite or out-of-range amount, a missing `totalWithoutBalanceAmount`, a non-array `payments` → `UNAVAILABLE`; a payment date that does not parse → `null`; `404` → `undefined`.
- **Repository:** the DE side in one snapshot, Realm-filtered; `matchedTotal` over `CONFIRMED` only (a `RELEASED` one listed, not summed); the Transaction read with `counted`, `rentCash`, `available` for a counted rent Transaction, an unconfirmed one (`available = null`), a reversal, and a non-rent Transaction (`rentCash = null`).
- **Use case:** `AVAILABLE`, `NOT_RETURNED` and `UNAVAILABLE` each with the DE side answered; `401`/`403` passed through; the Transaction read never asks MRE.
- **API:** the path and query `400`s; `404` for an unknown Transaction; the response shapes.
- **End to end** against the fake MRE: a term matched by two Transactions (`PARTIALLY_MATCHED`, then `MATCHED`, then `OVERPAID` after a third), MRE's own payments shown separately and never summed; MRE down → `UNAVAILABLE` with DE's matches; another Realm sees `NOT_RETURNED` and an empty DE side.
- **Counter-checks:** MRE's payments summed into `matchedTotal`; `RELEASED` summed; the coverage boundary off by one cent; the MRE amount truncated instead of rounded; exponent notation refused (the `e-15` case turns red); an MRE outage turned into a `503`.

## 37.3 Suggestions: suggest, confirm, reject (VC-4-03, implemented: migration 0031)

Decisions P4-D4 and P4-D5 of `docs/development/phase-4-plan.md`, BR-RENT-004. A suggestion is a stored `SUGGESTED` reconciliation: it never counts, never consumes cash and never changes MRE. A human confirms or rejects it. Confirmation runs the checks of §37.1 again, so a stale suggestion can never confirm wrong cash.

- **Domain owner and authorization:** as §37.1.
- **Status (P4-D2):** `SUGGESTED` → `CONFIRMED` (confirm) | `REJECTED` (reject, final). Both steps raise `version` by one.

### `POST /api/v1/rent-reconciliations/suggest`

- **Body** (strict): `from`, `to` as `YYYY-MM` (`400 INVALID_FORMAT`). `from` ≤ `to` (`400 INVALID_RANGE`), at most 12 months inclusive (`400 RANGE_TOO_LONG`). No `Idempotency-Key`: suggesting is idempotent by design (below).
- **1. MRE, outside any database transaction (P4-D8):** for each month of the window, and for the month before `from` and the month after `to`, `GET /rents/:year/:month` with the caller's token and Realm.
  - The two neighbouring months are read **for the uniqueness check only**: nothing is suggested for their terms.
  - Without them, a Transaction booked from the 15th to the end of a boundary month would look unique for one term in one run, and ambiguous in a run over a wider window (review on #80). Of each rent only the Tenant's `_id`, the `term` and `totalWithoutBalanceAmount` are read (amounts as §37.2). The occupant object with the Tenant's name and contacts is dropped by the client and never logged. If any month fails → `503 EXTERNAL_SYSTEM_ERROR` and nothing is written. A `401`/`403` is as §37.1.
- **2. DE, in one `REPEATABLE READ READ ONLY` snapshot:**
  - **open amount of a term** = MRE's amount due − Σ `matchedAmount` of the Realm's `CONFIRMED` reconciliations for that Tenant and term. MRE's own payments are not subtracted (BR-RENT-001). Terms with open amount ≤ 0 are skipped.
  - **candidates:** the Realm's counted `INFLOW` Transactions (§37.1) with available rent cash > 0.
  - **a pair (Transaction, term) fits** when the Transaction's available rent cash **equals** the term's open amount exactly, and its booking date lies from the 15th of the month before the term's month to the last day of the term's month. The term's month is the `YYYYMM` of its key.
  - **pairs already handled:**
    - a pair (Transaction, Tenant, term) with a `REJECTED`, `RELEASED` or `CONFIRMED` reconciliation is no fit and is never suggested again. A `CONFIRMED` one acts through the cash and the open amount anyway;
    - a pair with an **open `SUGGESTED`** reconciliation **stays in the graph as competition**, whether or not its amounts still match. It is never written again, but its Transaction and its term are not unique for any other pair (review on #80). Without that rule, two runs would suggest two Transactions for one term, or one Transaction for two terms, where a single run over both would have suggested nothing.
- **3. The rule** (deterministic, independent of input order):
  - The fits and the open suggestions form a bipartite graph between Transactions and terms, the neighbouring months' terms included. A fit whose Transaction and term have no other edge is **unique** → suggested.
  - **The month in the purpose text** (#125, real-data run F10), before the uniqueness check: a candidate whose description names the month of some of its fits keeps only those fits. Read are `MM.YYYY`, `MM/YYYY`, `YYYY-MM`, and a German month name with a four-digit year (`Oktober 2026`, `Okt. 2026`). A name without a year is not read, since `Jan` and `August` are first names. A full date (`DD.MM.YYYY`, `YYYY-MM-DD`) is not read either (review on #127): in a German transfer it is mostly the execution date (`DATUM 28.09.2027, 10.15 UHR`), which for a tenant who pays early names the month before. A text naming none of its fits' months changes nothing.
  - **IBAN history decides the rest:** a fit is a *history fit* when an earlier `CONFIRMED` reconciliation of the same Tenant names a Transaction with the same `counterparty_iban_raw` (not null). Among the non-unique fits, keep only the history fits, and keep the open suggestions as edges. A history fit whose Transaction and term have no other edge → suggested. A term of a neighbouring month is never suggested, but its edges block.
  - **In order from an anchor** (#125): a tenant who pays before the month (e.g. on the 28th) makes a chain in which every payment fits two terms of the same Tenant, so no pair is unique and the IBAN history cannot decide. The remaining fits are assigned in order, per Tenant:
    - a walk starts only at an open term whose **month before is done** for that Tenant: its term's open amount is ≤ 0, it was decided in this run, or it has an open suggestion;
    - a lease start (no term the month before) is **no anchor**, and neither is an open month before: read from the middle of a chain, or with the first payment not imported, the whole chain would shift by one month;
    - each consecutive month takes the **oldest** remaining candidate (booking date, then id) that fits it, as long as it has a counterparty IBAN (the same for all of the Tenant's walks), fits no other Tenant's term and no earlier open term, and has no open suggestion;
    - the walk stops at the first month without such a candidate. A Tenant who skipped a month is therefore placed one month late until the user corrects it: the suggestion is `MEDIUM` and never authoritative.
  - Everything else is left alone: partial and combined payments, overpayments, and ambiguous amounts. The user matches those by hand (§37.1).
  - **`confidence`:** `HIGH` for a history fit (whether it was unique or decided by the history), `MEDIUM` for a unique fit without history.
  - **`suggestionReason`:** `EXACT_AMOUNT_IN_ORDER` for the walk; else `EXACT_AMOUNT_PURPOSE_MONTH` when the text's month removed other fits of the candidate; else `EXACT_AMOUNT_IBAN_HISTORY` for a history fit; else `EXACT_AMOUNT`. `confidence` stays as above.
  - **`matchedAmount`:** the open amount.
- **4. Write** (one READ COMMITTED transaction):
  - lock the chosen pairs' Transaction rows in id order (P3-D8's no-op write; Transaction → reconciliation);
  - re-check each pair: still counted, still the same available rent cash, still no reconciliation for the pair. A pair that changed is skipped, not refused;
  - insert it `SUGGESTED` with `version = 1` and one AuditRecord `SUGGESTED` (Transaction, Tenant, term, amount, confidence, reason).
- **Success:** `200 { from, to, items }`. `items` are the reconciliations written by this run, in Transaction id order. A repeat over the same window writes nothing new and answers `items: []`.
- **Concurrency:** two runs over one window cannot both write a pair. The partial unique index `(transaction_id, mre_tenant_id, mre_rent_term) WHERE status = 'SUGGESTED'` (0031) is the arbiter, and the loser skips (`ON CONFLICT … DO NOTHING`).

### `POST /api/v1/rent-reconciliations/{reconciliationId}/confirm`

- **Body** (strict, may be empty): `matchedAmount` (Money, optional). When given it is > 0 (`400 NOT_POSITIVE`) and not above the suggested amount (`422 ABOVE_SUGGESTION` with `details.suggested`): a confirmation may lower the amount, never raise it (P4-D5). Without it, the suggested amount is kept.
- **Order of checks:**
  1. `400`;
  2. unknown or foreign → `404`;
  3. `CONFIRMED` with the same amount → `200` no-op whatever the version; `CONFIRMED` with another amount, `REJECTED` or `RELEASED` → `409 CONFLICT` with `reason = "NOT_CONFIRMABLE"` and `details.status`;
  4. `ABOVE_SUGGESTION`;
  5. checks 3–7 of §37.1 for the Transaction with the amount to confirm: `TRANSACTION_NOT_COUNTED`, `TRANSACTION_NOT_INFLOW`, `NO_RENT_CASH`, `ALREADY_MATCHED`, `RENT_CASH_EXCEEDED`. The suggestion itself never counts as consumed cash;
  6. the MRE term, read live: as §37.1 (`422 MRE_RENT_TERM_NOT_FOUND`, `503`), read outside any database transaction after checks 1–5;
  7. **`409 CONFLICT` with `reason = "SUGGESTION_STALE"`** and `details.openAmount`: the amount to confirm is above the term's open amount now. This is MRE's amount due, read in step 6, minus the term's `CONFIRMED` matches; someone matched the term in between. A deliberate overpayment is still possible by hand (§37.1);
  8. `If-Match` → `412`.
- The write repeats checks 3–5 and 7 under the locks (Transaction row first, then the reconciliation `FOR UPDATE`), with the MRE amount of step 6.
- **Success:** `200` with the reconciliation (`status = CONFIRMED`, `confirmedAt`, `confirmedBy`, `matchedAmount`, `version` + 1; `confidence` and `suggestionReason` kept). AuditRecord `CONFIRMED` with `manual = false`, `suggestedAmount` and `matchedAmount`. Never calls the write-back (BR-MRE-005).

### `POST /api/v1/rent-reconciliations/{reconciliationId}/reject`

- **Body:** `{ "reason": "..." }` (required, trimmed, 1–500).
- **Order:**
  1. `400`;
  2. `404`;
  3. `REJECTED` → `200` no-op keeping the first reason;
  4. `CONFIRMED` or `RELEASED` → `409 CONFLICT` with `reason = "NOT_REJECTABLE"` and `details.status`;
  5. `If-Match` → `412`.
- **Success:** `200` (`status = REJECTED`, `rejectedAt`, `rejectedBy`, `rejectReason`, `version` + 1). AuditRecord `REJECTED` with the reason. The pair is never suggested again.
- **Locks:** the reconciliation `FOR UPDATE` only. A rejection consumes no cash, so it takes no Transaction lock.
- The §37.1 response gains `rejectedAt`, `rejectedBy`, `rejectReason` (`null` unless `REJECTED`).

### Reads

- `GET /rent-reconciliations?status=SUGGESTED` lists the open suggestions (§37.1's list). The route list's `…/suggestions` is that filter and has no route of its own.

### In the database (migration 0031)

- **`rent_payment_reconciliation` gains** `rejected_at`, `rejected_by` and `reject_reason` (1–500, trimmed). CHECK `(status = 'REJECTED') =` each of them `IS NOT NULL`.
- **CHECK:** `status <> 'SUGGESTED' OR (confidence IS NOT NULL AND suggestion_reason IS NOT NULL)`. `suggestion_reason` must be one of `EXACT_AMOUNT`, `EXACT_AMOUNT_IBAN_HISTORY`, `EXACT_AMOUNT_PURPOSE_MONTH` or `EXACT_AMOUNT_IN_ORDER` when set (the last two from migration 0036, #125).
- **Partial unique index** `(transaction_id, mre_tenant_id, mre_rent_term) WHERE status = 'SUGGESTED'`.
- **`rent_payment_reconciliation_frozen`:** `matched_amount` may change only in the step `SUGGESTED` → `CONFIRMED`, and only to a lower positive amount. The other fixed fields are unchanged.
- **`rent_payment_reconciliation_cash` on a `SUGGESTED` insert:** it writes the Transaction row as for a confirm, then refuses a Transaction not counted, not `INFLOW`, or without rent cash. There is no sum check, because a suggestion consumes nothing. The step into `CONFIRMED` gets the full check of §37.1, as today.
- Not in the database: the rule, the MRE reads, the order of checks.

### Tests (VC-4-03)

- **Domain, the rule, each with its fixture:**
  - one Transaction and one term with equal amounts → `MEDIUM`;
  - an open suggestion T1–A blocks a new T2–A, and T1 with an open suggestion for A is not suggested for B (review on #80);
  - a Transaction booked on the 20th of `to` that also fits the month after `to` → nothing; the neighbouring month's term itself never suggested;
  - two Transactions for one term → nothing;
  - two terms for one Transaction → nothing;
  - the IBAN history deciding one of two → `HIGH`, and the other not suggested;
  - the history on both sides → nothing;
  - a booking date one day before the 15th of the prior month, and one day after the term's month → no fit;
  - an amount a cent off → no fit;
  - a handled pair (each status) → excluded;
  - an open amount ≤ 0 → skipped;
  - permuted input gives the same result.
- **Repository:**
  - the DE snapshot (counted `INFLOW` with available cash, the term sums, the IBAN history within the Realm);
  - the write skipping a pair changed in between;
  - the AuditRecords `SUGGESTED`, `CONFIRMED` (`manual = false`) and `REJECTED`;
  - confirm and reject with every refusal in order, and the no-ops;
  - lowering the amount on confirm.
- **Concurrency (RC and RR, each with a counter-check):**
  - two suggest runs over one window → each pair once (the index);
  - a confirm against a manual match of the same cash → `RENT_CASH_EXCEEDED`, RR `40001`;
  - a confirm against a correction of the Transaction → as §37.1.
- **Schema past the repository, each with a counter-check:**
  - the new CHECKs and the index;
  - `matched_amount` raised on confirm, or changed outside the step, refused;
  - a `SUGGESTED` insert on an unconfirmed or `OUTFLOW` Transaction refused.
- **MRE client:** `listRentTerms(token, realm, year, month)` parsed to `{ mreTenantId, term, amountDue }` only (no name, contacts or payments). An unexpected shape → `UNAVAILABLE`. The fake MRE gains the month read. `mre.contract.test.ts` pins `GET /rents/:year/:month` against the baseline: the Tenant's rent of that month comes back with `_id`, `term` and `totalWithoutBalanceAmount`, and another Realm's month does not list it.
- **Use case and API:**
  - the window `400`s;
  - MRE down → `503`, nothing written;
  - a repeat writes nothing;
  - confirm's `ABOVE_SUGGESTION`, `SUGGESTION_STALE` and `MRE_RENT_TERM_NOT_FOUND`, and reject's `NOT_REJECTABLE`.
- **End to end** against the fake MRE: suggest over two months → confirm one (it counts in §37.2's coverage), reject another (never suggested again), lower an amount on confirm; a suggestion never counts before its confirmation.
- **Counter-checks:**
  - the rule summing MRE's payments into the open amount;
  - a rejected pair suggested again;
  - open suggestions excluded before the uniqueness check (both blocking tests turn red);
  - the neighbouring months not read;
  - ambiguity broken by input order;
  - the booking window off by a day;
  - confirm without the live MRE read;
  - confirm raising the amount;
  - a suggestion counted as consumed cash.

## 37.4 Write-back to MRE (VC-4-04, implemented: migration 0032)

Decision P4-D6 of `docs/development/phase-4-plan.md`, and P4-D7's effect of a release on a written-back match. BR-MRE-005/006, BR-RENT-010, BR-OPEN-005 (decided: explicit). A write-back adds **one MRE payment** for one `CONFIRMED` reconciliation, marked with DE's identity, and records the outcome. It never changes the reconciliation's status, its Transaction or its cash. The MRE baseline is `479d0ad`, as for every MRE call (mre-integration §47.1).

- **Domain owner and authorization:** as §37.1. MRE is called with the caller's own token and Realm: the write-back is the human's action, under the human's MRE rights.
- **No database transaction is open during an MRE call** (P4-D8). The protocol is claim → read → write → verify → record.

### The MRE side (baseline `479d0ad`)

- **Read:** `GET /rents/tenant/:id/:term` (§37.1), here parsed **to its raw values** for the round trip:
  - `_id`, `vatRatio`;
  - `payments[]` with `date`, `amount`, `type`, `reference`, `description`, each as read (JSON numbers and strings, never converted to Money);
  - `promo`, `notepromo`, `extracharge`, `noteextracharge`, `description`.
- **Write:** `PATCH /rents/payment/:id/:term`. MRE's `updateByTerm` never reads the path's `:id`. `_updateByTerm` looks the Tenant up with `findOne({ _id: body._id, realmId })` and `payTerm` replaces the term's whole settlement with the body: payments, the settlement discount (`promo`), the extra charge (`extracharge`) and the description. So:
  - the body carries `_id: mreTenantId`, and the path's `:id` is the same value (review on #75). Without `_id`, or with a Tenant of another of the caller's Realms, MRE answers `500`. A Realm the caller is not a member of is `checkOrganization`'s `404`, read as no access (`403`);
  - every field DE does not send is lost. The body is therefore the term as read, plus DE's payment.
  - MRE drops payments whose `amount` is missing or ≤ 0 on every save, its own form's included. DE treats them as not part of the term.
  - MRE stores each payment normalised: `date || ''`, `Number(amount)`, `type || ''`, `reference || ''`, `description || ''`. DE compares payments in that form, so one that never went through MRE's save (an import, a seed) is no mismatch once it has (review on #82).
  - MRE divides `promo` and `extracharge` by `1 + vatRatio` on the way in and multiplies and rounds them to the cent on the way out. Under a VAT ratio a round trip can change them, hence `MRE_TERM_NOT_ROUND_TRIPPABLE` below.
  - The answer is the saved term in the read's shape (`toRentData`).
- **DE's payment:**
  - `date`: the Transaction's booking date as `DD/MM/YYYY`;
  - `amount`: `matchedAmount` as a JSON number written from its decimal text (`"800.10"` → `800.1`), never by float arithmetic on cents;
  - `type`: `transfer`;
  - `reference`: the **DE marker** `DE-RPR-<reconciliationId>` (lower-case UUID). MRE payments have no stable id (mre-integration §41). MRE's own form keeps `reference` for a `transfer`, so the marker survives a later save in MRE;
  - `description`: `""`.
- **The marker is DE's payment identity.** A payment whose `reference` is the marker is DE's payment for that reconciliation, wherever it is in the term's list.

### `POST /api/v1/rent-reconciliations/{reconciliationId}/write-back-to-mre`

- **Body:** none, or `{}` (strict). No `Idempotency-Key`: the command is idempotent by design (a `WRITTEN` no-op, and every attempt reads before it writes). `If-Match` optional (§16.1).
- **Order of checks:**
  1. `400`;
  2. unknown or foreign → `404`;
  3. `status` not `CONFIRMED` → `409 CONFLICT` with `reason = "NOT_WRITABLE"` and `details.status`;
  4. `WRITTEN` → `200` no-op without an MRE call, whatever the version;
  5. `PENDING` with a live lease, its own or another reconciliation's of the same Realm and `mreTenantId` → `409 CONFLICT` with `reason = "WRITE_BACK_IN_PROGRESS"` and `details.reconciliationId` (the holder);
  6. `If-Match` → `412`.
- **1. Claim** (one READ COMMITTED transaction; the reconciliation row only, never the Transaction, P4-D8):
  - the reconciliation `FOR UPDATE`, and checks 2–6 again;
  - other reconciliations of the same Realm and `mreTenantId` that are `PENDING` with an **expired** lease are set to `FAILED` (`LEASE_EXPIRED`), each with an AuditRecord `WRITE_BACK_ABANDONED`, in the same transaction that takes the new lease (review on #75);
  - its own expired `PENDING` is claimed again;
  - set `PENDING` with a new `attemptId` (UUID) and `leaseUntil = now() + 2 × the MRE timeout`, `version` + 1, and an AuditRecord `WRITE_BACK_STARTED` with the `attemptId`;
  - two claims for the same Tenant: the partial unique index lets one commit; the other answers `WRITE_BACK_IN_PROGRESS`.
- **2. Read** the term (outside any transaction):
  - MRE `404` → record `FAILED` (`MRE_RENT_TERM_NOT_FOUND`) and answer `422 MRE_RENT_TERM_NOT_FOUND` (§37.1's neutral wording);
  - MRE down → `FAILED` (`MRE_UNAVAILABLE`), `503 EXTERNAL_SYSTEM_ERROR`;
  - `401` / `403` → `FAILED` (`MRE_FORBIDDEN`), answered as §37.1;
  - the marker found **once** with DE's date and amount: an earlier attempt wrote it (a crash between write and record, or a lost answer). Go to **5. Record** as `WRITTEN`, **without a PATCH**;
  - the marker found more than once, or with another date or amount (changed in MRE by hand) → `FAILED` (`MRE_PAYMENT_CHANGED`), `409 CONFLICT` with that reason. DE never repairs a payment in MRE;
  - `vatRatio` ≠ 0 and `promo` or `extracharge` ≠ 0 → back to `NOT_WRITTEN` (the marker is absent, so nothing of DE's is in MRE), an AuditRecord `WRITE_BACK_NOT_ROUND_TRIPPABLE`, and `409 CONFLICT` with `reason = "MRE_TERM_NOT_ROUND_TRIPPABLE"`. The user records the payment in MRE by hand.
- **3. Write:** the PATCH with the body above: every payment read (amount > 0) in its order, normalised as MRE stores it, then DE's payment; `promo`, `extracharge` and `description` as read; `notepromo` and `noteextracharge` with their trailing `\n` removed, as MRE's form does (the read joins notes with `\n`).
- **4. Verify** the term in the PATCH answer:
  - exactly one payment with the marker, DE's date and amount (the same JSON number DE sent, which MRE stores as it is), type `transfer`;
  - every payment read, normalised as MRE stores it, in its order;
  - `promo`, `extracharge` and `description` as read.
  - No answer, an error answer, or a failed verification → **read the term once more** and verify that read the same way. It passes → `WRITTEN`: the PATCH reached MRE and only its answer was lost. It fails:
    - the marker is absent → `FAILED` (`MRE_UNAVAILABLE` without an answer, `MRE_WRITE_REFUSED` with an error answer), `503 EXTERNAL_SYSTEM_ERROR`;
    - the marker is there but the term's other content differs (someone edited the Tenant in MRE in between) → `FAILED` (`MRE_TERM_CHANGED`), `409 CONFLICT` with that reason.
- **5. Record** (one READ COMMITTED transaction): only while the row is still `PENDING` with **this** `attemptId`:
  - `WRITTEN` with `mreWrittenBackAt`, `mreWrittenBackBy` and `mrePayment`, the snapshot of DE's payment as MRE stores it (`date`, `amount` as Money, `type`, `reference`); AuditRecord `WRITE_BACK_WRITTEN` with the `attemptId` and whether a PATCH was sent;
  - `FAILED` with `mreWriteBackError` and `mreWriteBackFailedAt`; AuditRecord `WRITE_BACK_FAILED` with the code;
  - `version` + 1 either way;
  - the lease was lost (another attempt took over after `leaseUntil`) → nothing is recorded and the answer is `409 CONFLICT` with `reason = "WRITE_BACK_IN_PROGRESS"`. The other attempt reads before it writes, so it finds this attempt's payment.
- **Success:** `200` with the reconciliation (`mreWriteBackState = WRITTEN`, `mreWrittenBackAt`, `mreWrittenBackBy`, `mrePayment`, `version`). Each error after the claim carries `details.reason` (the code) and `details.mreWriteBackState` (`FAILED` or `NOT_WRITTEN`); a `401` / `403` from MRE is recorded as `MRE_FORBIDDEN` and answered as §37.1. Its ETag is the recorded version.
- **Failure keeps the match (BR-RENT-010).** The reconciliation stays `CONFIRMED`; its cash stays matched. `FAILED` is visible in every read and retried by the same command.
- **Exactly once (BR-MRE-006):** a `WRITTEN` write-back is a no-op; every attempt reads before it writes; a PATCH body holds the marker once and the PATCH replaces the whole settlement, so a PATCH that reaches MRE late cannot add a second payment. The lease of twice the MRE timeout **assumes MRE finishes a request within twice the timeout** (review on #82): DE's timeout only ends DE's side, and MRE completes a request after its client has gone. For VC-4-04 a later PATCH is harmless (it holds the marker once and replaces the whole settlement). **For VC-4-05** it is not: a PATCH landing after a release and a removal would add DE's payment back while DE shows `REMOVED`, and undo MRE edits in between. The removal therefore touches a `FAILED` or `PENDING` state only after `leaseUntil` plus a margin, and `?checkMre=true` reports a payment that reappears (`PRESENT` on `REMOVED`).
- **Residual risk, accepted (P4-D6):** MRE has no version or ETag. An edit of the same Tenant in MRE between DE's read and DE's PATCH can be lost, or can make DE's payment lost; the latter is detected (`MRE_TERM_CHANGED`), the former is not. The window is one request (mre-integration §42–44).

### `mreWriteBackState` (P4-D6, P4-D7)

- `NOT_WRITTEN` → `PENDING` (claim) → `WRITTEN` | `FAILED` | `NOT_WRITTEN` (not round-trippable);
- `FAILED` → `PENDING` (retry); `PENDING` with an expired lease → `PENDING` (its own retry) or `FAILED` (`LEASE_EXPIRED`, another reconciliation's claim);
- with the release (`CONFIRMED` → `RELEASED`, §37.1): `NOT_WRITTEN` stays; `WRITTEN`, `FAILED` and an expired `PENDING` become **`REMOVAL_REQUIRED`**, because DE's payment is, or may be, in MRE. A failed attempt may have reached MRE without an answer; the removal (VC-4-05) reads first and finds nothing to remove if it did not. `PENDING` with a live lease → `409 CONFLICT` with `reason = "WRITE_BACK_IN_PROGRESS"`;
- `REMOVING`, `REMOVED` and `REMOVAL_FAILED` come with VC-4-05.
- The response of §37.1 gains `mreWrittenBackAt`, `mreWrittenBackBy`, `mrePayment` (`null` unless written), `mreWriteBackError`, `mreWriteBackFailedAt` (`null` unless `FAILED`), and `mreWriteBackLeaseUntil` (`null` unless `PENDING`). The `attemptId` stays internal.
- Release stays DE-only and never calls MRE (BR-MRE-004). Confirm and the manual create never write back (BR-MRE-005).

### `GET /api/v1/rent-reconciliations/{reconciliationId}?checkMre=true`

- **Presence check** for a marker deleted in MRE by hand. A read only: it never changes the state and writes no AuditRecord.
- `checkMre` is `true` or `false` (default); any other value is `400`. The list keeps refusing it (§37.1).
- The response gains `mrePresence`:
  - `null` without `checkMre`, or when the state is neither `WRITTEN` nor `REMOVAL_REQUIRED` (no MRE call);
  - `PRESENT` when the term read live holds a payment with the marker, `MISSING` when it does not or the term is gone, `UNAVAILABLE` when MRE is down. `401` / `403` are answered as §37.1.

### In the database (migration 0032)

- **`rent_payment_reconciliation` gains:**
  - `mre_write_back_attempt_id uuid`, `mre_write_back_lease_until timestamptz`: set exactly when `PENDING`;
  - `mre_written_back_at timestamptz`, `mre_written_back_by text`, `mre_payment jsonb` (`date`, `amount`, `type`, `reference`): set when `WRITTEN`, kept into `REMOVAL_REQUIRED`, `NULL` when `NOT_WRITTEN`, `PENDING` or `FAILED`;
  - `mre_write_back_error text` in (`MRE_RENT_TERM_NOT_FOUND`, `MRE_UNAVAILABLE`, `MRE_FORBIDDEN`, `MRE_WRITE_REFUSED`, `MRE_PAYMENT_CHANGED`, `MRE_TERM_CHANGED`, `LEASE_EXPIRED`) and `mre_write_back_failed_at timestamptz`: set exactly when `FAILED`.
- **CHECKs:**
  - `mre_write_back_state` in (`NOT_WRITTEN`, `PENDING`, `WRITTEN`, `FAILED`, `REMOVAL_REQUIRED`);
  - `PENDING`, `WRITTEN` and `FAILED` only on `CONFIRMED`; `REMOVAL_REQUIRED` only on `RELEASED`;
  - the field sets above.
- **Partial unique index** `(mre_realm_id, mre_tenant_id) WHERE mre_write_back_state = 'PENDING'`: one write-back per MRE Tenant at a time (VC-4-05 adds `REMOVING`).
- **`rent_payment_reconciliation_frozen`:**
  - a change that keeps `status` may change only the write-back fields, with `version` + 1, along the steps above; `PENDING` → `PENDING` only from an expired lease, with a new `attemptId`;
  - with the step `CONFIRMED` → `RELEASED`, `mre_write_back_state` becomes exactly `NOT_WRITTEN` from `NOT_WRITTEN` and `REMOVAL_REQUIRED` from the others; a live lease refuses the release (`WRITE_BACK_IN_PROGRESS`). A written-back match is never released silently;
  - the other status steps keep `NOT_WRITTEN`;
  - the fixed fields and status steps of 0030/0031 are unchanged.
- `down` restores 0031's functions exactly, as 0031's `down` does for 0030.
- Not in the database: the MRE calls, the verification, the order of checks.

### Concurrency (RC and RR, each with a counter-check)

- **Two write-backs of one reconciliation:** the second waits on the row in its claim and answers `WRITE_BACK_IN_PROGRESS` (RC), or fails with `40001` (RR).
- **Two write-backs of two terms of one Tenant:** the index; the loser answers `WRITE_BACK_IN_PROGRESS`.
- **A takeover after an expired lease,** by the same reconciliation and by another one of the same Tenant (the expired row becomes `FAILED`, `LEASE_EXPIRED`, with its AuditRecord). VC-4-04 tests this (review on #75).
- **A record after a lost lease** writes nothing.
- **Release against a write-back:** a release during `PENDING` is refused; a claim that waited on a release sees `RELEASED` (`NOT_WRITABLE`) under RC, or fails with `40001` under RR.

### Tests (VC-4-04)

- **Domain:** the state steps; the PATCH body from a term read (raw values kept, notes trimmed, payments ≤ 0 dropped, DE's payment last); the marker; the verification (each mismatch); the round-trip rule (VAT with `promo`, with `extracharge`, VAT alone, neither); the amount written from decimal text (`800.10`, `0.01`, `1234567.89`).
- **MRE client:** `readRentTermForWriteBack` keeps the raw values and drops the occupant's personal data; `writeRentTermPayments` sends the PATCH with `_id` in the body and the caller's token and Realm; an unexpected shape → `UNAVAILABLE`.
- **Fake MRE** gains the PATCH with `_updateByTerm`'s behaviour: the Tenant from the body's `_id` (`500` without it, or for another Realm), payments ≤ 0 dropped, `promo` and `extracharge` through `vatRatio`, the saved term answered; and switches to fail a PATCH, to apply a PATCH but drop its answer, and to delay it.
- **`mre.contract.test.ts`** pins the PATCH against the baseline: a payment with a marker written next to an existing one, both read back with their raw values; the description and a `promo` kept (no VAT); without `_id` → `500`; another Realm's token → no change. Each case restores the term it changed.
- **Repository:** claim, record and the takeover; the lease; the record after a lost lease; the AuditRecords; release's effect on each state.
- **Use case:**
  - the order claim → read → PATCH → verify → record, and no database transaction open during an MRE call;
  - a `WRITTEN` no-op without an MRE call;
  - **a crash between PATCH and record** (the record throws after the PATCH): the row stays `PENDING`; after the lease expires the retry finds the marker and records `WRITTEN` without a second PATCH; the fake MRE counts one PATCH;
  - a lost PATCH answer → the second read → `WRITTEN`;
  - each failure code and its answer; not round-trippable back to `NOT_WRITTEN`.
- **API:** the `400`s (a body, `checkMre=yes`), the error mapping, `ETag`, `mrePresence` with each value.
- **End to end** against the fake MRE: confirm → write back → the term shows DE's payment next to MRE's own payment and DE's Transaction stays one record (§37.2's coverage unchanged); a repeat adds nothing; a payment deleted in MRE by hand → `mrePresence = MISSING`; MRE down → `FAILED`, then a retry → `WRITTEN`; release of a written match → `REMOVAL_REQUIRED`; Realm isolation.
- **Schema past the repository**, each with a counter-check: the new CHECKs, the index, each allowed and refused state step, release setting `REMOVAL_REQUIRED`, a release under a live lease refused.
- **Concurrency** as above, under RC and RR, each with its counter-check.
- **Counter-checks:**
  - the PATCH without `_id`;
  - a field of the term not sent back (`description`, `promo`, an existing payment);
  - no read before the write (the crash test adds a second payment);
  - the marker check skipped on a retry;
  - the verification skipped (a `MRE_TERM_CHANGED` case turns `WRITTEN`);
  - the amount written by float arithmetic from cents;
  - the round-trip rule dropped;
  - the record without the `attemptId` check;
  - the takeover without failing the expired row (the claim is refused by the index);
  - release keeping `WRITTEN`;
  - the index not unique;
  - the presence check changing the state.

## 37.5 Removal from MRE after release (VC-4-05, implemented: migration 0033)

Decision P4-D7 of `docs/development/phase-4-plan.md`: the protocol of §37.4 in reverse. A released reconciliation whose payment is, or may be, in MRE (`REMOVAL_REQUIRED`) has DE's payment removed from the MRE term. Everything else in the term stays. Release stays DE-only (BR-MRE-004); removal is the separate, explicit command. It never changes the reconciliation's status, its Transaction or its cash.

- **Domain owner and authorization:** as §37.1. MRE is called with the caller's own token and Realm.
- **No database transaction is open during an MRE call** (P4-D8). The protocol is claim → read → write → verify → record, as §37.4.
- **It removes only DE's payment:** the one payment whose `reference` is the marker `DE-RPR-<reconciliationId>` with DE's date and amount (§37.4). A payment without DE's marker is never removed. A marker payment changed in MRE by hand is not removed either (`MRE_PAYMENT_CHANGED`).

### The lease assumption (review on #82)

§37.4's lease assumes MRE finishes a request within twice the timeout. A write-back PATCH that MRE completes after DE gave up would put DE's payment back, and would undo MRE edits made in between. So:

- the reconciliation keeps the end of its **latest** lease, write-back or removal: `mreLastLeaseUntil`. Every claim raises it to its own lease if that ends later; it is never lowered or cleared, so a shorter retry cannot hide a longer lease still running;
- a removal is refused before `mreLastLeaseUntil` **plus one MRE timeout** (a margin for clock skew between DE and MRE): `409 CONFLICT` with `reason = "REMOVAL_TOO_EARLY"` and `details.notBefore`. A `WRITTEN` reconciliation's lease ended long ago, so in practice only a release right after a failed or abandoned write-back waits;
- `?checkMre=true` (§37.4) also reads `REMOVAL_FAILED` and `REMOVED`. `PRESENT` on `REMOVED` reports a payment that reappeared in MRE. DE does not remove it again by itself; the user removes it in MRE (residual risk, accepted, as §37.4's).

### `POST /api/v1/rent-reconciliations/{reconciliationId}/remove-from-mre`

- **Body:** none, or `{}` (strict). No `Idempotency-Key`; `If-Match` optional (§16.1).
- **Order of checks:**
  1. `400`;
  2. unknown or foreign → `404`;
  3. `status` not `RELEASED` → `409 CONFLICT` with `reason = "NOT_REMOVABLE"` and `details.status`;
  4. `REMOVED` → `200` no-op without an MRE call, whatever the version;
  5. `NOT_WRITTEN` (nothing of DE's was ever in MRE) → `409 CONFLICT` with `reason = "NOT_REMOVABLE"` and `details.mreWriteBackState`;
  6. `REMOVING` with a live lease, its own or another reconciliation's of the same Realm and `mreTenantId` (also a `PENDING` write-back) → `409 CONFLICT` with `reason = "WRITE_BACK_IN_PROGRESS"` and `details.reconciliationId`;
  7. before `mreLastLeaseUntil` + one MRE timeout → `409 REMOVAL_TOO_EARLY` (above);
  8. `If-Match` → `412`.
- **1. Claim** (one READ COMMITTED transaction; reconciliation rows only): as §37.4's, from `REMOVAL_REQUIRED` or `REMOVAL_FAILED`. It sets `REMOVING` with a new `attemptId` and lease, `version` + 1, and writes an AuditRecord `REMOVAL_STARTED`. Expired leases of other reconciliations of the same Tenant are failed in the same transaction: an expired `REMOVING` becomes `REMOVAL_FAILED` (`LEASE_EXPIRED`), an expired `PENDING` becomes `FAILED` (`LEASE_EXPIRED`), each with an AuditRecord `WRITE_BACK_ABANDONED`. The Tenant index covers `PENDING` and `REMOVING`: one MRE write per Tenant at a time.
- **2. Read** the term (§37.4's raw read):
  - MRE `404` → `REMOVAL_FAILED` (`MRE_RENT_TERM_NOT_FOUND`), `422`. MRE also answers `404` when its own database read fails (review on #76), so a missing term is no proof that the payment is gone;
  - MRE down → `REMOVAL_FAILED` (`MRE_UNAVAILABLE`), `503`; `401` / `403` → `REMOVAL_FAILED` (`MRE_FORBIDDEN`), answered as §37.1;
  - the marker **absent**: nothing of DE's is in MRE (removed by hand, or an earlier attempt removed it and crashed). Go to **5. Record** as `REMOVED`, **without a PATCH**;
  - the marker more than once, or with another date or amount → `REMOVAL_FAILED` (`MRE_PAYMENT_CHANGED`), `409`. DE never removes or repairs a payment it cannot identify exactly;
  - the marker once, but `vatRatio` ≠ 0 with `promo` or `extracharge` ≠ 0 → back to `REMOVAL_REQUIRED` (a removal is still required; a former `REMOVAL_FAILED` code is dropped), an AuditRecord `REMOVAL_NOT_ROUND_TRIPPABLE`, and `409 CONFLICT` with `reason = "MRE_TERM_NOT_ROUND_TRIPPABLE"`. The user removes DE's payment in MRE by hand; the next removal then reads it absent and records `REMOVED`.
- **3. Write:** the PATCH of §37.4 with every payment read except DE's, in its order and normalised as MRE stores it; `promo`, `extracharge`, `description` and the notes as §37.4; `_id: mreTenantId` in the body.
- **4. Verify** the answer: no payment with the marker, every other payment read in its order, the settlement as read. Without an answer or on a mismatch, read once more:
  - it passes → `REMOVED`;
  - the marker still there with the rest as read → `REMOVAL_FAILED` (`MRE_UNAVAILABLE` without an answer, `MRE_WRITE_REFUSED` with an error answer), `503`;
  - anything else changed → `REMOVAL_FAILED` (`MRE_TERM_CHANGED`), `409`.
- **5. Record** (one READ COMMITTED transaction), only while the row is `REMOVING` with **this** `attemptId`:
  - `REMOVED` with `mreRemovedAt` and `mreRemovedBy`; `mrePayment` stays as the record of what was written. AuditRecord `REMOVED` with the `attemptId` and whether a PATCH was sent;
  - `REMOVAL_FAILED` with `mreWriteBackError` and `mreWriteBackFailedAt`; AuditRecord `REMOVAL_FAILED`;
  - `version` + 1 either way;
  - a lost lease records nothing and answers `WRITE_BACK_IN_PROGRESS`.
- **Success:** `200` with the reconciliation (`mreWriteBackState = REMOVED`, `mreRemovedAt`, `mreRemovedBy`). Errors after the claim carry `details.reason` and `details.mreWriteBackState`, as §37.4.
- **Exactly once:** `REMOVED` is a no-op; every attempt reads before it writes; a PATCH without DE's payment that reaches MRE late removes nothing more.

### `mreWriteBackState` with removal (P4-D7)

- on `RELEASED`: `REMOVAL_REQUIRED` | `REMOVAL_FAILED` → `REMOVING` (claim) → `REMOVED` | `REMOVAL_FAILED` | `REMOVAL_REQUIRED` (not round-trippable); `REMOVING` with an expired lease → `REMOVING` (its own retry) or `REMOVAL_FAILED` (`LEASE_EXPIRED`, another reconciliation's claim);
- `REMOVED` and `NOT_WRITTEN` are final on `RELEASED`.
- The response of §37.1 gains `mreRemovedAt`, `mreRemovedBy` (`null` unless `REMOVED`) and `mreLastLeaseUntil`; `mreWriteBackLeaseUntil`, `mreWriteBackError` and `mreWriteBackFailedAt` also hold for `REMOVING` and `REMOVAL_FAILED`.
- Releasing stays as §37.4. With VC-4-05 it also uses the **database's clock** for the lease, as the claim and the trigger do (review on #83); the trigger's `WRITE_BACK_IN_PROGRESS` on the release path is answered `409`, never `500`.

### In the database (migration 0033)

- **`rent_payment_reconciliation` gains** `mre_last_lease_until timestamptz` (raised by every claim to `greatest(mre_last_lease_until, the new lease)`, never lowered or cleared; the trigger enforces both), `mre_removed_at timestamptz` and `mre_removed_by text` (set exactly when `REMOVED`).
- **Backfill:** every row claimed under 0032 (any state but `NOT_WRITTEN`) gets `mre_last_lease_until = coalesce(mre_write_back_lease_until, mre_write_back_failed_at, mre_written_back_at, released_at) + interval '2 minutes'`. Their real lease end is unknown, but it is at most twice the longest MRE timeout DE accepts (`MRE_TIMEOUT_MS` ≤ 60 s) after the claim, and the claim came before the failure, the write and the release. `released_at` covers the riskiest rows (review on #84): a `REMOVAL_REQUIRED` that came from `FAILED` or an expired `PENDING` has its lease, its failure time and its written time cleared by 0032's release.
- **CHECKs:**
  - `mre_write_back_state` adds `REMOVING`, `REMOVED`, `REMOVAL_FAILED`, all three only on `RELEASED`;
  - the attempt and the lease set exactly when `PENDING` or `REMOVING`; the error and its time exactly when `FAILED` or `REMOVAL_FAILED`;
  - the written fields as 0032, also kept through `REMOVING`, `REMOVED` and `REMOVAL_FAILED`;
  - `mre_last_lease_until` not null once a claim has happened: every state but `NOT_WRITTEN` (`PENDING`, `WRITTEN`, `FAILED`, `REMOVAL_REQUIRED`, `REMOVING`, `REMOVED`, `REMOVAL_FAILED`; every `REMOVAL_REQUIRED` comes from a claim). So the trigger's `now()` > `mre_last_lease_until` and `REMOVAL_TOO_EARLY` never see `NULL`.
- **The Tenant index** becomes `(mre_realm_id, mre_tenant_id) WHERE mre_write_back_state IN ('PENDING', 'REMOVING')`.
- **§37.4's write-back claim changes with it** (review on #84): its holders are the Tenant's `PENDING` **and** `REMOVING` rows. A live `REMOVING` answers `WRITE_BACK_IN_PROGRESS`; an expired one becomes `REMOVAL_FAILED` (`LEASE_EXPIRED`) with an AuditRecord `WRITE_BACK_ABANDONED`, in the same transaction that takes the new lease. Without that, an abandoned removal would block every write-back of the Tenant through the index until someone retried the removal.
- **`rent_payment_reconciliation_frozen`:** on a `RELEASED` row, a change that keeps `status` is a removal step with `version` + 1: `REMOVAL_REQUIRED` | `REMOVAL_FAILED` → `REMOVING` only when `now()` is past `mre_last_lease_until` (the margin stays in the application); `REMOVING` → `REMOVING` only from an expired lease with a new attempt; `REMOVING` → `REMOVED` | `REMOVAL_FAILED` | `REMOVAL_REQUIRED`. 0032's steps are unchanged, plus `mre_last_lease_until` set on each claim and never lowered or cleared.
- `down` restores 0032's functions, constraints and index exactly.

### Concurrency (RC and RR, each with a counter-check)

- **Two removals of one reconciliation:** the second waits on the row and answers `WRITE_BACK_IN_PROGRESS` (RC) or fails with `40001` (RR).
- **A removal and a write-back of two terms of one Tenant:** the index; the loser answers `WRITE_BACK_IN_PROGRESS`.
- **A takeover after an expired lease,** by the same reconciliation, and by another one of the Tenant (an expired `REMOVING` becomes `REMOVAL_FAILED`, an expired `PENDING` becomes `FAILED`, each `LEASE_EXPIRED`).
- **A write-back after an abandoned removal of the same Tenant:** the write-back's claim fails the expired `REMOVING` (`REMOVAL_FAILED`, `LEASE_EXPIRED`) and takes its own lease; under a live `REMOVING` it answers `WRITE_BACK_IN_PROGRESS`.
- **A record after a lost lease** writes nothing.

### Tests (VC-4-05)

- **Domain:** the PATCH body without DE's payment; the verification (marker gone, every other payment and the settlement as read); the steps; `REMOVAL_TOO_EARLY` at the margin's edge.
- **Repository:** claim, record and takeover; `mre_last_lease_until` kept through record and release; the release with the database's clock (an application clock running ahead does not turn the trigger's refusal into a `500`).
- **Migration:** a 0032 row `FAILED` → released → 0033 gets `mre_last_lease_until = released_at + 2 minutes`, and a removal before it plus the margin is `REMOVAL_TOO_EARLY`; a 0032 `WRITTEN` row gets `mre_written_back_at + 2 minutes`; `NOT_WRITTEN` rows stay `NULL`.
- **Use case:**
  - the order claim → read → PATCH → verify → record;
  - `REMOVED` a no-op without an MRE call;
  - the marker absent → `REMOVED` without a PATCH;
  - a crash between PATCH and record: after the lease, the retry finds the marker absent and records `REMOVED` without a second PATCH;
  - a lost answer → the second read → `REMOVED`;
  - each failure code; not round-trippable back to the state before.
- **Fake MRE:** unchanged PATCH behaviour (§37.4); the removal uses it.
- **`mre.contract.test.ts`:** a removal of a DE payment written next to an existing one; the existing payment, the promo and the description kept.
- **API:** the `400`s, the error mapping, `REMOVAL_TOO_EARLY` with `details.notBefore`, `mrePresence` on `REMOVED`.
- **End to end** against the fake MRE: confirm → write back → release → remove (MRE's own payment kept, DE's gone, coverage of §37.2 unchanged); a repeat adds nothing; a release right after an abandoned write-back waits for the lease; a payment that reappears is `PRESENT` on `REMOVED`; Realm isolation.
- **Schema past the repository,** each with a counter-check: the new CHECKs, the widened index, each removal step allowed and refused, a claim before `mre_last_lease_until` refused.
- **Concurrency** as above, under RC and RR, each with its counter-check.
- **Counter-checks:**
  - a payment without DE's exact marker removed;
  - the read before the write skipped (the crash test then sends a second PATCH);
  - the verification skipped;
  - the lease margin dropped (the removal right after an abandoned write-back proceeds);
  - `mre_last_lease_until` cleared on record or release;
  - the index without `REMOVING`;
  - the write-back claim's holders only `PENDING` (the write-back after an abandoned removal is then refused for good);
  - the backfill without `released_at`, and `REMOVAL_REQUIRED` left out of the CHECK;
  - the record without the attempt check;
  - the release's lease check on the application's clock.

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

Refined by §37.4 (VC-4-04).

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

Decisions: `docs/development/phase-3-plan.md` (P3-D1…D8). Data: data-model §21–24. Items: backlog §3b.

### Queries

```text
GET /api/v1/loans                                                  (VC-3-01, §41.1)
GET /api/v1/loans/{loanId}                                         (VC-3-01, §41.1)
GET /api/v1/loans/{loanId}/terms                                   (VC-3-02, §41.2)
GET /api/v1/loans/{loanId}/allocations[?asOf=|?status=]            (VC-3-03, §41.3)
GET /api/v1/property-references/{propertyReferenceId}/loans[?asOf=] (VC-3-03, §41.3)
GET /api/v1/loans/{loanId}/schedule[?from=&to=]                    (VC-3-04, §41.4)
GET /api/v1/loans/{loanId}/payment-proposal?transactionId=         (VC-3-05, §41.5)
GET /api/v1/loans/{loanId}/remaining-debt[?asOf=&perProperty=]    (VC-3-06, §41.6)
GET /api/v1/loans/{loanId}/payments?year=[&perProperty=]          (VC-3-06, §41.6)
GET /api/v1/loans/{loanId}/balance-statements[?status=]            (VC-3-06, §41.6)
```

### Commands

```text
POST /api/v1/loans                                                 (VC-3-01, §41.1)
POST /api/v1/loans/{loanId}/amend                                  (VC-3-01, §41.1)
POST /api/v1/loans/{loanId}/void                                   (VC-3-01, §41.1)
POST /api/v1/loans/{loanId}/terms                                  (VC-3-02, §41.2)
POST /api/v1/loans/{loanId}/terms/{termsId}/void                   (VC-3-02, §41.2)
POST /api/v1/loans/{loanId}/allocations                            (VC-3-03, §41.3)
POST /api/v1/loans/{loanId}/allocations/{allocationSetId}/void     (VC-3-03, §41.3)
POST /api/v1/loans/{loanId}/balance-statements                     (VC-3-06, §41.6)
POST /api/v1/loans/{loanId}/balance-statements/{statementId}/void  (VC-3-06, §41.6)
POST /api/v1/loans/{loanId}/close                                  (VC-3-07, §41.7)
```

This list is complete for Phase 3; ACC3 (VC-3-08) compares it with the app's routes, as ACC2 does for Phase 2. The former `recalculate-schedule`, `reconcile-payment` and `refinance` commands are dropped:
- the schedule is derived on read (P3-D5);
- a payment is a split carrying `loanId` (P3-D4);
- refinancing is a new Loan plus `close` (P3-D7).

## 41.1 Contract (VC-3-01, implemented: migration 0024)

- **Domain owner:** Financing. **Authorization:** as §19.1. A Loan belongs to the caller's Realm, and so do its lender, its borrowers and its Acquisition. Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`).
- **What it is (P3-D1):** one canonical financing contract. It is never duplicated per property: properties come only through allocations (VC-3-03). Full disbursement is assumed: `principalOriginal` is owed from the disbursement date (staged disbursement is a later item).
- **Status:**
  - `ACTIVE` → `VOID` (here);
  - `ACTIVE` → `CLOSED` (VC-3-07, §41.7).
  - Both are final.
- **Response:**
  - `loanId`, `mreRealmId`, `status`;
  - `lenderPartyId`, `borrowerPartyIds` (in the order given);
  - `principalOriginal` (Money as §31);
  - `startDate`, `disbursementDate` (as stored, may be `null`), and the derived `debtFrom` (`disbursementDate`, or `startDate` while that is unset); `maturityDate`;
  - `contractNumber`, `acquisitionId`, `sourceReferences`, `notes`;
  - `voidedAt`, `voidReason`;
  - `closingDate`, `closingReason`, `refinancedByLoanId`, `closingNote` (`null` unless `CLOSED`, §41.7);
  - `createdAt`, `version`.
  - Single-Loan responses carry `ETag: "<version>"` (§16.1).

### `POST /api/v1/loans`

- **Body** (strict; unknown keys `400`):
  - `lenderPartyId` (UUID, required).
  - `borrowerPartyIds` (1–20 UUIDs, required). No duplicates (`DUPLICATE`). The lender is not a borrower (`400` `LENDER_IS_BORROWER` at the borrower's position). Borrowers are not checked against Ownership: a borrower need not be an owner (P3-D1).
  - `principalOriginal` (Money as §31, required): **> 0** (`400` `NOT_POSITIVE`), EUR.
  - `startDate` (business date, required): the contract date.
  - `disbursementDate` (optional): not before `startDate` (`400` `BEFORE_START_DATE`).
  - `maturityDate` (optional): after `disbursementDate`, or after `startDate` while that is unset (`400` `NOT_AFTER_DISBURSEMENT`).
  - `contractNumber` (≤ 100), `sourceReferences` (up to 10 strings of 1–500) and `notes` (≤ 2000), trimmed as §26.1.
  - `acquisitionId` (UUID, optional): an Acquisition of the Realm that the Loan finances, in any status. It is informational and has no effect on the Acquisition.
  - `documentIds`: `400 NOT_SUPPORTED` until documents exist (as §33.2). Data-model §21's `repaymentType`, `paymentFrequency` and `currentTermsId` belong to the terms (P3-D2) and are unknown keys here.
- **Order of checks:**
  1. `400`;
  2. the lender, then each borrower in the order given: unknown or foreign → `404` (`details.partyId`);
  3. the Acquisition: unknown or foreign → `404` (`details.acquisitionId`);
  4. the lender, then each borrower: `INACTIVE` → `422 PARTY_INACTIVE` (`details.partyId`; P2-D1: no new role for an inactive Party).
- **Success:** `201` with the Loan (`status = ACTIVE`, `version = 1`); AuditRecord `CREATED` with the principal, the dates and the parties. Nothing is unique: two Loans may share a contract number, e.g. at different lenders.
- **Idempotency (§15):** `Idempotency-Key` with scope `loan.create`, fingerprint of the normalized body. A replay answers `201` with the recorded body and `Idempotent-Replayed: true`; the same key with another payload is `409`.

### `POST /api/v1/loans/{loanId}/amend`

- **Body:** the fields to change, at least one; `null` clears an optional field. Amendable fields:
  - `lenderPartyId`;
  - `borrowerPartyIds` (the whole list, replaced; same rules as on create);
  - `maturityDate` (same rule as on create);
  - `contractNumber`, `sourceReferences`, `notes`.
- The fixed fields (`principalOriginal`, `startDate`, `disbursementDate`, `acquisitionId`) are `400` with code `NOT_AMENDABLE`. A wrong one is voided and entered again (P3-D1).
- **Order of checks (review on #59):** a final status answers before anything about the request's Parties, as in §27.1 and §28.1.
  1. `400`;
  2. Loan unknown or foreign → `404`;
  3. the Loan not `ACTIVE` → `409 CONFLICT` with `reason = "LOAN_NOT_ACTIVE"` and `details.status`. This holds also when the values equal the current ones: a `VOID` or `CLOSED` Loan answers no amend with `200`;
  4. the merged values break a rule of create (the lender amended to a current borrower, `maturityDate` not after the debt starts) → `400` with `LENDER_IS_BORROWER` (at the borrower's position) or `NOT_AFTER_DISBURSEMENT`;
  5. values equal to the current ones → `200` no-op (below);
  6. a Party newly named (a new lender, or a borrower not in the current list): unknown or foreign → `404` (`details.partyId`), then `INACTIVE` → `422 PARTY_INACTIVE`. A borrower who stays in the list may have become inactive since: that is an existing role (P2-D1);
  7. `If-Match` → `412`.
- **Success:** `200` with the Loan (`version` + 1; AuditRecord `AMENDED` with each changed field's old and new value). Values equal to the current ones are a `200` no-op without a new version or AuditRecord, answered regardless of `If-Match` (as §19.1).

### `POST /api/v1/loans/{loanId}/void`

- **Body:** `{ "reason": "..." }` (required, trimmed, 1–500).
- **Success:** `200` with the Loan (`status = VOID`, `voidedAt`, `voidReason`, `version` + 1); AuditRecord `VOIDED` with the reason.
- Voiding a `VOID` Loan is a `200` no-op keeping the first reason and time. A `CLOSED` one is final: `409 CONFLICT` with `reason = "LOAN_CLOSED"`.
- While a split references the Loan, void is `409 CONFLICT` with `reason = "LOAN_HAS_SPLITS"` and `details.transactionIds` (from VC-3-05; before it, no split can). A reversal's splits count, so the Loan's history stays complete. Its terms, allocations and statements (VC-3-02, -03, -06) do not block a void: they count nowhere once the Loan is `VOID`.
- While a `CLOSED` Loan names it as `refinancedByLoanId`, void is `409 CONFLICT` with `reason = "LOAN_REFINANCES"` and `details.loanIds` (VC-3-07, §41.7).
- `If-Match` as §16.1; a no-op answers regardless of the version.
- **Locks (P3-D8):** the Loan `FOR UPDATE`, then its splits are read; no Transaction is locked. From VC-3-05 the split guard writes the Loan row after its Transaction lock, so a split write and a void serialise on the Loan row: whichever waits sees the other's result (READ COMMITTED) or fails to serialise (REPEATABLE READ).

### Reads

- `GET /loans/{loanId}`: one Loan with `ETag`.
- `GET /loans`: `{ items, page, pageSize, total }` (§11), ordered by `startDate` (newest first), then `createdAt`, then `loanId`; count and page in one snapshot.
  - Filters: `status`; `partyId` (lender or borrower); `acquisitionId`.
  - `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`.
  - `propertyReferenceId` is not a filter here: a Loan reaches a property only through allocations, so `GET /property-references/{id}/loans` comes with VC-3-03.

### In the database (VC-3-01)

- **`loan`:**
  - `lender_party_id` with a composite foreign key to `party (id, mre_realm_id)`; `borrower_party_ids` (below);
  - `principal_original` `numeric` with `scale ≤ 2`, `> 0` and `< 1e18`; `currency` EUR (as the ledger's amounts);
  - the date order as above (CHECK);
  - `acquisition_id` with a composite foreign key to `acquisition (id, mre_realm_id)`;
  - `status` in (`ACTIVE`, `VOID`, `CLOSED`): `VOID` exactly with `voided_at` and `void_reason`. The closing columns come with VC-3-07 (§41.7, migration 0029).
- **Borrowers are a column of the Loan (review on #59):** `borrower_party_ids uuid[]`, in the order given, rather than a child table. Then every rule about them is a rule about one row:
  - `cardinality` 1–20, one-dimensional, and no `NULL` element (`array_position(borrower_party_ids, NULL) IS NULL`; review on #59: `NOT (x = ANY (…))` is `NULL` with a `NULL` element, which a CHECK passes), all in one CHECK; no duplicates (the trigger below, which leaves `NULL` to the CHECK so the CHECK is tight on its own);
  - **the lender is never a borrower:** `CHECK (NOT (lender_party_id = ANY (borrower_party_ids)))`. It holds in both directions at once, for a new borrower and for the lender amended to a current borrower. A swap (lender A and borrower B → lender B and borrower A) is one `UPDATE` and passes;
  - **changes only with a version step of an `ACTIVE` Loan:** `loan_frozen` below covers the column like any amendable field. A separate table would need a deferred trigger to see whether the Loan row was stepped in the same transaction (`xmin`), and P3-D8's no-op write would pass that check without a step;
  - **Realm and existence:** an array cannot carry a foreign key. A trigger (`loan_parties`, on insert and on a change of `lender_party_id` or `borrower_party_ids`) checks that every newly named Party exists in the Loan's Realm, reading it `FOR SHARE`, and that it is `ACTIVE` (below). DE never deletes a Party (no route), and other tables' foreign keys refuse deleting a referenced one. For the array, the migration adds the same guard: a `BEFORE DELETE` trigger on `party` refuses deleting a Party that a Loan names as lender or borrower, so a check at write time stays true.
  - `GET /loans?partyId=` uses a GIN index on the column (`lender_party_id = $1 OR borrower_party_ids @> ARRAY[$1]`).
- **`loan_frozen` trigger:**
  - keeps `id`, Realm, principal, currency, `start_date`, `disbursement_date`, `acquisition_id`, `created_at` and `created_by` fixed;
  - allows the amendable fields to change only while `ACTIVE`, each change with `version` + 1;
  - allows the status to change only out of `ACTIVE`, with `version` + 1 exactly (as 0022);
  - makes `VOID` and `CLOSED` final;
  - lets the no-op `UPDATE … SET version = version` of P3-D8 through.
  - A Loan is only inserted `ACTIVE`, and never deleted.
- **Active Parties past the repository** (as 0020 for buyers): `loan_parties` refuses linking an `INACTIVE` Party as a **newly named** lender or borrower (one not in the old row). A borrower who stays may be inactive (P2-D1). The trigger reads the Party `FOR SHARE`; the repository locks the newly named Parties `FOR SHARE` in id order before the Loan, so a concurrent `deactivate` comes first and is seen, or waits.
- **Lock order:** Parties → Loan, as Parties → Acquisition (§27.1).

### Tests (VC-3-01)

- **API:** every `400` code above; `404` for each kind of reference; `PARTY_INACTIVE` for a lender and a borrower; idempotent replay and conflict; amend no-op, `412` and `NOT_AMENDABLE`; amend and void of a `VOID` Loan; the list filters and order.
- **Repository:** Realm isolation of every read and command; `deactivate` of a borrower racing a create (RC and RR); amend against void.
- **Schema tests past the repository**, each with a counter-check (the guard neutralised, the test red):
  - a fixed field changed;
  - a status step without `version` + 1, or out of `VOID`;
  - an insert as `VOID`;
  - the borrowers changed on a `VOID` Loan, or on an `ACTIVE` one without `version` + 1;
  - the lender as a borrower, in both directions: a borrower added who is the lender, and the lender amended to a current borrower;
  - a swap of lender and borrower in one `UPDATE`, which is allowed;
  - a duplicate borrower; a borrower of another Realm or unknown; deleting a Party a Loan names;
  - an `INACTIVE` Party linked.

## 41.2 Loan terms (VC-3-02, implemented: migration 0025)

Decision P3-D2 of `docs/development/phase-3-plan.md`. Terms are the Loan's conditions over time: periods, appended, never overwritten. A follow-up rate with the same lender (Anschlussfinanzierung) is a new period; refinancing with another lender is a new Loan (P3-D7).

- **Domain owner:** Financing. **Authorization:** as §41.1; the terms belong to the Loan's Realm. An unknown or foreign Loan or terms id is `404`.
- **Response** (one period):
  - `termsId`, `loanId`, `status` (`VALID` | `VOID`);
  - `validFrom`, and the derived `validUntil`: the day before the next `VALID` period's `validFrom`, or `null` for the last;
  - `interestRate`: nominal percent p.a. as an exact decimal string with three decimals, e.g. `"3.450"`;
  - `repaymentModel` (`ANNUITY` | `INTEREST_ONLY`);
  - `scheduledPayment` (Money as §31, or `null` for `INTEREST_ONLY`), `firstPaymentDate`;
  - `principalAtStart` (Money or `null`);
  - `fixedRateUntil`, `initialRepaymentRate` (decimal string or `null`), `specialRepaymentLimit` (Money per calendar year, or `null`), `notes`;
  - `voidedAt`, `voidReason`, `createdAt`, `version`.
  - Single-period responses carry `ETag: "<version>"`.

### `POST /api/v1/loans/{loanId}/terms`

- **Body** (strict; unknown keys `400`):
  - `validFrom` (business date, required).
  - `interestRate` (string, required): a decimal with at most three decimals, `0 ≤ rate < 100` (`400` `INVALID_FORMAT` / `OUT_OF_RANGE`). `0` is allowed (an interest-free loan, e.g. within a family). A JSON number is `400`, as for Money (no float in transit).
  - `repaymentModel` (required): `ANNUITY` or `INTEREST_ONLY`. Linear repayment is a later item (P3-D2) and is `400` `INVALID_FORMAT`.
  - `scheduledPayment` (Money, > 0, EUR): **required** for `ANNUITY` (`400` `REQUIRED`), **not allowed** for `INTEREST_ONLY` (`400` `NOT_ALLOWED_FOR_MODEL`), whose payment is the period's interest. Entered as on the contract; DE does not compute it from `initialRepaymentRate` (P3-D2).
  - `firstPaymentDate` (business date, required): not before `validFrom` (`400` `BEFORE_VALID_FROM`). Later payments fall on the same day of each following month, clamped to the month's last day and always counted from `firstPaymentDate` (31 Jan → 28/29 Feb → 31 Mar). VC-3-02 implements this already, since the annuity check needs the carried-over balance; VC-3-04 exposes the schedule.
  - `principalAtStart` (Money, > 0, optional): the balance this period starts from, as the follow-up contract states it (e.g. after special repayments). Not on a Loan's first period, which starts from `principalOriginal` (`422` `PRINCIPAL_AT_START_ON_FIRST_TERMS`); never above `principalOriginal` (`422` `PRINCIPAL_AT_START_EXCEEDS_ORIGINAL`, since Phase 3 has no further disbursement, P3-D1).
  - `fixedRateUntil` (business date, optional; not before `validFrom`, `400` `BEFORE_VALID_FROM`), `initialRepaymentRate` (decimal string as `interestRate`, optional), `specialRepaymentLimit` (Money ≥ 0, optional), `notes` (≤ 2000, trimmed): informational only, they change nothing in the schedule's entries; the last period's `fixedRateUntil` dates §41.4's `summary.fixedRateEnd` (#119).
  - `paymentFrequency`: unknown key; Phase 3 is monthly only (P3-D2).
- **Order of checks:**
  1. `400`;
  2. Loan unknown or foreign → `404`;
  3. Loan not `ACTIVE` → `409 CONFLICT` with `reason = "LOAN_NOT_ACTIVE"` and `details.status`;
  4. `validFrom` before the Loan's `debtFrom` → `422 TERMS_BEFORE_DEBT` with `details.debtFrom`;
  5. `validFrom` not after the last `VALID` period's `validFrom` → `422 TERMS_NOT_APPENDED` with `details.lastValidFrom` (periods are only appended, P3-D2);
  5a. `validFrom` not after the last `VALID` period's `firstPaymentDate` → `422 PREVIOUS_TERMS_WITHOUT_PAYMENT` with `details.termsId` and `details.firstPaymentDate` (review on #61): the previous period would end before its first payment, and its interest up to the follow-up would silently vanish from the plan. So every `VALID` period has at least one payment;
  6. `principalAtStart` as above → `422`;
  7. **an annuity must repay (review on #58):** for `ANNUITY`, `scheduledPayment` must exceed the first period's interest, `round_half_up(balance × rate / 100 / 12)` to the cent, on the balance the period starts from: `principalAtStart`, or else the planned balance carried over from the previous periods on `validFrom` (P3-D5; for the first period `principalOriginal`). Otherwise `422 PAYMENT_DOES_NOT_COVER_INTEREST` with `details.firstInterest` and `details.balance`. So VC-3-02 already implements P3-D5's derivation as a domain function; VC-3-04 exposes it as a read.
- **Success:** `201` with the period (`status = VALID`, `version = 1`); AuditRecord `CREATED` on `LoanTerms` with the fields. **Idempotency (§15):** scope `loan.terms.create`, fingerprint of the Loan id and the normalized body.

### `POST /api/v1/loans/{loanId}/terms/{termsId}/void`

- Body `{ "reason": "..." }` (1–500, trimmed). `200` with the period (`status = VOID`, `voidedAt`, `voidReason`, `version` + 1); AuditRecord `VOIDED`. A `VOID` period counts nowhere: not in `validUntil`, the append rule or the schedule.
- **Order of checks:** `400` → Loan or terms unknown or foreign → `404` → already `VOID`: `200` no-op keeping the first reason → Loan not `ACTIVE` → `409 LOAN_NOT_ACTIVE` → a later `VALID` period exists → `409 CONFLICT` with `reason = "TERMS_NOT_LAST"` and `details.laterTermsId` (only the last period is voidable, P3-D2) → `If-Match` → `412`.
- Correcting a wrong period: void it while it is the last one, then append the right one.

### `GET /api/v1/loans/{loanId}/terms`

- `{ items }`, ordered by `validFrom`, then `createdAt`; `VOID` periods included, each with its `validUntil` derived over the `VALID` ones only. `?status=VALID|VOID`. Unpaged (a Loan has a handful of periods); one snapshot (`REPEATABLE READ READ ONLY`). Unknown parameters are `400`.

### Concurrency and locks (P3-D8)

- Every terms write (create, void) first locks the **Loan row** `FOR UPDATE`, then reads its periods; past the repository both triggers write the Loan row first (below). Two appends to one Loan therefore serialise, and so do an append and a void or close of the Loan. No Transaction is locked (Loan writers never do, P3-D8).
- Past the repository the insert trigger writes the Loan row with the no-op of P3-D8 before it reads the periods, so under REPEATABLE READ a concurrent append fails to serialise (`40001`) instead of reading a stale last period.

### In the database (VC-3-02)

- `loan_terms`:
  - composite foreign key `(loan_id, mre_realm_id)` to `loan`;
  - `interest_rate numeric` with `scale ≤ 3`, `≥ 0` and `< 100`; `initial_repayment_rate` likewise;
  - `repayment_model` in (`ANNUITY`, `INTEREST_ONLY`); `scheduled_payment` present exactly for `ANNUITY` (CHECK), `> 0`, scale ≤ 2, EUR;
  - `first_payment_date ≥ valid_from`, `fixed_rate_until ≥ valid_from`; `principal_at_start > 0`; `special_repayment_limit ≥ 0`;
  - `status` in (`VALID`, `VOID`), `VOID` exactly with `voided_at` and `void_reason`;
  - a unique index on `(loan_id, valid_from) WHERE status = 'VALID'`.
- `loan_terms_append` (before insert): writes the Loan row (P3-D8's no-op), then refuses a period on a Loan that is not `ACTIVE`, before its `debtFrom`, not after the last `VALID` period's `validFrom`, or not after its `firstPaymentDate`; only inserted `VALID` with version 1.
- `loan_terms_frozen` (before update or delete): the data never changes; the only step is `VALID` → `VOID` with `version` + 1 exactly, and only while no later `VALID` period exists; never deleted. **Before it looks for a later period it writes the Loan row too** (P3-D8's no-op; review on #61). Otherwise a raw void of the last period and a raw append behind it would miss each other: the void would not see the uncommitted append, and both would commit with a voided period that is no longer the last. With the write both meet on the Loan row: under READ COMMITTED the void waits and then sees the new period (refused), under REPEATABLE READ the later one fails to serialise (`40001`).
- Not in the database: the annuity check (it needs the schedule's derivation) and the `principalAtStart` rules against the Loan (a cross-row comparison the repository makes under the Loan lock).

### Tests (VC-3-02)

- **Domain:** the first interest and the carried-over balance (hand-computed, including `round_half_up` at half a cent); `PAYMENT_DOES_NOT_COVER_INTEREST` at equality and one cent above; rate `0`.
- **API:** every `400` code above; `NOT_ALLOWED_FOR_MODEL`; a JSON number as rate; the error mapping.
- **Repository:** order of checks; append and void with their refusals; `validUntil` derived over `VALID` periods only; idempotency; Realm isolation.
- **Concurrency:** two appends to one Loan (RC: the second sees the first and is `TERMS_NOT_APPENDED`; RR past the repository: `40001`); an append against a void of the Loan; **a void of the last period against an append behind it, past the repository** (RC: the void waits on the Loan row and is refused; RR: `40001`), with a counter-check (the Loan write in `loan_terms_frozen` removed, the test red).
- **Schema past the repository**, each with a counter-check: an insert before the last period, an insert not after the last period's `firstPaymentDate`, on a `VOID` Loan, before `debtFrom`, as `VOID`; a changed field; a void of a period that is not the last; a step without `version` + 1; a delete; `scheduled_payment` with `INTEREST_ONLY` or without it for `ANNUITY`.

## 41.3 Loan allocation (VC-3-03, implemented: migration 0026)

Decision P3-D3 of `docs/development/phase-3-plan.md`, ADR-038. One Loan is never duplicated per property (ADR-014, BR-FIN-002). It reaches its PropertyReferences through **allocation sets**: one exact fraction per property, summing to exactly `1/1`, valid from a date. One basis for principal, interest and remaining debt (ADR-038). The allocated amounts are derived by VC-3-06 (largest remainder, ties by `propertyReferenceId`) and never stored.

- **Domain owner:** Financing. **Authorization:** as §41.1; the set, its PropertyReferences and its Acquisitions belong to the Loan's Realm. Unknown, foreign or malformed ids are answered as §30.1.
- **Sets, like terms (§41.2):** appended after the last one, never edited, only the last one voidable. A set's `validUntil` is derived: the day before the next `VALID` set's `validFrom`, or `null` for the last. Before the first set the Loan is **unallocated** (P3-D3, BR-FIN-009).
- **Response** (one set):
  - `allocationSetId`, `loanId`, `status` (`VALID` | `VOID`), `validFrom`, derived `validUntil`;
  - `basis` (`MANUAL` | `PURCHASE_PRICE`);
  - `allocations`: `[{ propertyReferenceId, share, acquisitionId }]` in the order given, `share` a reduced fraction `"n/d"` (§26.1's notation), `acquisitionId` only for `PURCHASE_PRICE` (else `null`);
  - `notes`, `voidedAt`, `voidReason`, `createdAt`, `version`; single-set responses carry `ETag`.

### `POST /api/v1/loans/{loanId}/allocations`

- **Body** (strict):
  - `validFrom` (business date, required).
  - `basis` (`MANUAL` | `PURCHASE_PRICE`, default `MANUAL`).
  - `allocations` (1–50 entries, required), one per PropertyReference (`DUPLICATE` at the later position):
    - `MANUAL`: `{ propertyReferenceId, share }`. `share` as §26.1 (`"n/d"`, `0 < n ≤ d ≤ 10000`, input may be unreduced, stored reduced). The shares sum to exactly `1/1`, else `400` with field `allocations` and code `SHARE_SUM_NOT_ONE`. An `acquisitionId` is `400` `NOT_ALLOWED_FOR_BASIS`.
    - `PURCHASE_PRICE`: `{ propertyReferenceId, acquisitionId }`, the default of ADR-038 ("defaulted from the financed purchase amount"). DE derives `share_i = price_i / Σ price` exactly and reduced, from those Acquisitions' `purchasePrice` in cents. The denominator may then exceed 10 000; it is stored and returned exactly. A `share` is `400` `NOT_ALLOWED_FOR_BASIS`; the same Acquisition twice is `DUPLICATE`.
    - A single-property Loan is a set with one entry: `"1/1"`, or one Acquisition.
  - `notes` (≤ 2000, trimmed).
- **Order of checks** (as §41.2):
  1. `400`;
  2. Loan unknown or foreign → `404`;
  3. Loan not `ACTIVE` → `409 LOAN_NOT_ACTIVE` with `details.status`;
  4. `validFrom` before the Loan's `debtFrom` → `422 ALLOCATION_BEFORE_DEBT` with `details.debtFrom`;
  5. `validFrom` not after the last `VALID` set's `validFrom` → `422 ALLOCATION_NOT_APPENDED` with `details.lastValidFrom`;
  6. each PropertyReference, in the order given: unknown or foreign → `404` (`details.propertyReferenceId`);
  7. `PURCHASE_PRICE` only, each Acquisition in the order given: unknown, foreign, or of another PropertyReference than its entry → `404` (`details.acquisitionId`); `CANCELLED` → `422 ACQUISITION_CANCELLED` (`details.acquisitionId`; P3-D3 takes `CONFIRMED` and `DRAFT` ones).
- **Success:** `201` with the set (`status = VALID`, `version = 1`); AuditRecord `CREATED` on `LoanAllocationSet` with the basis, `validFrom` and every entry. **Idempotency (§15):** scope `loan.allocation.create`, fingerprint of the Loan id and the normalized body (shares reduced). The fractions of a `PURCHASE_PRICE` set are fixed when it is written: a later cancel of one of its Acquisitions does not change it (prices themselves never change, §27.1). To follow a change, append a new set.

### `POST /api/v1/loans/{loanId}/allocations/{allocationSetId}/void`

- Body `{ "reason": "..." }`. As §41.2's terms void: `404` → already `VOID` `200` no-op → `409 LOAN_NOT_ACTIVE` → a later `VALID` set exists → `409 CONFLICT` with `reason = "ALLOCATION_NOT_LAST"` and `details.laterAllocationSetId` → `412`. AuditRecord `VOIDED`. A `VOID` set counts nowhere.

### Reads

- `GET /api/v1/loans/{loanId}/allocations`: `{ items }`, every set in `validFrom`, then `createdAt` order, `VOID` included, with `validUntil` over the `VALID` ones. `?status=`.
- `GET /api/v1/loans/{loanId}/allocations?asOf=d`: `{ asOf, set }`, the `VALID` set covering `d`, or `set: null` while the Loan is unallocated on `d`. `status` and `asOf` cannot be combined (`400`). The property-level amounts that need a set (VC-3-06) answer `409 LOAN_NOT_ALLOCATED` instead of inventing one (BR-FIN-009).
- `GET /api/v1/property-references/{propertyReferenceId}/loans[?asOf=d]` (`404` for an unknown or foreign PropertyReference): the Loans allocated to it, `VOID` Loans left out (they count nowhere). Each item:
  - `loanId`, `status`, `lenderPartyId`, `principalOriginal`;
  - `allocationSetId`, `validFrom`, `validUntil`, `basis`, `share`: the property's entry in one set.
  - Without `asOf`, one item per `VALID` set that contains the property, as a history. With `asOf`, only the sets covering `d`, so at most one item per Loan.
  - Ordered by `validFrom` (newest first), then `loanId`. Unpaged; a property has few Loans.
- All reads in one `REPEATABLE READ READ ONLY` snapshot; unknown parameters are `400`.

### Concurrency and locks (P3-D8)

- A set write (create, void) locks the **Loan row** `FOR UPDATE` first, then reads its sets. PropertyReferences and Acquisitions are only read: their ids, Realm and prices never change, and a cancel racing a `PURCHASE_PRICE` set is equivalent to "set, then cancel" (the fractions stay, as above). No Transaction is locked.
- Past the repository both triggers write the Loan row first (P3-D8's no-op), as `loan_terms_append` and `loan_terms_frozen` do (§41.2): two raw appends serialise, and a raw void of the last set meets a raw append behind it on the Loan row.

### In the database (VC-3-03)

- `loan_allocation_set`:
  - composite foreign key `(loan_id, mre_realm_id)` to `loan`; `UNIQUE (id, mre_realm_id)`;
  - `basis` in (`MANUAL`, `PURCHASE_PRICE`); status fields as `loan_terms`;
  - a unique index on `(loan_id, valid_from) WHERE status = 'VALID'`.
- `loan_allocation` `(set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator, acquisition_id)`:
  - composite foreign keys to the set `(set_id, mre_realm_id)` and to `property_reference (id, mre_realm_id)`;
  - `acquisition_id` with a composite foreign key to `acquisition (id, mre_realm_id, property_reference_id)` (0020's key), so an Acquisition of another property cannot be named;
  - `share_numerator`, `share_denominator` as `numeric` integers (scale 0): `0 < n ≤ d`, `gcd(n, d) = 1`;
  - `UNIQUE (set_id, property_reference_id)`;
  - rows are never updated or deleted.
- `loan_allocation_set_append` (before insert): writes the Loan row (P3-D8), then refuses a set on a Loan that is not `ACTIVE`, before `debtFrom`, or not after the last `VALID` set's `validFrom`; only inserted `VALID` with version 1.
- `loan_allocation_set_frozen` (before update or delete): data never changes; the only step is `VALID` → `VOID` with `version` + 1, for the last `VALID` set only, writing the Loan row before looking for a later set; never deleted.
- **The sum is exactly one, at commit:** a **deferred** constraint trigger on `loan_allocation_set` (insert) and `loan_allocation` (insert) sums the set's fractions exactly in integer arithmetic (as 0019's share sums) and refuses anything but `1/1`. Rows are only ever added, every share is positive, and a set of sum one cannot take another row without exceeding it. So a committed set is never changed by adding rows past the repository, and a set without rows is refused.
- `basis = MANUAL` rows have no `acquisition_id`, and `PURCHASE_PRICE` rows have one: a CHECK through the set is not possible, so the deferred trigger checks it with the sum.
- Not in the database: `ACQUISITION_CANCELLED` (a status read when the set is written; a later cancel keeps the set, above), `d ≤ 10000` for `MANUAL` (§26.1's input format; a `PURCHASE_PRICE` denominator is unbounded) and the 1–50 entries of a request. The repository and the API check them.

### Tests (VC-3-03)

- **Domain:**
  - the derivation from prices, exact and reduced (e.g. 300 000.00 and 175 000.00 → `12/19`, `7/19`), with a denominator above 10 000;
  - the manual sum, `1/3 + 1/3 + 1/3` exactly one, `1/3 + 2/3 + 1/10000` not;
  - the set covering a day, and `validUntil`.
- **API:** every `400` code (`SHARE_SUM_NOT_ONE`, `NOT_ALLOWED_FOR_BASIS`, `DUPLICATE`, the share format); the error mapping; `asOf` with `status`.
- **Repository:**
  - order of checks;
  - an Acquisition of another property, which is `404`;
  - a `CANCELLED` Acquisition;
  - idempotency; void only of the last set;
  - the three reads with `asOf` before, on and after a change of set, and `null` before the first;
  - a `VOID` Loan left out of the property list; Realm isolation.
- **Concurrency:** two appends (RC sees the first; RR `40001`); an append against a void of the Loan; a raw void of the last set against a raw append behind it (RC refused; RR `40001`).
- **Schema past the repository**, each with a counter-check:
  - a set whose shares sum below or above one, or that has no rows;
  - a row added to a committed set;
  - a row updated or deleted; a set edited or deleted;
  - an append not after the last set; a void that is not of the last set;
  - an Acquisition of another property; the basis and `acquisition_id` disagreeing.

## 41.4 Loan schedule (VC-3-04, implemented)

Decision P3-D5 of `docs/development/phase-3-plan.md`, ADR-015. The schedule is the **plan**: derived on read from the Loan and its `VALID` terms periods (§41.2), never stored, never cash. The same Loan and terms always give the same schedule, so there is no `scheduleVersion` and no recalculate command. VC-3-02 already implements the derivation (`deriveSchedule`), since the annuity check needs the carried-over balance; VC-3-04 exposes it.

- **Domain owner:** Financing. **Authorization:** as §41.1. An unknown or foreign Loan is `404`.
- **Status:** a schedule is read for a Loan in any status. A `VOID` Loan's plan is shown as its terms state it, and it counts nowhere (§41.1). A `CLOSED` Loan's plan ends at its `closingDate` (§41.7).

### `GET /api/v1/loans/{loanId}/schedule[?from=&to=]`

- **Query** (strict; unknown parameters are `400`):
  - `from`, `to`: business dates, both optional and inclusive, applied to `paymentDate`;
  - `to` before `from` → `400` with field `to` and code `BEFORE_FROM`.
  - The window only filters `items`. Balances are always derived from the Loan's start, and `summary` always covers the whole plan.
- **Derivation** (P3-D5), periods in `validFrom` order, `VOID` periods ignored:
  - **Payment dates:** monthly from each period's `firstPaymentDate`, on the same day of each following month, clamped to the month's last day and always counted from `firstPaymentDate` (31 Jan → 28 Feb → 31 Mar → 30 Apr).
  - **Where a period's payments stop:** before the next `VALID` period's `validFrom`; never after the Loan's `maturityDate`; once the balance is 0; and at 600 payments in all (50 years).
  - **Balance:** the first period starts from `principalOriginal`. A later period starts from its `principalAtStart` when it states one, else from the balance carried over.
  - **Interest:** `round_half_up(balanceBefore × rate / 100 / 12)` to the cent, a 30/360 convention, in integer arithmetic (cents as bigint, the rate in thousandths of a percent). A lender's own schedule may differ by cents; the plan is a plan, and the ledger is the truth.
  - **Principal:**
    - `ANNUITY`: `min(scheduledPayment − interest, balanceBefore)`. So the last payment is smaller, and the balance never falls below 0;
    - `INTEREST_ONLY`: 0.
  - `payment = interest + principal`; `balanceAfter = balanceBefore − principal`.
- **Response** `200`:
  - `loanId`, `from`, `to` (as given, or `null`).
  - `items`: `[{ number, paymentDate, termsId, balanceBefore, interest, principal, payment, balanceAfter }]` in `paymentDate` order. `number` is the payment's position in the whole plan, starting at 1, so a window keeps the numbers. Amounts are Money (§31, EUR).
  - `summary`, over the whole plan:
    - `payments` (count), `firstPaymentDate`, `lastPaymentDate` (`null` without payments);
    - `totalInterest`, `totalPrincipal`;
    - `balanceDue`: the balance after the last payment;
    - `endReason`, one of:
      - `PAID_OFF`: the balance reached 0, so `balanceDue` is 0;
      - `MATURITY`: the next payment would fall after `maturityDate`, and `balanceDue` is due on `maturityDate`. This is how an `INTEREST_ONLY` plan ends (P3-D5), and an annuity that has not repaid by then;
      - `PAYMENT_CAP`: 600 payments were reached, e.g. `INTEREST_ONLY` without `maturityDate`;
      - `NO_TERMS`: no `VALID` period, so no payments, and `balanceDue` is `principalOriginal`. A Loan without terms has no plan, which is not an error.
    - **Ties (review on #65):** `PAID_OFF` before `MATURITY` before `PAYMENT_CAP`. A plan paid off by a payment on `maturityDate`, or by its 600th payment, is `PAID_OFF`. A 600th payment after which the next one would fall after `maturityDate` ends the plan with `MATURITY`.
    - **A follow-up period after the plan reached 0** (review on #65): when it states no `principalAtStart`, it starts from 0 and has no payments, and the plan stays `PAID_OFF`. §41.2 lets such a period be appended (its first interest is 0); it is shown in the terms and has no entries here.
    - `fixedRateEnd` (#119): the balance at the end of the fixed-rate period (Restschuld nach Zinsbindung), `{ date, balance }` or `null`.
      - `date` is the **last** `VALID` period's `fixedRateUntil`. An earlier period's date is history; `null` when the last period states none.
      - `balance` is the planned remaining debt of §41.6 on that date: the balance after every payment on or before it (before the first payment, the balance the period starts from), 0 when paid off before it, 0 from `maturityDate` on with `MATURITY`, and 0 when a `CLOSED` Loan's closing date is before it (§41.7).
      - The plan itself does not change at that date: it goes on at the same rate, since the follow-up rate is unknown (`fixedRateUntil` stays informational for the entries, §41.2).
  - Unpaged: at most 600 items. One snapshot (`REPEATABLE READ READ ONLY`) of the Loan and its periods.
- **Example** (hand-computed; the reference for the tests):
  - The Loan: `principalOriginal` 1 000.00, one `ANNUITY` period at `"6.000"` with payment 300.00, `firstPaymentDate` 2027-01-31, no `maturityDate`. A monthly rate of 0.5 %.

    | # | paymentDate | balanceBefore | interest | principal | payment | balanceAfter |
    |---|---|---|---|---|---|---|
    | 1 | 2027-01-31 | 1 000.00 | 5.00 | 295.00 | 300.00 | 705.00 |
    | 2 | 2027-02-28 | 705.00 | 3.53 (3.525 rounds up) | 296.47 | 300.00 | 408.53 |
    | 3 | 2027-03-31 | 408.53 | 2.04 (2.04265) | 297.96 | 300.00 | 110.57 |
    | 4 | 2027-04-30 | 110.57 | 0.55 (0.55285) | 110.57 | 111.12 | 0.00 |

  - `summary`: 4 payments, `totalInterest` 11.12, `totalPrincipal` 1 000.00, `balanceDue` 0.00, `endReason = PAID_OFF`.
- **Not here:** the actual remaining debt from the ledger and the planned-vs-actual comparison are VC-3-06 (P3-D6). The payment proposal for a Transaction is VC-3-05 (P3-D4). Property-level amounts are VC-3-06.

### Tests (VC-3-04)

- **Domain:**
  - the example above, row for row;
  - a carry-over into a follow-up period, and a `principalAtStart` that restarts the balance;
  - `INTEREST_ONLY` up to `maturityDate` (`MATURITY`, the principal as `balanceDue`), and without a `maturityDate` (`PAYMENT_CAP` at 600);
  - an annuity cut by `maturityDate` with a `balanceDue`;
  - month-end clamping; `NO_TERMS`.
  - `fixedRateEnd` (#119): `fixedRateUntil` before the first payment, on a due date, between two, after the payoff; `MATURITY`; the last period's date with a `principalAtStart`; a `CLOSED` Loan; the property test against the oracle.
- **Property test** (seeded, deterministic, no new dependency), over a few hundred random full annuities (principal, rate, a payment above the first interest, no `maturityDate`):
  - Σ principal = `principalOriginal` exactly, and `endReason = PAID_OFF`;
  - every row has `payment = interest + principal` and `balanceAfter = balanceBefore − principal`, and each row's `balanceBefore` is the previous row's `balanceAfter`;
  - only the last payment is below `scheduledPayment`.
- **API:**
  - the response shape and Money format;
  - `from`/`to`: the window keeps the numbers and the summary;
  - `BEFORE_FROM`; unknown parameters; `404`; the error mapping.
- **Repository:**
  - the Loan's `VALID` periods only, a `VOID` period ignored;
  - Realm isolation; one snapshot.
- **Counter-checks:**
  - in the domain: `round_half_up` replaced by truncation, the cap on the last principal, the carry-over, `principalAtStart`, the stop at the next period and at `maturityDate`, and the clamping;
  - the property test must fail for each of them.

## 41.5 Loan payments (VC-3-05, implemented: migration 0027)

Decision P3-D4 of `docs/development/phase-3-plan.md`, ADR-015, BR-FIN-004/005. An actual payment is ledger cash only. Its interest and principal are separate `TransactionSplit`s with the seeded categories `LOAN_INTEREST` and `LOAN_PRINCIPAL` (migration 0008, data-model §72), each carrying the Loan's `loanId`. The split is the link: data-model §25's `LoanPaymentReconciliation` and §46's `reconcile-payment` are dropped. Deviations from the plan are derived (P3-D5, VC-3-06).

### `loanId` on a split

`PUT /api/v1/transactions/{id}/splits` (§33.2) accepts `loanId` on a split, lifting its `NOT_SUPPORTED`. `correct` accepts it in `replacement.splits` (§35.2), and a reversal mirrors it (below). Every split in a response carries `loanId` (`null` without one), as do the Transaction reads (§30).

- **Rules for a split with `loanId`:**
  - **The Loan:** of the caller's Realm, else `404 NOT_FOUND` with `details.loanId`, for the first such split in position order. It must not be `VOID`, else `409 CONFLICT` with `reason = "LOAN_NOT_ACTIVE"` and `details.loanId` and `details.status`. For a `CLOSED` Loan, a split on a Transaction booked after `closingDate` is then `409 LOAN_CLOSED` (§41.7).
  - **The category:** `LOAN_INTEREST` or `LOAN_PRINCIPAL`, else `422 INVALID_LOAN_SPLIT` with `details.position` and `details.reason = "CATEGORY"`.
  - **The direction:** the Transaction is `OUTFLOW`, else `422 INVALID_LOAN_SPLIT` with `details.reason = "DIRECTION"`. A **reversal** is exempt (review on #58): it has the opposite direction, mirrors its original's splits (§35.3, 0014) and never counts. Originals and replacements must be `OUTFLOW`.
  - **No PropertyReference with it:** a Loan reaches its properties only through its allocation (§41.3, BR-FIN-002/007), so it is never attributed twice. A split with both is `400`, code `NOT_ALLOWED_WITH_LOAN` at `splits.<i>.propertyReferenceId`.
  - A `LOAN_*` split **without** `loanId` stays allowed and counts for no Loan.
  - Several Loans in one Transaction are allowed, e.g. two loans paid in one bank debit.
- **Order of checks** (§33.2's, extended):
  1. `400`, `NOT_ALLOWED_WITH_LOAN` among them;
  2. Transaction `404`; `409 TRANSACTION_FROZEN`; `409 SPLIT_SUM_MISMATCH`; `412`; `UNKNOWN_CATEGORY`; PropertyReference `404`, all unchanged;
  3. Loan `404` → `422 INVALID_LOAN_SPLIT` (`CATEGORY`, then `DIRECTION`) → `409 LOAN_NOT_ACTIVE`, each for the first split in position order.
- **Same set again** (§33.2's no-op): `loanId` is part of the comparison. Changing only a split's `loanId` is a change: it gets a new version and the AuditRecord `SPLITS_REPLACED`, and it is refused once the Transaction is frozen.
- **Confirm (§34):** unchanged. A confirmed Transaction's splits, `loanId` included, are frozen (0009). A forgotten or wrong `loanId` is fixed by `correct`, whose replacement carries the right splits (P3-D4).

### Corrections of a payment (review on #58)

- **Reversal** (`correct` and `reverse`, §35.3, §35.9): its splits mirror the original's `loanId` together with category, PropertyReference and amount. 0014's comparison gains `loan_id`, so a reversal cannot drop or change it, and each Loan's history stays complete.
- **Replacement:** its splits follow the rules above, whether copied from the original (§35.2) or given in the request. A copied split whose Loan has become `VOID` is refused like any other (`409 LOAN_NOT_ACTIVE`). The client then sends the replacement's splits. (A Loan with splits cannot be voided, below, so this needs a Loan voided before any of its splits was written.)
- **Closing date (P3-D7, VC-3-07):** a reversal takes the original's booking date and is allowed whenever the original was. A replacement booked after the Loan's `closingDate` is refused like any new split. §41.7 adds the rule to the guard below.

### What counts

A Loan's actual payments are the splits with its `loanId` of **current** Transactions: `CONFIRMED` or `RECONCILED`, and not a reversal (§35.3), by booking date. A correction replaces them through the replacement's splits. Unconfirmed Transactions do not count. VC-3-06's reads (remaining debt, planned vs actual, per property) are built on exactly this rule. Property-level figures attribute a split with `loanId` through the Loan's allocation set valid on its booking date (§41.3).

### `GET /api/v1/loans/{loanId}/payment-proposal?transactionId=`

A read, never a write (ADR-015: the plan never becomes cash). The client applies a proposal through `PUT …/splits`.

- **Query** (strict): `transactionId` is required (`400 REQUIRED`, malformed `400`).
- **Refusals**, in this order:
  1. `400`;
  2. Loan unknown or foreign → `404` (`details.loanId`); Transaction unknown or foreign → `404` (`details.transactionId`);
  3. Loan `VOID` → `409 LOAN_NOT_ACTIVE`;
  4. the Transaction is not `OUTFLOW`, or not unconfirmed (`IMPORTED`, `UNREVIEWED` or `CLASSIFIED`) → `409 CONFLICT` with `reason = "NOT_PROPOSABLE"` and `details.direction` and `details.status`;
  5. the Loan's schedule (§41.4) has no payments → `409 CONFLICT` with `reason = "NO_SCHEDULE"` and `details.endReason`.
- **The schedule entry:** the payment of the whole plan whose `paymentDate` is nearest to the Transaction's `bookingDate`. On a tie it is the earlier one. A bank debit booked a day or two before or after its due date matches it.
- **The proposal:**
  - **interest** = `min(entry.interest, amount)`;
  - **principal** = `amount − interest`, for an `ANNUITY` entry;
  - for an `INTEREST_ONLY` entry no principal is proposed; the rest stays `unallocated` (P3-D4: "interest only, any rest flagged").
  - `splits` has a `LOAN_INTEREST` and a `LOAN_PRINCIPAL` split with this `loanId`, in that order; a split of amount 0 is left out. Their sum plus `unallocated` is the Transaction's `amount`.
- **Flags** (a list, possibly empty):
  - `AMOUNT_DIFFERS_FROM_SCHEDULE` with `details.difference` (amount − `entry.payment`, signed Money): e.g. a special repayment or a changed rate. The principal absorbs the difference.
  - `AMOUNT_BELOW_INTEREST`: the amount does not cover the entry's interest.
  - `REST_NOT_PLANNED`: an `INTEREST_ONLY` entry and an amount above its interest.
  - `ALREADY_SPLIT`: the Transaction has splits already; the proposal ignores them.
- **Response `200`:**
  - `loanId`, `transactionId`, `bookingDate`, `amount`;
  - `scheduleEntry`: `{ number, paymentDate, termsId, interest, principal, payment, balanceBefore }`;
  - `splits`: `[{ financialCategoryCode, loanId, amount }]`;
  - `unallocated` (Money), `flags`.
  - One `REPEATABLE READ READ ONLY` snapshot of the Loan, its terms and the Transaction.
- **Example** (§41.4's Loan): a Transaction of 300.00 booked on 2027-03-01 matches entry 2 (2027-02-28, 1 day away). It proposes `LOAN_INTEREST` 3.53 and `LOAN_PRINCIPAL` 296.47, with no flags. A Transaction of 400.00 on the same day proposes 3.53 and 396.47 with `AMOUNT_DIFFERS_FROM_SCHEDULE` (difference 100.00).

### Concurrency and locks (P3-D8; review on #58)

- **Lock order Transaction → Loan.** `loanId` is written through the ledger's own path (`PUT …/splits`, `correct`, `reverse`), which locks the Transaction first (§34.2, §35.5). After that lock, the repository locks the split set's Loans `FOR UPDATE` in id order and checks them. `correct` and `reverse` lock every Loan they write in one id-ordered step: the original's, which the reversal mirrors, and the replacement's (review on #68). Past the repository the split guard **writes** the Loan row (P3-D8's no-op, as 0022 does for the Acquisition, lesson of #50). Then a stale `void` under REPEATABLE READ fails to serialise (`40001`) instead of passing a share lock.
- **Loan writers never lock a Transaction:** void, terms, allocations and, later, close and statements lock the Loan row and only read splits. No cycle can arise.
- **Void against a split write:** they serialise on the Loan row. Whichever comes second sees the other's result under READ COMMITTED (the void is refused with `LOAN_HAS_SPLITS`, or the split with `LOAN_NOT_ACTIVE`), or fails to serialise under REPEATABLE READ.
- **The import path writes no splits.** Imports create unconfirmed Transactions (§32); their splits come through `PUT …/splits` later. So the import never reaches a Loan row, and has nothing to retry. The application's commands run under READ COMMITTED; a `40001` arises only for a raw writer under REPEATABLE READ, where the tests show it.

### In the database (VC-3-05)

- **`transaction_split.loan_id`:**
  - `uuid`, with a composite foreign key `(loan_id, mre_realm_id)` to `loan`, so a split never names another Realm's Loan;
  - an index on `loan_id`;
  - `CHECK (loan_id IS NULL OR property_reference_id IS NULL)`.
- **`transaction_split_loan` trigger** (before insert or update, only for a split with `loan_id`):
  - it writes the Loan row with P3-D8's no-op, `RETURNING status`, and refuses a `VOID` Loan;
  - it refuses a category other than `LOAN_INTEREST` and `LOAN_PRINCIPAL`;
  - it refuses a Transaction that is not `OUTFLOW`, unless the Transaction's `correction_role` is `REVERSAL`.
  - The frozen-splits rules (0009/0010) and the split trigger's own Transaction write are unchanged.
  - **Trigger order (review on #67):** it fires after `transaction_split_frozen`, since BEFORE triggers fire in name order. So past the repository the Transaction row is written before the Loan row, and raw writers keep P3-D8's Transaction → Loan. A test checks the order in `pg_trigger`; a renamed trigger that sorted first would turn it red.
  - §41.7 adds the `closingDate` check here.
- **`loan_void_unreferenced`** (before update of `loan`): a step to `VOID` is refused while a split references the Loan, a reversal's included. With the guard's Loan write, a void and a split cannot both commit past the repository either.
- **0014's mirror** compares `(category, PropertyReference, loan_id, amount, currency)`.
- Not in the database: the proposal (a read), and the order of checks (the API).

### Tests (VC-3-05)

- **API:**
  - every `400` (`NOT_ALLOWED_WITH_LOAN`, a malformed `loanId`);
  - the error mapping (`404` Loan, `INVALID_LOAN_SPLIT` with its reasons, `LOAN_NOT_ACTIVE`);
  - `loanId` in the split responses and in `GET /transactions/{id}`;
  - the proposal's query, its refusals and its shape.
- **Repository:**
  - the order of checks;
  - several Loans in one set;
  - the same set again as a no-op, and a changed `loanId` as a change;
  - Realm isolation.
- **Corrections:**
  - `correct` of a payment with `loanId`: the copied splits, the replacement's own splits with another Loan or without a Loan, and a replacement that is not `OUTFLOW`;
  - `reverse` of a payment with `loanId`;
  - the payments that count before and after each, by the rule above.
- **Proposal (domain):**
  - the example above;
  - the nearest entry and a tie;
  - `INTEREST_ONLY` with a rest;
  - an amount below the interest;
  - `ALREADY_SPLIT`.
- **Concurrency**, RC and RR, each with a counter-check:
  - a split write against a void of the Loan, both orders: RC sees the other's result; RR past the repository `40001`;
  - two split writes with two Loans in opposite position order: no deadlock, because of the id order.
- **Schema past the repository**, each with a counter-check:
  - a split with `loan_id` of another Realm;
  - one on a `VOID` Loan;
  - one with another category, or on an `INFLOW` Transaction that is not a reversal;
  - an `INFLOW` reversal mirroring a payment, which is allowed;
  - `loan_id` with `property_reference_id`;
  - a reversal whose splits drop or change `loan_id`;
  - a `VOID` step of a Loan with splits.

## 41.6 Remaining debt, payments and lender statements (VC-3-06, implemented: migration 0028)

Decision P3-D6 of `docs/development/phase-3-plan.md`, ADR-016, BR-FIN-006. Remaining debt is **derived**: from the contract (§41.1), the ledger (the payments that count, §41.5) and the plan (§41.4). It is never stored and never taken from a bank balance. A lender's statement is evidence that is compared with the derived value; it never replaces it.

- **Domain owner:** Financing. **Authorization:** as §41.1. An unknown or foreign Loan is `404`. A `VOID` Loan counts nowhere: its reads answer `409 CONFLICT` with `reason = "LOAN_NOT_ACTIVE"`.
- **The business date `asOf`** defaults to today in Europe/Berlin, from the server's clock.
- **All amounts are exact in cents.** Every read below is one `REPEATABLE READ READ ONLY` snapshot of the Loan, its terms, its allocation sets, the counted splits and the statements.

### Definitions on a day `d`

- **Owed from `debtFrom`** (`disbursementDate`, else `startDate`; §41.1, full disbursement). Before `debtFrom` the actual and the planned remaining debt are both 0, and so is `principalPaid` (with `NO_TERMS` the planned values stay `null`).
- **Principal paid** on `d` = Σ `LOAN_PRINCIPAL` splits with this `loanId` that count (§41.5: of current Transactions, `CONFIRMED` or `RECONCILED` and not a reversal), with booking date ≤ `d`.
- **Actual remaining debt** = `principalOriginal` − principal paid. It is negative when more principal has been paid than was lent (a booking error, or a payment of another Loan); the read shows that rather than hiding it.
- **Planned remaining debt** = the plan's balance after its last payment on or before `d` (§41.4). Before the first payment it is the balance the period in effect starts from (`principalOriginal`, or its `principalAtStart`). With `NO_TERMS` there is no plan, and the planned values are `null`.
- **Maturity (review on #69):** with `endReason = MATURITY` the plan's `balanceDue` is due on `maturityDate` (§41.4, P3-D2). So from `maturityDate` on, inclusive, `planned` is **0**: the balance due counts as repaid as planned on that day. A bullet repayment paid on time then shows a difference of 0, and an overdue one shows the full balance as a positive difference. With `PAID_OFF`, `planned` is 0 after the last payment anyway. With `PAYMENT_CAP` there is no due date, and `planned` stays at `balanceDue`.
- **Difference** = actual − planned, signed. Special repayments, missed or late payments, and cents of rounding show up here.
- **After a `CLOSED` Loan's `closingDate`** both are 0 (§41.7).

### Per property

- **The allocation:** the Loan's `VALID` allocation set covering `d` (§41.3). Each property-level amount distributes its total by the set's exact fractions into cents by **largest remainder**, ties by `propertyReferenceId`, as Phase 2 does for owners (§27.4).
- **Derived, never distributed (F4b):** `actual` and `planned` are distributed; each property's `difference` is its `actual − planned`. Largest remainder is not monotone, so distributing the difference separately could break `difference_i = actual_i − planned_i`. Distributing it this way keeps every per-property identity by construction, and each column still sums exactly to its total.
- **A negative total** (an actual remaining debt below 0) is distributed by its absolute value, and the sign is restored on each part.
- **Unallocated:** with `perProperty=true` and no set covering `d`, the read answers `409 CONFLICT` with `reason = "LOAN_NOT_ALLOCATED"` and `details.asOf` (BR-FIN-009: it never invents a share). Without `perProperty`, the Loan-level values are answered whatever the allocation.

### `GET /api/v1/loans/{loanId}/remaining-debt[?asOf=&perProperty=]`

- **Query** (strict; unknown parameters are `400`): `asOf` (business date), `perProperty` (`true`/`false`, default `false`).
- **Response `200`:**
  - `loanId`, `asOf`, `debtFrom`;
  - `principalOriginal`, `principalPaid`, `actual`;
  - `planned` (Money or `null`), `difference` (signed Money or `null`), `planEndReason` (§41.4's `endReason`);
  - `latestStatement`: the `VALID` statement with the latest `statementDate` on or before `asOf` (of several that day, the last created), with its comparison (below), or `null`;
  - `fixedRateEnd` (#119): §41.4's `summary.fixedRateEnd`, the same whatever `asOf`; it is the plan's figure, so a special repayment shows as `actual` below `planned`, not here;
  - with `perProperty=true`: `allocationSetId`, `items: [{ propertyReferenceId, share, actual, planned, difference }]` in the set's order.
- **Order of refusals:** `400` → Loan `404` → `VOID` `409 LOAN_NOT_ACTIVE` → `409 LOAN_NOT_ALLOCATED`.
- **Example** (§41.4's Loan of 1 000.00, debt from 2027-01-01):
  - Two payments are confirmed, booked 2027-01-31 and 2027-02-28, with principal 295.00 and 296.47.
  - On `asOf = 2027-03-15`: `principalPaid` = 591.47, `actual` = 408.53, `planned` = 408.53 (after entry 2), `difference` = 0.00.
  - With a set of `2/3` and `1/3` from 2027-01-01, `actual` is distributed as 272.35 and 136.18. In cents, 40 853 × 2/3 = 27 235⅓ and 40 853 × 1/3 = 13 617⅔. The floors 27 235 and 13 617 leave one cent, which goes to the larger remainder, ⅔ against ⅓. So the parts are 272.35 and 136.18. `planned` is distributed the same way, and each `difference` is 0.00.

### `GET /api/v1/loans/{loanId}/payments?year=[&perProperty=]`

The interest and principal **paid** in a calendar year, for reports and, later, tax (Phase 7 interprets the interest; `germany/taxation.md`, VERIFY).

- **Query:** `year` (required, `2000`–`2100`), `perProperty` as above.
- **What it sums:** the counted `LOAN_INTEREST` and `LOAN_PRINCIPAL` splits with this `loanId`, with booking dates in the year.
- **Response `200`:** `loanId`, `year`, `interest`, `principal`, and `payments` (the number of Transactions).
- **With `perProperty=true`:**
  - each split is attributed by the set covering **its booking date**, then distributed into cents by largest remainder, ties by `propertyReferenceId`;
  - the parts are summed per property and category: `items: [{ propertyReferenceId, interest, principal }]`, ordered by `propertyReferenceId`;
  - each column sums exactly to its total;
  - if any counted split of the year falls on a day without a set → `409 LOAN_NOT_ALLOCATED` with `details.bookingDate`, the first such date.
- **Refusals:** `400` (`year` missing or out of range) → `404` → `409 LOAN_NOT_ACTIVE` → `409 LOAN_NOT_ALLOCATED`.

### Lender statements: `LoanBalanceStatement`

A balance the lender reports on a date, e.g. from the annual account statement (ADR-016: evidence, never the truth).

- **`POST /api/v1/loans/{loanId}/balance-statements`**
  - **Body** (strict):
    - `statementDate` (business date, required);
    - `balance` (Money ≥ 0, EUR, required);
    - `source` (1–200 characters, trimmed, required, e.g. "Jahreskontoauszug 2027");
    - `notes` (≤ 2000).
  - **Order of checks:**
    1. `400`;
    2. `404`;
    3. Loan `VOID` → `409 LOAN_NOT_ACTIVE` (a `CLOSED` Loan: `statementDate` after `closingDate` → `422 STATEMENT_AFTER_CLOSING`, §41.7);
    4. `statementDate` before `debtFrom` → `422 STATEMENT_BEFORE_DEBT` with `details.debtFrom`.
  - **Success:** `201` with the statement and its comparison; AuditRecord `CREATED`.
  - **Idempotency (§15):** scope `loan.statement.create`.
  - Several statements may exist for one date, e.g. a correction letter: the comparison takes each as it is.
- **`POST …/balance-statements/{statementId}/void`:** body `{ reason }`. As the other voids:
  - `404`;
  - an already `VOID` statement → `200` no-op;
  - Loan `VOID` → `409 LOAN_NOT_ACTIVE`;
  - `412` on a version conflict;
  - AuditRecord `VOIDED`.
  - Statements are never edited: void and record again.
- **`GET …/balance-statements[?status=]`:** `{ items }` by `statementDate`, then `createdAt`, each with its comparison. `404`; a `VOID` Loan `409 LOAN_NOT_ACTIVE` (it counts nowhere).
- **Fields of a statement:** `statementId`, `loanId`, `status` (`VALID` | `VOID`), `statementDate`, `balance`, `source`, `notes`, `voidedAt`, `voidReason`, `createdAt`, `version`, and its comparison:
  - `comparison: { actualOnDate, difference }`, where `actualOnDate` is the actual remaining debt on `statementDate` as derived now, and `difference` = `balance − actualOnDate`, signed;
  - the comparison is derived at each read, so it follows later corrections of the ledger.
- **Locks (P3-D8):** a statement write locks the Loan row `FOR UPDATE`. Past the repository the statement's trigger writes the Loan row (P3-D8's no-op), so a statement and a void of the Loan serialise.
- **In the database:** table `loan_balance_statement`:
  - a composite foreign key to `loan`;
  - `balance` `numeric`, scale ≤ 2, ≥ 0;
  - `source`, `notes` and the status fields as `loan_terms`.
  - `loan_balance_statement_append` (before insert): writes the Loan row, refuses a `VOID` Loan and a date before `debtFrom`; only inserted `VALID` with version 1.
  - `loan_balance_statement_frozen` (before update or delete): data never changes; the only step is `VALID` → `VOID` with `version` + 1; never deleted.
  - Not in the database: the comparison (a read).

### Tests (VC-3-06)

- **Domain:**
  - actual, planned and difference on days before `debtFrom`, before the first payment, on a payment date and between payments;
  - `MATURITY` (review on #69): `planned` the day before and on `maturityDate`; the difference for a bullet repayment paid on `maturityDate` (0) and for one not paid (the full balance), also per property; `PAYMENT_CAP` keeping `balanceDue`; a counter-check with the old rule (the balance due kept after `maturityDate`), which must turn these tests red;
  - a special repayment (actual below planned);
  - a missed payment (above);
  - a principal paid beyond the original (negative);
  - `NO_TERMS`;
  - the example above;
  - largest remainder, ties by `propertyReferenceId`, a negative total, the derived difference;
  - a **property test**: per-property columns sum exactly to their totals and `difference_i = actual_i − planned_i`.
- **Repository:**
  - only counted splits: an unconfirmed payment, a reversal, a corrected original and its replacement, a split of another Loan, a `LOAN_INTEREST` split;
  - booking dates up to and including `asOf`;
  - the set covering `asOf`, and before the first set;
  - the payments of a year per property with a set change within the year;
  - the latest statement;
  - Realm isolation; one snapshot.
- **Statements:**
  - create with its order of checks;
  - idempotency;
  - void as a no-op;
  - the comparison following a later correction;
  - concurrency of a statement against a void of the Loan (RC sees it; RR past the repository `40001`), with a counter-check;
  - the schema past the repository (a `VOID` Loan, before the debt, inserted as `VOID`, an edit, a delete), each with a counter-check.
- **API:** every `400`, the error mapping, `perProperty`, the Money format of signed values.

## 41.7 Closing a Loan and refinancing (VC-3-07, implemented: migration 0029)

Decision P3-D7 of `docs/development/phase-3-plan.md`. A Loan ends by `close`: repaid, taken over by another Loan, or for another reason. Refinancing with another lender (Umschuldung) is a new Loan (§41.1) plus closing the old one as `REFINANCED`. With the same lender (Anschlussfinanzierung) it is a new terms period (§41.2). There is no `refinance` command.

- **Domain owner:** Financing. **Authorization:** as §41.1.
- **Status:** `ACTIVE` → `CLOSED`, final (§41.1). A `CLOSED` Loan is never voided (`409 LOAN_CLOSED`, §41.1) and never amended (`409 LOAN_NOT_ACTIVE`).

### `POST /api/v1/loans/{loanId}/close`

- **Body** (strict):
  - `closingDate` (business date, required);
  - `reason` (`REPAID` | `REFINANCED` | `OTHER`, required);
  - `refinancedByLoanId` (UUID): required for `REFINANCED` (`400 REQUIRED`), refused otherwise (`400 NOT_ALLOWED_FOR_REASON`); the Loan itself is `400 SELF_REFERENCE`;
  - `closingNote` (trimmed, 1–500): required for `OTHER` (`400 REQUIRED`), optional otherwise.
- **Order of checks:**
  1. `400`;
  2. Loan unknown or foreign → `404` (`details.loanId`);
  3. the Loan `CLOSED` with exactly these values → `200` no-op (below); `CLOSED` with others, or `VOID` → `409 CONFLICT` with `reason = "LOAN_NOT_ACTIVE"` and `details.status`;
  4. `closingDate` before `debtFrom` → `422 CLOSING_BEFORE_DEBT` with `details.debtFrom`;
  5. `REFINANCED`: the named Loan unknown or foreign → `404` with `details.refinancedByLoanId`; not `ACTIVE` → `422 REFINANCING_LOAN_NOT_ACTIVE` with `details.status`. Requiring `ACTIVE` also rules out a cycle: a Loan that is closed cannot take over another.
  6. a split with this `loanId` that could still count, on a Transaction booked after `closingDate` → `409 CONFLICT` with `reason = "SPLITS_AFTER_CLOSING"` and `details.transactionIds` (booking-date order). Closing must not leave a counting or open split behind it (review on #71):
     - **these count:** splits of **current** Transactions (`CONFIRMED`, `RECONCILED`, not a reversal) and of **open** ones (`IMPORTED`, `UNREVIEWED`, `CLASSIFIED`, and `IGNORED`, which `restore` can bring back, §31);
     - **these do not:** a `CORRECTED` original and its reversal. They cancel out exactly (0014 mirrors `loan_id`), §41.6 never counts them, and they are frozen, so they could never be removed.
     - A payment booked on the old Loan after the date by mistake (typical at a refinancing date) is corrected first, and the close then passes.
  7. `REPAID`: the actual remaining debt on `closingDate` (§41.6, by the counted splits) is not 0 → `409 CONFLICT` with `reason = "REMAINING_DEBT_NOT_ZERO"` and `details.actual` (signed Money: positive while debt is left, negative when more was paid);
  8. `If-Match` → `412`.
- **Success:** `200` with the Loan (`status = CLOSED`, `closingDate`, `closingReason`, `refinancedByLoanId`, `closingNote`, `version` + 1).
  - AuditRecord `CLOSED` with the values and `settledAmount`: the actual remaining debt on `closingDate`, signed. It is 0 for `REPAID`. For `REFINANCED` it is the amount the other Loan took over (P3-D7).
  - A repeat with the same values is a `200` no-op without a new version or AuditRecord, answered regardless of `If-Match` (as §41.1's void).
- **Locks (P3-D8):** the Loan `FOR UPDATE`, and with `REFINANCED` both Loans in id order; then the splits and their Transactions are read. No Transaction is locked: Loan writers never do.
- **The `REPAID` check holds at closing.** The ledger stays the truth (ADR-015): a reversal or correction of a payment dated on or before `closingDate` stays allowed after closing (§41.5). The read then shows the deviation in `closing.actualOnClosingDate` (below), rather than the close being undone.

### Effects of `CLOSED`

- **Splits (§41.5, the guard of 0027):**
  - a split with the Loan's `loanId` on a Transaction booked **after** `closingDate` is refused: `409 CONFLICT` with `reason = "LOAN_CLOSED"` and `details.loanId`, `details.closingDate`. Its position in the order of checks is right after the `VOID` check of §41.5;
  - a **reversal** is exempt. It takes the original's booking date, so it is allowed whenever the original was;
  - a replacement booked after `closingDate` is refused like any new split;
  - splits on or before `closingDate` stay allowed, e.g. a payment found later.
- **A Transaction's booking date (§31.3 amend):** moving an unconfirmed Transaction's booking date after the `closingDate` of a Loan that one of its splits names is refused the same way (`409 LOAN_CLOSED`). Otherwise an amend would carry a split past the date.
- **Remaining debt (§41.6):**
  - after `closingDate` `actual` and `planned` are 0, and so is `difference`. With `NO_TERMS`, `planned` and `difference` stay `null`. `principalPaid` stays the sum of what was paid. For `REFINANCED` it is not `principalOriginal`: the rest was taken over, not paid;
  - on and before `closingDate` the values are derived as for an `ACTIVE` Loan;
  - the response gains `closing`: `{ closingDate, reason, refinancedByLoanId, actualOnClosingDate }`, or `null`. `actualOnClosingDate` is derived now, so a later correction shows here;
  - per property: the zeros are distributed as any amount (each part 0), still by the set covering `asOf`.
- **Payments (§41.6):** unchanged. No split lies after `closingDate`.
- **Schedule (§41.4):**
  - entries with `paymentDate` after `closingDate` are omitted;
  - the summary covers the entries left;
  - `endReason` is `CLOSED` when an entry was omitted. Otherwise it is unchanged: a plan that was paid off or matured on or before the closing keeps its reason.
  - `SCHEDULE_END_REASONS` becomes `PAID_OFF`, `MATURITY`, `PAYMENT_CAP`, `CLOSED`, `NO_TERMS`.
- **Payment proposal (§41.5):** from that schedule. A Transaction booked after `closingDate` → `409 CONFLICT` with `reason = "LOAN_CLOSED"` and `details.closingDate`, after the `VOID` check, since its splits would be refused.
- **Terms and allocations (§41.2, §41.3):** create and void stay refused (`409 LOAN_NOT_ACTIVE`, as today). A closed contract gets no new conditions, and its last set stays open-ended, so it covers every day after the closing.
- **Statements (§41.6):**
  - create on a `CLOSED` Loan is allowed with `statementDate` on or before `closingDate`, e.g. the lender's final statement;
  - a later date → `422 STATEMENT_AFTER_CLOSING` with `details.closingDate`, after `STATEMENT_BEFORE_DEBT`;
  - void stays allowed;
  - the comparison is unchanged: `actualOnDate` on a date on or before `closingDate`.

### In the database (migration 0029)

- **`loan` gains:**
  - `closing_date date`;
  - `closing_reason text` in (`REPAID`, `REFINANCED`, `OTHER`);
  - `refinanced_by_loan_id uuid`, with a composite foreign key `(refinanced_by_loan_id, mre_realm_id)` to `loan`;
  - `closing_note text` (1–500, trimmed).
- **CHECKs on `loan`:**
  - `(status = 'CLOSED') = (closing_date IS NOT NULL)`, and the same for `closing_reason`;
  - `(closing_reason = 'REFINANCED') = (refinanced_by_loan_id IS NOT NULL)`;
  - `closing_reason <> 'OTHER' OR closing_note IS NOT NULL`;
  - `refinanced_by_loan_id <> id`;
  - `closing_date >= coalesce(disbursement_date, start_date)`.
- **`loan_frozen`:** the closing columns are set only in the step `ACTIVE` → `CLOSED`, and fixed after it. 0024's trigger already gives this together with the CHECKs: the CHECKs allow the columns only on a `CLOSED` row, and a `CLOSED` row is final. The step's `version` + 1 rule is unchanged.
- **`loan_close_guard`** (before update, `WHEN (OLD.status <> 'CLOSED' AND NEW.status = 'CLOSED')`):
  - refuses a split of the Loan on a Transaction booked after `closing_date` whose status is not `CORRECTED` and whose `correction_role` is not `REVERSAL` (`SPLITS_AFTER_CLOSING`, the rule of check 6);
  - for `REPAID`, refuses a counted `LOAN_PRINCIPAL` sum up to `closing_date` other than `principal_original` (`REMAINING_DEBT_NOT_ZERO`);
  - for `REFINANCED`, writes the named Loan's row (P3-D8's no-op, `RETURNING status`) and refuses one not `ACTIVE`. A concurrent void of that Loan then serialises with the close. A missing or self reference is left to the CHECKs, since BEFORE triggers fire before them.
- **`transaction_split_loan` (0027):**
  - after the `VOID` refusal, refuses a `CLOSED` Loan when the Transaction's `booking_date` is after `closing_date` and its `correction_role` is not `REVERSAL` (`LOAN_CLOSED`);
  - it still writes the Loan row first, so a close and a split write serialise on it;
  - the trigger keeps its name and so its place after `transaction_split_frozen` (review on #67).
- **`ledger_transaction_loan_closing`** (before update of `booking_date` on `ledger_transaction`, when it changes):
  - writes the rows of the Loans the Transaction's splits name, in id order (P3-D8's Transaction → Loan);
  - refuses when one is `CLOSED` and the new date is after its `closing_date` (`LOAN_CLOSED`).
- **`loan_balance_statement_append` (0028):** also refuses a `statement_date` after a `CLOSED` Loan's `closing_date` (`STATEMENT_AFTER_CLOSING`).
- Not in the database: the effects on the reads (derived), and the order of checks.

### Concurrency

- **Close against a split write:** they serialise on the Loan row. The split guard writes it after the Transaction lock; close locks it `FOR UPDATE`.
  - Under READ COMMITTED whichever comes second sees the other's result:
    - a close that waited answers `SPLITS_AFTER_CLOSING` (or `REMAINING_DEBT_NOT_ZERO`);
    - a split that waited answers `LOAN_CLOSED`.
  - Under REPEATABLE READ the second fails to serialise (`40001`).
- **Close against an amend of a booking date:** the same, on the Loan row written by `ledger_transaction_loan_closing`.
- **`REFINANCED` against a void of the named Loan:**
  - the close writes that Loan's row. A void that waited sees the `CLOSED` Loan naming it under READ COMMITTED and is refused with `LOAN_REFINANCES` (below); under REPEATABLE READ a stale void fails to serialise (`40001`);
  - a void that came first leaves the named Loan `VOID`, and the close that waited answers `REFINANCING_LOAN_NOT_ACTIVE`;
  - the close repository locks both Loans in id order, so two closes naming each other cannot deadlock. Only one of them can pass, since the second finds the other `CLOSED`.

### A Loan that took over another is never voided (review on #71)

- **Why:** a `CLOSED` Loan with `REFINANCED` names its successor, and its AuditRecord's `settledAmount` is the amount that Loan took over. `CLOSED` is final. A void of the successor would leave the reference pointing at a Loan that counts nowhere, and the settled amount taken over by nobody. That could never be repaired.
- **`POST /loans/{id}/void`** (§41.1) gains a refusal after `LOAN_HAS_SPLITS`: a `CLOSED` Loan names this one as `refinancedByLoanId` → `409 CONFLICT` with `reason = "LOAN_REFINANCES"` and `details.loanIds` (in id order).
  - Before the old Loan is closed, the successor can still be voided, e.g. a wrongly entered one. A close naming it then answers `REFINANCING_LOAN_NOT_ACTIVE`.
- **In the database:** `loan_void_unreferenced` (0027) also refuses the step to `VOID` while a `CLOSED` Loan names the Loan in `refinanced_by_loan_id` (`LOAN_REFINANCES`). With the close guard's write on the named Loan's row, a void and a close naming it cannot both commit past the repository either.
- **Locks:** the void locks its Loan `FOR UPDATE` and reads the Loans naming it; no other row is locked. A close naming it writes that row too, so the two serialise as above.

### Tests (VC-3-07)

- **Domain:**
  - the order of checks;
  - `REPAID` with 0, a rest and an overpayment;
  - `REFINANCED` with `settledAmount`;
  - the no-op;
  - remaining debt on and after `closingDate`, including `NO_TERMS` and per property;
  - the schedule cut with `endReason = CLOSED`, and a plan paid off before the closing keeping `PAID_OFF`;
  - the proposal after closing;
  - a counter-check: the reads without the closing rule.
- **Repository:**
  - Realm isolation;
  - the refinancing Loan unknown, foreign, `VOID` or `CLOSED`;
  - `SPLITS_AFTER_CLOSING` for a current, an unconfirmed and an `IGNORED` split; not for a `CORRECTED` original and its reversal: the refinancing scenario (a payment booked on the old Loan after the date, corrected to the new one, then the close passes), with a counter-check (the rule counting every status);
  - the audit record with `settledAmount`;
  - after closing:
    - a split after `closingDate` refused, one on it allowed;
    - a reversal of an earlier payment allowed;
    - a replacement after it refused;
    - an amend of a booking date past it refused;
  - statements before and after `closingDate`;
  - terms and allocations refused.
- **Concurrency**, RC and RR, each with a counter-check (the guard's Loan write → `FOR SHARE` turns RR red):
  - close against a split write, both orders;
  - close against a booking-date amend;
  - `REFINANCED` against a void of the named Loan, both orders; a counter-check: `loan_close_guard` without the write on the named Loan's row turns the RR test red;
  - two booking-date amends of Transactions naming two Loans in opposite order: no deadlock (id order, as #68), with a counter-check (`ledger_transaction_loan_closing` in position order);
  - the split guard's reversal exemption removed (counter-check: a reversal after the close refused).
- **Void of a successor (`LOAN_REFINANCES`):** refused after the close and allowed before it, in the repository and past it, each with a counter-check.
- **Schema past the repository**, each with a counter-check:
  - every CHECK above;
  - the closing columns changed after closing, or set without the step;
  - `loan_close_guard`'s three refusals;
  - the split guard's closing rule with the reversal exempt;
  - the booking-date trigger;
  - the statement rule.
- **API:**
  - every `400`;
  - the error mapping;
  - `closing` in the remaining-debt read;
  - the schedule's `CLOSED`.

# 42. Create Loan

Superseded by §41.1 (`POST /api/v1/loans`).

---

# 43. Loan Terms

Superseded by §41.2.

---

# 44. Loan Allocation

Superseded by §41.3 (`POST /api/v1/loans/{id}/allocations`, a new dated set; the former `PUT` is gone, since sets are never overwritten).

---

# 45. Loan Schedule Query

Superseded by §41.4 (`GET /api/v1/loans/{id}/schedule[?from=&to=]`, derived on read; `version` is gone, since nothing is stored, P3-D5).

---

# 46. Loan Payment Reconciliation

Superseded by §41.5 (P3-D4): the split's `loanId` is the link, so there is no `reconcile-payment` command; `GET /api/v1/loans/{id}/payment-proposal?transactionId=` proposes the splits, and deviations from the plan are derived (VC-3-06).

---

# 47. Security Deposit API

Decisions P5-D1…D9 of `docs/development/phase-5-plan.md` (ADR-013, ADR-039, BR-DEP-001…008). A `SecurityDeposit` is the landlord-side record of one rental deposit (Kaution) held for one MRE Tenant. Its cash is ledger cash only, linked through splits (P5-D3, VC-5-02); its amounts and state are derived on read (P5-D2, VC-5-03). It never changes MRE (P5-D7).

### Routes (Phase 5)

```text
POST /api/v1/security-deposits                          (VC-5-01, §47.1)
GET  /api/v1/security-deposits                          (VC-5-01, §47.1; derived fields and filters VC-5-03)
GET  /api/v1/security-deposits/{id}                     (VC-5-01, §47.1; ?checkMre=true VC-5-04)
POST /api/v1/security-deposits/{id}/amend               (VC-5-01, §47.1)
POST /api/v1/security-deposits/{id}/void                (VC-5-01, §47.1; DEPOSIT_HAS_SPLITS VC-5-02, §47.2)
PUT  /api/v1/transactions/{id}/splits                   (securityDepositId: VC-5-02, §47.2; also correct and reverse)
POST /api/v1/security-deposits/{id}/close               (VC-5-04)
POST /api/v1/security-deposits/{id}/reopen              (VC-5-04)
```

Superseded by the plan: `GET /rental-contract-references/{id}/security-deposit` (no `RentalContractReference`, P5-D1; `GET /security-deposits?mreTenantId=` instead), `link-transaction` and `return` (the split is the link, P5-D3), and `reconcile-with-mre` (a comparison read, P5-D7). The plan's `PATCH` is this API's amend command (as §41.1).

## 47.1 Create, read, list, amend, void (VC-5-01, implemented: migration 0037)

- **Domain owner:** Security Deposit. **Authorization:** as §19.1. The deposit, its holding account and its MRE Tenant belong to the caller's Realm. Unknown, foreign or malformed ids are answered as §30.1 (`404` / `400`).
- **Status (P5-D2):** `ACTIVE` → `VOID` (here; final). `ACTIVE` ⇄ `CLOSED` comes with VC-5-04.
- **Fixed after creation:** Realm, `mreTenantId`. A deposit recorded for the wrong Tenant is voided and recorded again.
- **Response:**
  - `securityDepositId`, `mreRealmId`, `status`;
  - `mreTenantId`;
  - `expectedAmount` (Money as §31), `expectedAmountSource`: `REQUEST` or `MRE_GUARANTY` (where the value came from on create; an amend sets `REQUEST`);
  - `holdingFinancialAccountId` (or `null`), `interestBearing`, `notes`;
  - `voidedAt`, `voidReason` (`null` unless `VOID`);
  - `createdAt`, `version`.
  - The derived amounts, `state` and `flags` (P5-D2) come with VC-5-03; VC-5-01 answers without them.
  - Single-deposit responses carry `ETag: "<version>"` (§16.1).

### `POST /api/v1/security-deposits`

- **Body** (strict; unknown keys `400`):
  - `mreTenantId` (required): an MRE id, `^[0-9a-f]{24}$` as §20.1;
  - `expectedAmount` (Money as §31, optional): **> 0** (`400 NOT_POSITIVE` for zero; a negative amount is §31's `NEGATIVE_AMOUNT`), EUR. Without it, the default from MRE below;
  - `holdingFinancialAccountId` (UUID, optional);
  - `interestBearing` (boolean, optional, default `true`, P5-D5);
  - `notes` (optional, trimmed, ≤ 2000).
  - Data-model §26's `tenantPartyIds`, `payerPartyId`, `sourceIban`, `destinationIban`, `documentIds`, `receivedAmount`, `returnedAmount` and `outstandingAmount` are unknown keys: dropped or derived (P5-D1, P5-D2).
- **Order of checks:**
  1. `400`;
  2. the holding account: unknown or foreign → `404` (`details.financialAccountId`); not `accountType = SECURITY_DEPOSIT` → `422 NOT_A_SECURITY_DEPOSIT_ACCOUNT` with `details.accountType` (P5-D4). A `CLOSED` account is allowed: it may still hold the cash it held;
  3. a deposit of the Tenant that is not `VOID` exists → `409 CONFLICT` with `reason = "DEPOSIT_EXISTS"` and `details.securityDepositId` (P5-D1);
  4. **the MRE Tenant**, read live with the caller's token, outside any database transaction (P5-D9):
     - read through `GET /tenants` (the Realm's list, as the Party external references do, §20.1), and the Tenant picked by `_id`. **Not** through `GET /tenants/:id`: at the baseline `479d0ad` that route answers `500` for an unknown or malformed id (`toOccupantData(null)` throws, `ObjectId(...)` throws), so a missing Tenant would read as an MRE outage;
     - the Tenant not in the list → `404 NOT_FOUND` with `details.externalId` (`MreTenantNotFoundError`, #100, P5-D1);
     - MRE refuses the token → `401`, refuses the caller → `403`, as every MRE call;
     - MRE unavailable, or an unexpected answer → `503 EXTERNAL_SYSTEM_ERROR`. Nothing is written;
  5. without `expectedAmount`: MRE's `guaranty`, rounded half-up to the cent once at the client (P5-D9), when it is > 0. MRE's default `0`, or a missing value, is `422 EXPECTED_AMOUNT_REQUIRED` (P5-D1).
- **Where the MRE read sits:** checks 2 and 3 are read first in one snapshot, so a request DE refuses anyway never calls MRE. The write transaction repeats them under its locks.
- **Success:** `201` with the deposit (`status = ACTIVE`, `version = 1`); AuditRecord `CREATED` with the Tenant id, `expectedAmount`, `expectedAmountSource`, the holding account and `interestBearing`. Only the Tenant's id and the amount are kept: the client parses the list to `_id`, `guaranty` and `guarantyPayback` and drops the rest; nothing of the Tenant's name or contacts is stored or logged (mre-integration §20.1).
- **Idempotency (§15):** `Idempotency-Key` with scope `security-deposit.create`, fingerprint of the normalized body. A replay answers `201` with the recorded body and `Idempotent-Replayed: true`, without an MRE call; the same key with another payload is `409`.

### `POST /api/v1/security-deposits/{securityDepositId}/amend`

- **Body:** the fields to change, at least one; `null` clears an optional field. Amendable: `expectedAmount` (> 0, not `null`), `holdingFinancialAccountId`, `interestBearing`, `notes`. `mreTenantId` is `400` with code `NOT_AMENDABLE`.
- **Order of checks:**
  1. `400`;
  2. unknown or foreign → `404`;
  3. not `ACTIVE` → `409 CONFLICT` with `reason = "DEPOSIT_NOT_ACTIVE"` and `details.status` (P5-D2: amend while `ACTIVE`; VC-5-04 lets a `CLOSED` deposit amend its `notes` only);
  4. a newly named holding account: as on create (`404`, `422 NOT_A_SECURITY_DEPOSIT_ACCOUNT`);
  5. values equal to the current ones → `200` no-op without a new version or AuditRecord, answered regardless of `If-Match`;
  6. `If-Match` → `412`.
- **Success:** `200` with the deposit (`version` + 1); AuditRecord `AMENDED` with each changed field's old and new value. Amend never calls MRE.

### `POST /api/v1/security-deposits/{securityDepositId}/void`

- **Body:** `{ "reason": "..." }` (required, trimmed, 1–500).
- **Success:** `200` with the deposit (`status = VOID`, `voidedAt`, `voidReason`, `version` + 1); AuditRecord `VOIDED` with the reason. A `VOID` deposit no longer blocks a new one for the Tenant.
- Voiding a `VOID` deposit is a `200` no-op keeping the first reason and time, answered regardless of `If-Match`.
- A `CLOSED` one (VC-5-04) is `409 CONFLICT` with `reason = "DEPOSIT_CLOSED"`.
- While a split references the deposit (from VC-5-02; before it, none can), void is `409 CONFLICT` with `reason = "DEPOSIT_HAS_SPLITS"` and `details.transactionIds`, a reversal's splits included (as `LOAN_HAS_SPLITS`, §41.1).
- `If-Match` as §16.1.

### Reads

- `GET /security-deposits/{securityDepositId}`: one deposit with `ETag`.
- `GET /security-deposits`: `{ items, page, pageSize, total }` (§11), newest `createdAt` first, then `securityDepositId`; count and page in one snapshot.
  - Filters, optional and combined with AND: `status` (a comma-separated list), `mreTenantId`, `holdingFinancialAccountId`. `state` comes with VC-5-03.
  - `page` from 1, `pageSize` 1–200 (default 50); unknown parameters are `400`. An unknown or foreign filter id is an empty page, not `404` (§30.1).
- Reads never call MRE (the comparison is VC-5-04's `?checkMre=true`).

### In the database (VC-5-01)

- **`security_deposit`:**
  - `id uuid`, `mre_realm_id text`, `status text` in (`ACTIVE`, `CLOSED`, `VOID`); `CLOSED` is reached only from VC-5-04;
  - `mre_tenant_id text` (`^[0-9a-f]{24}$`);
  - `expected_amount numeric` (scale ≤ 2, > 0, < 1e18) and `currency text = 'EUR'`; `expected_amount_source text` in (`REQUEST`, `MRE_GUARANTY`);
  - `holding_financial_account_id uuid` with a composite foreign key `(holding_financial_account_id, mre_realm_id)` to `financial_account`;
  - `interest_bearing boolean NOT NULL`, `notes text` (≤ 2000);
  - `voided_at`, `voided_by`, `void_reason` (1–500): set exactly with `VOID` (CHECK);
  - `created_at`, `created_by`, `version`.
- **Partial unique index** `(mre_realm_id, mre_tenant_id) WHERE status <> 'VOID'`. Two concurrent creates for one Tenant cannot both commit; the repository answers the loser `DEPOSIT_EXISTS` (`ON CONFLICT … DO NOTHING` and a re-read).
- **`security_deposit_holding_account`** (before insert, and before update of `holding_financial_account_id` to another non-null value): the account's `account_type` is `SECURITY_DEPOSIT`, read `FOR SHARE`. No route changes an account's type (§16), but nothing in the database forbids it yet; so the migration adds `financial_account_type_held` (before update of `account_type` on `financial_account`), which refuses a change while a deposit that is not `VOID` names the account. The check at write time then stays true.
- **`security_deposit_frozen`** (before update): Realm, `mre_tenant_id`, `currency`, `created_at` and `created_by` are fixed; the amendable fields change only while `ACTIVE`, each change with `version` + 1; the status steps are `ACTIVE` → `VOID` here (VC-5-04 adds close and reopen), with `version` + 1; `VOID` is final; P3-D8's no-op `UPDATE … SET version = version` passes. Only inserted `ACTIVE` with `version = 1`; never deleted.
- Not in the database: the MRE check and default (P5-D1), the order of checks, the reads.

### Concurrency (RC and RR, each with a counter-check)

- **Two creates for one Tenant:** the partial unique index; the loser answers `DEPOSIT_EXISTS`. Counter-check: the index dropped lets both commit.
- **Void against amend:** they serialise on the deposit row (`FOR UPDATE`); the one that waited sees `VOID` (`DEPOSIT_NOT_ACTIVE`) or a new version (`412`) under RC, or fails to serialise (`40001`) under RR.
- **Void and a new create for the Tenant:** a create that waited on the index sees the void committed and succeeds; without the void it answers `DEPOSIT_EXISTS`.

### Tests (VC-5-01)

- **Domain:** the body rules; the default from `guaranty` (a float such as `2999.995` rounded half-up once, `0` and a missing value refused); the amend no-op; the void no-op.
- **Repository:** Realm isolation (a foreign holding account is `404`); `NOT_A_SECURITY_DEPOSIT_ACCOUNT`; `DEPOSIT_EXISTS` and a new deposit after a void; amend with `412`; the AuditRecords `CREATED`, `AMENDED`, `VOIDED`.
- **Schema past the repository**, each with a counter-check: every CHECK; the frozen fields and status steps; `DELETE`; the holding-account guard; the unique index.
- **Concurrency** as above, under RC and RR.
- **MRE client:** the Tenant read from the list, parsed to `_id`, `guaranty` and `guarantyPayback` (each a number or `null`; `guaranty` `0` → `null`, a missing `guarantyPayback` → `null`, P5-D7). The fake MRE's Tenants gain the two fields. `mre.contract.test.ts` pins against the baseline: a Tenant with a `guaranty`, one with MRE's default `0`, and `guarantyPayback` missing until set.
- **API:** every `400` code above; the error mapping (`404 NOT_FOUND` for an unknown Tenant, `422 EXPECTED_AMOUNT_REQUIRED`, `503 EXTERNAL_SYSTEM_ERROR`, nothing written on any of them, end to end against the fake MRE); a refusal and an idempotent replay without an MRE call; amend and void no-ops, `412`; the list filters and order; Realm isolation end to end.

## 47.2 `securityDepositId` on splits (VC-5-02, implemented: migration 0038)

Decisions P5-D3, P5-D5 and P5-D6. The split is the deposit's link to cash, as `loanId` is a Loan's (§41.5). There is no `link-transaction` or `return` command. A receipt, a repayment and an interest credit are each a `TransactionSplit` that carries the deposit's `securityDepositId`. What they add up to is derived on read (P5-D2, VC-5-03).

### `securityDepositId` on a split

`PUT /api/v1/transactions/{id}/splits` (§33.2) accepts `securityDepositId` on a split, lifting its `NOT_SUPPORTED`. `correct` accepts it in `replacement.splits` (§35.2), and a reversal mirrors it (below). Every split in a response carries `securityDepositId` (`null` without one), as do the Transaction reads (§30).

- **Rules for a split with `securityDepositId`:**
  - **The deposit:** of the caller's Realm, else `404 NOT_FOUND` with `details.securityDepositId`, for the first such split in position order. It must not be `VOID`, else `409 CONFLICT` with `reason = "DEPOSIT_NOT_ACTIVE"` and `details.securityDepositId` and `details.status`. This is §47.1's code, as `LOAN_NOT_ACTIVE` serves both a Loan's amend and its splits (§41.1, §41.5): one family of deposit codes (`DEPOSIT_NOT_ACTIVE`, `DEPOSIT_CLOSED`) for amend, void and split (review on #132). VC-5-04 adds `409 DEPOSIT_CLOSED` for a `CLOSED` deposit right after this check (P5-D8); until then no deposit can be `CLOSED` (0037).
  - **The category and the direction** (P5-D3, P5-D5):
    - `SECURITY_DEPOSIT` on an `INFLOW` is a **receipt**;
    - `SECURITY_DEPOSIT` on an `OUTFLOW` is a **repayment**;
    - `SECURITY_DEPOSIT_INTEREST` (new, below) is only allowed on an `INFLOW`; it is an **interest credit**.
    - Any other category is `422 INVALID_SECURITY_DEPOSIT_SPLIT` with `details.position` and `details.reason = "CATEGORY"`. `SECURITY_DEPOSIT_INTEREST` on an `OUTFLOW` is the same with `details.reason = "DIRECTION"`.
    - A **reversal** is exempt from the direction rule, as in §41.5: it has the opposite direction, mirrors its original's splits (§35.3, 0014) and never counts.
  - **Not with a PropertyReference or a Loan:** a deposit is not a property's income or cost (BR-DEP-001), so it is never attributed to one; and a split names at most one thing its cash belongs to. A split with `securityDepositId` and `propertyReferenceId` or `loanId` is `400`, code `NOT_ALLOWED_WITH_SECURITY_DEPOSIT` at `splits.<i>.propertyReferenceId` or `splits.<i>.loanId`.
  - A `SECURITY_DEPOSIT` or `SECURITY_DEPOSIT_INTEREST` split **without** `securityDepositId` stays allowed. It counts for no deposit, and it is still not rent (P5-D6).
  - **Several deposits in one Transaction** are allowed, e.g. a pooled account's interest credit split across its deposits by the user (P5-D5), or one transfer for two leases.
  - **A mixed transfer** (BR-DEP-006), such as the first month's rent plus the deposit, is two or more splits: `RENT_BASE` (and the advance) for the rent, `SECURITY_DEPOSIT` with `securityDepositId` for the deposit. Rent reconciliation sees only the rent splits (P4-D3).
- **Order of checks** (§33.2's and §41.5's, extended):
  1. `400`, `NOT_ALLOWED_WITH_SECURITY_DEPOSIT` among them;
  2. Transaction `404`; `409 TRANSACTION_FROZEN`; `409 SPLIT_SUM_MISMATCH`; `412`; `UNKNOWN_CATEGORY`; PropertyReference `404`, all unchanged;
  3. the Loan checks of §41.5 and §41.7, unchanged;
  4. deposit `404` → `422 INVALID_SECURITY_DEPOSIT_SPLIT` (`CATEGORY`, then `DIRECTION`) → `409 DEPOSIT_NOT_ACTIVE`, each for the first split in position order.
- **Same set again** (§33.2's no-op): `securityDepositId` is part of the comparison. Changing only a split's `securityDepositId` is a change: it gets a new version and the AuditRecord `SPLITS_REPLACED`, and it is refused once the Transaction is frozen.
- **Confirm (§34):** unchanged. A confirmed Transaction's splits, `securityDepositId` included, are frozen (0009). A forgotten or wrong link is fixed by `correct`, whose replacement carries the right splits.

### The category `SECURITY_DEPOSIT_INTEREST`

- Seeded by the migration: code `SECURITY_DEPOSIT_INTEREST`, name `Kautionszinsen`, `category_type = SECURITY_DEPOSIT`, active. It is listed by §36's reads like any other.
- Its type is never `INCOME`, as `SECURITY_DEPOSIT`'s is not (0008, P5-D6): the interest belongs to the tenant and is repaid with the deposit. Its tax meaning is Phase 7's (`VERIFY`, verification-checklist).

### Corrections of deposit cash

- **Reversal** (`correct` and `reverse`, §35.3, §35.9): its splits mirror the original's `securityDepositId` together with category, PropertyReference, `loanId` and amount. 0014's comparison gains `security_deposit_id`, so a reversal cannot drop or change it, and each deposit's history stays complete.
- **Replacement:** its splits follow the rules above, whether copied from the original (§35.2) or given in the request. A copied split whose deposit has become `VOID` is refused like any other (`409 DEPOSIT_NOT_ACTIVE`); the client then sends the replacement's splits. (A deposit with splits cannot be voided, below, so a copied split never meets a `VOID` deposit; the refusal is defence in depth.)

### What counts

A deposit's cash is the splits with its `securityDepositId` on **current** Transactions: `CONFIRMED` or `RECONCILED`, and not a reversal (§35.3), by booking date. A correction replaces them through the replacement's splits. Unconfirmed Transactions do not count. VC-5-03's derived amounts (`received`, `interestCredited`, `returned`, `held`) are built on exactly this rule, per category and direction as above.

### Void (§47.1, now with splits)

- `POST /security-deposits/{id}/void` on a deposit that any split references, a reversal's included and whatever its Transaction's status, is `409 CONFLICT` with `reason = "DEPOSIT_HAS_SPLITS"` and `details.transactionIds` (unique, sorted). This is §47.1's refusal, which VC-5-01 could not reach yet. Its place in §47.1's order is unchanged: after the no-op and `DEPOSIT_CLOSED`, before `412`.
- The splits are read after the deposit's lock, so a void and a split write serialise on the deposit row (below).

### Concurrency and locks (P5-D9)

- **Lock order Transaction → SecurityDeposit**, as Transaction → Loan in §41.5. `securityDepositId` is written through the ledger's own path (`PUT …/splits`, `correct`, `reverse`), which locks the Transaction first (§34.2, §35.5). After that lock, the repository locks the split set's Loans in id order (§41.5) and then its deposits `FOR UPDATE` in id order, and checks them. `correct` and `reverse` lock every deposit they write in one id-ordered step: the original's, which the reversal mirrors, and the replacement's. Past the repository the split guard **writes** the deposit row (P3-D8's no-op), so a stale `void` under REPEATABLE READ fails to serialise (`40001`) instead of passing a share lock.
- **Deposit writers never lock a Transaction or a Loan:** amend and void (and VC-5-04's close and reopen) lock only the deposit row and read splits. Loan writers never lock a deposit. No cycle can arise.
- **Void against a split write:** they serialise on the deposit row. Whichever comes second sees the other's result under READ COMMITTED (the void is refused with `DEPOSIT_HAS_SPLITS`, or the split with `DEPOSIT_NOT_ACTIVE`), or fails to serialise under REPEATABLE READ.
- **The import path writes no splits** (§32), so it never reaches a deposit row.

### In the database (VC-5-02)

- **`transaction_split.security_deposit_id`:**
  - `uuid`, with a composite foreign key `(security_deposit_id, mre_realm_id)` to `security_deposit (id, mre_realm_id)` (0037's `security_deposit_realm_key`), so a split never names another Realm's deposit;
  - an index on `security_deposit_id`;
  - `CHECK (security_deposit_id IS NULL OR (property_reference_id IS NULL AND loan_id IS NULL))`.
- **The seed** of `SECURITY_DEPOSIT_INTEREST` (above); `down` removes it only while no split uses it.
- **`transaction_split_security_deposit` trigger** (before insert or update, only for a split with `security_deposit_id`):
  - it writes the deposit row with P3-D8's no-op, `RETURNING status`, and refuses a `VOID` deposit (0037's frozen trigger lets the no-op pass, also on a `VOID` row);
  - it refuses a category other than `SECURITY_DEPOSIT` and `SECURITY_DEPOSIT_INTEREST`;
  - it refuses `SECURITY_DEPOSIT_INTEREST` on a Transaction that is not `INFLOW`, unless the Transaction's `correction_role` is `REVERSAL`.
  - **Trigger order (review on #67):** BEFORE triggers fire in name order, so it fires after `transaction_split_frozen` and after `transaction_split_loan`. Past the repository the Transaction row is written first, then the Loan rows, then the deposit rows, and raw writers keep P5-D9's order. A test checks the order in `pg_trigger`.
- **`security_deposit_void_unreferenced`** (before update of `security_deposit`, `WHEN (OLD.status <> 'VOID' AND NEW.status = 'VOID')`): a step to `VOID` is refused while a split references the deposit, a reversal's included.
- **0014's mirror** compares `(category, PropertyReference, loan_id, security_deposit_id, amount, currency)`.
- Not in the database: the order of checks (the API) and what counts (a read, VC-5-03).

### Tests (VC-5-02)

- **API:**
  - every `400` (`NOT_ALLOWED_WITH_SECURITY_DEPOSIT` with a PropertyReference and with a Loan, a malformed `securityDepositId`);
  - the error mapping (`404` deposit, `INVALID_SECURITY_DEPOSIT_SPLIT` with both reasons, `DEPOSIT_NOT_ACTIVE`, `DEPOSIT_HAS_SPLITS` on void);
  - `securityDepositId` in the split responses and in `GET /transactions/{id}`.
- **Repository:**
  - the order of checks, including a set with a Loan split and a deposit split;
  - a receipt, a repayment and an interest credit; interest on an `OUTFLOW` refused;
  - several deposits in one set; a mixed rent-and-deposit transfer;
  - the same set again as a no-op, and a changed `securityDepositId` as a change;
  - Realm isolation;
  - void refused with splits, and allowed once none references the deposit.
- **Corrections:**
  - `correct` of a receipt: the copied splits, the replacement's own splits with another deposit or without one, interest on a replacement that is not `INFLOW`;
  - `reverse` of a receipt and of a repayment (the reversal's opposite direction is allowed);
  - which splits count before and after each, by the rule above.
- **Concurrency**, RC and RR, each with a counter-check:
  - a split write against a void of the deposit, both orders: RC sees the other's result; RR past the repository `40001`;
  - two split writes with two deposits in opposite position order: no deadlock, because of the id order;
  - a split set with a Loan and a deposit against a void of each.
- **Schema past the repository**, each with a counter-check:
  - a split with `security_deposit_id` of another Realm;
  - one on a `VOID` deposit;
  - one with another category, and `SECURITY_DEPOSIT_INTEREST` on an `OUTFLOW` that is not a reversal;
  - an `OUTFLOW` reversal mirroring an interest credit, which is allowed;
  - `security_deposit_id` with `property_reference_id`, and with `loan_id`;
  - a reversal whose splits drop or change `security_deposit_id`;
  - a `VOID` step of a deposit with splits;
  - the trigger order in `pg_trigger`.
- **Rent separation (P5-D6), carried into ACC5 (VC-5-05):** a deposit split is not rent cash; a deposit-only Transaction is `422 NO_RENT_CASH` on a manual match; the mixed transfer's suggestion covers only its rent splits.

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
