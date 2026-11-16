/**
 * The integration gate's pinned backend state (ui-guide.md §10, "Gepinnten Backend-Stand festhalten und Routeninventar
 * prüfen"): the `main` commit the cockpit is written against and the route inventory of that commit
 * (`docs/development/api-inventory.md`). `backend-pin.test.ts` fails when the inventory differs from the pinned one or a
 * route the cockpit calls is missing, so a new backend state is checked (routes and DTOs, ui-guide.md §2) before the pin
 * moves. Moving the pin is a change of this file with that check, never a side effect.
 *
 * The pin is the backend commit of „Import und Vorschlag, Nachträge“ (VC-X-75, VC-X-77, VC-X-78; api-design.md §32.1a,
 * §32.6, §37.6): no route changes (177, the inventory and its hash as at a4b18bf), but the DTOs the cockpit reads do —
 * `firstBookingDate` / `lastBookingDate` per import, `continuityMissing` on the single read, `skipped.decidedBefore` of
 * a suggest run — so the pin moves with them, as it did for VC-X-69. DTOs were checked against that commit; it reaches
 * `main` with the pull request that carries it (a merge, not a squash). Before it the pin was a4b18bf (VC-X-74, #369,
 * 176 → 177).
 */
export const BACKEND_PIN = {
  commit: '215f447f1084616f6c73d4766af1f98dc0e50e34',
  /** `Routes: 177.` in the inventory. */
  routes: 177,
  /** SHA-256 of `docs/development/api-inventory.md` at the pinned commit. */
  inventorySha256: '299363cfd3d74b1a77c2ded89e2b6a6b780d9647fe2b5652a641fc036a889d1d',
} as const;

/** Every DE route the cockpit calls, as the inventory names it (method, path with `:parameter`). */
export const USED_ROUTES: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/api/v1/health'],
  // Step 2 (ui-guide.md §10): the transaction list and detail, and the lists that name accounts, objects and categories.
  ['GET', '/api/v1/transactions'],
  ['GET', '/api/v1/transactions/:transactionId'],
  ['GET', '/api/v1/financial-accounts'],
  ['GET', '/api/v1/property-references'],
  ['GET', '/api/v1/financial-categories'],
  // Step 3 (ui-guide.md §10): the split editor replaces the whole split set with `If-Match` (api-design.md §33.2).
  ['PUT', '/api/v1/transactions/:transactionId/splits'],
  // Step 4 (ui-guide.md §10): confirm with `If-Match` (api-design.md §34), correct with `If-Match` and `Idempotency-Key` (§35).
  ['POST', '/api/v1/transactions/:transactionId/confirm'],
  ['POST', '/api/v1/transactions/:transactionId/correct'],
  // „Stornieren“ (Entscheidung des Projektinhabers, 2026-11-11): reverse without a replacement, `If-Match` and
  // `Idempotency-Key` as correct (api-design.md §35.9).
  ['POST', '/api/v1/transactions/:transactionId/reverse'],
  // Step 5 (ui-guide.md §6.5, §10): the bank import (multipart), its result read again, its review items and their resolve
  // under the owning batch (api-design.md §32.1a–§32.3a).
  ['POST', '/api/v1/imports/bank-transactions'],
  ['GET', '/api/v1/imports/:importBatchId'],
  // „Bisherige Importe“ under the import form (Issue #369; Entscheidung des Projektinhabers, 2026-11-16): the Realm's
  // imports newest first, paged, open review items highlighted (api-design.md §32.6). A read; its filters `status`
  // (only NEEDS_REVIEW) and `financialAccountId` are sent when chosen (VC-X-76).
  ['GET', '/api/v1/imports'],
  ['GET', '/api/v1/imports/:importBatchId/review-items'],
  ['POST', '/api/v1/imports/:importBatchId/review-items/:reviewItemId/resolve'],
  // Step 6 (ui-guide.md §6.6, §10): suggest, the list and one reconciliation, confirm and reject (`If-Match`), and as
  // separate commands the write-back to MRE, the release and the removal from MRE (api-design.md §37.1–§37.5); the
  // coverage of a term and of a Transaction (§37.2). No `Idempotency-Key` on any of them (§7.3).
  ['POST', '/api/v1/rent-reconciliations/suggest'],
  ['GET', '/api/v1/rent-reconciliations'],
  ['GET', '/api/v1/rent-reconciliations/:reconciliationId'],
  ['POST', '/api/v1/rent-reconciliations/:reconciliationId/confirm'],
  ['POST', '/api/v1/rent-reconciliations/:reconciliationId/reject'],
  ['POST', '/api/v1/rent-reconciliations/:reconciliationId/write-back-to-mre'],
  ['POST', '/api/v1/rent-reconciliations/:reconciliationId/release'],
  ['POST', '/api/v1/rent-reconciliations/:reconciliationId/remove-from-mre'],
  ['GET', '/api/v1/rent-reconciliations/terms/:mreTenantId/:mreRentTerm'],
  ['GET', '/api/v1/transactions/:transactionId/rent-reconciliations'],
  // Step 8 (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §6.6 steps 2 and 3): the split proposal of a term
  // for an unconfirmed inflow, a read applied only through the split editor (api-design.md §37.6), and the manual match,
  // created `CONFIRMED` with an `Idempotency-Key` of the intent (§37.1). Both routes are in the pinned inventory.
  ['GET', '/api/v1/rent-reconciliations/split-proposal'],
  ['POST', '/api/v1/rent-reconciliations'],
  // Setup of a Realm (Issue #365; Entscheidung des Projektinhabers, 2026-11-16): „Konto anlegen“ with an
  // `Idempotency-Key` of the intent (api-design.md §29.1, §29.2) and „Objekte verknüpfen“ without one (natural key,
  // §23.1). Both routes are in the pinned inventory; the Realm's MRE property list is MRE's own `GET /api/v2/properties`.
  ['POST', '/api/v1/financial-accounts'],
  ['POST', '/api/v1/property-references/link'],
  // Choosing the Tenant and the term (Issue #364; Entscheidung des Projektinhabers, 2026-11-16): the Realm's Tenants by
  // their MRE id from its reconciliations, and a Tenant's terms around the booking date (api-design.md §37.7), in
  // „Aufteilungsvorschlag aus MRE“ and „Manuell zuordnen“. Both are reads; the typed id and key stay possible.
  ['GET', '/api/v1/rent-reconciliations/tenants'],
  ['GET', '/api/v1/rent-reconciliations/terms/:mreTenantId'],
];
