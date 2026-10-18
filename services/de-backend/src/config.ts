import { z } from 'zod';

/** Runtime configuration from environment variables, validated at startup. */
const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  DATABASE_URL: z.string().url(),
  /** MRE landlord API base URL including /api/v2, e.g. http://gateway:8080/api/v2. */
  MRE_API_URL: z.string().url(),
  MRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
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
