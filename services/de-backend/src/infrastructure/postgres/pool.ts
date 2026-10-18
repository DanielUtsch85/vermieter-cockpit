import pg from 'pg';

/** Connection pool for the DE PostgreSQL database (ADR-031). */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Readiness probe: true when a trivial query succeeds within the pool's limits. */
export async function isDatabaseReachable(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
