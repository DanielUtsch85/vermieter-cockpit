import pg from 'pg';

/** Connection pool for the DE PostgreSQL database (ADR-031). */
export function createPool(connectionString: string): pg.Pool {
  // connectionTimeoutMillis: without it a blackholed host makes queries (and
  // /health/ready) hang indefinitely instead of failing.
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 2_000 });
  // Idle clients can be terminated by the server (restart, failover). Without a
  // listener that is an unhandled 'error' event and kills the process; the pool
  // discards the broken client and opens a new one on the next query.
  pool.on('error', () => {
    /* logged once a logger exists; must never crash the process */
  });
  return pool;
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
