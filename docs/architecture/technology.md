# Technology

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Living Document  
**Document Type:** Technology Strategy and Technical Constraints

---

# 1. Purpose

This document defines the technology strategy for Vermieter Cockpit DE.

It translates the accepted architecture into implementation guidance.

> **Status note:** The technology decisions this document originally listed as open have since been accepted. They are recorded canonically in `docs/architecture/architecture-decisions.md` (ADR-026, ADR-031 through ADR-036) with detailed rationale in `docs/architecture/technology-adrs.md` (TECH-ADR-001 through TECH-ADR-007). Where this document still described a choice as open, it now points to the accepted decision. If any wording here appears to reopen a decision, the accepted ADR wins.

The document answers:

> Which technical choices are already constrained by the architecture, which choices are recommended for the initial implementation, and which choices still require an ADR?

This document is intentionally conservative.

The project values:

1. maintainability
2. consistency
3. compatibility with upstream MicroRealEstate (MRE)
4. self-hostability
5. data ownership and exportability
6. understandable architecture
7. operational simplicity

over novelty or unnecessary infrastructure.

---

# 2. Governing Documents

Technology choices must comply with:

- `docs/constitution.md`
- `docs/architecture/architecture-decisions.md`
- `docs/architecture/technology-adrs.md`
- `docs/architecture/architecture-overview.md`
- `docs/architecture/mre-integration.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/data-model.md`
- `docs/architecture/api-design.md`
- `docs/architecture/data-flow.md`
- `docs/product/business-rules.md`
- `AGENTS.md`

Technology must serve the domain model.

The domain model must not be distorted merely to fit a preferred framework or database.

---

# 3. Existing Architectural Constraints

The following decisions are already established and are therefore technology constraints.

## 3.1 MicroRealEstate Is the Operational Core

MRE remains responsible for operational rental management.

The DE Investment Layer extends MRE rather than replacing it.

Therefore:

- existing MRE APIs should be preferred over direct database access
- MRE-specific semantics remain behind an anti-corruption layer
- upstream MRE should be modified only where extension is impractical
- DE domains must not depend directly on MRE persistence internals

---

## 3.2 Self-Hosting Is Mandatory

The complete platform must remain deployable in a self-hosted environment.

Containerized deployment is preferred.

Core functionality must not require proprietary hosted infrastructure.

Optional cloud integrations may exist, but the application must retain a viable self-hosted core.

---

## 3.3 Domain Boundaries Are Mandatory; Microservices Are Not

Clear module/domain boundaries are required.

Separate operating processes are optional.

For the initial DE Investment Layer, the preferred direction is:

> **modular monolith first**

unless a concrete operational or security requirement justifies a separate process.

---

## 3.4 HTTP/JSON Is the Initial API Style

The business API specification currently assumes:

```text
/api/v1
```

with REST-like resources plus explicit business commands.

Examples:

```text
POST /api/v1/transactions/{id}/confirm
POST /api/v1/rent-reconciliations/{id}/confirm
POST /api/v1/loans/{id}/recalculate-schedule
```

The architectural commitment is Node.js + TypeScript over HTTP/JSON (ADR-032 / TECH-ADR-003); the exact web/controller framework is an implementation-level choice and does not require its own ADR unless it materially changes the architecture.

---

# 4. Recommended Initial Runtime Architecture

The recommended initial topology is:

```text
┌─────────────────────────────────────────────┐
│                  Browser                    │
│                                             │
│   MRE UI             Vermieter Cockpit UI   │
└────────┬───────────────────────┬────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────────┐
│ Existing MRE    │     │ DE Investment Layer │
│ APIs / Services │◄────│ Modular Backend     │
└────────┬────────┘     └──────────┬──────────┘
         │                         │
         ▼                         ▼
┌─────────────────┐     ┌─────────────────────┐
│ Existing MRE    │     │ DE Persistence      │
│ Persistence     │     │                     │
└─────────────────┘     └─────────────────────┘
```

The DE backend owns:

- DE business modules
- DE persistence
- MRE adapter
- bank import
- reconciliation
- tax/depreciation logic
- investment calculations
- reporting APIs

The DE backend should not become a proxy for every MRE operation.

---

# 5. Application Structure

## 5.1 Preferred Structure: Modular Monolith

The initial implementation should favor one deployable DE backend with strong internal module boundaries.

Conceptually:

```text
de-backend/
├── application/
├── domains/
│   ├── party/
│   ├── ownership/
│   ├── acquisition/
│   ├── ledger/
│   ├── financing/
│   ├── security-deposit/
│   ├── weg/
│   ├── taxation/
│   ├── depreciation/
│   ├── investment/
│   └── documents/
├── integrations/
│   ├── mre/
│   ├── bank-import/
│   └── document-import/
├── reporting/
├── shared/
└── api/
```

This is conceptual, not a mandatory folder layout.

## 5.2 Dependency Direction

Preferred dependency direction:

```text
API / UI
   ↓
Application / Workflow
   ↓
Domain
   ↓
Ports / Interfaces
   ↓
Infrastructure Adapters
```

Domain logic should not depend directly on:

- HTTP
- database drivers
- MRE client implementation
- UI framework
- CSV parser
- PDF library

---

# 6. Language and Runtime Strategy

## 6.1 Compatibility Before Language Preference

The implementation language should be chosen after checking the actual MRE repository conventions and extension points.

The project should avoid introducing a second language ecosystem without a clear benefit.

## 6.2 Recommended Bias

Because the DE layer integrates deeply with an existing web application and should remain maintainable alongside MRE, the preferred implementation direction is to stay close to MRE's existing JavaScript/TypeScript ecosystem where practical.

However, the exact choice of:

- JavaScript vs TypeScript
- Node.js runtime version
- package manager
- build system

must be verified against the current upstream repository before implementation and recorded in an ADR.

## 6.3 Type Safety

For newly written DE domain code, strong static typing is preferred.

Business concepts such as:

- Money
- percentages
- ownership shares
- dates
- external references
- status enums
- IDs

should not be represented as unstructured primitive values throughout the codebase.

---

# 7. Frontend Strategy

The DE frontend should integrate visually and operationally with MRE without forcing DE business logic into MRE UI components.

Preferred separation:

```text
UI components
    ↓
typed API client
    ↓
DE Business API
```

The frontend must not become the authoritative location for:

- investment formulas
- depreciation logic
- tax classification rules
- reconciliation invariants
- ownership allocation

These belong to backend/domain logic.

## 7.1 UI Framework

The initial DE frontend should normally follow the current MRE frontend ecosystem to reduce:

- duplicated dependencies
- inconsistent UI behavior
- developer context switching
- upgrade friction

The exact framework/version must be verified against upstream MRE before implementation.

---

# 8. Persistence Strategy

## 8.1 Status

**Decided.** ADR-031 (mirrored by TECH-ADR-001) resolved the former ADR-OPEN-001.

The DE Investment Layer uses **PostgreSQL** as its own separate canonical datastore. MRE retains its existing MongoDB persistence. The two integrate through supported APIs and explicit references, never through shared collections.

The criteria below record *why* PostgreSQL was selected; they are no longer an open comparison.

## 8.2 Selection Criteria

PostgreSQL was chosen after comparing candidates against:

1. transactional integrity
2. domain consistency
3. query patterns
4. financial precision
5. temporal data
6. migrations
7. backup/restore
8. self-hosting
9. operational burden
10. MRE compatibility
11. testability
12. long-term maintainability

## 8.3 Persistence Boundary

Regardless of database:

```text
Domain
   ↓
Repository Port
   ↓
Persistence Adapter
   ↓
Database
```

Domain services should not expose database-native objects.

## 8.4 No Direct MRE Database Coupling

The DE layer should not directly mutate MRE MongoDB collections where a supported MRE API/domain operation exists.

Direct reads should also be avoided where API access is sufficient.

---

# 9. Money and Numeric Precision

Financial correctness is a hard technical requirement.

## 9.1 Never Use Binary Floating Point for Money

Do not use ordinary IEEE floating-point arithmetic for canonical monetary calculations.

**Decided (ADR-033 / TECH-ADR-004):** the canonical representation is a dedicated **Money value object backed by exact decimal arithmetic**, persisted as PostgreSQL `NUMERIC` and serialized over the API as a decimal string plus currency (e.g. `{ "amount": "1250.00", "currency": "EUR" }`).

The concrete decimal library is an implementation-level choice that may be made during scaffolding, provided it preserves exact decimal semantics.

## 9.2 Required Properties

The chosen representation must support:

- exact cent-level monetary arithmetic
- deterministic rounding
- percentage calculations
- interest calculations
- allocation reconciliation
- serialization without precision loss
- persistence without precision loss

## 9.3 Rounding

Rounding rules must be explicit at business boundaries.

Never rely on implicit runtime rounding for:

- ownership allocation
- Loan allocation
- interest/principal decomposition
- tax amounts
- depreciation
- investment metrics

---

# 10. Date and Time Strategy

The model contains both business dates and technical timestamps.

They must remain distinct.

## 10.1 Business Dates

Examples:

- acquisition date
- economic transfer date
- ownership effective date
- booking date
- value date
- valuation date
- tax year
- Loan term dates

Use date-only semantics where time-of-day has no business meaning.

## 10.2 Technical Timestamps

Examples:

- `createdAt`
- `updatedAt`
- import timestamp
- synchronization timestamp
- audit timestamp

Use explicit timezone-aware timestamps.

## 10.3 Timezone

Technical timestamps should have unambiguous UTC/offset semantics.

User-facing presentation may use local timezone.

Do not infer tax/business dates from technical timestamps.

---

# 11. IDs and External References

Internal DE identifiers should be stable and opaque.

External MRE identity must remain explicit.

Example:

```text
PropertyReference
├── id                  // DE canonical ID
├── mreRealmId          // external scope
└── mrePropertyId       // external entity ID
```

Do not encode business meaning into IDs unnecessarily.

Do not reuse raw MRE IDs as universal DE primary keys.

---

# 12. MRE Integration Technology

The MRE integration layer is an anti-corruption layer.

## 12.1 Preferred Access

Use supported MRE APIs wherever practical.

Relevant inspected MRE API areas include:

```text
/api/v2/properties
/api/v2/tenants
/api/v2/leases
/api/v2/rents
```

Exact endpoint compatibility must be verified against the target MRE version.

## 12.2 MRE Client

Create a dedicated authenticated MRE API client behind an interface.

Conceptually:

```text
MreClient
├── properties
├── tenants
├── leaseDefinitions
├── rents
└── paymentWriteBack
```

DE domain code must not construct MRE HTTP calls directly.

## 12.3 Translation

Raw MRE DTO:

```text
        ↓
MRE Adapter
        ↓
DE integration model
        ↓
DE domain
```

Do not expose MRE persistence schemas through the DE public API.

## 12.4 Compatibility Tests

MRE integration requires contract/integration tests for the upstream version supported by the project.

---

# 13. Bank Import Technology

Initial bias:

> file-based import first; provider APIs later.

A CSV/file adapter is operationally simple and provider-independent.

Architecture:

```text
Input File
   ↓
Parser
   ↓
Normalized Bank Record
   ↓
Fingerprint / Duplicate Detection
   ↓
ImportBatch
   ↓
Transaction
```

The Ledger must not depend on one bank's CSV structure.

Each source format belongs in an adapter.

Future Open Banking/API integrations should produce the same normalized import contract.

---

# 14. Document Handling

Documents are supporting evidence and provenance.

Separate:

```text
binary storage
metadata
domain references
extracted/suggested information
```

**Decided (ADR-035 / TECH-ADR-006):** document binaries go through a `DocumentStorage` port whose default implementation is local filesystem storage on a persistent mounted volume; an S3-compatible adapter may be added later without touching the domain model. Canonical document metadata lives in PostgreSQL. Only the concrete storage-folder layout remains an implementation detail.

Core requirements:

- self-hostable
- backupable
- stable references
- content type
- filename
- checksum where useful
- source/provenance
- access control

Do not store large document binaries directly inside domain aggregates merely for convenience.

AI/OCR extraction, if added later, creates suggestions rather than authoritative domain facts.

---

# 15. API Implementation

## 15.1 Public API

Initial public contract:

```text
HTTP + JSON
/api/v1
```

## 15.2 Business Commands

Use explicit endpoints for meaningful transitions.

Prefer:

```text
POST /transactions/{id}/confirm
POST /rent-reconciliations/{id}/confirm
```

over generic state mutation.

## 15.3 Validation

Validation exists at several layers:

```text
Transport validation
        ↓
Application validation
        ↓
Domain invariant validation
```

Transport schemas must not replace domain validation.

## 15.4 Error Model

The API should return machine-readable errors containing at least:

- stable error code
- human-readable message
- relevant field/reference where appropriate
- validation details where appropriate

Do not expose internal stack traces to clients.

---

# 16. API Schema and Documentation

The implementation should generate or maintain an OpenAPI specification once concrete endpoints are implemented.

Goals:

- API discoverability
- generated/typed clients where useful
- contract testing
- consistent error models
- easier Codex/Claude-assisted implementation

The architecture documentation remains the business authority.

Generated OpenAPI must not become the only explanation of domain semantics.

---

# 17. Idempotency

Idempotency is required at retry-prone boundaries.

## 17.1 Bank Import

Use:

- external IDs where available
- normalized fingerprints
- ImportBatch provenance

## 17.2 Business Commands

Commands with duplicate side-effect risk should support idempotency keys where specified by API Design.

## 17.3 MRE Write-Back

Payment write-back must be retry-safe.

## 17.4 Storage

Idempotency must be backed by persistence constraints where practical, not only in-memory checks.

---

# 18. Concurrency

Use optimistic concurrency for material editable state where concurrent updates could destroy business meaning.

Possible mechanisms:

- version field
- ETag
- updated-at precondition
- database-native compare-and-set

Relevant entities include:

- Transaction classifications/splits
- Ownership
- LoanAllocation
- reconciliation
- confirmed tax interpretations

A stale write should fail explicitly.

---

# 19. Transactions and Consistency

Within one DE datastore, domain operations that require atomic consistency should use datastore transactions where supported and justified.

Do not create distributed transactions across MRE and DE.

External coordination should follow:

```text
commit DE state
    ↓
attempt external action
    ↓
record synchronization result
```

or another explicit, retryable workflow.

MRE write-back failure must not corrupt DE canonical state.

---

# 20. Background Processing

The MVP should not introduce a general distributed job infrastructure without need.

Background execution may be useful for:

- large imports
- document processing
- MRE synchronization
- report generation
- future bank API synchronization

Start with the simplest mechanism supported by the selected runtime.

If durable asynchronous processing becomes necessary, introduce it through an ADR.

---

# 21. Eventing

No Kafka, generic event sourcing, or distributed event bus is required for the initial architecture.

Within the modular monolith, explicit application calls or lightweight in-process domain/application events may be used where they reduce coupling.

Do not make correctness depend on an eventually consistent event pipeline unless the architecture explicitly requires it.

---

# 22. Caching

Caching is an optimization, not a source of truth.

Appropriate candidates may include:

- MRE display metadata
- expensive read models
- derived dashboard values

Do not cache canonical financial writes in a way that risks hidden inconsistency.

Redis or another distributed cache is not required by default.

Introduce external caching only when measured need justifies operational complexity.

---

# 23. Search

A dedicated search engine is not required for the MVP.

Use datastore queries for initial:

- transaction search
- Party lookup
- Property lookup
- document metadata search

Introduce Elasticsearch/OpenSearch or similar only if concrete requirements justify it.

---

# 24. Authentication and Authorization

The exact cross-application authentication mechanism requires alignment with MRE and may require a dedicated ADR.

Hard requirements:

- authenticated access
- Realm isolation for MRE references
- owner-only DE data must not leak into tenant-facing MRE contexts
- authorization checks occur server-side
- external IDs alone never establish authorization

The frontend must not be trusted to enforce access control.

---

# 25. Secrets and Configuration

Configuration must be externalized from source code.

Examples:

- MRE base URL
- credentials/tokens
- database connection
- document storage path
- environment-specific settings

Secrets must not be committed to Git.

Use environment/configuration mechanisms compatible with self-hosted container deployment.

Provide documented example configuration without real secrets.

---

# 26. Deployment

## 26.1 Containerization

Docker-compatible containerization is preferred.

A local/self-hosted deployment should be possible with a small number of services.

Conceptually:

```text
docker compose
├── existing MRE services
├── DE backend
├── DE persistence
└── optional supporting services
```

Avoid adding infrastructure services without clear value.

## 26.2 Upgradeability

The project should make upstream MRE upgrades manageable.

Prefer:

- separate DE code
- adapters
- explicit patches only where unavoidable
- documented MRE compatibility version
- integration tests

over a heavily modified MRE fork.

---

# 27. Repository Strategy

The repository structure should make the distinction between:

- upstream MRE
- DE extension code
- documentation
- integration code

obvious.

If the DE project lives inside or alongside an MRE checkout, upstream modifications should remain easy to identify.

Recommended principle:

> A reviewer should be able to tell whether a change belongs to upstream MRE, the DE extension, or the integration boundary without reading the whole diff.

The exact monorepo/submodule/fork strategy should follow the current development setup and may require a separate ADR.

---

# 28. Dependency Management

Prefer mature, well-maintained libraries with narrow responsibilities.

Before adding a dependency, consider:

1. can the platform/runtime already do this?
2. is the dependency actively maintained?
3. does it work self-hosted?
4. does it introduce a large transitive tree?
5. is its license compatible?
6. is it needed in core domain code?
7. can it be replaced without rewriting the domain?

Avoid framework-specific domain models.

---

# 29. Database Migrations

Whichever datastore is chosen, schema evolution must be explicit and version-controlled.

Requirements:

- repeatable deployment process
- forward migration path
- backup before destructive changes
- data transformations tested
- no undocumented production-only schema changes

Migration strategy must be selected alongside the persistence ADR.

---

# 30. Testing Strategy

Testing is part of the architecture.

## 30.1 Domain Unit Tests

Fast tests for:

- money calculations
- TransactionSplit invariants
- Ownership periods
- LoanAllocation
- SecurityDeposit balance
- depreciation
- investment formulas
- tax rule selection

## 30.2 Application / Workflow Tests

Test:

- bank import
- reconciliation
- correction propagation
- tax-year aggregation
- MRE write-back failure

## 30.3 Persistence Integration Tests

Run against the real selected datastore technology.

Do not rely solely on mocks for persistence semantics.

## 30.4 MRE Contract Tests

Verify supported upstream MRE API behavior.

## 30.5 API Tests

Verify:

- validation
- authorization
- idempotency
- concurrency
- error semantics

## 30.6 End-to-End Tests

Keep a small set of high-value landlord journeys.

Avoid making the entire test suite dependent on slow browser tests.

---

# 31. Test Data

Use deterministic synthetic fixtures.

Never require personal production data for automated tests.

Useful fixtures should cover:

- 50/50 Ownership
- changing Ownership period
- exact rent payment
- partial rent payment
- combined rent + deposit payment
- Loan interest/principal split
- shared Loan
- Hausgeld split
- WEG annual statement
- depreciation
- missing valuation
- scenario calculation

---

# 32. Observability

For a self-hosted application, observability should remain useful but lightweight.

Minimum:

- structured application logs
- request/correlation ID where practical
- integration error logs
- import batch status
- synchronization status
- health endpoint

Avoid logging:

- secrets
- authentication tokens
- unnecessary personal data
- full bank/document payloads by default

Metrics/tracing infrastructure may be added later if operational need justifies it.

---

# 33. Audit Logging

Audit is distinct from technical logging.

Technical log:

```text
HTTP request failed with timeout
```

Audit record:

```text
User confirmed Transaction classification
```

Material domain actions should preserve audit data in canonical application storage.

Do not rely on container logs as the only audit history.

---

# 34. Backup and Restore

Self-hosting requires documented backup.

At minimum, backup must cover:

- DE datastore
- document binaries if locally owned
- configuration needed for restoration, excluding secrets where separately managed

MRE backup remains governed by MRE's own deployment/storage requirements.

Restore should be tested, not merely documented.

---

# 35. Exportability

Core user-owned data must remain exportable in open/documented formats.

Preferred:

- JSON for structured complete exports
- CSV for tabular financial data
- PDF for human-readable reports

Exports should preserve stable identifiers where useful for traceability.

---

# 36. Security Baseline

Minimum engineering requirements:

- dependency updates
- server-side authorization
- input validation
- output encoding
- secure secret handling
- safe file upload handling
- explicit CORS policy where applicable
- secure cookies/tokens according to authentication design
- no arbitrary code execution from imported data
- no trust in CSV/document content

Detailed security architecture can be expanded when authentication and deployment are finalized.

---

# 37. Privacy

The application handles sensitive landlord and tenant information.

Technology should support:

- least-privilege access
- data minimization
- controlled logging
- export
- retention/deletion policy
- self-hosted storage

Do not copy MRE personal data into DE persistence merely because it is technically convenient.

---

# 38. AI Integration

AI is optional assistance, not infrastructure required for correctness.

Potential uses:

- transaction category suggestions
- document classification
- explanation
- matching suggestions
- tax classification suggestions

Architecture:

```text
Canonical / source data
       ↓
AI adapter
       ↓
Suggestion
       ↓
Human confirmation
       ↓
Domain command
```

AI must not directly mutate canonical:

- cash
- Ownership
- tax
- financing
- reconciliation

records without the accepted confirmation workflow.

Core functionality must remain usable without a proprietary AI service.

---

# 39. Technology Anti-Patterns

Avoid the following unless an accepted ADR explicitly justifies them.

## 39.1 Premature Microservices

Do not create one service per domain merely because domain boundaries exist.

## 39.2 Direct MRE Database Mutation

Do not bypass supported MRE APIs for convenience.

## 39.3 Shared Persistence Models Across Domains

Do not let every module directly manipulate every other's collections/tables.

## 39.4 Business Logic in Frontend

Do not calculate authoritative tax, financing, depreciation, or investment results only in the browser.

## 39.5 Business Logic in Reports

Reports consume domain outputs.

## 39.6 Floating-Point Money

Forbidden for canonical financial calculations.

## 39.7 Framework Leakage Into Domain

Domain rules should remain testable without booting the web framework or database.

## 39.8 Infrastructure by Fashion

Do not introduce Kafka, Redis, Elasticsearch, Kubernetes, GraphQL, CQRS, or event sourcing simply because they are common in larger systems.

Use them only for a demonstrated requirement.

---

# 40. Initial Technology Decision Matrix

| Area | Current Direction | Status |
|---|---|---|
| Architecture | Modular monolith | **Accepted (ADR-026)** |
| MRE integration | API + anti-corruption layer | Accepted |
| Public API | HTTP/JSON, `/api/v1` | Specified |
| API style | REST-like + business commands | Specified |
| Backend ecosystem | Node.js 24 LTS + TypeScript | **Accepted (ADR-032, amended 2026-10-18)** |
| Static typing | Strong typing for DE code | **Accepted (ADR-032)** |
| Frontend | Align with MRE frontend ecosystem | Recommended; verify upstream |
| Database | PostgreSQL, separate from MRE MongoDB | **Accepted (ADR-031)** |
| Money | Exact decimal / `NUMERIC` | **Accepted (ADR-033)**; decimal library impl-level |
| Deployment | Self-hosted containers | Accepted |
| Process model | Modular monolith first | **Accepted (ADR-026)** |
| Event bus | None initially | Recommended |
| Cache | None required initially | Recommended |
| Search engine | None required initially | Recommended |
| Bank integration | File/CSV first | Recommended |
| MRE access | Supported API preferred | Accepted |
| API documentation | OpenAPI when implemented | Recommended |
| Documents | Pluggable storage, local FS default; metadata in PostgreSQL | **Accepted (ADR-035)** |
| Authentication | Reuse MRE auth + Realm authority | **Accepted (ADR-034)** |
| Repository | Separate `vermieter-cockpit` repo, pinned MRE | **Accepted (ADR-036)** |
| AI | Optional suggestion layer | Accepted constraint |
| Export | JSON/CSV/PDF | Accepted |
| Testing | Domain + integration + contract + selective E2E | Required strategy |

---

# 41. Technology Decisions — Now Accepted

The technology decisions this section originally listed as "to become ADRs" **have been accepted**. Detailed rationale is in `docs/architecture/technology-adrs.md`; the canonical records are in `docs/architecture/architecture-decisions.md`.

| Decision | Resolution | Canonical ADR |
|---|---|---|
| TECH-ADR-001 DE Persistence | PostgreSQL, separate from MRE MongoDB | ADR-031 |
| TECH-ADR-002 Application Process Structure | Modular monolith | ADR-026 |
| TECH-ADR-003 Runtime / Language / Package Manager | Node.js 24 LTS + TypeScript + Yarn 3.3 | ADR-032 |
| TECH-ADR-004 Money Representation | Money value object, exact decimal, `NUMERIC`, decimal-string API | ADR-033 |
| TECH-ADR-005 Authentication Between DE and MRE | Reuse MRE auth + Realm authority | ADR-034 |
| TECH-ADR-006 Document Binary Storage | Pluggable storage, local FS default, metadata in PostgreSQL | ADR-035 |
| TECH-ADR-007 Repository / Upstream Strategy | Separate `vermieter-cockpit` repo, pinned MRE baseline | ADR-036 |

Remaining choices are implementation-level (see `technology-adrs.md` §10): decimal library, PG access layer, migration tool, validation library, test runner, HTTP framework.

---

# 42. Decision Order (historical)

> **Note:** all decisions below are now accepted (see §41). This ordering is retained as a record of how the technology baseline was reached; it is no longer a pending sequence. The one remaining *implementation* prerequisite is to inspect the exact pinned MRE runtime/toolchain during Phase 0 scaffolding.

```text
1. inspect exact MRE runtime/toolchain   (Phase 0)
        ↓
2. persistence            → ADR-031 ✓
3. application process     → ADR-026 ✓
4. money representation    → ADR-033 ✓
5. authentication          → ADR-034 ✓
6. repository/upstream     → ADR-036 ✓
7. document storage        → ADR-035 ✓
        ↓
8. implementation scaffolding
```

---

# 43. Accepted MVP Technical Shape

The intended MVP shape is:

```text
┌──────────────────────────────────────────┐
│ Browser                                  │
│                                          │
│ MRE UI + DE Cockpit UI                   │
└──────────────────┬───────────────────────┘
                   │ HTTP/JSON
                   ▼
┌──────────────────────────────────────────┐
│ DE Backend — Modular Monolith            │
│                                          │
│ API                                      │
│ Application Workflows                    │
│ Domain Modules                           │
│ MRE Adapter                              │
│ Bank Import Adapter                      │
│ Reporting                                │
└───────────────┬──────────────┬───────────┘
                │              │
                ▼              ▼
         DE Persistence      MRE API
                │              │
                ▼              ▼
          DE Data Store    Existing MRE
```

No additional infrastructure is required until a concrete need appears.

---

# 44. Definition of a Good Technology Choice

A technology choice is good for Vermieter Cockpit DE when it:

- keeps the domain model clear
- reduces long-term maintenance
- works well in self-hosted environments
- integrates cleanly with MRE
- preserves user data ownership
- supports deterministic financial calculations
- is easy to test
- is easy to upgrade
- has a credible maintenance ecosystem
- does not create infrastructure disproportionate to the product

A technology is not preferred merely because it is newer, more scalable in theory, or popular.

---

# 45. Final Technology Principle

The project should optimize for:

```text
boring where possible
explicit where important
precise where financial
isolated where external
modular where domain-specific
self-hostable by default
```

The DE Investment Layer should feel like a disciplined extension of MicroRealEstate, not a second platform competing with it.

Technology exists to make the business model maintainable and trustworthy.

It must not become the architecture.
