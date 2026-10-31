import { z } from 'zod';
import type { Distribution } from '../application/index.js';
import { RESOURCE_ID } from './validation.js';

/** The request schema and response mapping shared by the Taxation route files (api-design.md §55–§58C). */

export const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

export const ref = (r: { readonly ruleCode: string; readonly version: number } | null) => (r === null ? null : { ruleCode: r.ruleCode, version: r.version });

/** Money anywhere in a value as its JSON (`{ amount, currency }`), everything else as it is. */
export const plain = (value: unknown): unknown => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown));
export const flagsDto = (flags: readonly { readonly code: string; readonly details: unknown }[]) =>
  flags.map((f) => ({ code: f.code, details: plain(f.details) }));

export function distributionDto(d: Distribution | null) {
  return d === null
    ? null
    : {
        years: d.years,
        firstYear: d.firstYear,
        parts: d.parts.map((p) => ({ year: p.year, amount: p.amount.toJSON() })),
        endYear: d.endYear,
        rule: ref(d.rule),
      };
}
