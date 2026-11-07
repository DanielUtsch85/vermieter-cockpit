import { runAuditErasureCli } from './infrastructure/postgres/audit-erasure.js';
import { createDatabase, createPool } from './infrastructure/postgres/index.js';

/**
 * VC-X-24 (api-design.md §58U rule 8): the entry point of the erasure procedure, `node dist/audit-erasure.js <mreRealmId>
 * <partyId> [--dry-run|--apply]`, called by `scripts/ops/audit-erasure.sh` inside the de-backend container. Needs only
 * `DATABASE_URL`; runs no migration and starts no server.
 */
const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL fehlt');
  process.exit(2);
}
const pool = createPool(url);
try {
  process.exitCode = await runAuditErasureCli(process.argv.slice(2), {
    db: createDatabase(pool),
    now: new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} finally {
  await pool.end();
}
