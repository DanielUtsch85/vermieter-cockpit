/**
 * The types a DE client (`webapps/cockpit`) takes from the backend (ui-guide.md §7.1, technology.md §7.1: the DTO
 * types come from the backend's schemas, so the API has one source of truth). Exported to the workspace as
 * `@vermieter-cockpit/de-backend/client-contract` (package.json `exports`, `types` only).
 *
 * Types only, never a value: `export type` is erased at compile time, so nothing of the backend reaches a browser
 * bundle and this file changes no behaviour. A type is added here when a client slice first uses it.
 */
export type { FieldError } from './validation.js';
