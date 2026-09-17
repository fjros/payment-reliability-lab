import pg from 'pg';
import { assertResettableTarget, connectionString, ROLES, type DbTargets } from '../config.ts';
import { migrate } from './migrate.ts';

const BOOTSTRAP_LOCK = 727002;

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

async function withAdmin<T>(db: DbTargets, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: connectionString(db, 'admin') });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_LOCK]);
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureRole(client: pg.Client, role: string, password: string): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  const stmt = await client.query<{ sql: string }>(
    `SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql`,
    [role, password],
  );
  await client.query(stmt.rows[0]!.sql);
}

/** Cluster-level roles. The investigation role is read-only by default at the role level too. */
export async function ensureRoles(db: DbTargets): Promise<void> {
  await withAdmin(db, async (client) => {
    await ensureRole(client, ROLES.app, db.appPassword);
    await ensureRole(client, ROLES.mcp, db.mcpPassword);
    await ensureRole(client, ROLES.provider, db.providerPassword);
    await client.query(`ALTER ROLE ${quoteIdent(ROLES.mcp)} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${quoteIdent(ROLES.mcp)} SET statement_timeout = '5s'`);
  });
}

async function ensureDatabase(client: pg.Client, name: string, connectRoles: string[]): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
  await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdent(name)} FROM PUBLIC`);
  for (const role of connectRoles) {
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(name)} TO ${quoteIdent(role)}`);
  }
}

/**
 * Creates (if missing) the application and provider databases with separated credentials, then
 * migrates both. One PostgreSQL server hosts both for convenience; that does not simulate
 * independent database-server outages.
 */
export async function bootstrapDatabases(db: DbTargets, options: { allowHost?: string } = {}): Promise<void> {
  assertResettableTarget(db, options.allowHost);
  await withAdmin(db, async (client) => {
    await ensureDatabase(client, db.appDatabase, [ROLES.app, ROLES.mcp]);
    await ensureDatabase(client, db.providerDatabase, [ROLES.provider]);
  });
  await migrate(connectionString(db, 'admin', db.appDatabase), 'app');
  await migrate(connectionString(db, 'admin', db.providerDatabase), 'provider');
}

/** Drops only the two explicitly configured lab databases. Never touches Docker volumes. */
export async function dropDatabases(db: DbTargets, options: { allowHost?: string } = {}): Promise<void> {
  assertResettableTarget(db, options.allowHost);
  await withAdmin(db, async (client) => {
    for (const name of [db.appDatabase, db.providerDatabase]) {
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    }
  });
}
