import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

/** Works from both src/db (type-stripped) and dist/db (built): both sit two levels below root. */
const MIGRATIONS_ROOT = fileURLToPath(new URL('../../migrations/', import.meta.url));

export type MigrationSet = 'app' | 'provider';

/**
 * Applies explicit, ordered SQL files once each, under an advisory lock, one transaction per
 * file. Deliberately tiny: the SQL files are the reviewable source of truth.
 */
export async function migrate(connectionString: string, set: MigrationSet): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const dir = path.join(MIGRATIONS_ROOT, set);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const seen = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (seen.rowCount) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${set}/${file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file);
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    await client.end();
  }
  return applied;
}
