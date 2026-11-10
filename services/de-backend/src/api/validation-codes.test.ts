import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldErrors, parse } from './validation.js';

/**
 * VC-X-65: the §90 code of every issue zod raises itself, as Zod 3 gave it (api-design §90: a missing value `REQUIRED`,
 * anything else `INVALID_FORMAT`, a route's own code from `params.code`). Zod 4 reports a missing enumeration value as
 * `invalid_value` and drops the input from a finished issue, so `parse` decides the code while the issue is raised.
 * Every expectation is what Zod 3.25.76 answered on main b97f2d7. No database; synthetic values only.
 */
const codes = (schema: z.ZodType, value: unknown) => {
  const result = parse(schema, value);
  return result.success ? 'ok' : fieldErrors(result.error).map((f) => `${f.field} ${f.code}`);
};

describe('the code of each issue zod raises (Zod 3 answers)', () => {
  const body = z
    .object({
      text: z.string(),
      kind: z.enum(['A', 'B']),
      fixed: z.literal('MRE'),
      list: z.array(z.string()),
      when: z.string().regex(/^\d{4}$/),
    })
    .strict();

  it('a missing string, enumeration and array are REQUIRED; a missing literal is INVALID_FORMAT (Zod 3 invalid_literal)', () => {
    expect(codes(body, {})).toEqual(['text REQUIRED', 'kind REQUIRED', 'fixed INVALID_FORMAT', 'list REQUIRED', 'when REQUIRED']);
  });

  it('a wrong value of any kind is INVALID_FORMAT, null included', () => {
    expect(codes(body, { text: null, kind: 'C', fixed: 'X', list: 'x', when: '12' })).toEqual([
      'text INVALID_FORMAT',
      'kind INVALID_FORMAT',
      'fixed INVALID_FORMAT',
      'list INVALID_FORMAT',
      'when INVALID_FORMAT',
    ]);
    expect(codes(body, { text: 'x', kind: 5, fixed: 'MRE', list: [], when: '2027' })).toEqual(['kind INVALID_FORMAT']);
  });

  it('a route code from params; a refinement without one is INVALID_FORMAT, even with a message of its own', () => {
    const refined = z
      .object({ n: z.string() })
      .strict()
      .superRefine((_b, ctx) => {
        ctx.addIssue({ code: 'custom', path: ['n'], params: { code: 'OUT_OF_RANGE' } });
        ctx.addIssue({ code: 'custom', path: ['n'] });
        ctx.addIssue({ code: 'custom', path: ['n'], message: 'REQUIRED' });
      });
    expect(codes(refined, { n: 'x' })).toEqual(['n OUT_OF_RANGE', 'n INVALID_FORMAT', 'n INVALID_FORMAT']);
  });

  it('the whole value is (body); an unknown key stays INVALID_FORMAT at its container for fieldErrors', () => {
    expect(codes(body, [])).toEqual(['(body) INVALID_FORMAT']);
    expect(codes(body, undefined)).toEqual(['(body) REQUIRED']);
  });

  it('counter-check: an error parsed without `parse` is refused, its codes would be guesses', () => {
    const plain = body.safeParse({});
    expect(plain.success).toBe(false);
    if (!plain.success) expect(() => fieldErrors(plain.error)).toThrow('validation: a zod error not parsed with `parse`');
  });
});
