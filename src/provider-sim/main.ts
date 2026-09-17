import { setTimeout as sleep } from 'node:timers/promises';
import { connectionString, loadConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { systemClock } from '../shared/clock.ts';
import { randomIds } from '../shared/ids.ts';
import { createLogger } from '../shared/logger.ts';
import { envInt, onShutdown } from '../shared/process.ts';
import { SimulatorControl } from './control.ts';
import { buildProviderSim } from './server.ts';

const config = loadConfig();
const logger = createLogger('provider-sim');
const pool = createPool(connectionString(config.db, 'provider'));
const deps = { pool, clock: systemClock, ids: randomIds };
const app = buildProviderSim(deps);
const url = await app.listen({ host: config.providerHost, port: config.providerPort });
logger.info('provider simulator listening', { url });

// Webhooks go to one fixed, configured receiver. In scenario runs the harness delivers instead.
const control = new SimulatorControl(deps, {
  webhookUrl: `http://${config.apiHost}:${config.apiPort}/v1/provider/webhooks`,
  webhookSecret: config.webhookSecret,
});
const stopping = new AbortController();
const autoDeliver = process.env.PRL_SIM_AUTO_DELIVER !== 'off';
const loop = (async () => {
  while (autoDeliver && !stopping.signal.aborted) {
    await control.deliverPending().catch((error: unknown) => logger.warn('webhook delivery failed', { error }));
    await sleep(envInt('PRL_SIM_DELIVERY_POLL_MS', 300), undefined, { signal: stopping.signal }).catch(() => undefined);
  }
})();
onShutdown(logger, async () => {
  stopping.abort();
  await loop;
  await app.close();
  await pool.end();
});
