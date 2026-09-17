import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: a pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(connectionString: string, max = 10): Pool {
  // numeric and timestamptz keep pg defaults: numeric arrives as an exact string (never a JS
  // number), timestamptz as Date.
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  // Idle client errors (e.g. the database restarting) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

export interface TxOptions {
  isolation?: 'read committed' | 'repeatable read';
  readOnly?: boolean;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    const isolation = options.isolation === 'repeatable read' ? 'REPEATABLE READ' : 'READ COMMITTED';
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}${options.readOnly ? ' READ ONLY' : ''}`);
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

export function pgErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
