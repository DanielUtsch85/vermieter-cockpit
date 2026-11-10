/**
 * The integration gate's pinned backend state (ui-guide.md §10, "Gepinnten Backend-Stand festhalten und Routeninventar
 * prüfen"): the `main` commit the cockpit is written against and the route inventory of that commit
 * (`docs/development/api-inventory.md`). `backend-pin.test.ts` fails when the inventory differs from the pinned one or a
 * route the cockpit calls is missing, so a new backend state is checked (routes and DTOs, ui-guide.md §2) before the pin
 * moves. Moving the pin is a change of this file with that check, never a side effect.
 *
 * The pin is to move to the `main` commit that contains VC-X-69 (#318) once it is merged: the UI is to be written against
 * the finished answers of `POST /transactions` and the resolve of a review item (Entscheidung des Projektinhabers,
 * 2026-11-10). VC-X-69 changes no route, so the inventory's hash stays; only the commit moves.
 */
export const BACKEND_PIN = {
  commit: 'ff680bab05b0e9223ea29eef5050d746d1f4537a',
  /** `Routes: 174.` in the inventory. */
  routes: 174,
  /** SHA-256 of `docs/development/api-inventory.md` at the pinned commit. */
  inventorySha256: '768829d617385ed72db5be671799db1ea19e31bff085332d6e7eab82ce560ba0',
} as const;

/** Every DE route the cockpit calls, as the inventory names it (method, path with `:parameter`). */
export const USED_ROUTES: readonly (readonly [method: string, path: string])[] = [['GET', '/api/v1/health']];
