import { z } from 'zod';

/** Runtime configuration from environment variables, validated at startup. */
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  DATABASE_URL: z.string().url(),
  /** MRE landlord API base URL including /api/v2, e.g. http://gateway:8080/api/v2. */
  MRE_API_URL: z.string().url(),
  MRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  /**
   * The recording switch of api-design.md §60 (decided 2026-10-31, second and third set): exactly `true` or `false`,
   * unset is `false`. Never `z.coerce.boolean()`, which reads the string `"false"` as on. Read once at startup; a change
   * needs a restart. The first productive enablement is the binding freeze point of the AfA rule versions.
   */
  DEPRECIATION_RECORDING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * The released stage of recording (VC-X-45; api-design.md §60 "As implemented (VC-X-45, stage 1)"): exactly `1`, `2`
   * or `3`, unset is `1`; any other value fails the start like the main switch. It only limits what the main switch
   * allows: while `DEPRECIATION_RECORDING_ENABLED` is off it has no effect and is only reported by the schedule read (A6).
   */
  DEPRECIATION_RECORDING_STAGE: z
    .enum(['1', '2', '3'])
    .default('1')
    .transform((value) => Number(value) as 1 | 2 | 3),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
