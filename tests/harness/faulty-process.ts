/**
 * TEST-ONLY process entry. Runs the real API or worker with one injected fault, selected by
 * environment. Production entry points (src/<component>/main.ts) cannot inject faults.
 *   PRL_TEST_COMPONENT=api     PRL_TEST_FAULT=drop_response_after_commit
 *   PRL_TEST_COMPONENT=worker  PRL_TEST_CRASH_AT=<checkpoint name>   (exits with code 137)
 */
import { buildApi } from '../../src/api/server.ts';
import { connectionString, loadConfig } from '../../src/config.ts';
import { createPool } from '../../src/db/pool.ts';
import { systemClock } from '../../src/shared/clock.ts';
import type { Checkpoints } from '../../src/shared/checkpoints.ts';
import { randomIds } from '../../src/shared/ids.ts';
import { createLogger } from '../../src/shared/logger.ts';
import { ProviderClient } from '../../src/worker/provider-client.ts';
import { Worker } from '../../src/worker/worker.ts';

const config = loadConfig();
const logger = createLogger('faulty-process');
const pool = createPool(connectionString(config.db, 'app'));
const crashAt = process.env.PRL_TEST_CRASH_AT;
const fault = process.env.PRL_TEST_FAULT;

const checkpoints: Checkpoints = {
  async hit(name, context) {
    if (name === crashAt) process.exit(137); // abrupt: no cleanup, no rollback courtesy
    if (name === 'api.accept.after_commit' && fault === 'drop_response_after_commit') context.dropConnection?.();
  },
};
const deps = { pool, clock: systemClock, ids: randomIds, checkpoints, logger };

if (process.env.PRL_TEST_COMPONENT === 'api') {
  const app = buildApi({ deps, webhookSecret: config.webhookSecret });
  logger.info('api listening', { url: await app.listen({ host: '127.0.0.1', port: 0 }) });
} else {
  new Worker(deps, new ProviderClient(`http://${config.providerHost}:${config.providerPort}`, 2000), {
    workerId: `faulty-${process.pid}`,
    leaseMs: 800,
    retryDelayMs: 200,
    pollMs: 50,
  }).start();
  logger.info('worker started');
}
