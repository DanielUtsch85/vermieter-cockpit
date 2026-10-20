import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Random per `vitest run`; set by vitest.global-setup.ts. */
    testRunId: string;
  }
}

/**
 * The schema a database test file works in: `<name>_<runId>`, e.g.
 * `split_test_3f9a01c2`. The run id ties it to this test run, so the global
 * teardown drops exactly this run's schemas — never those of another run
 * against the same database. Test support only.
 */
export function testSchemaName(name: 'test' | `${string}_test` | `${string}_e2e`): string {
  return `${name}_${inject('testRunId')}`;
}
