import { seedRun, purgeRun } from '../app/seed.ts';
import { assertResettableTarget, connectionString, loadConfig } from '../config.ts';
import { systemClock } from '../shared/clock.ts';
import { noCheckpoints } from '../shared/checkpoints.ts';
import { randomIds } from '../shared/ids.ts';
import { createLogger } from '../shared/logger.ts';
import { bootstrapDatabases, dropDatabases, ensureRoles } from './bootstrap.ts';
import { createPool } from './pool.ts';

const DEMO_RUN = 'demo';
const DEMO_ACCOUNTS = ['demo-alice', 'demo-bob'];

const config = loadConfig();
const command = process.argv[2];
const say = (text: string): void => void process.stdout.write(`${text}\n`);

async function migrate(): Promise<void> {
  await ensureRoles(config.db);
  await bootstrapDatabases(config.db);
  say(`Migrated ${config.db.appDatabase} and ${config.db.providerDatabase} on ${config.db.host}:${config.db.port}.`);
}

async function seed(): Promise<void> {
  assertResettableTarget(config.db);
  const admin = createPool(connectionString(config.db, 'admin', config.db.appDatabase), 2);
  const pool = createPool(connectionString(config.db, 'app'), 2);
  try {
    await purgeRun(admin, DEMO_RUN);
    await seedRun(
      { pool, clock: systemClock, ids: randomIds, checkpoints: noCheckpoints, logger: createLogger('seed') },
      DEMO_RUN,
      DEMO_ACCOUNTS.map((accountId) => ({ accountId })),
    );
    say(`Seeded run "${DEMO_RUN}" with accounts ${DEMO_ACCOUNTS.join(', ')} (100000 DEMO_USD minor units each).`);
  } finally {
    await Promise.all([admin.end(), pool.end()]);
  }
}

async function reset(): Promise<void> {
  // Drops ONLY the two configured lab databases; refuses non-local or unexpected names.
  await dropDatabases(config.db);
  await migrate();
  say('Reset complete. No Docker volumes were touched.');
}

const commands: Record<string, () => Promise<void>> = { migrate, seed, reset };
const run = command ? commands[command] : undefined;
if (!run) {
  process.stderr.write('usage: node src/db/cli.ts <migrate|seed|reset>\n');
  process.exit(2);
}
try {
  await run();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  if (/ECONNREFUSED/.test(String((error as Error).message) + String((error as { code?: string }).code))) {
    process.stderr.write('PostgreSQL is not reachable. Start the local demo database with: npm run db:up\n');
  }
  process.exit(1);
}
