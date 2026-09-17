import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { connectionString } from '../../src/config.ts';
import { withTransaction } from '../../src/db/pool.ts';
import { postBatch, DuplicateJournalPhaseError } from '../../src/app/journal-repo.ts';
import { acceptTransfer } from '../../src/app/accept-transfer.ts';
import { purgeRun, seedRun } from '../../src/app/seed.ts';
import { assertResettableTarget } from '../../src/config.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import { balances, testDeps, uniqueName } from '../harness/deps.ts';

let dbs: TestDatabases;
beforeAll(async () => {
  dbs = await createTestDatabases();
});
afterAll(async () => {
  await dbs.close();
});

async function acceptOne(runId: string, accountId: string, amountMinor = 1250n): Promise<string> {
  const result = await acceptTransfer(testDeps(dbs.app), {
    accountId,
    idempotencyKey: uniqueName('key'),
    requestId: 'req_test',
    asset: 'DEMO_USD',
    amountMinor,
    destination: 'demo:merchant-1',
    note: null,
  });
  if (result.kind !== 'accepted') throw new Error(`unexpected ${result.kind}`);
  void runId;
  return result.body.transferId;
}

describe('S5 foundation: migrated PostgreSQL enforces the journal invariants', () => {
  it('seeds +100000 available / -100000 funding as one balanced batch, projection equals journal', async () => {
    const runId = uniqueName('run');
    await seedRun(testDeps(dbs.app), runId, [{ accountId: `${runId}-A` }]);
    expect(await balances(dbs.app, runId)).toEqual({
      [`user:${runId}-A:available`]: '100000',
      [`user:${runId}-A:reserved`]: '0',
      'provider:clearing': '0',
      'demo:funding': '-100000',
    });
    const totals = await dbs.app.query(
      `SELECT j.ledger_account, j.total_minor, b.balance_minor FROM readmodel.journal_account_totals j
         JOIN account_balances b USING (run_id, ledger_account, asset) WHERE run_id = $1`,
      [runId],
    );
    expect(totals.rows).toHaveLength(2); // only accounts with postings have journal totals
    for (const row of totals.rows) expect(row.total_minor).toBe(row.balance_minor);
    const sum = await dbs.app.query('SELECT sum(amount_minor)::text AS s FROM journal_postings WHERE run_id = $1', [runId]);
    expect(sum.rows[0].s).toBe('0');
  });

  it('rejects an unbalanced batch at commit, inside the database', async () => {
    const runId = uniqueName('run');
    await seedRun(testDeps(dbs.app), runId, [{ accountId: `${runId}-A` }]);
    const attempt = withTransaction(dbs.app, async (client) => {
      await client.query(
        "INSERT INTO journal_batches (batch_id, run_id, transfer_id, phase, created_at) VALUES ('jb_bad', $1, NULL, 'seed', now())",
        [runId],
      );
      await client.query(
        "INSERT INTO journal_postings (posting_id, batch_id, run_id, ledger_account, asset, amount_minor) VALUES ('jp_bad', 'jb_bad', $1, 'demo:funding', 'DEMO_USD', 5)",
        [runId],
      );
    });
    await expect(attempt).rejects.toThrow(/does not balance/);
    const leftover = await dbs.app.query("SELECT 1 FROM journal_batches WHERE batch_id = 'jb_bad'");
    expect(leftover.rowCount).toBe(0);
  });

  it('allows one reservation, one terminal effect, and never both settle and release (I3)', async () => {
    const runId = uniqueName('run');
    const accountId = `${runId}-A`;
    const deps = testDeps(dbs.app);
    await seedRun(deps, runId, [{ accountId }]);
    const transferId = await acceptOne(runId, accountId);
    const post = (phase: 'reserve' | 'settle' | 'release') =>
      withTransaction(dbs.app, (client) => postBatch(client, deps, { runId, transferId, phase, accountId, amountMinor: 1250n }));

    await expect(post('reserve')).rejects.toBeInstanceOf(DuplicateJournalPhaseError);
    await post('settle');
    await expect(post('settle')).rejects.toBeInstanceOf(DuplicateJournalPhaseError);
    await expect(post('release')).rejects.toBeInstanceOf(DuplicateJournalPhaseError);
    expect(await balances(dbs.app, runId)).toEqual({
      [`user:${accountId}:available`]: '98750',
      [`user:${accountId}:reserved`]: '0',
      'provider:clearing': '1250',
      'demo:funding': '-100000',
    });
  });

  it('keeps available and reserved nonnegative through a database CHECK', async () => {
    const runId = uniqueName('run');
    const accountId = `${runId}-A`;
    const deps = testDeps(dbs.app);
    await seedRun(deps, runId, [{ accountId, fundMinor: 100n }]);
    const transferId = await acceptOne(runId, accountId, 100n);
    // A second settle-sized debit of reserved funds cannot happen; simulate a buggy caller directly.
    await withTransaction(dbs.app, (client) =>
      postBatch(client, deps, { runId, transferId, phase: 'settle', accountId, amountMinor: 100n }),
    );
    const overdraw = dbs.app.query(
      'UPDATE account_balances SET balance_minor = balance_minor - 1 WHERE run_id = $1 AND ledger_account = $2',
      [runId, `user:${accountId}:reserved`],
    );
    await expect(overdraw).rejects.toThrow(/account_balances_check|violates check/);
  });

  it('denies the application role any UPDATE or DELETE of journal and trace history', async () => {
    const runId = uniqueName('run');
    await seedRun(testDeps(dbs.app), runId, [{ accountId: `${runId}-A` }]);
    await expect(dbs.app.query('UPDATE journal_postings SET amount_minor = 1')).rejects.toThrow(/permission denied/);
    await expect(dbs.app.query('DELETE FROM journal_postings')).rejects.toThrow(/permission denied/);
    await expect(dbs.app.query('DELETE FROM trace_events')).rejects.toThrow(/permission denied/);
    await expect(dbs.app.query('DELETE FROM transfers')).rejects.toThrow(/permission denied/);
    // Even a privileged role cannot UPDATE postings: the trigger refuses.
    await expect(dbs.admin.query('UPDATE journal_postings SET amount_minor = 1')).rejects.toThrow(/immutable/);
  });

  it('separates credentials: application roles cannot connect to the provider database and vice versa', async () => {
    const tryConnect = async (url: string): Promise<string> => {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        return 'connected';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.end().catch(() => {});
      }
    };
    expect(await tryConnect(connectionString(dbs.targets, 'app', dbs.targets.providerDatabase))).toMatch(/permission denied/);
    expect(await tryConnect(connectionString(dbs.targets, 'mcp', dbs.targets.providerDatabase))).toMatch(/permission denied/);
    expect(await tryConnect(connectionString(dbs.targets, 'provider', dbs.targets.appDatabase))).toMatch(/permission denied/);
  });

  it('purges exactly one run and leaves others intact', async () => {
    const keep = uniqueName('run');
    const drop = uniqueName('run');
    await seedRun(testDeps(dbs.app), keep, [{ accountId: `${keep}-A` }]);
    await seedRun(testDeps(dbs.app), drop, [{ accountId: `${drop}-A` }]);
    await acceptOne(drop, `${drop}-A`);
    expect(await purgeRun(dbs.admin, drop)).toBe(true);
    expect(await balances(dbs.app, drop)).toEqual({});
    expect(Object.keys(await balances(dbs.app, keep))).toHaveLength(4);
  });

  it('refuses destructive operations on non-local or unexpected database names', () => {
    expect(() => assertResettableTarget({ ...dbs.targets, host: 'db.example.com' })).toThrow(/non-loopback/);
    expect(() => assertResettableTarget({ ...dbs.targets, host: '127.0.0.1', appDatabase: 'postgres' })).toThrow(/Refusing/);
    expect(() => assertResettableTarget({ ...dbs.targets, host: '127.0.0.1' })).not.toThrow();
  });
});
