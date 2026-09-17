import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedRun } from '../../src/app/seed.ts';
import { SimulatorControl } from '../../src/provider-sim/control.ts';
import { systemClock } from '../../src/shared/clock.ts';
import { randomIds } from '../../src/shared/ids.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import { testDeps, uniqueName } from '../harness/deps.ts';
import { postTransfer, TEST_WEBHOOK_SECRET } from '../harness/api.ts';
import { dbEnv, eventually, spawnNode, type Child } from '../harness/processes.ts';

/**
 * Real operating-system processes, killed for real, restarted against the same PostgreSQL.
 * These complement the in-process scenario tests, which use simulated crashes for determinism.
 */
let dbs: TestDatabases;
const children: Child[] = [];
const start = (entry: string, env: Record<string, string>): Child => {
  const child = spawnNode(entry, { ...dbEnv(dbs), ...env });
  children.push(child);
  return child;
};

// One database pair per test: a real worker process drains every due job it can see.
beforeEach(async () => {
  dbs = await createTestDatabases();
});
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => c.kill()));
  await dbs.close();
});

async function seededAccount(): Promise<{ runId: string; account: string }> {
  const runId = uniqueName('run');
  const account = `${runId}-A`;
  await seedRun({ ...testDeps(dbs.app), clock: systemClock }, runId, [{ accountId: account }]);
  return { runId, account };
}

describe('S1 restart variant: API process dies after commit, before the response', () => {
  it('a fresh API process replays the original acceptance', async () => {
    const { runId, account } = await seededAccount();
    const faulty = start('tests/harness/faulty-process.ts', { PRL_TEST_COMPONENT: 'api', PRL_TEST_FAULT: 'drop_response_after_commit' });
    const faultyUrl = String((await faulty.waitForLog('api listening')).url);

    await expect(postTransfer(faultyUrl, { account, key: 'K-restart' })).rejects.toThrow(/fetch failed/);
    await faulty.kill(); // SIGKILL: nothing in memory survives

    const fresh = start('src/api/main.ts', { PRL_API_PORT: '0' });
    const freshUrl = String((await fresh.waitForLog('api listening')).url);
    const retry = await postTransfer(freshUrl, { account, key: 'K-restart' });
    expect(retry.status).toBe(202);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');

    const rows = await dbs.app.query('SELECT transfer_id FROM transfers WHERE run_id = $1', [runId]);
    expect(rows.rows).toHaveLength(1);
    expect(((await retry.json()) as { transferId: string }).transferId).toBe(rows.rows[0].transfer_id);
    const reserves = await dbs.app.query("SELECT 1 FROM journal_batches WHERE run_id = $1 AND phase = 'reserve'", [runId]);
    expect(reserves.rowCount).toBe(1);
  });
});

describe('S3 restart variant: worker process dies between the provider answer and its own commit', () => {
  it('a restarted worker and simulator recover through outcome_unknown to exactly one settlement', async () => {
    const { account } = await seededAccount();
    const api = start('src/api/main.ts', { PRL_API_PORT: '0' });
    const apiUrl = String((await api.waitForLog('api listening')).url);
    const sim = start('src/provider-sim/main.ts', { PRL_PROVIDER_PORT: '0', PRL_SIM_AUTO_DELIVER: 'off' });
    const simPort = new URL(String((await sim.waitForLog('provider simulator listening')).url)).port;

    const accepted = await postTransfer(apiUrl, { account, key: 'K-worker-crash' });
    const { transferId } = (await accepted.json()) as { transferId: string };
    const state = async (): Promise<string> =>
      (await dbs.app.query('SELECT state FROM transfers WHERE transfer_id = $1', [transferId])).rows[0].state;
    const reference = (await dbs.app.query('SELECT provider_reference FROM transfers WHERE transfer_id = $1', [transferId])).rows[0]
      .provider_reference as string;
    const oracle = new SimulatorControl(
      { pool: dbs.provider, clock: systemClock, ids: randomIds },
      { webhookUrl: `${apiUrl}/v1/provider/webhooks`, webhookSecret: TEST_WEBHOOK_SECRET },
    );

    const crashing = start('tests/harness/faulty-process.ts', {
      PRL_TEST_COMPONENT: 'worker',
      PRL_TEST_CRASH_AT: 'worker.job.after_provider_response',
      PRL_PROVIDER_PORT: simPort,
    });
    expect(await crashing.exited).toBe(137);

    // The provider paid; the application never recorded the answer.
    expect(await oracle.oracleEffectCount(reference)).toBe(1);
    expect(await state()).toBe('submitting');
    const reserved = await dbs.app.query('SELECT balance_minor FROM account_balances WHERE ledger_account = $1', [
      `user:${account}:reserved`,
    ]);
    expect(reserved.rows[0].balance_minor).toBe('1250');

    // Restart the simulator too: its acceptance must survive in its own database.
    await sim.kill();
    const sim2 = start('src/provider-sim/main.ts', { PRL_PROVIDER_PORT: '0', PRL_SIM_AUTO_DELIVER: 'off' });
    const sim2Port = new URL(String((await sim2.waitForLog('provider simulator listening')).url)).port;

    start('src/worker/main.ts', {
      PRL_PROVIDER_PORT: sim2Port,
      PRL_WORKER_LEASE_MS: '800',
      PRL_WORKER_RETRY_MS: '200',
      PRL_WORKER_POLL_MS: '50',
    });
    await eventually(state, (s) => s === 'settled', 'restarted worker to settle the transfer');

    const phases = await dbs.app.query('SELECT phase FROM journal_batches WHERE transfer_id = $1 ORDER BY created_at', [transferId]);
    expect(phases.rows.map((r) => r.phase)).toEqual(['reserve', 'settle']);
    const types = (await dbs.app.query('SELECT type FROM trace_events WHERE transfer_id = $1 ORDER BY seq', [transferId])).rows.map(
      (r) => r.type,
    );
    expect(types).toContain('outcome_unknown');
    const refs = await dbs.app.query('SELECT DISTINCT provider_reference FROM provider_attempts WHERE transfer_id = $1', [transferId]);
    expect(refs.rows).toEqual([{ provider_reference: reference }]);
    expect(await oracle.oracleEffectCount(reference)).toBe(1);
  });
});
