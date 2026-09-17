import { withTransaction, type Pool } from '../db/pool.ts';
import type { AppDeps } from './deps.ts';
import { postBatch } from './journal-repo.ts';
import { ASSET } from '../domain/amount.ts';
import { availableAccount, CLEARING_ACCOUNT, FUNDING_ACCOUNT, mustBeNonNegative, reservedAccount } from '../domain/journal.ts';

export const SEEDED_DESTINATIONS = ['demo:merchant-1', 'demo:merchant-2'] as const;
export const DEFAULT_SEED_FUNDS_MINOR = 100000n;

export interface SeedAccount {
  accountId: string;
  fundMinor?: bigint;
}

/** Creates one isolated synthetic run: its accounts, the fixed destinations and seed postings. */
export async function seedRun(deps: AppDeps, runId: string, accounts: SeedAccount[]): Promise<void> {
  await withTransaction(deps.pool, async (client) => {
    const now = deps.clock.now();
    await client.query('INSERT INTO runs (run_id, created_at) VALUES ($1, $2)', [runId, now]);
    for (const destination of SEEDED_DESTINATIONS) {
      await client.query('INSERT INTO destinations (destination_id) VALUES ($1) ON CONFLICT DO NOTHING', [destination]);
    }
    for (const account of accounts) {
      await client.query('INSERT INTO demo_accounts (account_id, run_id, created_at) VALUES ($1, $2, $3)', [account.accountId, runId, now]);
      // Pre-create every projection row so concurrent first postings never race to insert one.
      for (const ledger of [availableAccount(account.accountId), reservedAccount(account.accountId), CLEARING_ACCOUNT, FUNDING_ACCOUNT]) {
        await client.query(
          `INSERT INTO account_balances (run_id, ledger_account, asset, balance_minor, must_be_nonnegative)
           VALUES ($1, $2, $3, 0, $4) ON CONFLICT DO NOTHING`,
          [runId, ledger, ASSET, mustBeNonNegative(ledger)],
        );
      }
      await postBatch(client, deps, {
        runId,
        transferId: null,
        phase: 'seed',
        accountId: account.accountId,
        amountMinor: account.fundMinor ?? DEFAULT_SEED_FUNDS_MINOR,
      });
    }
  });
}

/**
 * Removes one run and everything hanging off it. Requires an admin pool: the application role
 * has no DELETE privilege anywhere. Callers must pass the reset guard first.
 */
export async function purgeRun(adminPool: Pool, runId: string): Promise<boolean> {
  const result = await adminPool.query('DELETE FROM runs WHERE run_id = $1', [runId]);
  return (result.rowCount ?? 0) > 0;
}
