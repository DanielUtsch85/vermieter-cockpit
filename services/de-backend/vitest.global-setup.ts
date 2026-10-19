import pg from 'pg';

/**
 * Test schemas are dropped once, after every test file has finished — never by
 * one file while others still run. Kysely's Migrator introspects *all* schemas
 * (`getTables` evaluates catalog functions per schema), so a schema dropped by
 * one file while another migrates makes that migration fail with "schema … does
 * not exist".
 *
 * Every database test names its schema `<name>_(test|e2e)_<pid>_<Date.now()>`;
 * the teardown drops the ones created since this run started.
 */
const TEST_SCHEMA = /^[a-z_]+_(?:test|e2e)_\d+_(\d+)$/;

export default function setup(): () => Promise<void> {
  const startedAt = Date.now();
  return async () => {
    const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
    if (databaseUrl === undefined) return;
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ nspname: string }>('SELECT nspname FROM pg_namespace');
      for (const { nspname } of rows) {
        const createdAt = TEST_SCHEMA.exec(nspname)?.[1];
        if (createdAt !== undefined && Number(createdAt) >= startedAt) {
          await client.query(`DROP SCHEMA "${nspname}" CASCADE`);
        }
      }
    } finally {
      await client.end();
    }
  };
}
