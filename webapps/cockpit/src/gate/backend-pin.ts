/**
 * The integration gate's pinned backend state (ui-guide.md §10, "Gepinnten Backend-Stand festhalten und Routeninventar
 * prüfen"): the `main` commit the cockpit is written against and the route inventory of that commit
 * (`docs/development/api-inventory.md`). `backend-pin.test.ts` fails when the inventory differs from the pinned one or a
 * route the cockpit calls is missing, so a new backend state is checked (routes and DTOs, ui-guide.md §2) before the pin
 * moves. Moving the pin is a change of this file with that check, never a side effect.
 *
 * The pin is the `main` commit with VC-X-69 (#318) merged: the UI is written against the finished answers of
 * `POST /transactions` and the resolve of a review item (Entscheidung des Projektinhabers, 2026-11-10). VC-X-69 changed
 * no route: the inventory and its hash are the same as at ff680ba, only the commit moved.
 */
export const BACKEND_PIN = {
  commit: '1d2f37ffd307c0d16090f985f436408ddfd5c8eb',
  /** `Routes: 174.` in the inventory. */
  routes: 174,
  /** SHA-256 of `docs/development/api-inventory.md` at the pinned commit. */
  inventorySha256: '768829d617385ed72db5be671799db1ea19e31bff085332d6e7eab82ce560ba0',
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
];
