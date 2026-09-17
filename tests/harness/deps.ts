import type { AppDeps } from '../../src/app/deps.ts';
import type { Pool } from '../../src/db/pool.ts';
import { ManualClock } from '../../src/shared/clock.ts';
import { noCheckpoints, type Checkpoints } from '../../src/shared/checkpoints.ts';
import { randomIds } from '../../src/shared/ids.ts';
import { silentLogger } from '../../src/shared/logger.ts';

export function testDeps(pool: Pool, overrides: Partial<AppDeps> = {}): AppDeps & { clock: ManualClock } {
  const clock = new ManualClock();
  return { pool, clock, ids: randomIds, checkpoints: noCheckpoints as Checkpoints, logger: silentLogger, ...overrides } as AppDeps & {
    clock: ManualClock;
  };
}

let counter = 0;
/** Unique run/account names so tests in one file never share balances. */
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}`;
}

export async function balances(pool: Pool, runId: string): Promise<Record<string, string>> {
  const result = await pool.query<{ ledger_account: string; balance_minor: string }>(
    'SELECT ledger_account, balance_minor FROM account_balances WHERE run_id = $1',
    [runId],
  );
  return Object.fromEntries(result.rows.map((r) => [r.ledger_account, r.balance_minor]));
}
