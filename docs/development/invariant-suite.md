# Ledger invariant suite (VC-1-09)

Where each Phase-1 ledger invariant is tested. A rule counts as covered only
when a test exercises it against the real behaviour: domain rules in pure
unit tests, persistence rules against PostgreSQL, and the important ones also
in the schema itself (so that no code path, present or future, can break
them) and end to end through the HTTP API.

Paths are relative to `services/de-backend/src/`. Abbreviations:

| Abbreviation | File |
|---|---|
| **INV** | `infrastructure/postgres/ledger-invariants.test.ts` (schema-level guarantees, VC-1-09) |
| **ACC** | `slice-1-acceptance.e2e.test.ts` (Slice-1 definition of done through the API, VC-1-09) |
| **IR** | `infrastructure/postgres/import-repository.test.ts` |
| **TR** | `infrastructure/postgres/transaction-repository.test.ts` |
| **SR** | `infrastructure/postgres/transaction-split-repository.test.ts` |
| **BI** | `domains/ledger/bank-import.test.ts` |
| **TS** | `domains/ledger/transaction-split.test.ts` |
| **CT** | `domains/ledger/confirm-transaction.test.ts` |
| **CR** | `infrastructure/postgres/correction-repository.test.ts` (VC-1-11) |
| **CC** | `domains/ledger/correct-transaction.test.ts` (VC-1-11) |
| **ACC2** | `phase-2-acceptance.e2e.test.ts` (Phase-2 exit through the API, VC-2-10) |

Database tests run against `DE_TEST_DATABASE_URL` (CI: a PostgreSQL 16
service; also run locally with `default_transaction_isolation = repeatable read`).

## 1. Split totals are exact (data-model §18, domain-model §24)

| Level | Tests |
|---|---|
| Domain | TS "a set that adds up exactly classifies the Transaction", "one cent off is a mismatch, in both directions — no rounding tolerance"; CT "needs splits, an exact sum (re-checked) and active categories, in that order" |
| Repository | SR "refuses a sum one cent off and keeps the previous set"; TR confirm "refuses without splits, with a sum off, …" (sum re-checked at confirmation) |
| **Schema** | INV "no confirmation without splits, or with a sum one cent off in either direction", "an exact split set can be confirmed, and stays exact: its splits are frozen", "no Transaction is inserted already confirmed" (migration 0010 + 0009) |
| **Schema, two writers** | INV "two writers: a confirmation waits for an uncommitted split and is refused (no 150 on 100)", "two writers: a split waits for an uncommitted confirmation and is then refused as frozen": the split trigger writes its Transaction row (0010), so a split change and a confirmation in different sessions serialize, under READ COMMITTED and REPEATABLE READ alike; both fail without it |
| API / end to end | `api/transaction-splits.test.ts` (409 `SPLIT_SUM_MISMATCH` with `difference`); `transaction-split.e2e.test.ts`; ACC (cent off refused, exact set classifies and confirms) |

## 2. Non-negative amount, sign only in `direction` (data-model §17.4)

| Level | Tests |
|---|---|
| API | `api/transactions.test.ts` "400 VALIDATION_ERROR: %s" (`NEGATIVE_AMOUNT`, missing/unknown direction); `api/transaction-splits.test.ts` (negative split, a split `direction` → `NOT_ALLOWED`) |
| Import | `integrations/bank-import/generic-csv.test.ts` (signed CSV amount → non-negative amount + direction); `normalize.test.ts` |
| **Schema** | INV "refuses a negative amount", "refuses a direction other than INFLOW/OUTFLOW"; TR and SR schema tests (negative amounts) |
| End to end | ACC (`-1.00` refused; stored amount and direction) |

## 3. Monetary precision: rejected, never rounded (data-model §17.4, ADR-033)

| Level | Tests |
|---|---|
| Money | `shared/money.test.ts` (more decimals than EUR allows, non-string amounts, unsupported currency, numeric JSON) |
| API | `api/transactions.test.ts` (`SCALE_EXCEEDED`, JSON number, `UNSUPPORTED_CURRENCY`, out of range); `api/transaction-splits.test.ts` |
| Import | `generic-csv.test.ts` "reports bad rows per row …" (`SCALE_EXCEEDED`, `CURRENCY_MISMATCH`) |
| **Schema** | INV "refuses more decimals than EUR allows", "refuses an unsupported currency"; `money-column.test.ts` (why never `NUMERIC(p,s)`); TR/SR schema tests |
| End to end | ACC (`1.005` and a JSON number refused; stored `1250.00` exactly) |

## 4. Realm isolation

| Resource | Tests (Realm B never sees or changes Realm A's data) |
|---|---|
| PropertyReference | `property-reference-repository.test.ts`; `application/refresh-property-reference.test.ts`; `property-reference.e2e.test.ts` |
| FinancialAccount | `financial-account-repository.test.ts`; `financial-account.e2e.test.ts` |
| Manual Transaction | TR "rejects a Transaction on %s"; `transaction.e2e.test.ts` |
| Splits, confirm | SR "PropertyReferences must be in the Realm; …"; TR confirm "another Realm’s Transaction is not found"; `transaction-split.e2e.test.ts` |
| Import, batch, review items | IR "another Realm's or an unknown account is not found …", "lists only the items the batch owns …", "only the owning batch path resolves an item …"; `bank-import.e2e.test.ts` |
| **All endpoints at once** | ACC: every endpoint, given Realm A's ids, answers Realm B with `404` and writes no AuditRecord |
| **Schema** | INV "a Transaction cannot point at another Realm’s PropertyReference", "a split cannot point at another Realm’s PropertyReference", "import batches, imported Transactions and review items stay in their Realm"; TR and SR schema tests (account, split → Transaction) |

## 5. Import identity and ambiguity (data-model §70.5)

| Case | Tests |
|---|---|
| Identical file retry → zero new Transactions | IR "re-importing the identical file creates nothing …", "two concurrent uploads of one file create each row once"; `bank-import.e2e.test.ts`; ACC |
| Overlap / partial overlap of the same statement identity | IR "an overlapping export of the same statement creates only the new rows and dedupes the shared ones" (VC-1-09) |
| Row reordering | IR "a reordered file is a different statement: … review items, never Transactions" (no ids); IR "a reordered export is deduped by its row ids, not sent to review" (VC-1-09); IR "a stable external id with the same content is a duplicate …" |
| Row ids only within their statement | IR "row ids only count within their statement …" (VC-1-09) |
| Two identical real payments in one source → two Transactions | IR "two identical payments in one file are two Transactions"; `generic-csv.test.ts` |
| Stable external id preferred over fallback | IR "a stable external id with the same content is a duplicate across files and adapter versions"; BI external-id branch tests |
| Ambiguous cross-file match → `needs_review`, no Transaction, owning counter | IR "a reordered file is a different statement …"; BI "the same content in another statement is ambiguous …" |
| Resolve `CREATE` → exactly one Transaction | IR "CREATE makes exactly one IMPORTED Transaction …", "two concurrent CREATE resolutions create one Transaction" |
| Resolve `SKIP` → none | IR "CREATE makes exactly one …" (SKIP part); `bank-import.e2e.test.ts` |
| Re-import with a still-`PENDING` row | IR "re-presenting a PENDING item references it in its owning batch …", "lists only the items the batch owns …", "only the owning batch path resolves an item …"; BI |
| Re-import after `CREATE` / `SKIP` | IR "re-importing after the decision reports the stored decision …", "a RESOLVED item makes the re-presented row a duplicate …" |
| Same row under another adapter version | IR "the same statement under another adapter version is a conflict for review, never automatic"; BI |
| Same row, new adapter version, stable external id | IR "a stable external id with the same content is a duplicate across files and adapter versions" |
| Same external id, other content (also within one file) | IR "the same external id with other content is a review item, never a swallowed payment …"; BI |
| First without, then with external id | IR "a row imported first without, then with its external id is a review item …" |
| Never auto-merged nor auto-duplicated | all of the above: an ambiguous row is always `needs_review`, never `created` or `duplicate` |

## 6. Confirmed Transactions are immutable (ADR-037)

TR confirm "the database keeps a confirmed Transaction and its splits immutable (ADR-037)", "the status of a confirmed Transaction only moves forward; CORRECTED is terminal"; SR "a replacement waiting on a confirm in progress finds the Transaction frozen"; ACC (splits refused after confirm).

`version` (the `ETag`, API §16.1) and `updated_at` change only with a status step, which raises `version` by exactly one (VC-X-22, migration 0013): INV "without a status step, version and updated_at stay; a no-op write is fine", "a status step raises version by exactly one …".

## 7. Correction chain (VC-1-11)

Specified in API §35.6 and data-model §17.8.

| Invariant | Tests |
|---|---|
| Link and role set together, exactly with `provenance = CORRECTION` | INV "link and role go together, exactly with provenance CORRECTION" |
| The link stays within the Realm | INV "a correction links only within its Realm" |
| At most one reversal and one replacement per original | INV "at most one reversal and one replacement per original" |
| A reversal matches its original (amount, account, dates; opposite direction), both records confirmed | INV "a reversal matches its original …"; CR "writes a confirmed reversal and replacement …" |
| A reversal mirrors its original's splits: category, PropertyReference, amount as a multiset, checked at commit (VC-X-17, migration 0014) | INV "a reversal mirrors the splits of its original …", "the mirror is checked at commit …" |
| `CORRECTED` exactly when its reversal exists (replacement optional, VC-X-15), checked at commit | INV "CORRECTED exactly when its reversal exists …", "a complete chain commits; the reversal may come before or after …" |
| A replacement only while its original is not yet `CORRECTED`, so a reversed Transaction never gets one later (VC-X-15), also after a touched `updated_at`, also against a concurrent reversal | INV "a reversed Transaction never gets a replacement later …", "a replacement racing a reversal waits for it and is then refused" |
| A correction inside a savepoint commits like any other | INV "a correction inside a savepoint commits like any other" |
| Reverse without a replacement: net effect zero, ends a chain, final | CR "reverse without a replacement …" |
| `CORRECTED` only from `CONFIRMED`/`RECONCILED` (review counterexample on #21) | INV "CORRECTED only from CONFIRMED/RECONCILED …"; TR "the status of a confirmed Transaction only moves forward" |
| No correction links to a reversal | INV "no correction links to a reversal"; CC, CR (`NOT_CORRECTABLE` with `correctionRole`) |
| `propertyReferenceId`, `description` and the link of a confirmed Transaction are frozen (review counterexample on #21) | INV "PropertyReference, description and the link …"; TR "the database keeps a confirmed Transaction … immutable" |
| Net effect per account, period, split category and split PropertyReference, over a chain T1 → T2 → T3 | CR "net effect …"; ACC "corrects a confirmed import …" |
| Two concurrent corrections: one chain, the waiter gets `ALREADY_CORRECTED` with its ids (deterministic: both wait on a held lock) | CR "two concurrent corrections …" |
| A re-import of a corrected original's row stays a duplicate | ACC "corrects a confirmed import …" |
| Must change something; closed account of the original; idempotency | CC "NO_CHANGE only when …"; CR "a correction must change something …", "the original’s closed account …", "Idempotency-Key …" |

## 8. Party (VC-2-01, api-design §19.1)

| Invariant | Tests |
|---|---|
| Type-specific fields only on their type, in the API and the schema | PR "the schema refuses fields of the other type …"; API "400 for … fields of the other type"; Party "fields of the other type are not allowed" |
| `INACTIVE` exactly with `deactivatedAt` and its reason; deactivation once, a repeat keeps the first reason | PR "deactivate: once, with its reason …", "the schema refuses … inconsistent deactivation" |
| Realm isolation | PR "creates an ACTIVE Party in the Realm …"; ACC (Realm B gets `404` on read, amend and deactivate, and an empty list) |
| No automatic deduplication | PR "two Parties with one name are allowed" |
| Literal name filter (`%`, `_`, `\` match themselves) | PR "list: … a literal name substring" |
| `If-Match` prevents a lost update: two amends of one version, one wins, the other `412` (review on #39) | PR "two people amend the same version at once …" |

## 8a. Party external references (VC-2-02, api-design §20.1)

`PER` = `party-external-reference-repository.test.ts`.

| Invariant | Tests |
|---|---|
| Among active references a key resolves to at most one Party (partial unique index) | PER "claim: … another Party is IN_USE", "the schema: … one active holder per key" |
| Concurrent claims by different Parties: one reference, the other `IN_USE`, never an aborted transaction (`ON CONFLICT … WHERE status = 'ACTIVE' DO NOTHING` + re-read); the winner rolling back lets the waiter insert | PER "two different Parties claim one key at once …" |
| No new reference for an inactive Party, also when racing `deactivate`; its own references repeat and can be ended | PER "claim: an inactive Party gets no new reference …", "a claim racing deactivate …", "end: … the key is free again" |
| A reference stays in its Party's Realm (composite FK); `ENDED` exactly with `endedAt`; `ENDED` final; key, Party and creation never change | PER "the schema: …" |
| End once; a repeat keeps the first `endedAt` whatever `If-Match` says; an ended key can be claimed again as a new row | PER "end: once, with an AuditRecord …" |
| MRE existence decided from the Realm's `GET /tenants` list, client-side; a valid unknown id in a Realm with Tenants is `404` | Contract "tenants (…)"; ACC (unknown Tenant `404`, nothing written) |
| Realm isolation | PER "end: another Party, another Realm …", "list: … undefined for an unknown or foreign Party"; ACC (Realm B gets `404` on claim, end and list; the Tenant resolves to nothing in Realm B) |

## 9. Ownership (VC-2-03, api-design §26.1)

`OR` = `ownership-repository.test.ts`, `OD` = `ownership.test.ts`, `SH` = `share.test.ts`.

| Invariant | Tests |
|---|---|
| A share is an exact fraction `1 ≤ n ≤ d ≤ 10000`, stored reduced; sums exact (three thirds are 1; coprime denominators beyond 64 bits) | SH "parses …", "sums exactly …"; OR "the schema: … reduced shares" |
| No overlap per owner over `VALID` Ownerships (inclusive dates, adjacent is fine) | OD "no overlap per owner …"; OR "invariants: …"; OR "the schema: … the invariant trigger past the repository" |
| No day above 1, checked where a period starts; `VOID` counts nowhere | OD "no day above 1 …"; OR "invariants: …", "the schema: …" |
| Two writers of one PropertyReference serialise: RC waits and refuses, RR fails to serialise (the trigger touches the PropertyReference first) | OR "two writers … under READ COMMITTED …", "… under REPEATABLE READ …" |
| `close` and `void` serialise too, in one lock order (PropertyReference, Party, Ownership): close waits for a concurrent create before locking its row; void and close of one Ownership serialise (`If-Match` conflicts); a void past the repository serialises with a create (review on #43) | OR "close waits for a concurrent writer …", "void and close of one Ownership serialise …", "a void serialises with a create too …" |
| A new owner is active, also when racing `deactivate` (`FOR SHARE`); an inactive owner's Ownership can be closed | OR "create: the order of checks …", "a new owner racing deactivate …", "close: … inactive owner" |
| Close only sets or shortens `validUntil`; void is final; share, owner, PropertyReference, `validFrom` never change (also past the repository) | OD "close sets or shortens …", "void once …"; OR "close: …", "void: …", "the schema: … frozen fields" |
| Completeness derived per day: `COMPLETE` exactly 1, `INCOMPLETE` below, `NONE` without | OD "a day: …"; OR "reads: …"; ACC (two halves `COMPLETE`) |
| A refusal writes nothing, not even the `Idempotency-Key` claim; a replay answers the recorded Ownership | OR "create: the order of checks …", "create: Idempotency-Key …"; ACC |
| Party guards: `party_type` fixed, `INACTIVE` final with its time and reason (0018) | OR "the Party guards (0018) …" |
| Realm isolation | OR (other Realm `NOT_FOUND` / `undefined`); ACC (Realm B gets `404` on create, read, close, void and both reads) |

## 9a. Ownership change (VC-2-04, api-design §26.2)

`OC` = `ownership-change-repository.test.ts`, `CH` = `change.test.ts`.

| Invariant | Tests |
|---|---|
| Atomic: closes on `effectiveDate − 1` and creates from `effectiveDate` in one transaction; a refusal writes nothing (no AuditRecord, no key claim) | OC "a sale to a third party …", "refusals in the order of §26.2 …" |
| Closes are written before creates, so a correct change never trips the immediate invariant trigger (sale to a third party at complete ownership; share change of the same owner) | OC "a sale to a third party …", "a share change of the same owner …"; counter-check: creates first are refused by the trigger |
| Listed Ownerships: `NOT_FOUND` (also another PropertyReference), `VOID`, `STARTS_ON_OR_AFTER_EFFECTIVE_DATE`, `ALREADY_ENDED`, in the order given, before the new owners | CH "the listed Ownerships …"; OC "refusals …", "a VOID or already ended …" |
| Complete before means complete after (`OWNERSHIP_INCOMPLETE`); an incomplete ownership may stay so | CH "complete before means complete after …"; OC "refusals …" |
| Inactive owners may be closed (inheritance); new owners must be active | OC "an inheritance …", "refusals …" |
| A close-only change of nothing is a `200` no-op without AuditRecords; a keyed retry replays, a keyless one never applies twice | CH "a later planned end …"; OC "a close-only change …", "Idempotency-Key …" |
| One lock order with every Ownership writer (PropertyReference, Parties, Ownerships): a concurrent close is waited for and seen | OC "serialises with a concurrent close …" |
| Realm isolation | OC (another Realm's PropertyReference `PROPERTY_REFERENCE_NOT_FOUND`); ACC (Realm B gets `404`) |

## 10. Acquisition (VC-2-05, api-design §27.1)

`AR` = `acquisition-repository.test.ts`.

| Invariant | Tests |
|---|---|
| A draft with price > 0 (EUR, ≤ 2 decimals), a reduced share, transfer dates not before the contract, buyers active, parties in their order; a refusal writes nothing | AR "create: …", "create: the order of checks …", "the schema: …" |
| Data fixed after creation; status only `DRAFT` → `CANCELLED`/`CONFIRMED`, then final; parties never change (also past the repository) | AR "the schema: …" |
| Cancel once; a repeat keeps the first reason; confirmed is final; refused while `VALID` Ownerships carry it (review on #46), also past the repository by `acquisition_frozen` (review on #47) | AR "cancel: …", "the database keeps both directions past the repository …" |
| An Ownership links only an Acquisition of its own Realm and PropertyReference (composite FK) that is a `DRAFT` (repository, and past it by `ownership_acquisition_draft`, review on #47), fixed afterwards; also via `ownership-changes` | AR "the Ownership link: …", "the database keeps both directions past the repository …" |
| Cancel and an Ownership create for the draft serialise (PropertyReference, then Acquisition): the cancel sees the new Ownership | AR "a cancel racing an Ownership create …" |
| Realm isolation | AR (`findById`, `cancel` other Realm); ACC (Realm B gets `404` on create, read, cancel and the PropertyReference list; its list is empty) |

## 11. Acquisition costs and payments (VC-2-06, api-design §27.2)

`CR` = `acquisition-cost-repository.test.ts`, `CD` = `domains/acquisition/cost.test.ts`.

| Invariant | Tests |
|---|---|
| A cost is > 0, of a category of P2-D7 (no `PURCHASE_PRICE`), with a counterparty of the Realm; data fixed, `ACTIVE` → `VOID` final, never deleted (also past the repository) | CR "create: …", "void: …", "keeps data fixed and rows undeleted …"; API "400 for a bad body …" |
| A payment links a current `OUTFLOW` Transaction of the Realm, in its currency, to the price or a cost of the same Acquisition (composite keys); data fixed, the unlink final | CR "link: the order of checks …", "keeps the links in the Realm …", "refuses what the repository refuses …"; CD "checkLink" |
| Per Transaction the live payments ≤ its amount; per cost and price the counting ones ≤ the amount; the paid state is derived | CR "installments: …", "link: …", "refuses what the repository refuses …"; CD "the derived paid state" |
| A corrected Transaction stops counting, the payment names the direct replacement, re-linking is explicit; the ledger is never written | CR "a ledger correction: …" |
| A `CANCELLED` Acquisition takes no cost or payment write and counts nowhere; its payments free the Transaction | CR "cancel: …", "refuses what the repository refuses …" |
| A cost is voided only without linked payments | CR "void: …", "refuses what the repository refuses …" |
| Every cost and payment write serialises on the Acquisition row (with each other and with cancel), a link also on the Transaction row (with other links and with `correct`); RC sees the other's commit, RR fails to serialise (review on #37, #48) | CR "concurrency (READ COMMITTED …)", "concurrency (REPEATABLE READ …)" |
| Realm isolation | CR (foreign Acquisition, Transaction and counterparty are not found; reads `undefined`) |

## 12. Acquisition confirmation (VC-2-07, api-design §28.1)

`CF` = `acquisition-confirm-repository.test.ts`, `AD` = `domains/acquisition/acquisition.test.ts`, `CR` as §11.

| Invariant | Tests |
|---|---|
| Confirm only a `DRAFT`: buyers active; its `VALID` Ownerships start on the transfer date, are held by exactly the buyers and sum to `acquiredShare`; the PropertyReference is `COMPLETE` that day; every failure reported, in order | CF "reports every failed requirement at once …", "a partial acquisition …"; AD "planConfirm (§28.1)" |
| A repeat is a no-op, `CANCELLED` answers before `If-Match`, `If-Match` before the requirements | CF "confirms: …", "the order of checks …" |
| The same six requirements hold past the repository; an Acquisition is only inserted `DRAFT` | CF "refuses a raw confirmation for each requirement 1–6 …"; AR "the schema: …" |
| After confirmation its Ownerships close but do not void (also past the repository); cancel is refused; costs and payments stay writable | CF "after confirmation: …", "a status step raises version …"; CR "a confirm waits for a payment link …" |
| Every status step raises `version` by exactly one (Acquisition, cost, payment); a cost is only inserted `ACTIVE`, a payment only not unlinked (review on #49) | CF "a status step raises version …"; CR "refuses a void or unlink that does not raise version by one …" |
| Confirm serialises with Ownership create, close and void, `deactivate`, cancel and payment writes (RC); a raw confirm fails to serialise against a void of its Ownership, an insert carrying its id and a `deactivate`, and commits beside a close of another owner (RR, review on #50) | CF "concurrency through the repository …", "concurrency past the repository …" |
| Realm isolation | CF ("the order of checks": another Realm is `NOT_FOUND`) |

## 13. Land/building allocation (VC-2-08, api-design §27.3)

`LA` = `land-building-allocation-repository.test.ts`, `LD` = `domains/acquisition/allocation.test.ts`.

| Invariant | Tests |
|---|---|
| As entered: total > 0, land and building ≥ 0, `land + building = total` exactly (also past the repository); the shares are derived display values | LA "the first allocation: …", "refuses a wrong sum …"; LD "shares are display values …"; API "400: the exact sum …" |
| A correction supersedes the current one, which keeps its data; the history is readable; at most one current per Acquisition | LA "a correction supersedes …", "refuses … a second current row …" |
| The optimistic check: `supersedes` names the current allocation (`null` only while there is none); a retry without a key is refused | LA "the optimistic check …", "with an Idempotency-Key …"; LD "checkAllocation …" |
| The chain is consistent and in one Acquisition: no supersede without a successor (at commit), no successor elsewhere or of a current row, one successor at most | LA "keeps the chain consistent …" |
| Data fixed, rows undeleted, superseded final; inserted only current and never on a `CANCELLED` Acquisition | LA "keeps data fixed …", "refuses … an insert already superseded, an insert on a CANCELLED Acquisition" |
| Allocations serialise on the Acquisition row with each other and with cancel (RC: the waiter sees the other; RR: `40001`) | LA "concurrency …" |
| Realm isolation | LA ("the order of checks": foreign Acquisition and advisor not found; "list": foreign is `undefined`) |

## 14. Owner-level allocation (VC-2-09, api-design §27.4)

`OA` = `domains/acquisition/owner-allocation.test.ts`, `OS` = `owner-allocation-source.test.ts`.

| Invariant | Tests |
|---|---|
| Split among the Acquisition's own buyers by weight = share / `acquiredShare` (a partial acquisition's buyer carries everything); a closed Ownership still counts | OA "a partial acquisition …"; OS "reads one snapshot …" |
| Cents by largest remainder per amount, ties by `ownerPartyId`; parts ≥ 0, every column exact, every part within a cent of `A·w` | OA "largestRemainder", "property: …" (400 random cases, up to 20 owners, denominators up to 10 000) |
| Totals derived from the parts, never distributed (F4b; the review counterexample 3/7, 3/7, 1/7 → 5/4/2) | OA "the review counterexample …", "property: …" |
| Price, each cost category over `ACTIVE` costs, and the current allocation's land and building, from one snapshot | OS "reads one snapshot …" |
| `CONFIRMED` answers; a `DRAFT` only as `PROVISIONAL` with requirements 2–5 of §28.1 (the confirmation's own `structureViolations`), else `409` with the violations; `CANCELLED` is `409` | OA "status: …"; OS "the status answers …" |
| Realm isolation | OS (another Realm is not found) |

## 15. Phase 2 exit (VC-2-10, roadmap Phase 2)

The exit of `docs/roadmap.md` Phase 2, claim by claim, each shown **end to end through the HTTP API** by **ACC2** (one
scenario against PostgreSQL and the fake MRE, as ACC does for Slice 1), and backed by the sections above.

| Exit claim | ACC2 step | Backed by |
|---|---|---|
| An acquisition with **purchase price** + **transaction costs** + **land/building split** exists | A draft (price 300,000.00, buyers Anna and Ben, seller Sven, transfer date 2026-08-01); costs (transfer tax, notary, broker; a wrong one voided); a confirmed bank Transaction linked to the price and the tax; the allocation entered, then corrected (supersede) | §10, §11, §13 |
| It **drives owner-level allocation** | The confirmed Acquisition's `owner-allocation`: Anna and Ben 1/2 each, every column exact to the cent (an odd cost amount, e.g. notary 1,234.57, so a column has an odd cent, which goes by `ownerPartyId`), per-owner totals equal to their parts; the corrected allocation is the one used; a `DRAFT` without its structure is `409` | §12, §14 |
| **Ownership changes over time are queryable** | Sven 1/1 since 2020; the atomic change on the transfer date (Sven closed, Anna and Ben created with the `acquisitionId`); `asOf` before, on and after the date, and the history | §9, §9a |
| **Ownership shares validated** | An extra 1/2 for Carl from the transfer date is `422 OWNERSHIP_TOTAL_EXCEEDS_ONE` with `details.date = 2026-08-01` and `details.shareSum = 3/2` (§26.1); a confirm before the change is `422 CONFIRMATION_BLOCKED` with the violations; after confirmation Anna's Ownership cannot be voided (`409 ACQUISITION_CONFIRMED`) but closes | §9, §12 |
| **Realm isolation** across Phase 2 | Realm B gets `404` on **every route of api-design §19–§28** called with an id of Realm A (reads and commands, each a row of one table in ACC2 that the test iterates, so a forgotten route shows as a missing row) and empty lists of its own | §4, §8–§14 |

ACC2 also checks the traceability that every write promises: AuditRecords for the acquisition's steps (`CREATED`,
`CONFIRMED`), the costs (`CREATED`, `VOIDED`), the payments (`LINKED`) and the allocations (`CREATED`, `SUPERSEDED`).

## Keeping this current

A new invariant gets a schema-level test when the schema can express it, a
repository or domain test otherwise, and a line here. Removing or weakening a
test listed here needs the same review as changing the invariant itself.
