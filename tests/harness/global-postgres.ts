import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { ensureRoles } from '../../src/db/bootstrap.ts';
import { testDbTargets, type PgServer } from './databases.ts';

/** Pinned and verified locally; bump deliberately. */
export const POSTGRES_IMAGE = 'postgres:17.11-alpine';

declare module 'vitest' {
  export interface ProvidedContext {
    pgServer: PgServer;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withUsername('postgres')
      .withPassword('test-admin')
      .withDatabase('postgres')
      .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
      .start();
  } catch (error) {
    throw new Error(
      'Integration tests need a working Docker-compatible runtime for Testcontainers (real PostgreSQL). ' +
        'They are NOT skipped: start Docker and re-run. Original error: ' +
        (error as Error).message,
      { cause: error },
    );
  }
  const server: PgServer = { host: container.getHost(), port: container.getPort(), adminPassword: 'test-admin' };
  await ensureRoles(testDbTargets(server, 'bootstrap'));
  project.provide('pgServer', server);
  return async () => {
    await container?.stop();
  };
}
