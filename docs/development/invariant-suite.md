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
| **ACC3** | `phase-3-acceptance.e2e.test.ts` (Phase-3 exit through the API, VC-3-08) |
| **ACC4** | `phase-4-acceptance.e2e.test.ts` (Phase-4 exit through the API, VC-4-06) |
| **ACC5** | `phase-5-acceptance.e2e.test.ts` (Phase-5 exit through the API, VC-5-05) |
| **ACC6** | `phase-6-acceptance.e2e.test.ts` (Phase-6 exit through the API, VC-6-06) |
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
| PropertyReference | `property-reference-repository.test.ts`; `application/refresh-property-reference.test.ts`; `property-reference.e2e.test.ts`; `reads.e2e.test.ts` (VC-X-25: Realm B's list holds only its own reference; Realm A's id read in Realm B is `404`) |
| FinancialAccount | `financial-account-repository.test.ts`; `financial-account.e2e.test.ts`; `reads.e2e.test.ts` (VC-X-25: the same for the account list and single read) |
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

## 5a. Balance identity and continuity (VC-1-12, data-model §70.6, ADR-043)

`IL` = `infrastructure/postgres/import-lookup.test.ts`, `BL` = `domains/ledger/balance-identity.test.ts`, `GC` = `integrations/bank-import/generic-csv.test.ts`; `BI`, `IR` as §5.

| Case | Tests |
|---|---|
| Overlapping exports with balance → shared rows `duplicate`, new rows created, no review item | IL "overlapping exports with balance …"; `bank-import.e2e.test.ts` "generic-csv v2 (ADR-043) …" |
| Same balance identity, other content → `BALANCE_IDENTITY_CONTENT_CONFLICT` | IL "the same balance identity with other content …"; BI "one with other content …" |
| Identity repeated in one file → fallback; against an earlier file → review, never a duplicate | IL "a repeated identity in one file uses the fallback …"; BL "only an identity unique in its file is used …" |
| Several existing matches → `AMBIGUOUS_CROSS_FILE_MATCH` naming all | IL "several existing matches …"; BI "several: …" |
| Broken chain (filtered export) and gap → reported, outcomes unchanged | IL "a broken chain (filtered export) is reported …"; BL "continuity …" |
| Only a possible predecessor chains: a balance recurring from before a gap is a gap (review on #114) | IL "a balance that only recurs from further back is no chain …" |
| v1 rows, then an overlapping v2 file → review once, not dropped | IL "v1 rows, then an overlapping v2 file …" |
| The balance is stored, kept by `CREATE`, fixed after creation (0034) | IL "a CREATE resolution keeps the balance …", "several existing matches …" |
| Adapter v2: signed balance, empty cell none, row errors; fingerprint unchanged; v1 refuses the key | GC "generic-csv v2 …" |

Counter-checked (8 mutants, each red): several matches taken as a duplicate; the content check dropped; the in-file uniqueness dropped; the balance not stored on import or on `CREATE`; `OVERLAPS` reported as `CHAINS`; the cross-file check not limited to earlier days; chain breaks never reported.

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
| Reversal and replacement keep the original's counterparty, along the chain and on `reverse`; their import identity stays empty; earlier corrections backfilled (#111, migration 0035) | CR "reversal and replacement keep the original's counterparty …", "writes a confirmed reversal and replacement …" (manual: none); `correction-counterparty-migration.test.ts` |
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

## 20. Loan payments (VC-3-05, api-design §41.5)

`LP` = `infrastructure/postgres/loan-payment-repository.test.ts`, `TS` = `domains/ledger/transaction-split.test.ts`, `PP` = `domains/financing/payment-proposal.test.ts`, `PA` = `application/payment-proposal.test.ts`, `SA` = `api/transaction-splits.test.ts`, `TA` = `api/loan-terms.test.ts`, `XA` = `api/transactions.test.ts`, `XL` = `api/transaction-lifecycle.test.ts`.

| Invariant | Tests |
|---|---|
| A split with `loanId`: a Loan of the Realm, not `VOID`, `LOAN_INTEREST`/`LOAN_PRINCIPAL`, an `OUTFLOW` unless a reversal, never with a PropertyReference; in the repository and past it | TS "checkLoanSplits …"; LP "order of checks …"; LP schema "a Loan of the Realm and not VOID …"; SA "400 …" (`NOT_ALLOWED_WITH_LOAN`) |
| Order of checks: the existing ones, then an unknown Loan, the category, the direction, a `VOID` Loan, each first by position; nothing written on a refusal | TS "in the order of §41.5 …"; LP "order of checks …" |
| `loanId` is part of the split set: the same set is a no-op, a changed `loanId` a change; reads and the AuditRecord carry it | LP "stores loanId …"; SA "200 …" |
| Corrections: copied splits keep `loanId`; a replacement's own splits name another Loan or none, and must be `OUTFLOW`; the `INFLOW` reversal mirrors `loanId` (0014 compares it); what counts before and after | LP "correct: …", "reverse: …"; LP schema "a reversal mirrors loan_id …"; XL "maps the refusals of §35.4" |
| A Loan with splits, a reversal's included, cannot be voided, in the repository and past it; the guard's no-op write and an amend pass | LP "LOAN_HAS_SPLITS …", "reverse: …" |
| Lock order Transaction → Loan, the guard writing the Loan row: void against a split write in both orders (RC sees the other's result, RR `40001`); two writers naming two Loans in opposite order do not deadlock (id order); the trigger order in `pg_trigger` | LP "concurrency …"; LP schema "trigger order …" |
| The correction path too (review on #68): `correct` and `reverse` lock every Loan they write, the original's (mirrored by the reversal) and the replacement's, in id order before any split; two reverses, and two corrects with a replacement without a Loan, of payments naming two Loans in opposite order both end `CORRECTED` | LP "concurrency of corrections …" |
| The proposal: the nearest entry (the earlier on a tie), interest `min(entry.interest, amount)`, principal the rest, `INTEREST_ONLY` leaving it unallocated, the flags, the refusals in order; a read only | PP "proposePayment …"; PA "getPaymentProposal …"; TA "GET …/payment-proposal"; LP "the proposal's inputs …" |

Counter-checked (32 mutants, each red): in 0027 the guard's Loan write replaced by `FOR SHARE` (the RR test), each refusal of the guard, the reversal exemption, the trigger renamed to sort before `transaction_split_frozen`, the CHECK, the foreign key without the Realm, `loan_void_unreferenced` removed or firing on every update, the mirror without `loan_id`; in the repositories the Loan lock removed or taken in position order (the deadlock test), `checkLoanSplits` skipped in the splits command and in `correct`, `correct` locking only the replacement's Loans (both correction deadlock tests `40P01`), the reversal dropping `loan_id`, the void ignoring splits, the read without `loan_id`; in the domain `sameSplits` without `loanId`, the order of checks, the reversal exemption, and the proposal's tie, interest cap, `INTEREST_ONLY` principal, `ALREADY_SPLIT` and statuses; at the API `NOT_ALLOWED_WITH_LOAN`, the lower-cased `loanId`, the zero split and the signed difference; in the application the `VOID` refusal.

## 21. Remaining debt and lender statements (VC-3-06, api-design §41.6)

`DB` = `domains/financing/debt.test.ts`, `LD` = `infrastructure/postgres/loan-debt-repository.test.ts`, `AD` = `application/loan-debt.test.ts`, `PD` = `api/loan-debt.test.ts`.

| Invariant | Tests |
|---|---|
| Actual = `principalOriginal` − counted `LOAN_PRINCIPAL` up to and including the day; 0 before `debtFrom`; negative when more was paid; interest never counts | DB "debtOn …"; LD "booking dates up to and including asOf" |
| Only the splits that count (§41.5): not unconfirmed, not a reversed original or its reversal, the replacement's, not another Loan's | LD "only the splits that count …" |
| Planned = the plan's balance after its last payment on or before the day (a later period's `principalAtStart` from its `validFrom`); `null` with `NO_TERMS`; with `MATURITY` 0 from `maturityDate` inclusive, `PAYMENT_CAP` keeping `balanceDue` (review on #69) | DB "debtOn …", "MATURITY (review on #69)" |
| Per property: `actual` and `planned` by largest remainder (ties by `propertyReferenceId`, a negative total by its absolute value), the difference derived (F4b); columns sum exactly, each part within a cent, `difference_i = actual_i − planned_i` (seeded property test, a negative `actual` included) | DB "per property …" (the 3/7, 3/7, 1/7 counterexample, the property test) |
| The set covering `asOf`; `409 LOAN_NOT_ALLOCATED` per property only; a `VOID` Loan counts nowhere | DB "remainingDebt …"; LD "per property: the set covering asOf …"; AD; PD |
| Payments of a year: per category and Transaction count; per property each split by the set of its booking date, then summed; `LOAN_NOT_ALLOCATED` with the first booking date without a set | DB "paymentsInYear …"; LD "the payments of a year per property …"; PD |
| One `REPEATABLE READ READ ONLY` snapshot: a statement committed while the read waits is not seen | LD "one snapshot …" |
| Statements: the order of checks (404 → `VOID` Loan → before `debtFrom`), idempotency (the comparison derived again on replay), void as a no-op, `If-Match`, the audit; the comparison derived at each read and following a later correction; the latest `VALID` one on or before `asOf` | DB "statements …"; LD "statements"; AD; PD |
| P3-D8: a statement (insert and void) writes the Loan row; against a void of the Loan RC sees it, RR past the repository `40001` in both orders | LD "concurrency of a statement and a void of the Loan" |
| The schema past the repository: a Loan of the Realm, not `VOID`, not before the debt, only inserted `VALID` v1, `balance` ≥ 0 with two decimals, `source` trimmed; never edited or deleted, the only step `VALID` → `VOID` with `version` + 1 | LD "the schema past the repository …" |

Counter-checked (38 mutants, each red): in 0028 the append trigger's Loan write replaced by `FOR SHARE` (the RR test, statement first) or a plain read (the RC test), each refusal of the append trigger, the frozen trigger allowing an edit, a delete or any step, or without its Loan write, the `balance` and `source` CHECKs, the foreign key without the Realm; in the repository the counted splits without the status or the reversal filter, the create without the Loan lock, the inputs read in READ COMMITTED, the void without the version check, the replay with a stale comparison; in the domain the old maturity rule, `maturityDate` exclusive, the difference distributed directly, a negative total not by its absolute value, interest counted, the booking date exclusive, no `debtFrom` guard, the plan read before the day's payment, the latest statement ignoring `VOID` or the creation order on a tie, a year attributed by its last day's set, splits counted as payments, the statement checks swapped, the void's no-op after the Loan check, a `VOID` Loan read; in the application the `VOID` list and `asOf` in UTC; at the API an unsigned `actual`, `perProperty` defaulting to true and the year's range.

## 22. Closing a Loan and refinancing (VC-3-07, api-design §41.7)

`LC` = `infrastructure/postgres/loan-close-repository.test.ts`, `CL` = `domains/financing/close.test.ts`, `TS` = `domains/ledger/transaction-split.test.ts`, `PA` = `application/payment-proposal.test.ts`, `LA` = `api/loans.test.ts`.

| Invariant | Tests |
|---|---|
| Close's order of checks: `404`, `VOID`/`CLOSED` with other values `LOAN_NOT_ACTIVE`, before the debt, the refinancing Loan (unknown, foreign, `VOID`, `CLOSED`), `SPLITS_AFTER_CLOSING`, `REPAID` only at 0 (a rest and an overpayment signed); a repeat a no-op; `If-Match`; the AuditRecord with `settledAmount` | CL "planClose …"; LC "close: the order of checks"; LA "POST …/close" |
| `SPLITS_AFTER_CLOSING` counts current, open and `IGNORED` splits (`ignore` → `close` → `restore` cannot carry one past the date), not a `CORRECTED` original and its reversal: the refinancing scenario passes after the correction (review on #71) | LC "SPLITS_AFTER_CLOSING …", "the refinancing scenario …" |
| After the close no split names the Loan on a later booking date, through the splits command, `correct` and an amend of the booking date, in the repository and past it; on the date allowed; a reversal exempt | TS "a CLOSED Loan …"; LC "after closing", schema "the split guard …" |
| The reads: remaining debt 0 after the date (`principalPaid` kept, `NO_TERMS` `null`, per property zeros), `closing` with `actualOnClosingDate` following a later correction; the schedule cut with `endReason = CLOSED`, a plan ended before keeping its reason; the proposal `LOAN_CLOSED` after the date | CL "effects of CLOSED"; LC "the remaining debt …"; PA "a CLOSED Loan …", "getLoanSchedule …" |
| Statements up to the date, later `STATEMENT_AFTER_CLOSING`; terms and allocations refused | CL "statements …"; LC "statements up to the date …"; LC schema "the split guard …" |
| A successor is never voided: `LOAN_REFINANCES` after the close, in the repository and past it; allowed before it, and a close naming it then `REFINANCING_LOAN_NOT_ACTIVE` (review on #71) | CL "void of a successor …"; LC "a successor is never voided …"; LA "void of a successor …" |
| P3-D8: close against a split write and against a booking-date amend (RC sees the other's result, RR `40001`, both orders); `REFINANCED` against a void of the named Loan (RC both orders, RR `40001`); two booking-date amends naming two Loans in opposite order do not deadlock (id order) | LC "concurrency (P3-D8)" |
| The schema: the closing fields only with `CLOSED`, `REFINANCED` ↔ its Loan, `OTHER` with a note, not itself, not before the debt, the Realm, the note trimmed, final after the close; `loan_close_guard`'s three refusals, an `IGNORED` split after the date included | LC "the schema past the repository …" |

Counter-checked (39 mutants, each red):
- **in 0029:**
  - `loan_close_guard` counting every status or leaving out `IGNORED` (the raw schema test, review on #72), without its split check, its `REPAID` check or its successor check, and with its successor write replaced by `FOR SHARE` (the RR void test);
  - the split guard's Loan write replaced by `FOR SHARE` (the RR test, split first), without its closing rule or its reversal exemption;
  - the booking-date trigger in position order (the deadlock test, `40P01`), without its rule, or reading instead of writing (the RR test);
  - `loan_void_unreferenced` without `LOAN_REFINANCES`; the statement rule;
  - the CHECKs for `OTHER`, `REFINANCED`, the self reference and the debt; the foreign key without the Realm;
- **in the repositories:** close counting every status or not locking the successor; void ignoring the successors; amend without its closing check; `lockLoansOf` without the closing date;
- **in the domain:** `REPAID` checked before the splits; the no-op; the successor's status; the split rule without the reversal exemption, refusing on the date, or removed; the remaining debt without the closing rule; the schedule keeping its end reason or not cut; `planVoid` ignoring successors; statements after the date;
- **in the application:** the proposal without `LOAN_CLOSED`;
- **at the API:** the self reference, `refinancedByLoanId` and the note for `OTHER` not required.

## 23. Phase 3 exit (VC-3-08, roadmap Phase 3; implemented)

The exit of `docs/roadmap.md` Phase 3, claim by claim. Each claim is shown **end to end through the HTTP API** by
**ACC3**, one scenario against PostgreSQL and the fake MRE as ACC2 does for Phase 2, and is backed by the sections
above. The scenario's figures are hand-computed and stated here, so the test checks them literally.

**The scenario (Realm A):**
- Two PropertyReferences P1 and P2, each with a `DRAFT` Acquisition: prices 200,000.00 and 100,000.00.
- Loan L1 from Bank to Anna:
  - principal 240,000.00, start date 2027-01-01;
  - terms from 2027-01-01: `ANNUITY` at 3.000 % with a payment of 1,200.00 from 2027-01-31.
- The plan (§41.4), hand-computed:

  | Payment | Interest | Principal | Balance after |
  |---|---|---|---|
  | 2027-01-31 | 600.00 | 600.00 | 239,400.00 |
  | 2027-02-28 | 598.50 | 601.50 | 238,798.50 |
  | 2027-03-31 | 597.00 (596.99625 rounds up) | 603.00 | 238,195.50 |

| Exit claim | ACC3 step | Backed by |
|---|---|---|
| **A shared loan allocates to properties without duplication** | <ul><li>A `PURCHASE_PRICE` set from 2027-01-01 gives P1 2/3 and P2 1/3.</li><li>A `MANUAL` override from 2027-04-01 gives 1/2 and 1/2.</li><li>`GET /property-references/{id}/loans` lists L1 once per set for each property, with its share. There is one Loan, never one per property.</li><li>An override set not summing to 1/1 is `400 SHARE_SUM_NOT_ONE`. Before the first set, a per-property read is `409 LOAN_NOT_ALLOCATED`.</li></ul> | §16, §18 |
| **Interest/principal split flows into the ledger via `TransactionSplit`** | <ul><li>A bank CSV import brings four `OUTFLOW` rows: 1,200.00 on 2027-01-31, 2027-02-28 and 2027-03-31, and a special repayment of 5,000.00 on 2027-03-15.</li><li>For each regular row the payment proposal (§41.5) gives the plan's interest and principal. They are applied through `PUT …/splits` with `loanId`, and the Transaction is confirmed. The special repayment is split as all principal.</li><li>**A correction is re-counted.** February is first confirmed with interest and principal swapped (601.50 / 598.50). The remaining debt then shows 3.00 more owed. A `correct` with the right splits brings it back to the plan.</li><li>A split with `loanId` on an `INFLOW` is `422 INVALID_LOAN_SPLIT`.</li></ul> | §20 |
| **Remaining debt is derived, never stored as truth** | <ul><li>`remaining-debt?asOf=2027-03-31`: `principalPaid` 6,804.50, `actual` 233,195.50, `planned` 238,195.50, `difference` −5,000.00 (the special repayment).</li><li>With `perProperty=true` (the 2/3 : 1/3 set):<ul><li>`actual` 155,463.67 and 77,731.83 (the odd cent goes by largest remainder);</li><li>`planned` 158,797.00 and 79,398.50;</li><li>each `difference` derived: −3,333.33 and −1,666.67.</li></ul>Every column sums exactly to its total.</li><li>`payments?year=2027&perProperty=true`: interest 1,795.50 and principal 6,804.50 from 4 payments. P1 gets 1,197.00 and 4,536.33, P2 598.50 and 2,268.17 (the special repayment's odd cent goes to the larger remainder, ⅓). Each split goes by the set of its booking date, so the figures stay the same after the override from 2027-04-01.</li><li>A lender statement of 233,195.49 on 2027-03-31 compares at −0.01. It is shown and never replaces the derived value: after it the read still answers 233,195.50.</li><li>No table stores a remaining debt: `information_schema.columns` holds no column named like `remaining`, `outstanding` or `debt`. `loan_balance_statement.balance` is evidence (ADR-016), not a stored remaining debt. The value follows the ledger: the February correction moves it.</li></ul> | §19, §21 |
| **Refinancing and closing** (P3-D7; the end of the Loan's life in Phase 3) | <ul><li>Loan L2 from Bank2, principal 233,195.50 from 2027-04-01.</li><li>L1 is closed on 2027-03-31 as `REFINANCED` by L2. The AuditRecord's `settledAmount` is 233,195.50.</li><li>Afterwards:<ul><li>L1's remaining debt on 2027-04-01 is 0, and its `closing` names L2;</li><li>a split naming L1 on 2027-04-30 is `409 LOAN_CLOSED`;</li><li>a void of L2 is `409 LOAN_REFINANCES`;</li><li>L1's schedule ends with `endReason = CLOSED`.</li></ul></li></ul> | §22 |
| **Realm isolation** across Phase 3 | <ul><li>Realm B gets `404` on **every route of api-design §41** called with an id of Realm A, reads and commands. Each route is a row of one table that ACC3 iterates. Realm B's own lists are empty, and nothing is written.</li><li>The table is compared with the routes the app serves (Express' router stack, filtered to `/loans` and `/property-references/{id}/loans`). A new route without a row turns ACC3 red.</li><li>`POST /loans` from Realm B naming Realm A's Parties is `404`.</li></ul> | §16–§22 |

**Order of the steps:** the `MANUAL` override from 2027-04-01 is recorded before L1 is closed on 2027-03-31, since a `CLOSED` Loan takes no new set (§41.7).

ACC3 also checks the traceability every write promises. On the Loan aggregates (`Loan`, `LoanTerms`, `LoanAllocationSet`, `LoanBalanceStatement`) it expects exactly these AuditRecords, each with its entity id, and on the February Transaction its correction:
- L1 and L2: `CREATED`; L1: `CLOSED` with `settledAmount`;
- the terms: `CREATED`;
- the two allocation sets: `CREATED`;
- the statement: `CREATED`;
- the February Transaction: its correction.

**Counter-checks**, each of which turns ACC3 red:
- the year's payments attributed by the set of the year's last day instead of each booking date. This replaces the counter-check planned in #73, the derived difference distributed directly: ACC3's planned parts are exact (238,195.50 is divisible by 3), so there the direct and the derived difference coincide. F4b stays counter-checked by §21's 3/7, 3/7, 1/7 counterexample;
- reversals counted as payments;
- the closing rule of `checkLoanSplits` removed (the database guard is counter-checked in §22, LC);
- the Realm filter dropped from the remaining-debt read;
- an extra Phase-3 route without a row;
- a missing `CLOSED` AuditRecord.

## 24. Rent reconciliation: manual match and release (VC-4-01, api-design §37.1)

`RR` = `infrastructure/postgres/rent-reconciliation-repository.test.ts`, `RD` = `domains/rent-reconciliation/reconciliation.test.ts`, `RU` = `application/rent-reconciliations.test.ts`, `RA` = `api/rent-reconciliations.test.ts`, `RE` = `rent-reconciliation.e2e.test.ts`, `MC` = `integrations/mre/http-mre-client.test.ts`.

| Invariant | Tests |
|---|---|
| Only counted `INFLOW` rent cash is matched, in §37.1's order: unknown or foreign, not counted (unconfirmed, a reversal, a `CORRECTED` original), `OUTFLOW`, no rent split, the same term twice, beyond the available amount; rent cash is the `RENT_*` splits only | RD "checkMatch …"; RR "create: the cash rules in their order" |
| Cash is never consumed twice (BR-RENT-005): available = rent cash − `CONFIRMED`; a release makes it available again; one Transaction over several terms or Tenants, several Transactions per term | RD "available …"; RR "rent cash is …", "several Transactions per term …" |
| MRE is read between the two DE checks, with the caller's token and Realm: a refusal or a replay never asks MRE; a term MRE does not return (`422`) or an MRE outage (`503`) writes nothing; the term read is parsed to existence only | RU "create: …"; RE "a manual match …", "a term MRE does not return …"; MC "rentTermExists …" |
| A matched Transaction is not corrected or reversed until released (P4-D7), in the repository and past it; the Transaction itself is never changed | RR "correct and reverse are refused …", "writes AuditRecords …"; RE "a reversal of a matched Transaction …" |
| Release: DE-only; a repeat a no-op keeping the first reason; `If-Match`; `SUGGESTED`/`REJECTED` not releasable; AuditRecords `CONFIRMED` (manual) and `RELEASED` | RD "planRelease …"; RR "release and reads", "writes AuditRecords …"; RA "POST …/release" |
| Realm isolation: get, release, list and create from another Realm see nothing of Realm A | RR "findById and list in the Realm …"; RE "Realm isolation …" |
| P4-D8: two creates on one Transaction (RC: the second sees the first; RR `40001`); the same match twice (`ALREADY_MATCHED`); a create against a reversal, both orders (RC), and against the step to `CORRECTED` (RR `40001`); a release lets a waiting create use the cash | RR "concurrency (P4-D8)" |
| The schema: born only `SUGGESTED` or `CONFIRMED` with version 1 (review on #77), the cash guard's four refusals (a reversal included), the partial unique index, the CHECKs (term and Tenant form, amount > 0, status fields, EUR, `NOT_WRITTEN` only), the fixed fields, the status steps with `version` + 1, no `DELETE` | RR "schema past the repository (migration 0030)" |

Counter-checked (17 mutants, each red):
- **in 0030:** the insert guard (any status and version at the insert); the cash guard's Transaction write replaced by `FOR SHARE` (the RR tests), without its sum check or its reversal rule; `ledger_transaction_rent_reconciled` without its refusal; the unique index not unique; the frozen fields free;
- **in the repositories:** create without the Transaction lock; the correction path not reading the reconciliations; rent cash over every category; `findById` without the Realm; no `RELEASED` AuditRecord;
- **in the domain:** the same term not checked; release without `version` + 1;
- **in the application:** MRE asked before the precheck;
- **in the MRE client and the fake MRE:** a `404` read as found; the fake without the `rents.term` filter (review on #76).

## 25. Rent reconciliation: coverage reads (VC-4-02, api-design §37.2)

`RR`, `RD`, `RU`, `RA`, `RE`, `MC` as §24.

| Invariant | Tests |
|---|---|
| MRE settlement and DE cash stay two records: the per-term read shows MRE's amount due and payments next to DE's matches; MRE's payments never enter `matchedTotal` or the coverage (BR-RENT-001, the Phase-4 exit) | RU "AVAILABLE …"; RE "coverage of a term …" |
| Coverage from DE cash against MRE's amount due: `UNMATCHED`, `PARTIALLY_MATCHED`, `MATCHED` (also 0 of 0), `OVERPAID`, with a signed `openAmount`; `matchedTotal` over `CONFIRMED` only | RD "coverageOf …", "matchedTotalOf …"; RE "coverage of a term …" |
| An MRE outage never hides DE's side (`UNAVAILABLE`), an unknown term is `NOT_RETURNED`, a refused caller stays `403` | RU "NOT_RETURNED and UNAVAILABLE …"; RA "UNAVAILABLE answers nulls …"; RE "coverage of a term …" |
| MRE floats exactly from their decimal text, exponent notation included, rounded half-up to the cent, never `-0.00`; the term parsed to the amount due and payments only (no name, contacts or description); a payment date `DD/MM/YYYY` or `null` | MC "readRentTerm …", "decimalText …" |
| Per Transaction: counted, rent cash, matched, available (`null` unless counted); never asks MRE; Realm-scoped DE sides | RU "per Transaction …"; RR "coverage reads, DE side"; RE "coverage of a term …" |

Counter-checked (9 mutants, each red): MRE's payments summed into `matchedTotal`; `RELEASED` summed; the coverage boundary off by a cent; the MRE amount truncated; exponent notation refused (the `e-15` case); an outage turned into a `503`; `available` although not counted; `termSide` without the Realm; the payment date's day and month swapped.

## 26. Rent reconciliation: suggestions (VC-4-03, api-design §37.3)

`RR`, `RD`, `RU`, `RA`, `RE`, `MC` as §24; `RS` = `domains/rent-reconciliation/suggestion.test.ts`, `RSS` = `infrastructure/postgres/rent-suggestion-store.test.ts`.

| Invariant | Tests |
|---|---|
| A suggestion only for an exact amount (available rent cash = the term's open amount, MRE's amount due − DE's `CONFIRMED`, never MRE's payments) booked from the 15th of the month before to the end of the term's month | RS "one Transaction and one term …", "the booking window …", "an amount a cent off …"; RU "suggest: MRE months …" |
| Only unique pairs: an ambiguity is left alone or decided by the IBAN history of the same Tenant (`HIGH`); never by input order | RS "two Transactions for one term …", "the IBAN history decides …", "two separate unique pairs …" |
| Open suggestions stay in the graph as competition, in both steps, and are never written again; the months before `from` and after `to` are read and block, never suggested (review on #80) | RS "an open suggestion T1–A blocks …", "a Transaction booked on the 20th of `to` …"; RU "suggest: MRE months …"; RE "suggestions (§37.3) …" |
| A rejected, released or confirmed pair is never suggested again; a repeat writes nothing; a pair changed between the snapshot and the write is skipped | RS "a handled pair …"; RSS "writeSuggestions …", "reject …"; RE "suggestions (§37.3) …" |
| A suggestion never counts or consumes cash until confirmed | RSS "writeSuggestions …", "suggestionSnapshot …"; RE "suggestions (§37.3) …" |
| Confirm: DE's checks, then MRE live (no MRE call on a refusal or a no-op), then the checks again under the locks; may lower, never raise the amount (`422 ABOVE_SUGGESTION`); `409 SUGGESTION_STALE` when the term was matched in between; `If-Match`; AuditRecord `CONFIRMED` with `manual = false` | RD "planConfirm …", "staleBy …"; RU "confirm: …"; RSS "confirm: …"; RA "confirm: …"; RE "suggestions (§37.3) …" |
| Reject: final, a repeat a no-op keeping the first reason; `CONFIRMED`/`RELEASED` not rejectable; AuditRecord `REJECTED` | RD "planReject …"; RSS "reject: …"; RA "reject: …" |
| MRE month read with the caller's token and Realm, parsed to Tenant, term and amount due only; MRE down or refusing writes nothing | MC "listRentTerms …"; RU "suggest: a year boundary …"; RA "suggest: 400 …"; RE "suggestions (§37.3) …"; `mre.contract.test.ts` |
| P4-D8: a run waiting on another run's pair skips it (the index); a confirm waiting on a manual match of the same cash is `RENT_CASH_EXCEEDED` (RC), RR `40001`; a confirm against a reversal of its Transaction (RC: `TRANSACTION_NOT_COUNTED`; RR, the step to `CORRECTED` after a confirm, `40001`) | RSS "concurrency: …" |
| The schema (0031): the suggestion and rejected fields, the `SUGGESTED` index, `matched_amount` only lowered in the step to `CONFIRMED`, a `SUGGESTED` insert only on counted `INFLOW` rent cash | RSS "schema (0031) …" |

Counter-checked (30 mutants, each red):
- **in the rule:** a handled pair suggested again; open suggestions left out of the uniqueness check, in either step; ambiguity broken by input order; the history ignored; the booking window a day early at either end; the neighbours' terms suggested;
- **in the application:** the confirmed matches not subtracted from the open amount; the neighbouring months not read; the candidate dates only the window's; confirm without the live MRE read;
- **in the domain:** confirm raising the amount; the stale check dropped; a `CONFIRMED` reconciliation rejectable;
- **in the repository:** a rejected pair not handled in the snapshot; an existing pair not skipped on the write; the available cash not re-checked on the write; the snapshot without the Realm; a suggestion counted as consumed cash in the snapshot; confirm without the Transaction lock;
- **in 0031:** a suggestion counted as consumed cash by the cash guard; a `SUGGESTED` insert past the cash guard's checks; `matched_amount` raised on confirm, or the rule dropped; the `SUGGESTED` index not unique; the rejected-fields and suggestion-fields CHECKs;
- **in the MRE client:** the month's amount truncated; the month not zero-padded.

## 27. Rent reconciliation: write-back to MRE (VC-4-04, api-design §37.4)

`RR`, `RD`, `RA`, `RE`, `MC` as §24; `RW` = `domains/rent-reconciliation/write-back.test.ts`, `RWS` = `infrastructure/postgres/rent-write-back-store.test.ts`, `RB` = `application/rent-write-back.test.ts`, `CT` = `integrations/mre/mre.contract.test.ts` (the real MRE baseline, CI job `compose-smoke`).

| Invariant | Tests |
|---|---|
| One MRE payment per reconciliation: the marker `DE-RPR-<id>`, the booking date `DD/MM/YYYY`, `transfer`, the amount written from its decimal text | RW "the DE payment …"; RE "write-back (§37.4) …" |
| MRE's PATCH replaces the whole settlement, so the term goes back as read: every payment (normalised as MRE stores it, review on #82), the promo, the extra charge, the description, the notes without their trailing `\n`; `_id` in the body | RW "writeBody …", "storedPayments …"; MC "readRentTermForWriteBack … writeRentTermPayments …"; CT "PATCH /rents/payment/:id/:term …"; RE "write-back (§37.4) …" |
| Exactly once (BR-MRE-006): `WRITTEN` is a no-op without an MRE call; every attempt reads before it writes; a crash between the PATCH and the record, retried after the lease, adds no second payment; a lost answer is `WRITTEN` by the second read | RB "the marker already there once …", "a lost answer …"; RE "exactly once …", "write-back (§37.4) …" |
| Verified after the write: the marker once, every other payment and the settlement as read; otherwise `MRE_TERM_CHANGED`; a marker edited in MRE is `MRE_PAYMENT_CHANGED`; DE never repairs MRE | RW "verifyWritten …", "markerIn …"; RB "an answer without DE's payment …" |
| Under a VAT ratio with a promo or an extra charge nothing is written (`MRE_TERM_NOT_ROUND_TRIPPABLE`, back to `NOT_WRITTEN`) | RW "isRoundTrippable …"; RB "under VAT …" |
| Failure keeps the match (BR-RENT-010): `FAILED` with its code, the cash still matched, retried by the same command; each code and its answer | RB "the read …", "the PATCH refused …"; RA "write-back to MRE (§37.4) …"; RE "write-back (§37.4) …" |
| One write-back per MRE Tenant at a time: the lease, the Tenant index, the takeover of an expired lease by the same reconciliation and by another one (the old row `FAILED`, `LEASE_EXPIRED`), a record only under its own attempt | RD "planRelease and planWriteBack …"; RWS "takeover after an expired lease …", "claim → PENDING …", "concurrency (RC) …", "concurrency (RR …)" |
| Release (P4-D7) stays DE-only: `NOT_WRITTEN` stays, `WRITTEN`, `FAILED` and an expired `PENDING` become `REMOVAL_REQUIRED`, a live lease refuses | RD "planRelease and planWriteBack …"; RWS "release (P4-D7) …", "schema (0032) …"; RA "release under a live lease …"; RE "write-back (§37.4) …" |
| The presence check is a read only: `PRESENT`, `MISSING`, `UNAVAILABLE`, `null` without an MRE call when nothing was written | RB "getReconciliationWithPresence …"; RA "GET ?checkMre=true …"; RE "write-back (§37.4) …" |
| The schema (0032): the field sets per state, the states per status, born `NOT_WRITTEN`, each allowed and refused step, the release rule, the Tenant index | RWS "schema (0032) …"; RR "schema past the repository (migration 0030) …" |
| Realm isolation: another Realm can neither write back nor check a reconciliation; MRE's own Realm check | RE "write-back (§37.4) …"; MC "readRentTermForWriteBack …" |

Counter-checked (25 mutants, each red):
- **in the MRE client:** the PATCH without `_id`;
- **in the domain:** the description, the promo or an existing payment not sent back; the amount by float arithmetic from cents; the round-trip rule dropped; payments compared raw (review on #82); release keeping `WRITTEN`, or a `FAILED` released without `REMOVAL_REQUIRED`; another or its own live lease ignored;
- **in the application:** no read before the write (the crash test then adds a second payment); the verification skipped; no second read after a lost answer; a refused caller not recorded; the presence check always `PRESENT`;
- **in the repository:** the record without the attempt check; the takeover without failing the expired row (the claim is then refused by the index);
- **in 0032:** the Tenant index not unique; the trigger's release rule dropped; a release under a live lease allowed; `PENDING` → `PENDING` under a live lease; a row born with a write-back state; the write-back fields CHECK and the state-per-status CHECK dropped.

## 28. Rent reconciliation: removal from MRE after release (VC-4-05, api-design §37.5)

`RR`, `RD`, `RW`, `RWS`, `RB`, `RA`, `RE`, `CT` as §24 and §27; `RM` = `infrastructure/postgres/rent-reconciliation-migration.test.ts`.

| Invariant | Tests |
|---|---|
| Only DE's payment is removed: the marker with DE's date and amount; every other payment, the promo, the extra charge and the description stay; a marker edited in MRE is `MRE_PAYMENT_CHANGED` | RW "removalBody …", "verifyRemoved …"; RB "the marker absent …"; RE "removal (§37.5) …"; CT "the removal PATCH removes only DE's payment …" |
| Exactly once: `REMOVED` is a no-op without an MRE call; the marker absent → `REMOVED` without a PATCH; a crash between PATCH and record, retried after the lease, sends no second PATCH; a lost answer is decided by the second read | RB "the marker absent …", "a missing term …"; RE "removal exactly once …", "removal (§37.5) …" |
| A missing term is no proof the payment is gone (MRE's 404 on its own errors) → `REMOVAL_FAILED`; under VAT with a promo or extra charge nothing is written (back to `REMOVAL_REQUIRED`) | RB "a missing term …", "the marker absent …" |
| The lease assumption (review on #82): the latest lease end is kept for good and only grows; a removal before it plus one MRE timeout is `REMOVAL_TOO_EARLY`; the database refuses a removal claim before it | RD "removal: only RELEASED …"; RWS "refusals: …", "schema (0033) …"; RE "removal (§37.5) …"; RA "removal from MRE (§37.5) …" |
| One MRE write per Tenant: the index over `PENDING` and `REMOVING`; an expired `REMOVING` is taken over by a removal and by a write-back of the Tenant (`REMOVAL_FAILED`, `LEASE_EXPIRED`, review on #84); a live one blocks both | RD "removal: only RELEASED …"; RWS "takeovers: …", "concurrency: a removal waiting …", "schema (0033) …" |
| The backfill (review on #84): a `REMOVAL_REQUIRED` from a failed write-back gets `released_at + 2 minutes`, a `WRITTEN` its written time + 2 minutes, `NOT_WRITTEN` stays `NULL`; the CHECK keeps every claimed state's last lease end not null | RM "a REMOVAL_REQUIRED from FAILED …", "a removal of the released failed write-back …"; RWS "schema (0033) …" |
| Release on the database's clock (review on #83): an application clock running ahead gets `WRITE_BACK_IN_PROGRESS`, never a `500`; one running behind does not keep a lease the database has ended (review on #85: the expired `PENDING` is released as `REMOVAL_REQUIRED`) | RWS "release on the database clock …" (both) |
| The presence check also reads `REMOVAL_FAILED` and `REMOVED`: `PRESENT` on `REMOVED` reports a payment that reappeared | RB "getReconciliationWithPresence …"; RE "removal (§37.5) …" |
| Realm isolation: another Realm cannot remove a reconciliation | RE "removal (§37.5) …" |

Counter-checked (19 mutants, each red):
- **in the domain:** a payment without DE's marker removed; the lease margin dropped; `REMOVED` not a no-op; a removal from `NOT_WRITTEN` allowed;
- **in the application:** the read before the removal skipped (the crash test then sends a second PATCH); the removal verification skipped; the presence check not on `REMOVED`;
- **in the repository:** the last lease end cleared on record, or set instead of raised; the record without the attempt check; the claim's holders only `PENDING` (review on #84); an expired `REMOVING` failed as `FAILED`; the release on the application's clock without the trigger's mapping, and the release on the application's clock alone (review on #85: the clock running behind then refuses a lease the database has ended);
- **in 0033:** the index without `REMOVING`; the trigger letting the last lease end change outside a claim, or allowing a removal claim before it; the last-lease CHECK dropped; the removed-fields CHECK dropped; the backfill without `released_at` (review on #84; the migration then fails its own CHECK).

## 29. Phase 4 exit (VC-4-06, roadmap Phase 4; implemented)

The exit of `docs/roadmap.md` Phase 4, claim by claim: *a bank transaction can be matched to an MRE rent obligation, confirmed by a human, and written back to MRE exactly once; MRE settlement and DE cash remain distinct records.* Each claim is shown **end to end through the HTTP API** by **ACC4** (`phase-4-acceptance.e2e.test.ts`), one scenario against PostgreSQL and the fake MRE, as ACC3 does for Phase 3. It is backed by §24–§28. The figures are hand-computed and stated here, so the test checks them literally.

**The scenario (Realm A, the fake MRE's Realm A):**
- Two MRE Tenants: T1 (Tina) with the terms `2027030100` and `2027040100`, each 800.00 due; T2 (Tom) with the same terms, each 650.00 due. T1's March term already holds **MRE's own payment** of 100.00 (`cash`, recorded in MRE by hand). T2's April term is 660.00 rent less a settlement discount (`promo` 10.00, note "Rabatt", no VAT), so 650.00 due as MRE answers it (`totalWithoutBalanceAmount`), and carries the description "April".
- A bank CSV import (`generic-csv`, as ACC3) into one `BANK` FinancialAccount brings four `INFLOW` rows:

  | Row | Booking date | Amount | Counterparty IBAN | Meaning |
  |---|---|---|---|---|
  | R1 | 2027-03-02 | 800.00 | DE…01 (Tina) | T1's March rent |
  | R2 | 2027-03-05 | 400.00 | DE…02 (Tom) | part of T2's March rent |
  | R3 | 2027-03-20 | 250.00 | DE…02 (Tom) | the rest of T2's March rent |
  | R4 | 2027-04-03 | 1,450.00 | DE…02 (Tom) | T1's and T2's April rent in one transfer (800.00 + 650.00) |

- Each row is split as `RENT_BASE` (its whole amount) and confirmed. Leases in the ACC4 wiring are short (a few hundred ms) so the removal can follow without waiting a real MRE timeout.

| Exit claim | ACC4 step | Backed by |
|---|---|---|
| **A bank transaction can be matched to an MRE rent obligation** (suggested) | <ul><li>`POST /rent-reconciliations/suggest { from: 2027-03, to: 2027-04 }` answers exactly **one** suggestion: R1 → T1 `2027030100`, 800.00, `MEDIUM`, `EXACT_AMOUNT`.</li><li>Nothing else fits: R2, R3 and R4 match no open amount exactly (400.00, 250.00 and 1,450.00 against 800.00 and 650.00), and R1 is outside the April window (from 2027-03-15).</li><li>A suggestion is not cash: before the confirm, R1's `available` is 800.00 and T1's March `matchedTotal` is 0.00.</li><li>A repeat of the run writes nothing (`items: []`).</li></ul> | §26 |
| **… confirmed by a human** | <ul><li>`POST …/{id}/confirm` with `If-Match: "1"` → `CONFIRMED`, `version` 2. The live MRE read happens with the caller's token.</li><li>T1's March coverage: `matchedTotal` 800.00, `coverage` `MATCHED`, `openAmount` 0.00.</li></ul> | §24, §26 |
| **A partial and a combined payment matched by hand** | <ul><li>Partial: R2 → T2 March 400.00 and R3 → T2 March 250.00 (two manual creates). T2's March coverage goes `PARTIALLY_MATCHED` (`openAmount` 250.00), then `MATCHED`.</li><li>Combined: R4 → T1 April 800.00 and R4 → T2 April 650.00. R4's `available` goes 1,450.00 → 650.00 → 0.00.</li></ul> | §24, §25 |
| **Cash is never consumed twice** | <ul><li>R4 → T1 March 0.01 more is `409 RENT_CASH_EXCEEDED` with `available` 0.00.</li><li>R1 → T1 April 800.00 is `409 RENT_CASH_EXCEEDED` (R1 is fully matched by the confirmed suggestion).</li><li>The same match twice (R2 → T2 March) is `409 ALREADY_MATCHED`.</li></ul> | §24 |
| **… written back to MRE exactly once** | <ul><li>`POST …/{R1's id}/write-back-to-mre` → `WRITTEN`. T1's March term in MRE now holds MRE's own 100.00 **and** DE's 800.00 with the marker `DE-RPR-<id>`, booking date 02/03/2027, `transfer`. The fake MRE counts one PATCH.</li><li>A **repeat** answers `200` without an MRE call and adds nothing.</li><li>A **crashed** earlier attempt: before writing back R4 → T2 April, the fake MRE's term already holds DE's payment with that reconciliation's marker, as if an earlier attempt's PATCH had reached MRE and its record had not. The write-back reads it, records `WRITTEN` **without a PATCH**, and the term holds the marker once. T2 April's promo 10.00 and description "April" are untouched.</li><li>A **lost answer**: the fake MRE applies the PATCH for R4 → T1 April but drops the answer; the second read records `WRITTEN`, and the term holds the marker once.</li></ul> | §27 |
| **MRE settlement and DE cash remain distinct records** | <ul><li>T1's March coverage (§37.2) shows MRE's two payments (100.00 `cash`, 800.00 with the marker) **next to** DE's one match. `matchedTotal` stays 800.00 and `coverage` `MATCHED`: MRE's payments are never added.</li><li>R1 is still one Transaction of 800.00 with one split; the write-back changed no Transaction (its `version` is unchanged).</li><li>`?checkMre=true` on R1's reconciliation reports `PRESENT`.</li></ul> | §25, §27 |
| **A correction is refused until release, and a release is DE-only** | <ul><li>A reversal of R2 is `409 TRANSACTION_RENT_RECONCILED` with R2's reconciliation id.</li><li>Release of R2 → T2 March → `RELEASED`, `NOT_WRITTEN` stays. T2's March coverage drops to `PARTIALLY_MATCHED`, `openAmount` 400.00. The reversal of R2 then succeeds.</li><li>Release of R1's written match → `REMOVAL_REQUIRED`; it asks MRE nothing. After the lease, `remove-from-mre` → `REMOVED`: T1's March term holds only MRE's own 100.00 again.</li></ul> | §24, §28 |
| **Realm isolation** across Phase 4 | <ul><li>Realm B calls **every route of api-design §37** with Realm A's ids. Each route is a row of one table that ACC4 iterates, and each row carries the answer it expects:<ul><li>`404` for the routes named by a reconciliation or Transaction id: `GET /rent-reconciliations/{id}` (also with `?checkMre=true`), `confirm`, `reject`, `release`, `write-back-to-mre`, `remove-from-mre`, `GET /transactions/{id}/rent-reconciliations`, and `POST /rent-reconciliations` with Realm A's `transactionId`;</li><li>`200` with an empty DE side (`reconciliations: []`, `matchedTotal` 0.00), `mreStatus` `NOT_RETURNED` and `mre` `null` for the term read `GET /rent-reconciliations/terms/{T1}/2027030100` (§37.2: MRE's read carries Realm B's `organizationid`);</li><li>`200` with an empty page for the list `GET /rent-reconciliations` with Realm A's `transactionId`, `mreTenantId` or `mreRentTerm` as filter (§37.1: a foreign filter is a read filter, not `404`);</li><li>`200` with `items: []` for a suggestion run in Realm B over the same months.</li></ul></li><li>After every row, nothing is written in Realm A: its reconciliations, versions and AuditRecords are unchanged, and the fake MRE counts no PATCH.</li><li>The table is compared with the routes the app serves (Express' router stack, filtered to `/rent-reconciliations` and `/transactions/{id}/rent-reconciliations`). A new route without a row turns ACC4 red.</li></ul> | §24–§28 |

ACC4 also checks the traceability every write promises. On the reconciliations it expects exactly these AuditRecords, each with its entity id:
- R1 → T1 March: `SUGGESTED`, `CONFIRMED` (`manual = false`), `WRITE_BACK_STARTED`, `WRITE_BACK_WRITTEN` (`patched = true`), `RELEASED`, `REMOVAL_STARTED`, `REMOVED`;
- R2 → T2 March: `CONFIRMED` (manual), `RELEASED`;
- R3 → T2 March: `CONFIRMED` (manual);
- R4 → T1 April: `CONFIRMED` (manual), `WRITE_BACK_STARTED`, `WRITE_BACK_WRITTEN` (`patched = true`);
- R4 → T2 April: `CONFIRMED` (manual), `WRITE_BACK_STARTED`, `WRITE_BACK_WRITTEN` (`patched = false`);
- R2: its reversal.

**Counter-checks**, each of which turns ACC4 red:
- MRE's payments summed into a term's `matchedTotal` (the distinct-records claim);
- a suggestion counted as consumed cash (R1's `available` before the confirm);
- the write-back without the read before the write (the crashed attempt then gets a second payment);
- the correction guard dropped (the reversal of R2 passes while matched);
- the Realm filter dropped from the coverage read of a term;
- an extra Phase-4 route without a row;
- a missing `WRITE_BACK_WRITTEN` AuditRecord.

## 30. Security deposit: the record (VC-5-01, api-design §47.1)

`DD` = `domains/security-deposit/deposit.test.ts`, `DR` = `infrastructure/postgres/security-deposit-repository.test.ts`, `DA` = `api/security-deposits.test.ts`, `DE` = `security-deposit.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| One deposit per MRE Tenant that is not `VOID` (P5-D1), by the partial unique index alone: concurrent creates give one `CREATED`, the rest `DEPOSIT_EXISTS`; a create waiting on a void of the Tenant's deposit succeeds once it commits | DR "one deposit per Tenant …", "concurrent creates …", "a void and a new create …" |
| `expectedAmount` from MRE's `guaranty` when not given (half-up to the cent once; `0` is no value → `422 EXPECTED_AMOUNT_REQUIRED`); MRE is never asked for a replay or a refusal DE decides itself | DD "resolveNew …"; DE "creates from MRE's guaranty …" |
| The holding account is the Realm's and of type `SECURITY_DEPOSIT` (P5-D4), and keeps that type while a deposit names it | DR "precheck and create refuse …", "database guards (migration 0037)"; DE |
| Amend only while `ACTIVE`; a no-op answers whatever the version; `VOID` is final and changes nothing else; the Tenant, Realm and creation never change; `version` + 1 per change; never deleted | DD "planAmend …", "planVoid …"; DR "amend", "void", "database guards (migration 0037)" |
| RC and RR: void against amend and two voids serialise on the deposit row | DR "concurrency (§47.1, RC and RR)" |

## 31. Security deposit: splits (VC-5-02, api-design §47.2)

`DS` = `infrastructure/postgres/deposit-split-repository.test.ts`, `TS` as above.

| Invariant | Tests |
|---|---|
| A split with `securityDepositId` is `SECURITY_DEPOSIT` (receipt on `INFLOW`, repayment on `OUTFLOW`) or `SECURITY_DEPOSIT_INTEREST` on an `INFLOW` (a reversal exempt); never with a PropertyReference or a Loan; the order of checks: unknown, category, direction, `VOID` | TS "checkDepositSplits …"; DS "the splits command", "the schema past the repository …" |
| The categories have `category_type = SECURITY_DEPOSIT`, never `INCOME` (P5-D6) | DS "the category SECURITY_DEPOSIT_INTEREST is seeded …" |
| Corrections: copied splits keep the id, a reversal mirrors it, a replacement may name another deposit | DS "corrections of deposit cash" |
| A deposit with splits (reversals included) is never voided (`DEPOSIT_HAS_SPLITS`) | DS "void of a deposit with splits" |
| P5-D9: Transaction → Loan → SecurityDeposit, the split trigger writing the deposit row; RC sees the other writer, RR `40001`; no deadlock in opposite orders | DS "concurrency (Transaction → Loan → SecurityDeposit …)" |

## 32. Security deposit: derived amounts, state and flags (VC-5-03, api-design §47.3)

`DF` = `domains/security-deposit/figures.test.ts`, `DFR` = `infrastructure/postgres/deposit-figures-repository.test.ts`.

| Invariant | Tests |
|---|---|
| Only current cash counts: splits on `CONFIRMED`/`RECONCILED` Transactions, not a reversal; a correction moves the amounts at once, nothing is stored | DFR "only current Transactions count …"; DF "deriveFigures …" |
| `outstanding` = max(expected − received, 0); interest never reduces it; `held` signed; the `state` in §47.3's order (`RETURNED` at `held` ≤ 0) | DF "three instalments …", "repayments …", "a repayment before any receipt …" |
| The flags `RECEIVED_EXCEEDS_EXPECTED`, `RETURNED_EXCEEDS_HELD` (`excess`) and `RECEIVED_OUTSIDE_HOLDING_ACCOUNT` (receipts only) in their order | DF "flags in order …"; DFR "RECEIVED_OUTSIDE_HOLDING_ACCOUNT …" |
| The figures and `cash` read in one snapshot with the record; the list's `state` filter before paging | DFR; DA "derived figures (§47.3) …" |

## 33. Security deposit: closing, reopening, the MRE comparison (VC-5-04, api-design §47.4)

`DC` = `infrastructure/postgres/deposit-close-repository.test.ts`, `DAP` = `application/security-deposits.test.ts`.

| Invariant | Tests |
|---|---|
| Close in §47.4's order: no-op, `DEPOSIT_NOT_ACTIVE`, `CASH_AFTER_CLOSING_DATE`, `UNCONFIRMED_CASH`, then `held` by reason (`RETURNED` = 0, `RETAINED` > 0); `heldAtClosing` stored, `retainedAmount` derived | DD "planClose …"; DC "close" |
| A `CLOSED` deposit takes no new split, whatever the date; a reversal and a replacement whose original names it pass; a later correction shows as `HELD_CHANGED_AFTER_CLOSING`; amend only `notes`; never voided | TS "CLOSED (§47.4) …"; DC "effects of CLOSED" |
| Reopen clears the closing and keeps it in the AuditRecord `REOPENED` | DC "reopen" |
| `checkMre` reads MRE after the snapshot; MRE down or the Tenant gone is a flag, never an error; MRE refusing the caller is | DF "HELD_CHANGED_AFTER_CLOSING and the MRE comparison …"; DAP; DE "VC-5-04 …" |
| 0039 past the repository: the closing CHECKs, the frozen rule's steps, the close guard's three reasons, the split guard's `CLOSED` rule with both exemptions, and `down` | DC "migration 0039 past the repository …" |
| Close against a split write, RC and RR; a correction waiting on a close is allowed | DC "concurrency (the deposit row, P5-D9)" |

## 34. Phase 5 exit (VC-5-05, roadmap Phase 5; implemented)

The exit of `docs/roadmap.md` Phase 5, claim by claim: *a deposit's expected vs actual cash is tracked without being mistaken for rental income.* Each claim is shown **end to end through the HTTP API** by **ACC5** (`phase-5-acceptance.e2e.test.ts`). It is one scenario against PostgreSQL and the fake MRE, as ACC4 does for Phase 4, and is backed by §30–§33. The figures are hand-computed and stated here, so the test checks them literally.

**The scenario (Realm A, the fake MRE's Realm A):**
- One MRE Tenant T1 with `guaranty` 2400 (three net rents of 800, as MRE stores it). Its lease is rent 650.00 and charges 150.00, and its terms `2027010100`, `2027020100` and `2027030100` are each 800.00 due. After the move-out, `guarantyPayback` 2254.20.
- Two FinancialAccounts: a `BANK` Girokonto and a `SECURITY_DEPOSIT` Kautionskonto.
- Transactions, each split, confirmed. R0–R2 come from a bank CSV import into the Girokonto (`generic-csv`, as ACC4) with the tenant's IBAN, which the in-order rule of #125 needs, and purposes that name no month (`Miete`, `Miete und Kaution`), so that no purpose month decides first (§37.3); R3–R6 are entered by hand. The order matters: import R0–R2, split and confirm R0, match R0 → January by hand, split and confirm R1 and R2, then `suggest`:

  | Row | Account | Booking date | Direction | Amount | Splits | Meaning |
  |---|---|---|---|---|---|---|
  | R0 | Giro | 2027-01-04 | INFLOW | 800.00 | `RENT_BASE` 650.00, `RENT_OPERATING_COST_ADVANCE` 150.00 | January rent, on time |
  | R1 | Giro | 2027-01-28 | INFLOW | 1,600.00 | `RENT_BASE` 650.00, `RENT_OPERATING_COST_ADVANCE` 150.00, `SECURITY_DEPOSIT` 800.00 (the deposit) | February rent, paid before the month, and the first instalment in one transfer |
  | R2 | Giro | 2027-02-26 | INFLOW | 800.00 | `RENT_BASE` 650.00, `RENT_OPERATING_COST_ADVANCE` 150.00 | March rent, paid before the month (F10, #125) |
  | R3 | Kaution | 2027-03-01 | INFLOW | 800.00 | `SECURITY_DEPOSIT` 800.00 | the second instalment: the same amount as a rent, never rent |
  | R4 | Kaution | 2027-04-01 | INFLOW | 880.00 | `SECURITY_DEPOSIT` 880.00 | the third instalment, entered by hand with a typo; corrected to 800.00 |
  | R5 | Kaution | 2027-12-31 | INFLOW | 4.20 | `SECURITY_DEPOSIT_INTEREST` 4.20 | interest credited |
  | R6 | Kaution | 2028-01-15 | OUTFLOW | 2,254.20 | `SECURITY_DEPOSIT` 2,254.20 | the repayment after the move-out; 150.00 kept for the utility bill |

| Exit claim | ACC5 step | Backed by |
|---|---|---|
| **A deposit's expected cash is tracked** | <ul><li>`POST /security-deposits { mreTenantId: T1, holdingFinancialAccountId: Kaution }` → `201`, `expectedAmount` 2400.00 from MRE, `expectedAmountSource` `MRE_GUARANTY`, `state` `EXPECTED`, `outstanding` 2400.00.</li><li>A second create for T1 → `409 DEPOSIT_EXISTS`.</li></ul> | §30 |
| **… against its actual cash, in instalments** | <ul><li>After R1: `received` 800.00, `outstanding` 1,600.00, `PARTIALLY_RECEIVED`, flag `RECEIVED_OUTSIDE_HOLDING_ACCOUNT` with R1.</li><li>After R3: `received` 1,600.00.</li><li>After R4 (880.00): `received` 2,480.00, `outstanding` 0.00, `RECEIVED`, flag `RECEIVED_EXCEEDS_EXPECTED` with `excess` 80.00.</li><li>`cash` lists R1, R3, R4 in booking-date order.</li></ul> | §31, §32 |
| **A correction of a receipt** | <ul><li>`correct` R4 with a replacement of 800.00 (the deposit kept): `received` 2,400.00, `RECEIVED`, no flag but the outside one.</li><li>`cash` lists R1, R3 and the replacement; neither R4 nor its reversal counts.</li></ul> | §31, §32 |
| **Interest credited** | After R5: `interestCredited` 4.20, `held` 2,404.20; `received` stays 2,400.00 and `outstanding` 0.00. | §32 |
| **… without being mistaken for rental income** (P5-D6) | <ul><li>R1's rent cash is 800.00, not 1,600.00 (`GET /transactions/{R1}/rent-reconciliations`: `available` 800.00).</li><li>R0 → T1 January is matched by hand (`POST /rent-reconciliations`).</li><li>`suggest { from: 2027-02, to: 2027-03 }` answers exactly two suggestions, both `EXACT_AMOUNT_IN_ORDER` with `confidence` `HIGH` (the IBAN history of the January match): R1 → T1 `2027020100` 800.00 and R2 → T1 `2027030100` 800.00. Each early payment falls into two months' windows, so only the in-order rule of #125 decides them; it starts after January, the matched month before. R3, the same amount as a rent in March's window, is no candidate.</li><li>A manual match of R3 to T1 March → `422 NO_RENT_CASH`.</li><li>After both confirms, T1's February and March are `MATCHED` at 800.00 each; the deposit's figures are unchanged.</li><li>The categories `SECURITY_DEPOSIT` and `SECURITY_DEPOSIT_INTEREST` have `categoryType` `SECURITY_DEPOSIT`.</li></ul> | §26, §31 |
| **A partial repayment, a retained part and the closing** | <ul><li>After R6: `returned` 2,254.20, `held` 150.00, `PARTIALLY_RETURNED`.</li><li>`close { closingDate: 2028-01-31, reason: RETURNED }` → `409 DEPOSIT_STILL_HELD`, `held` 150.00.</li><li>`close { …, reason: RETAINED, closingNote: "Nebenkosten 2027" }` with `If-Match` → `CLOSED`; `closing.heldAtClosing` and `retainedAmount` 150.00.</li><li>`?checkMre=true` → `mre` `{ guaranty 2400.00, guarantyPayback 2254.20 }` and no MRE flag.</li><li>A late split naming the deposit → `409 DEPOSIT_CLOSED`; a void → `409 DEPOSIT_CLOSED`.</li></ul> | §33 |
| **Realm isolation** across Phase 5 | <ul><li>Realm B calls **every route of api-design §47** with Realm A's ids, one row each in a table ACC5 iterates:<ul><li>`404` for `GET /security-deposits/{id}` (also with `?checkMre=true`), `amend`, `void`, `close` and `reopen`;</li><li>`404` for a create naming Realm A's Kautionskonto;</li><li>`200` with an empty page for the list with Realm A's Tenant or account as a filter;</li><li>`404 NOT_FOUND` with `details.securityDepositId` for a split in Realm B naming Realm A's deposit.</li></ul></li><li>After every row Realm A's deposit, its version and its AuditRecords are unchanged.</li><li>The table is compared with the routes the app serves (filtered to `/security-deposits`): a new route without a row turns ACC5 red.</li></ul> | §30–§33 |

ACC5 also checks the deposit's AuditRecords: exactly `CREATED` and `CLOSED`, with `heldAtClosing` 150.00.

**Counter-checks**, each of which turns ACC5 red:
- `SECURITY_DEPOSIT` added to the rent categories (R1's `available` is then 1,600.00, R3 a candidate, and the suggestions change; P5-D6);
- unconfirmed or reversed cash counted (the correction's figures);
- interest counted in `received`;
- the closing without the `held` check by reason;
- a split allowed on a `CLOSED` deposit;
- the Realm filter dropped from the deposit read;
- an extra `/security-deposits` route without a row.

## 35. WEG and membership (VC-6-01, api-design §49.1–§49.2)

`WR` = `infrastructure/postgres/weg-repository.test.ts`, `WD` = `domains/weg/weg.test.ts` and `domains/weg/mea.test.ts`, `WA` = `api/wegs.test.ts`, `WE` = `weg.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| One `ACTIVE` membership per unit on any day, across WEGs (`OVERLAPPING_WEG_MEMBERSHIP`); writers of one unit serialise on the PropertyReference row (RC sees the other, RR `40001`) | WR "schema past the repository", "concurrency" |
| The MEA as printed (three decimals, `0 < n ≤ d`), never reduced | WD "parseMea …"; WR |
| A WEG with an `ACTIVE` membership is never voided (`WEG_HAS_MEMBERSHIPS`); `VOID` is final; the frozen fields never change | WD; WR "schema past the repository" |

## 36. WEG splits, `WEG_FUNDS`, Wirtschaftsplan, Hausgeld proposal (VC-6-02, api-design §49.3–§49.6)

`WP` = `infrastructure/postgres/weg-plan-repository.test.ts`, `EP` = `domains/weg/economic-plan.test.ts`, `PA` = `api/weg-economic-plans.test.ts`, `PE` = `weg-plan.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| A WEG split names its unit (`NO_UNIT`) and needs an `ACTIVE` membership on its booking date (`NO_MEMBERSHIP`), also on amend of the date; a reversal is exempt | TS "checkWegSplits …"; WP "the WEG split rule (§49.3)", "schema past the repository" |
| The reserve contribution (and from VC-6-05 the Sonderumlage) is `WEG_FUNDS`, never an operating expense | WP "WEG_FUNDS (§49.4)"; ACC6 |
| End and void of a membership never leave a WEG split, a plan, a statement or a Sonderumlage outside the remaining period; the guard writes the unit first (RC) | WP "membership end and void …", "concurrency on the unit"; WR |
| The plan's components sum to the Hausgeld exactly; the proposal's cases in their order, `AMBIGUOUS` only for different splits | EP "derivePlan …", "proposeHausgeld …" |

## 37. The Jahresabrechnung (VC-6-03, api-design §50)

`ST` = `infrastructure/postgres/weg-statement-repository.test.ts`, `AS` = `domains/weg/annual-statement.test.ts`, `SA` = `api/weg-annual-statements.test.ts`, `SE` = `weg-statement.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| At most one `CONFIRMED` statement per membership and year (partial unique index; RC `STATEMENT_EXISTS`, RR `23505`) | ST "concurrency" |
| The content changes only while `DRAFT`; `SUPERSEDED` only by a `CONFIRMED` successor, checked at commit (deferred, review on #150); never deleted | ST "schema past the repository" |
| The statement's own check as flags, never refusals; the classification resolved on write and stored with its source | AS; ST "the classification …" |
| Writers serialise on unit → WEG → membership → statement; lines write their statement first | ST "concurrency" |

## 38. The ledger effects of a statement (VC-6-04, api-design §51)

`SR6` = `infrastructure/postgres/weg-settlement-repository.test.ts`, `SF` = `domains/weg/statement-effects.test.ts`, `SAE` = `weg-settlement.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| `Σ difference = settlementPeak + unpaidAdvances`, exact; only current WEG splits of the unit in the period count, settlements and Sonderumlage payments never as advances | SF "deriveComparison …"; SR6 "the comparison snapshot"; ACC6 |
| A settlement names a `CONFIRMED` statement of its unit, in a Hausgeld or reserve category; checked against the statement's membership, not the booking date, and it does not hold the membership (review on #152) | TS "wegAnnualStatementId …"; SR6 "wegAnnualStatementId on a split", "a settlement booked after the sale …" |
| A reversal mirrors the statement (0014) and is exempt from `STATEMENT_NOT_CURRENT`; a copied replacement must name the current one | SR6 "corrections …", "0014 mirror …" |
| A settlement write and the confirm superseding its statement serialise on the statement row (RC, RR `40001`) | SR6 "concurrency on the statement row" |

## 39. The Sonderumlage (VC-6-05, api-design §51A)

`SAR` = `infrastructure/postgres/weg-assessment-repository.test.ts`, `SAD` = `domains/weg/special-assessment.test.ts`, `SAA` = `api/weg-special-assessments.test.ts`, `SAX` = `weg-assessment.e2e.test.ts`.

| Invariant | Tests |
|---|---|
| Paid, outstanding, the instalments covered in due order, overdue at `asOf` and `SETTLED` derived from current cash only; nothing stored | SAD "deriveAssessment …"; SAR "payments" |
| A payment names an `ACTIVE` assessment of its unit in `WEG_SPECIAL_ASSESSMENT`; checked against the assessment's membership; a reversal mirrors it | TS "wegSpecialAssessmentId …"; SAR "payments", "0014 mirror …" |
| Never voided while a split names it, a reversal's included; void and a payment serialise on the assessment row (RC, RR `40001`) | SAR "void …", "concurrency on the assessment row" |
| No `WEG_HAS_YEARS`: a Sonderumlage is filed by its resolution date | SAR "rules elsewhere" |

## 40. Phase 6 exit (VC-6-06, roadmap Phase 6; implemented)

The exit of `docs/roadmap.md` Phase 6: *a Jahresabrechnung is represented with preserved statement structure and split into ledger effects without losing provenance.* (Provenance: every effect names its statement, every split its unit, and confirmed cash is never re-split.) Each claim is shown **end to end through the HTTP API** by **ACC6** (`phase-6-acceptance.e2e.test.ts`), one scenario against PostgreSQL and the fake MRE, backed by §35–§39. The figures are invented and hand-computed here.

**The scenario (Realm A):** a unit linked from MRE; a WEG with the unit's membership from 2026-01-01 (MEA 250/10000); the plan 2026: Hausgeld 150.00 a month (100.00 recoverable, 50.00 not, from the groups 1,200.00 and 600.00) and the reserve 50.00; a Girokonto.

| Exit claim | ACC6 step | Backed by |
|---|---|---|
| **The cash is booked by plan** | <ul><li>24 debits imported from a bank CSV (`generic-csv`): each month 150.00 Hausgeld and 50.00 Rücklage on the 3rd.</li><li>Each split by `GET /transactions/{id}/hausgeld-proposal?propertyReferenceId=`: `HAUSGELD_ONLY` (100.00 + 50.00) and `RESERVE_ONLY` (50.00) alternately, applied and confirmed.</li></ul> | §36 |
| **A WEG split names its unit and needs a membership** | A split on 2025-12-03: without a unit `422 NO_WEG_MEMBERSHIP NO_UNIT`, with it `NO_MEMBERSHIP`. | §36 |
| **The reserve is no operating expense** | `WEG_RESERVE_CONTRIBUTION` and `WEG_SPECIAL_ASSESSMENT` read `WEG_FUNDS`, `WEG_RECOVERABLE` `OPERATING_EXPENSE`. | §36 |
| **A Sonderumlage in instalments** | 600.00 in 300.00 on 2026-06-01 and 2026-09-01: after the first payment `ACTIVE`, 300.00 outstanding, the second instalment overdue at 2026-09-15; after the second `SETTLED`. | §39 |
| **A Jahresabrechnung with its structure** | Four lines (Hausmeister 1,000.00 and Versicherung 300.00 recoverable by MEA; Verwaltervergütung 400.00 per unit and Instandhaltung 200.00 not recoverable); costs 1,900.00, Hausgeld 1,800.00 and reserve 600.00 requested and paid, Abrechnungsspitze 100.00; no flags; confirmed. | §37 |
| **… split into its ledger effects** | The comparison: `RECOVERABLE` paid 1,200.00 actual 1,300.00 difference 100.00; `NON_RECOVERABLE` 600.00/600.00/0.00; `RESERVE` 600.00/600.00/0.00; unpaid 0.00; the differences sum to the Abrechnungsspitze. The Sonderumlage's payments are no advance. | §38 |
| **… without re-splitting cash** | January's debit keeps its splits (100.00 + 50.00) after the statement; a new split set on it is `409`. | §1, §38 |
| **The settlement names its statement** | The back-payment of 100.00 on 2027-05-03 split by the settlement proposal: `WEG_RECOVERABLE` 100.00 naming the statement; confirmed: settled 100.00, open 0.00. | §38 |
| **A correction keeps the old statement** | A corrected statement (Verwaltervergütung 420.00, Abrechnungsspitze 120.00) supersedes it: the old one `SUPERSEDED` with its successor; the new comparison: `NON_RECOVERABLE` difference 20.00, settled 100.00, open 20.00, flag `SETTLED_AGAINST_SUPERSEDED` with the back-payment; a new settlement against the old one `409 STATEMENT_NOT_CURRENT`; the old one's AuditRecords exactly `CREATED`, `CONFIRMED`, `SUPERSEDED`. | §37, §38 |
| **Realm isolation** across Phase 6 | Realm B calls every §49–§51A route with Realm A's ids (a table ACC6 iterates and compares with the routes the app serves): `404 NOT_FOUND` everywhere, except `POST /wegs` (a WEG of Realm B) and the list (never Realm A's WEG); Realm A's rows, versions and AuditRecords unchanged after each. | §35–§39 |

**Counter-checks**, each of which turns ACC6 red:
- a confirmed split re-split (the frozen check dropped);
- the reserve contribution read as an operating expense (0041's type change dropped);
- a WEG split without a membership (the membership check dropped);
- a Sonderumlage payment counted as an advance;
- no chain of superseded statements in the settlement;
- the Realm filter dropped from the comparison read;
- an extra Phase-6 route without a row;
- `SETTLED` never derived.

A settlement counted as an advance does not turn ACC6 red (its back-payment is booked after the period); SR6 "the comparison snapshot" covers it with a settlement inside the period.

## Keeping this current

A new invariant gets a schema-level test when the schema can express it, a
repository or domain test otherwise, and a line here. Removing or weakening a
test listed here needs the same review as changing the invariant itself.
