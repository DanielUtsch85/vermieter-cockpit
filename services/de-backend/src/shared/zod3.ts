import { z } from 'zod';

/**
 * Zod 3's parsing rules on Zod 4 (VC-X-65), where the two differ in what a client sees: the fields and the order of the
 * errors of a refused body, query or adapter option, and which inputs are accepted. Each helper keeps exactly the answer
 * Zod 3 gave; `error-answers-unchanged.test.ts` compares every route's answers with the record taken on Zod 3.
 *
 * Zod 3 had three states: valid, "dirty" (an issue, but the parent's refinements still run) and "aborted" (they do not).
 * Zod 4 marks each issue instead: `continue: true` is dirty, anything else aborts. They agree for a wrong type (aborts),
 * a failed check such as a pattern or a length (dirty), an unknown key (dirty) and a refinement's issue (dirty). They
 * differ for a transform and an integer, which these helpers restore, and in two orders of issues (`asZod3`).
 */

/**
 * Zod 4's issues in the number and order Zod 3 raised them: (1) a length or size check (`min`, `max`, `length` of a
 * string or an array) runs even after the value had the wrong type (`[]` for a string: `invalid_type`, then `too_small` of
 * the array's length), where Zod 3 stopped at the type; such a size issue at the path of a wrong type is dropped. (2) An
 * array's size is checked after its elements, where Zod 3 checked it first; the array's size issue moves before the first
 * issue of its elements.
 */
export function asZod3<T extends z.core.$ZodIssue>(issues: readonly T[]): T[] {
  const out: T[] = [];
  for (const issue of issues) {
    const size = issue.code === 'too_small' || issue.code === 'too_big';
    if (size && out.some((o) => o.code === 'invalid_type' && samePath(o.path, issue.path))) continue;
    const first = size && issue.origin === 'array' ? out.findIndex((o) => isUnder(o.path, issue.path)) : -1;
    if (first === -1) out.push(issue);
    else out.splice(first, 0, issue);
  }
  return out;
}

const samePath = (a: readonly PropertyKey[], b: readonly PropertyKey[]) => a.length === b.length && a.every((k, i) => k === b[i]);
const isUnder = (path: readonly PropertyKey[], parent: readonly PropertyKey[]) => path.length > parent.length && parent.every((k, i) => k === path[i]);

/**
 * Zod 3's `.transform`: it runs only on a valid value, and a value with any issue (a failed pattern, a length, an unknown
 * key) makes the whole result "aborted", so no refinement above it runs; an issue the transform adds itself leaves the
 * result "dirty", so the refinements above still run. Zod 4 runs the transform after an unknown key, lets the issues of
 * a failed check stay non-aborting, and aborts on the transform's own issue: three differences a client sees (an extra
 * or a missing error of a cross-field rule).
 */
export function transform<S extends z.ZodType, T>(schema: S, fn: (value: z.output<S>, ctx: z.core.$RefinementCtx<z.output<S>>) => T) {
  return schema
    .check((payload) => {
      // The value had an issue: Zod 3 never ran the transform and aborted (an issue without `continue` aborts in Zod 4).
      for (const issue of payload.issues) delete (issue as { continue?: boolean }).continue;
    })
    .transform((value, ctx) => {
      // Only an unknown key reaches the transform with an issue (Zod 4 lets it through a pipe): Zod 3 did not run it.
      if (ctx.issues.length > 0) return z.NEVER;
      const add = ctx.addIssue.bind(ctx);
      ctx.addIssue = (issue) => add(typeof issue === 'string' ? { code: 'custom', message: issue, continue: true } : { ...issue, continue: true });
      return fn(value, ctx);
    });
}

/**
 * Zod 3's `z.number()`: any number but `NaN`, `Infinity` and `-Infinity` included (Zod 4 refuses them as a wrong type); a
 * wrong type aborts (`invalid_type`, so a missing one is `REQUIRED`).
 */
export const number = () =>
  z.custom<number>().check((payload) => {
    if (typeof payload.value !== 'number' || Number.isNaN(payload.value))
      payload.issues.push({ code: 'invalid_type', expected: 'number', input: payload.value });
  });

/**
 * Zod 3's `z.number().int().min(min).max(max)`: a fraction (and `±Infinity`) is a dirty issue, after which the bounds are
 * still checked (Zod 4's `.int()` aborts, and refuses an integer beyond 2^53 that Zod 3 accepted).
 */
export const integer = (min?: number, max?: number) => {
  const whole = number().refine(Number.isInteger);
  const bounded = min === undefined ? whole : whole.check(z.gte(min));
  return max === undefined ? bounded : bounded.check(z.lte(max));
};

/** Zod 3's `z.coerce.number().int().min(min).max(max)`: `Number(value)`, then as `integer` (a query parameter's text). */
export const coercedInteger = (min?: number, max?: number) => z.preprocess((value) => Number(value), integer(min, max));

/**
 * Zod 3's `z.array`: every element is parsed and a `max` (or `length`) is a dirty issue before the elements' issues
 * (`asZod3` puts it there). Zod 4 stops an array over its maximum at that one aborting issue without parsing an element;
 * it does so only while the array's checks begin with a size check, so a first check that does nothing keeps it out.
 */
export const array = <T extends z.ZodType>(element: T) =>
  z.array(element).check(() => {
    // Nothing to check: placed first, so a `max` after it is an ordinary check (see above).
  });
