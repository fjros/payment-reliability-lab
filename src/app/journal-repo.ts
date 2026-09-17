import type { PoolClient } from '../db/pool.ts';
import { pgErrorCode } from '../db/pool.ts';
import { isBalanced, mustBeNonNegative, postingsFor, type JournalPhase } from '../domain/journal.ts';
import { serializeMinor } from '../domain/amount.ts';
import type { AppDeps } from './deps.ts';

export class DuplicateJournalPhaseError extends Error {
  constructor(transferId: string | null, phase: string) {
    super(`journal phase ${phase} already exists (or conflicts) for ${transferId ?? 'seed'}`);
    this.name = 'DuplicateJournalPhaseError';
  }
}

export interface PostedBatch {
  batchId: string;
  postingIds: string[];
}

/**
 * Inserts one balanced posting batch and applies it to the projection, inside the caller's
 * transaction. The unique indexes make a repeated phase, or settle-after-release, fail here
 * even if application checks were bypassed.
 */
export async function postBatch(
  client: PoolClient,
  deps: AppDeps,
  input: { runId: string; transferId: string | null; phase: JournalPhase; accountId: string; amountMinor: bigint },
): Promise<PostedBatch> {
  const postings = postingsFor(input.phase, input.accountId, input.amountMinor);
  if (!isBalanced(postings)) throw new Error('refusing to post an unbalanced batch');

  const batchId = deps.ids.next('jb');
  try {
    await client.query('SAVEPOINT post_batch');
    await client.query('INSERT INTO journal_batches (batch_id, run_id, transfer_id, phase, created_at) VALUES ($1, $2, $3, $4, $5)', [
      batchId,
      input.runId,
      input.transferId,
      input.phase,
      deps.clock.now(),
    ]);
    await client.query('RELEASE SAVEPOINT post_batch');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT post_batch');
    if (pgErrorCode(error) === '23505') throw new DuplicateJournalPhaseError(input.transferId, input.phase);
    throw error;
  }

  const postingIds: string[] = [];
  // Stable order keeps balance-row lock acquisition consistent across transactions.
  const ordered = [...postings].sort((a, b) => a.ledgerAccount.localeCompare(b.ledgerAccount));
  for (const posting of ordered) {
    const postingId = deps.ids.next('jp');
    postingIds.push(postingId);
    await client.query(
      `INSERT INTO journal_postings (posting_id, batch_id, run_id, ledger_account, asset, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6::numeric)`,
      [postingId, batchId, input.runId, posting.ledgerAccount, posting.asset, serializeMinor(posting.amountMinor)],
    );
    // UPDATE first: an upsert would evaluate the nonnegative CHECK against the bare delta.
    const amount = serializeMinor(posting.amountMinor);
    const updated = await client.query(
      `UPDATE account_balances SET balance_minor = balance_minor + $4::numeric
        WHERE run_id = $1 AND ledger_account = $2 AND asset = $3`,
      [input.runId, posting.ledgerAccount, posting.asset, amount],
    );
    if (updated.rowCount === 0) {
      await client.query(
        `INSERT INTO account_balances (run_id, ledger_account, asset, balance_minor, must_be_nonnegative)
         VALUES ($1, $2, $3, $4::numeric, $5)`,
        [input.runId, posting.ledgerAccount, posting.asset, amount, mustBeNonNegative(posting.ledgerAccount)],
      );
    }
  }
  return { batchId, postingIds };
}
