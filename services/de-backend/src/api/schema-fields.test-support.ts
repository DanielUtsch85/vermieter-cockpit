import type { z } from 'zod';

/**
 * VC-X-66 (review hint on #324): the field paths a body schema knows, read from the schema itself (the keys of its objects),
 * not from the answers, so an optional field that no error answer ever names is probed too. `a.0.b` is the field `b` of
 * an element of the array `a`; a record's keys are free and not listed. Every wrapper `assertStrictBody` walks is walked
 * here; a recursive lazy schema is entered once per branch. In schema order, each path once. Test support only.
 */
export function schemaFieldPaths(schema: z.ZodType): string[] {
  const out = new Set<string>();
  const walk = (inner: unknown, at: readonly string[], stack: ReadonlySet<unknown>): void => {
    if (stack.has(inner)) return;
    const next = new Set(stack).add(inner);
    const def = (inner as z.ZodType)._zod.def as unknown as Record<string, unknown> & { readonly type: string };
    const go = (child: unknown, path = at) => walk(child, path, next);
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def['shape'] as Record<string, z.ZodType>)) {
          out.add([...at, key].join('.'));
          go(value, [...at, key]);
        }
        return;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
      case 'nonoptional':
      case 'promise':
        return go(def['innerType']);
      case 'array':
        return go(def['element'], [...at, '0']);
      case 'set':
        return go(def['valueType'], [...at, '0']);
      case 'pipe':
        go(def['in']);
        return go(def['out']);
      case 'union':
        for (const option of def['options'] as readonly z.ZodType[]) go(option);
        return;
      case 'intersection':
        go(def['left']);
        return go(def['right']);
      case 'tuple':
        (def['items'] as readonly z.ZodType[]).forEach((item, i) => go(item, [...at, String(i)]));
        return;
      case 'lazy':
        return go((def['getter'] as () => z.ZodType)());
      default:
        return;
    }
  };
  walk(schema, [], new Set());
  return [...out];
}

/** The parameter names a query schema knows (the keys of its object, under pipes), in schema order. */
export function querySchemaKeys(schema: z.ZodType): string[] {
  let inner = schema._zod.def as unknown as Record<string, unknown> & { readonly type: string };
  while (inner.type === 'pipe') inner = (inner['in'] as z.ZodType)._zod.def as unknown as typeof inner;
  return inner.type === 'object' ? Object.keys(inner['shape'] as object) : [];
}
