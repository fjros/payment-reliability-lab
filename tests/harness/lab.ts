import { expect } from 'vitest';
import type { InvariantReport } from '../../src/app/invariants.ts';
import { seedRun } from '../../src/app/seed.ts';
import type { TransferRow } from '../../src/app/deps.ts';
import { Stack } from '../../src/scenarios/stack.ts';
import { ManualClock } from '../../src/shared/clock.ts';
import { randomIds } from '../../src/shared/ids.ts';
import type { TestDatabases } from './databases.ts';
import { TEST_WEBHOOK_SECRET, getJson, postTransfer } from './api.ts';
import { uniqueName } from './deps.ts';

export interface Lab {
  stack: Stack;
  clock: ManualClock;
  close(): Promise<void>;
}

export async function startLab(dbs: TestDatabases, options: { providerTimeoutMs?: number } = {}): Promise<Lab> {
  const clock = new ManualClock();
  const stack = await Stack.start({
    appPool: dbs.app,
    providerPool: dbs.provider,
    clock,
    ids: randomIds,
    webhookSecret: TEST_WEBHOOK_SECRET,
    ...options,
  });
  return { stack, clock, close: () => stack.close() };
}

export interface Subject {
  runId: string;
  account: string;
  transferId: string;
  reference: string;
}

/** Seeds a fresh run/account and accepts one 1250-unit transfer through the real HTTP API. */
export async function acceptedTransfer(lab: Lab, body?: Record<string, unknown>): Promise<Subject> {
  const runId = uniqueName('run');
  const account = `${runId}-A`;
  await seedRun(lab.stack.deps, runId, [{ accountId: account }]);
  const response = await postTransfer(lab.stack.apiUrl, body ? { account, key: 'K', body } : { account, key: 'K' });
  expect(response.status).toBe(202);
  const { transferId } = (await response.json()) as { transferId: string };
  const row = await transferRow(lab, transferId);
  return { runId, account, transferId, reference: row.provider_reference };
}

export async function transferRow(lab: Lab, transferId: string): Promise<TransferRow> {
  const result = await lab.stack.deps.pool.query<TransferRow>('SELECT * FROM transfers WHERE transfer_id = $1', [transferId]);
  return result.rows[0]!;
}

export async function journalPhases(lab: Lab, transferId: string): Promise<string[]> {
  const result = await lab.stack.deps.pool.query<{ phase: string }>(
    'SELECT phase FROM journal_batches WHERE transfer_id = $1 ORDER BY created_at, batch_id',
    [transferId],
  );
  return result.rows.map((r) => r.phase);
}

export async function traceTypes(lab: Lab, transferId: string): Promise<string[]> {
  const result = await lab.stack.deps.pool.query<{ type: string }>('SELECT type FROM trace_events WHERE transfer_id = $1 ORDER BY seq', [
    transferId,
  ]);
  return result.rows.map((r) => r.type);
}

export async function attempts(
  lab: Lab,
  transferId: string,
): Promise<Array<{ kind: string; outcome: string | null; provider_reference: string }>> {
  const result = await lab.stack.deps.pool.query<{ kind: string; outcome: string | null; provider_reference: string }>(
    'SELECT kind, outcome, provider_reference FROM provider_attempts WHERE transfer_id = $1 ORDER BY attempt_no',
    [transferId],
  );
  return result.rows;
}

export async function userBalances(lab: Lab, s: Subject): Promise<{ available: string; reserved: string; clearing: string }> {
  const { body } = await getJson<{ availableMinor: string; reservedMinor: string; runClearingMinor: string }>(
    lab.stack.apiUrl,
    '/v1/balances',
    s.account,
  );
  return { available: body.availableMinor, reserved: body.reservedMinor, clearing: body.runClearingMinor };
}

export async function invariantStatuses(lab: Lab, s: Subject): Promise<{ statuses: string[]; report: InvariantReport }> {
  const { body } = await getJson<InvariantReport>(lab.stack.apiUrl, `/v1/transfers/${s.transferId}/invariants`, s.account);
  return { statuses: body.results.map((r) => `${r.id}:${r.status}`), report: body };
}

/** After a submission, I6 is honestly `unknown` from the application's side; everything else passes. */
export const HEALTHY_AFTER_SUBMISSION = ['I1:pass', 'I2:pass', 'I3:pass', 'I4:pass', 'I5:pass', 'I6:unknown', 'I7:pass', 'I8:pass'];

/** S5: the whole run conserves value and the projection equals the journal. */
export async function expectConservation(lab: Lab, runId: string): Promise<void> {
  const pool = lab.stack.deps.pool;
  const total = await pool.query<{ s: string }>(
    'SELECT coalesce(sum(amount_minor), 0)::text AS s FROM journal_postings WHERE run_id = $1',
    [runId],
  );
  expect(total.rows[0]!.s).toBe('0');
  const perBatch = await pool.query(
    'SELECT batch_id FROM journal_postings WHERE run_id = $1 GROUP BY batch_id, asset HAVING sum(amount_minor) <> 0',
    [runId],
  );
  expect(perBatch.rows).toEqual([]);
  const drift = await pool.query(
    `SELECT b.ledger_account FROM account_balances b LEFT JOIN readmodel.journal_account_totals j USING (run_id, ledger_account, asset)
      WHERE b.run_id = $1 AND b.balance_minor <> coalesce(j.total_minor, 0)`,
    [runId],
  );
  expect(drift.rows).toEqual([]);
  const negative = await pool.query(
    'SELECT ledger_account FROM account_balances WHERE run_id = $1 AND must_be_nonnegative AND balance_minor < 0',
    [runId],
  );
  expect(negative.rows).toEqual([]);
}
