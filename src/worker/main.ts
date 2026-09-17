import { connectionString, loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { systemClock } from '../shared/clock.ts';
import { noCheckpoints } from '../shared/checkpoints.ts';
import { randomIds } from '../shared/ids.ts';
import { createLogger } from '../shared/logger.ts';
import { envInt, onShutdown } from '../shared/process.ts';
import { ProviderClient } from './provider-client.ts';
import { Worker } from './worker.ts';

const config = loadConfig();
const logger = createLogger('worker');
const pool = createPool(connectionString(config.db, 'app'));
const providerUrl = `http://${config.providerHost}:${config.providerPort}`;
const worker = new Worker(
  { pool, clock: systemClock, ids: randomIds, checkpoints: noCheckpoints, logger },
  new ProviderClient(providerUrl, envInt('PRL_PROVIDER_TIMEOUT_MS', 2000)),
  {
    workerId: `worker-${process.pid}`,
    leaseMs: envInt('PRL_WORKER_LEASE_MS', 30_000),
    retryDelayMs: envInt('PRL_WORKER_RETRY_MS', 2_000),
    pollMs: envInt('PRL_WORKER_POLL_MS', 250),
  },
);
worker.start();
logger.info('worker started', { providerUrl });
onShutdown(logger, async () => {
  await worker.stop();
  await pool.end();
});
