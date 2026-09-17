import { connectionString, loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { systemClock } from '../shared/clock.ts';
import { noCheckpoints } from '../shared/checkpoints.ts';
import { randomIds } from '../shared/ids.ts';
import { createLogger } from '../shared/logger.ts';
import { onShutdown } from '../shared/process.ts';
import { buildApi } from './server.ts';

// Production-shaped entry point: no fault injection is reachable from here.
const config = loadConfig();
const logger = createLogger('api');
const pool = createPool(connectionString(config.db, 'app'));
const app = buildApi({
  deps: { pool, clock: systemClock, ids: randomIds, checkpoints: noCheckpoints, logger },
  webhookSecret: config.webhookSecret,
});
const url = await app.listen({ host: config.apiHost, port: config.apiPort });
logger.info('api listening', { url });
onShutdown(logger, async () => {
  await app.close();
  await pool.end();
});
