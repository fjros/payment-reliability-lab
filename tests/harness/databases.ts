import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { connectionString, type DbTargets } from '../../src/config.ts';
import { bootstrapDatabases, dropDatabases } from '../../src/db/bootstrap.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';

export interface PgServer {
  host: string;
  port: number;
  adminPassword: string;
}

export function testDbTargets(server: PgServer, suffix: string): DbTargets {
  return {
    host: server.host,
    port: server.port,
    adminUser: 'postgres',
    adminPassword: server.adminPassword,
    adminDatabase: 'postgres',
    appDatabase: `prl_test_app_${suffix}`,
    providerDatabase: `prl_test_prov_${suffix}`,
    appPassword: 'test-app',
    mcpPassword: 'test-mcp',
    providerPassword: 'test-provider',
  };
}

export interface TestDatabases {
  targets: DbTargets;
  server: PgServer;
  app: Pool;
  admin: Pool;
  provider: Pool;
  close(): Promise<void>;
}

/** A fresh, migrated pair of databases per test file: an isolated namespace on the shared server. */
export async function createTestDatabases(): Promise<TestDatabases> {
  const server = inject('pgServer');
  const targets = testDbTargets(server, randomBytes(6).toString('hex'));
  await bootstrapDatabases(targets, { allowHost: server.host });
  const app = createPool(connectionString(targets, 'app'));
  const admin = createPool(connectionString(targets, 'admin', targets.appDatabase), 3);
  const provider = createPool(connectionString(targets, 'provider'));
  return {
    targets,
    server,
    app,
    admin,
    provider,
    async close() {
      await Promise.all([app.end(), admin.end(), provider.end()]);
      await dropDatabases(targets, { allowHost: server.host });
    },
  };
}
