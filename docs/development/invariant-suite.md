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
| **LN / LR / LA** | the Loan's domain, repository and API tests (VC-3-01, §16) |
| **TM / TR2 / TA** | the Loan terms' domain, repository and API tests (VC-3-02, §17) |

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

## 15. Phase 2 exit (VC-2-10, roadmap Phase 2; implemented)

The exit of `docs/roadmap.md` Phase 2, claim by claim, each shown **end to end through the HTTP API** by **ACC2** (one
scenario against PostgreSQL and the fake MRE, as ACC does for Slice 1), and backed by the sections above.

| Exit claim | ACC2 step | Backed by |
|---|---|---|
| An acquisition with **purchase price** + **transaction costs** + **land/building split** exists | A draft (price 300,000.00, buyers Anna and Ben, seller Sven, transfer date 2026-08-01); costs (transfer tax, notary, broker; a wrong one voided); a confirmed bank Transaction linked to the price and the tax; the allocation entered, then corrected (supersede) | §10, §11, §13 |
| It **drives owner-level allocation** | The confirmed Acquisition's `owner-allocation`: Anna and Ben 1/2 each, every column exact to the cent (an odd cost amount, e.g. notary 1,234.57, so a column has an odd cent, which goes by `ownerPartyId`), per-owner totals equal to their parts; the corrected allocation is the one used; a `DRAFT` without its structure is `409` | §12, §14 |
| **Ownership changes over time are queryable** | Sven 1/1 since 2020; the atomic change on the transfer date (Sven closed, Anna and Ben created with the `acquisitionId`); `asOf` before (`NONE` before 2020, Sven 1/1 on the eve), on and after the date (Anna and Ben 1/2, `COMPLETE`), and the history (three periods) | §9, §9a |
| **Ownership shares validated** | An extra 1/2 for Carl from the transfer date is `422 OWNERSHIP_TOTAL_EXCEEDS_ONE` with `details.date = 2026-08-01` and `details.shareSum = 3/2` (§26.1); a confirm before the change is `422 CONFIRMATION_BLOCKED` with the violations; after confirmation Anna's Ownership cannot be voided (`409 ACQUISITION_CONFIRMED`) but closes | §9, §12 |
| **Realm isolation** across Phase 2 | Realm B gets `404` on **every route of api-design §19–§28** called with an id of Realm A (reads and commands, each a row of one table in ACC2 that the test iterates) and empty lists of its own; nothing is written. The table is compared with the routes the app serves (Express' router stack, filtered to the Phase-2 paths), so a new route without a row turns ACC2 red. `POST /parties` takes no id: what it creates belongs to Realm B and is `404` for Realm A | §4, §8–§14 |

ACC2 also checks the traceability that every write promises: AuditRecords for the acquisition's steps (`CREATED`,
`CONFIRMED`), the costs (`CREATED`, `VOIDED`), the payments (`LINKED`) and the allocations (`CREATED`, `SUPERSEDED`),
exactly these and with their entity ids. Counter-checked: the tie-break reversed, an extra route, the Realm filter
dropped from the Acquisition read, and a missing `VOIDED` record each turn ACC2 red.

## 16. Loan (VC-3-01, api-design §41.1)

`LN` = `domains/financing/loan.test.ts`, `LR` = `infrastructure/postgres/loan-repository.test.ts`, `LA` = `api/loans.test.ts`.

| Invariant | Tests |
|---|---|
| One canonical Loan: lender and borrowers active Parties of the Realm, checked lender first, then borrowers in order, then the Acquisition, then inactive | LR "order of checks …", "links an Acquisition …"; LA "400 with the field codes" |
| Principal, contract dates and Acquisition fixed (`NOT_AMENDABLE`); every other change is `version` + 1 out of `ACTIVE`; `VOID`/`CLOSED` final; inserted only `ACTIVE` with version 1; never deleted; P3-D8's no-op write passes | LR "fixed fields never change …", "a Loan is only inserted ACTIVE …"; LA "400: fixed fields NOT_AMENDABLE …" |
| Borrowers a column of the Loan (review on #59): 1–20, no duplicate, no `NULL` element (the CHECK alone), the lender never one in both directions, a swap passes, Realm and existence by trigger, a named Party never deleted | LR "borrowers: the lender never one …", "a newly named Party must be ACTIVE …"; LN "fieldErrors" |
| Amend: `409 LOAN_NOT_ACTIVE` before anything about Parties, a no-op included; merged rules (`LENDER_IS_BORROWER`, `NOT_AFTER_DISBURSEMENT`); only newly named Parties must be active; no-op `200` whatever the version | LN "planAmend"; LR "amend …" |
| Void: once, a repeat keeps the first reason; `CLOSED` final; refused while splits reference the Loan (from VC-3-05) | LN "planVoid"; LR "void …" |
| Lock order Parties → Loan: `deactivate` racing create (RC) and past the repository (RR, `40001`); amend racing void | LR "concurrency" |
| Realm isolation of every read and command | LR "reads: …", "void …" (another Realm is not found) |

Counter-checked: each trigger branch and CHECK above, the repository's Party lock and the amend order were neutralised in turn, and a test went red each time.

## 17. Loan terms (VC-3-02, api-design §41.2)

`TM` = `domains/financing/terms.test.ts`, `TR2` = `infrastructure/postgres/loan-terms-repository.test.ts`, `TA` = `api/loan-terms.test.ts`.

| Invariant | Tests |
|---|---|
| Rate exact: a decimal string with at most three decimals in `[0, 100)`, never a JSON number; stored with scale ≤ 3 | TM "rates"; TA "400 with the field codes"; TR2 "the payment matches the model …" |
| Interest `round_half_up(balance × rate / 100 / 12)` in cents, exactly half a cent rounds up; monthly payments from `firstPaymentDate`, clamped to the month end | TM "monthlyInterest", "addMonths", "deriveSchedule" |
| Periods only appended: not before the debt, after the last start and after its first payment (review on #61); only the last one voidable; `validUntil` derived over `VALID` periods | TM "checkAppend …", "planVoidTerms and withValidUntil"; TR2 "order of checks …", "void: …"; TR2 schema "inserts: …", "updates: …" |
| `principalAtStart` not on the first period, never above `principalOriginal`; restarts the carried-over balance | TM "plannedBalanceOn", "checkAppend …" |
| An annuity must exceed the first interest on the balance it starts from (equal refused, one cent above passes; review on #58) | TM "an annuity must exceed …"; TR2 "order of checks …" (carried-over 99 499.38 → 248.75) |
| `scheduledPayment` exactly for `ANNUITY`; data never edited; `VALID` → `VOID` with `version` + 1 only; never deleted | TR2 schema; TA "400 with the field codes" |
| Lock order: the Loan row first, in the repository and in both triggers (review on #61): two appends (RC sees the first, RR `40001`), append against a void of the Loan, a raw void of the last period against a raw append behind it (RC refused, RR `40001`) | TR2 "concurrency …" |
| Realm isolation | TR2 "order of checks …", "void: …" |

Counter-checked: each trigger branch and CHECK, both Loan writes in the triggers, the repository's Loan lock, and in the domain the strict annuity bound, `round_half_up`, the carry-over boundary and the first-payment rule were neutralised in turn; a test went red each time.

## 18. Loan allocation sets (VC-3-03, api-design §41.3)

`AL` = `domains/financing/allocation.test.ts`, `AR` = `infrastructure/postgres/loan-allocation-repository.test.ts`, `AA` = `api/loan-allocations.test.ts`.

| Invariant | Tests |
|---|---|
| Shares exact: `PURCHASE_PRICE` derives `price_i / Σ price` in cents, reduced (300 000.00 / 175 000.00 → `12/19`, `7/19`), a denominator above 10 000 stored exactly; `MANUAL` is §26.1's `"n/d"` (`d ≤ 10000`), reduced | AL "allocation shares"; AR "appends a manual and a purchase-price set …", "stores a purchase-price denominator above 10 000 exactly"; AA "400 with the field codes" |
| A set sums to exactly `1/1` (`1/3 + 1/3 + 1/3` passes, `1/3 + 2/3 + 1/10000` not), checked at the API and **at commit** by the deferred trigger; a set without rows and a row added to a committed set are refused | AL "sums manual shares exactly"; AA "400 …" (`SHARE_SUM_NOT_ONE`); AR schema "the sum is exactly one at commit …", "a committed set takes no further row …" |
| One entry per property; an Acquisition only of the entry's property (0020's key); the basis and `acquisition_id` agree; `CANCELLED` Acquisitions refused when the set is written | AR "order of checks …"; AR schema "a share is a reduced fraction …", "an Acquisition only of the entry's property …"; AA "400 …" (`DUPLICATE`, `NOT_ALLOWED_FOR_BASIS`) |
| Sets only appended: not before the debt, after the last `VALID` start; only the last one voidable; `validUntil` derived over `VALID` sets; data never edited, rows never updated or deleted, sets never deleted | AL "sets over time"; AR "order of checks …", "void: …"; AR schema "inserts: …", "updates: …", "a committed set takes no further row …" |
| Order of checks: Loan → not `ACTIVE` → before the debt → not appended → the PropertyReferences in the order given → the Acquisitions in the order given | AR "order of checks …" |
| Reads: the set on a day (`null` before the first), the history with `?status`, the Loans of a property with `asOf` before, on and after a change of set, `VOID` sets and `VOID` Loans left out; `asOf` with `status` is `400` | AL "finds the set covering a day …", "lists a property per set …"; AR "reads: …"; AA "GET …" |
| Lock order: the Loan row first, in the repository and in both triggers: two appends (RC sees the first, RR `40001`), an append against a void of the Loan, a raw void of the last set against a raw append behind it (RC refused, RR `40001`) | AR "concurrency …" |
| Realm isolation | AR "order of checks …", "void: …", "reads: …" |

Counter-checked: each refusal of the four triggers of 0026 and the share CHECK's parts (the deferred trigger set to `INITIALLY IMMEDIATE` makes a valid multi-row set fail; the sum and the basis/`acquisition_id` checks each neutralised on their own; both Loan writes), the composite key to the Acquisition, `UNIQUE (set_id, property_reference_id)`, the repository's Loan lock, its Realm and property filters, `CANCELLED`, the order PropertyReferences → Acquisitions and the `VOID` Loan filter, in the domain the reduction, the day boundaries, the append boundary, the last-set rule, the `VOID` set filter and the order, and at the API the sum, both `DUPLICATE`s, `NOT_ALLOWED_FOR_BASIS` and `asOf` with `status` were neutralised in turn; a test went red each time.

## 19. Loan schedule (VC-3-04, api-design §41.4)

`SC` = `domains/financing/schedule.test.ts`, `TR2` = `infrastructure/postgres/loan-terms-repository.test.ts`, `TA` = `api/loan-terms.test.ts`.

| Invariant | Tests |
|---|---|
| The hand-computed example of §41.4 row for row (3.525 rounds up; the last payment 111.12; Σ interest 11.12) | SC "the hand-computed example …" |
| A full annuity repays exactly its principal; every payment but the last is the scheduled one, the last at most it | SC property "over 400 seeded random full annuities …" |
| Against an independent oracle (dates with their own month-end clamp, `round_half_up` as its own formula): balances chain and carry over, `principalAtStart` restarts, a period stops at the next one, at `maturityDate` and at 600 payments and nowhere earlier, the summary and `endReason` | SC property "over 400 seeded random plans …"; SC "carries the balance …", "interest-only …", "an annuity cut by maturity …", "clamps …" |
| `endReason` on ties: `PAID_OFF` before `MATURITY` before `PAYMENT_CAP`; a follow-up period after 0 without `principalAtStart` has no payments (review on #65); `NO_TERMS` | SC "ties …", "a follow-up period after the plan reached 0 …", "NO_TERMS …" |
| A window keeps the numbers and the summary; `to` before `from` is `400 BEFORE_FROM` | SC "a window …"; TA "GET …/schedule" |
| Only `VALID` periods, the Loan and its periods in one snapshot; Realm isolation | TR2 "schedule inputs …" |
| Never stored: no table, no command | §41.4 (no migration) |

Counter-checked: in the domain `round_half_up` replaced by truncation, the cap on the last principal, the carry-over, `principalAtStart`, the stop at the next period and at `maturityDate` (also made exclusive), the clamping, the 600 cap (as 601) and the tie between the cap and maturity each turned the oracle property test red. The ties `MATURITY` before `PAID_OFF`, the window bounds, the `VALID` filter and the Realm of the read, `BEFORE_FROM`, the Money of the response and the LoanTerms audit's `notes` (#64 nit) each turned their own tests red.

## Keeping this current

A new invariant gets a schema-level test when the schema can express it, a
repository or domain test otherwise, and a line here. Removing or weakening a
test listed here needs the same review as changing the invariant itself.
