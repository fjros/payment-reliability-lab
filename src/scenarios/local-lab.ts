import { purgeRun } from '../app/seed.ts';
import { assertResettableTarget, connectionString, loadConfig, type ServiceConfig } from '../config.ts';
import { createPool } from '../db/pool.ts';
import { ManualClock } from '../shared/clock.ts';
import { seededIds } from '../shared/ids.ts';
import type { ScenarioId } from './answers.ts';
import { runScenario, type ScenarioResult } from './scenarios.ts';
import { Stack } from './stack.ts';

export const SCENARIO_IDS: ScenarioId[] = ['S1', 'S2', 'S3', 'S7', 'S8'];

export function parseScenarioArgs(argv: string[]): { ids: ScenarioId[]; seed: string; stopAtUnknown: boolean } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const seedFlag = argv.find((a) => a.startsWith('--seed='))?.slice('--seed='.length) ?? '1';
  if (!/^[A-Za-z0-9]{1,16}$/.test(seedFlag)) throw new Error('--seed must be 1-16 alphanumeric characters');
  const wanted = positional[0] ?? 'all';
  const ids = wanted === 'all' ? SCENARIO_IDS : SCENARIO_IDS.filter((id) => id === wanted.toUpperCase());
  if (ids.length === 0) throw new Error(`Unknown scenario "${wanted}". Use one of: ${SCENARIO_IDS.join(', ')}, all.`);
  return { ids, seed: seedFlag, stopAtUnknown: argv.includes('--stop-at-unknown') };
}

/**
 * Runs scenarios against the configured LOCAL demo databases. Each scenario lives in its own run
 * (`<scenario>-<seed>`), which is purged first so the command is repeatable. Only that run and
 * the simulator rows for its provider references are removed.
 */
export async function runLocalScenarios(
  ids: ScenarioId[],
  seed: string,
  options: { stopAtUnknown?: boolean; config?: ServiceConfig } = {},
): Promise<ScenarioResult[]> {
  const config = options.config ?? loadConfig();
  assertResettableTarget(config.db);
  const appAdmin = createPool(connectionString(config.db, 'admin', config.db.appDatabase), 2);
  const providerAdmin = createPool(connectionString(config.db, 'admin', config.db.providerDatabase), 2);
  const appPool = createPool(connectionString(config.db, 'app'));
  const providerPool = createPool(connectionString(config.db, 'provider'));
  const results: ScenarioResult[] = [];
  try {
    for (const id of ids) {
      const runId = `${id}-${seed}`;
      const references = await appAdmin.query<{ provider_reference: string }>(
        'SELECT provider_reference FROM transfers WHERE run_id = $1',
        [runId],
      );
      const refs = references.rows.map((r) => r.provider_reference);
      await providerAdmin.query('DELETE FROM sim_transfers WHERE provider_reference = ANY($1)', [refs]);
      await providerAdmin.query('DELETE FROM sim_fault_plans WHERE provider_reference = ANY($1)', [refs]);
      await purgeRun(appAdmin, runId);

      const clock = new ManualClock();
      const stack = await Stack.start({
        appPool,
        providerPool,
        clock,
        ids: seededIds(`${id}:${seed}`),
        webhookSecret: config.webhookSecret,
        providerTimeoutMs: 1500,
      });
      try {
        results.push(
          await runScenario(stack, id, { runId, clock, ...(options.stopAtUnknown && id === 'S3' ? { stopAt: 'unknown' as const } : {}) }),
        );
      } finally {
        await stack.close();
      }
    }
  } finally {
    await Promise.all([appAdmin.end(), providerAdmin.end(), appPool.end(), providerPool.end()]);
  }
  return results;
}
