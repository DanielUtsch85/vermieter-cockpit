import { expect } from 'vitest';

/**
 * §58C "Follow-up: the level on the item flags" (Entscheidung des Projektinhabers, 2026-11-09): a generic walk over a
 * tax-year view as answered over HTTP. Every `flags` array anywhere in the response but the year's own (`flags` at the
 * root) is an item's, and each of its entries must be `{ code, level, details }` in that order, `level` `OPEN` or
 * `INFORMATIVE`. The walk knows no item kind: a future item list with flags is checked without a change here.
 *
 * It also checks the level against the review: an `OPEN` item flag's code is in `review.open`, an `INFORMATIVE` one's in
 * `review.info`. It returns the item kinds it found flags on (the path, indices dropped, a line as `lines[AFA]` or
 * `lines[cash]`) with their flag counts, so a caller can require the kinds its fixtures raise flags on.
 */
export function itemFlagKinds(view: unknown): Map<string, number> {
  const kinds = new Map<string, number>();
  const review = (view as { review: { open: { code: string }[]; info: { code: string }[] } }).review;
  const open = new Set(review.open.map((e) => e.code));
  const info = new Set(review.info.map((e) => e.code));
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => {
        const line = (child as { line?: unknown } | null)?.line;
        walk(child, typeof line === 'string' ? `${path}[${line.startsWith('AFA_') ? 'AFA' : 'cash'}]` : `${path}[]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const at = path === '' ? key : `${path}.${key}`;
      if (key === 'flags' && path === '') continue;
      if (key === 'flags' && Array.isArray(value)) {
        for (const flag of value as Record<string, unknown>[]) {
          expect(Object.keys(flag), `${at}: ${JSON.stringify(flag)}`).toEqual(['code', 'level', 'details']);
          expect(['OPEN', 'INFORMATIVE'], `${at}: ${JSON.stringify(flag)}`).toContain(flag['level']);
          expect((flag['level'] === 'OPEN' ? open : info).has(flag['code'] as string), `${at}: ${String(flag['code'])} in review`).toBe(true);
        }
        if (value.length > 0) kinds.set(path, (kinds.get(path) ?? 0) + value.length);
        continue;
      }
      walk(value, at);
    }
  };
  walk(view, '');
  // The year's flags stay `{ code, details }` (unchanged by the follow-up).
  for (const flag of (view as { flags: Record<string, unknown>[] }).flags) expect(Object.keys(flag)).toEqual(['code', 'details']);
  return kinds;
}

/** Adds the kinds of `view` to `seen` (the counts summed). */
export function collectItemFlagKinds(seen: Map<string, number>, view: unknown): void {
  for (const [kind, count] of itemFlagKinds(view)) seen.set(kind, (seen.get(kind) ?? 0) + count);
}
