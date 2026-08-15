# Technology Architecture Decisions

**Project:** Vermieter Cockpit DE  
**Version:** 0.1  
**Status:** Accepted  
**Date:** 2026-08-13

This document closes the initial Technology ADRs identified in `docs/architecture/technology.md`.

> **Canonicalization status:** These decisions have been merged into the canonical decision log `docs/architecture/architecture-decisions.md` as **ADR-026** (modular monolith) and **ADR-031 through ADR-036**. That file is authoritative per the README "Sources of Truth" hierarchy and the AGENTS.md reading order. This document is retained as the **detailed rationale** (context, rejected alternatives) behind those ADRs. If this file and `architecture-decisions.md` ever disagree, `architecture-decisions.md` wins. The mapping is:
>
> | This document | Canonical ADR |
> |---|---|
> | TECH-ADR-001 Separate PostgreSQL | ADR-031 |
> | TECH-ADR-002 Modular Monolith | ADR-026 |
> | TECH-ADR-003 Node.js 20 + TS + Yarn 3.3 | ADR-032 |
> | TECH-ADR-004 Decimal Money / NUMERIC | ADR-033 |
> | TECH-ADR-005 Reuse MRE Auth | ADR-034 |
> | TECH-ADR-006 Pluggable Document Storage | ADR-035 |
> | TECH-ADR-007 Separate Repo + Pinned MRE | ADR-036 |

---

# TECH-ADR-001 — Separate PostgreSQL Database for the DE Investment Layer

**Status:** Accepted

## Context

MicroRealEstate uses MongoDB through Mongoose for its operational rental-management model.

The DE Investment Layer has materially different persistence needs, including:

- canonical financial Transactions and TransactionSplits
- strong relational integrity
- temporal Ownership
- LoanAllocation
- tax classifications
- depreciation schedules
- versioned metric snapshots
- reconciliation relationships
- deterministic financial reporting

The DE layer must also remain loosely coupled to MRE persistence internals.

## Decision

The DE Investment Layer will use **PostgreSQL as a separate canonical datastore**.

MRE continues to own and persist its data in its existing MongoDB datastore.

The two systems integrate through supported APIs and explicit references, not shared database collections.

## Rationale

PostgreSQL is preferred because it provides:

- strong transactional semantics
- foreign-key integrity
- precise `NUMERIC` support
- effective relational modeling
- mature indexing/query tooling
- strong temporal/history query capabilities
- reliable backup/restore ecosystem
- straightforward self-hosting
- mature migration tooling

The DE model is more naturally relational than MRE's embedded operational rental model.

Using a separate database also protects MRE upgradeability.

## Consequences

Deployment contains at least:

```text
MRE MongoDB
+
DE PostgreSQL
```

This is intentional.

No distributed transaction is created between them.

Cross-system consistency uses explicit reconciliation and retryable integration workflows.

## Rejected Alternatives

### Store DE data inside MRE MongoDB

Rejected because it:

- increases persistence coupling
- makes DE architecture dependent on MRE schema choices
- weakens domain separation
- provides little value beyond reducing one container

### Separate MongoDB for DE

Viable, but less well aligned with the strongly relational and consistency-heavy DE model.

---

# TECH-ADR-002 — Modular Monolith for the DE Backend

**Status:** Accepted

## Context

The DE Investment Layer contains several clear domains but is initially intended for small private landlord portfolios and self-hosted deployment.

Separate microservices would add:

- deployment complexity
- network failure modes
- distributed observability
- inter-service versioning
- message/retry infrastructure

without a demonstrated scaling requirement.

## Decision

The initial DE backend will be implemented as a **modular monolith**.

Domain boundaries remain mandatory.

Process boundaries do not.

## Required Characteristics

The application must preserve logical modules for at least:

- Party / Ownership
- Acquisition
- Financial Ledger
- Financing
- Security Deposit
- WEG
- Taxation
- Depreciation
- Investment
- Documents
- MRE Integration
- Reporting

Modules must communicate through explicit application/domain interfaces rather than arbitrary cross-module database access.

## Consequences

The application is initially one deployable backend process.

Modules may later be extracted if:

- scaling requirements differ materially
- security isolation requires it
- operational ownership changes
- background processing becomes independently significant

Extraction requires a future ADR.

---

# TECH-ADR-003 — Node.js 20 + TypeScript + Yarn 3.3

**Status:** Accepted

## Context

The inspected MRE baseline uses:

- Node.js 20
- Yarn 3.3.0 workspaces
- TypeScript 5.5.x in shared/common packages
- Express 4 in backend infrastructure
- Next.js 14 and React 18 in the landlord frontend

Maintaining a second runtime ecosystem would increase operational and cognitive cost.

## Decision

The DE Investment Layer will use:

- **Node.js 20**
- **TypeScript**
- **Yarn 3.3.x compatible workspace tooling**

New DE backend/domain code should be TypeScript-first.

The frontend should remain compatible with the existing MRE React/Next ecosystem where integration occurs.

## Backend Framework

The initial backend may use Express-compatible HTTP infrastructure to remain close to MRE, but Express itself is an implementation-level choice unless the initial scaffold requires it.

The architectural commitment is Node.js + TypeScript, not a specific controller framework.

## TypeScript Requirements

Enable strict type checking for new DE code.

Domain concepts should use explicit types/value objects rather than widespread primitive aliases for:

- Money
- Percentage
- Entity IDs
- PropertyReference IDs
- currency
- business dates
- statuses

## Consequences

Developers can work largely within one runtime ecosystem across MRE and the DE extension.

---

# TECH-ADR-004 — Decimal Money Abstraction Backed by PostgreSQL NUMERIC

**Status:** Accepted

## Context

The platform performs financially sensitive calculations including:

- Transaction splits
- Loan interest/principal decomposition
- ownership allocation
- WEG allocation
- depreciation
- investment metrics

JavaScript `number` uses binary floating-point and is unsuitable as the canonical money representation.

## Decision

The DE layer will use a dedicated **Money value object backed by arbitrary/exact decimal arithmetic**.

Persistence uses PostgreSQL `NUMERIC`.

API monetary values are serialized as decimal strings plus currency.

Conceptually:

```json
{
  "amount": "1250.00",
  "currency": "EUR"
}
```

## Application Representation

The application must use a well-maintained decimal implementation or equivalent exact-decimal abstraction.

Raw JavaScript `number` must not be used for canonical Money arithmetic.

A concrete decimal library may be selected during scaffolding without a separate ADR if it satisfies these requirements.

## Percentages

Percentages should also avoid ambiguous implicit scaling.

Canonical API representation:

```text
0.50 = 50%
```

unless a later explicit convention supersedes it.

## Rounding

Rounding must be explicit at domain boundaries.

No global implicit rounding policy should be assumed for every domain.

## Consequences

Persistence and serialization preserve exact decimal meaning.

---

# TECH-ADR-005 — Reuse MRE Authentication and Realm Authorization

**Status:** Accepted

## Context

MRE already owns:

- user Accounts
- authentication
- Realm membership
- operational rental authorization

Creating an independent DE login system would produce duplicate identities, separate password/security handling, and confusing authorization.

## Decision

Vermieter Cockpit DE will **reuse MRE authentication as the primary user identity and Realm-access authority**.

The DE layer will not introduce a separate username/password identity system for the integrated application.

## DE Authorization

The DE backend maintains DE-specific authorization where needed, but authorization starts from a verified MRE-authenticated identity.

Conceptually:

```text
MRE authenticated user
        │
        ▼
Verified identity
        │
        ▼
MRE Realm membership
        │
        ▼
DE authorization policy
```

## Integration Requirement

The precise token/session propagation mechanism must be implemented through a dedicated authentication adapter.

The implementation may:

- validate an MRE-issued token where safely supported
- reuse the existing MRE gateway/session path
- use a supported server-to-server verification mechanism

but must not depend on copying user passwords or maintaining a second credential database.

## Security Rule

Possession of an MRE entity ID or Realm ID never grants access.

Realm membership/authorization must be verified server-side.

## Tenant Boundary

Owner-only DE data must never become accessible through the MRE tenant-facing API merely because authentication is shared.

## Consequences

Authentication remains coherent across the integrated application.

A lower-level implementation spike may be required to select the exact token propagation mechanism, but that is not a new architecture decision.

---

# TECH-ADR-006 — Pluggable Document Storage with Local Filesystem as Default

**Status:** Accepted

## Context

The project stores documents such as:

- purchase agreements
- invoices
- Loan agreements
- WEG statements
- tax evidence
- maintenance documentation

Self-hosted installations should remain simple.

At the same time, domain entities should not depend directly on local filesystem paths.

## Decision

Document binary storage will use a **storage abstraction**.

The initial/default implementation is **local filesystem storage on a persistent mounted volume**.

A future S3-compatible adapter may be added without changing the domain model.

## Architecture

```text
Domain Document Metadata
          │
          ▼
DocumentStorage Port
          │
          ├── LocalFilesystemStorage
          └── S3CompatibleStorage (future)
```

## Metadata

Canonical document metadata remains in PostgreSQL.

Binary files remain in the configured storage backend.

Metadata should include where useful:

- document ID
- content type
- original filename
- size
- checksum
- storage key
- provenance

## MRE Documents

Existing MRE rental documents may be referenced rather than copied when practical.

## Consequences

The default self-hosted deployment remains simple.

Storage technology can evolve without rewriting Acquisition, WEG, Tax, or other domains.

---

# TECH-ADR-007 — Separate Vermieter Cockpit Repository with Pinned MRE Compatibility

**Status:** Accepted

## Context

The project must extend MRE while minimizing upstream divergence.

Putting all DE code directly into a heavily modified MRE fork would:

- increase merge conflicts
- make upstream upgrades harder
- blur ownership boundaries
- encourage convenience modifications to MRE core

The current project already exists as a dedicated `vermieter-cockpit` repository/workspace alongside MRE development.

## Decision

`vermieter-cockpit` remains a **separate repository** containing:

- DE backend
- DE frontend/extensions
- integration adapters
- DE documentation
- migrations
- tests
- deployment additions

MicroRealEstate remains an upstream dependency/system with an explicitly supported version/commit range.

## Compatibility

The project records a supported MRE baseline.

For each upgrade, run:

- MRE contract tests
- integration tests
- schema/API compatibility review
- UI integration tests where relevant

## MRE Modifications

If MRE core changes are unavoidable:

1. keep them minimal
2. prefer generic upstream-worthy changes
3. maintain them as isolated patches/commits
4. contribute upstream where appropriate
5. document the required MRE compatibility patch

## Deployment

The separate repository may orchestrate MRE and DE services together through Docker Compose or equivalent deployment configuration.

Separate repository does not mean separate user experience.

## Rejected Alternative — Deep DE Fork of MRE

Rejected because long-term maintainability and upstream compatibility are primary project goals.

---

# 8. Resulting Technology Baseline

The accepted baseline is:

```text
Runtime
└── Node.js 20

Language
└── TypeScript

Package Management
└── Yarn 3.3-compatible

Backend
└── Modular Monolith

Persistence
├── MRE → existing MongoDB
└── DE → PostgreSQL

Money
└── exact Decimal Money abstraction
    └── PostgreSQL NUMERIC

Integration
└── MRE API + Anti-Corruption Layer

Authentication
└── MRE authentication + Realm authority reused

Documents
├── PostgreSQL metadata
└── pluggable binary storage
    └── local persistent filesystem default

Repository
├── MRE upstream repository/system
└── separate vermieter-cockpit repository

Deployment
└── Self-hosted containers / Docker Compose
```

---

# 9. Decisions That Are No Longer Open

The following items should be removed from the open-decision list in `technology.md` and the canonical Architecture Decisions document:

- DE persistence technology
- application process structure
- runtime/language/package manager
- Money representation architecture
- MRE/DE authentication ownership
- document storage architecture
- repository/upstream strategy

---

# 10. Remaining Implementation-Level Choices

These choices do **not** currently require architecture ADRs unless they materially change the decisions above:

- TypeScript validation library
- HTTP routing/controller library
- PostgreSQL query builder / ORM
- PostgreSQL migration tool
- concrete decimal library
- test runner
- local document folder layout
- OpenAPI generation tooling
- logging library

They should be selected conservatively using:

- maintenance quality
- TypeScript support
- low framework lock-in
- deterministic behavior
- ecosystem maturity
- compatibility with Node 20

---

# 11. Next Technical Decisions

With the foundation above accepted, the next technical design task should compare concrete implementation libraries.

Recommended sequence:

1. PostgreSQL access strategy:
   - Prisma
   - Drizzle
   - Kysely
   - node-postgres with repository layer

2. migration strategy

3. Decimal library

4. API validation/schema tooling

5. authentication adapter spike against the pinned MRE baseline

6. initial repository/module scaffolding

These should generally be recorded in `coding-guidelines.md` or implementation documentation unless a choice materially affects architecture.

---

# 12. Final Decision Principle

These decisions deliberately create **one additional database and one additional backend process**, but avoid a much larger set of long-term complications.

The architecture prioritizes:

```text
MRE compatibility
+
relational financial integrity
+
exact money
+
one runtime ecosystem
+
simple self-hosting
+
clear ownership boundaries
```

over minimizing the number of containers at all costs.

The resulting system remains intentionally conventional:

> Node.js, TypeScript, PostgreSQL, HTTP, Docker, explicit modules, explicit adapters.

That conventionality is a feature.
