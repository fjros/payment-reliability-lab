import { withTransaction } from '../db/pool.ts';
import { economicFingerprint } from '../domain/fingerprint.ts';
import { serializeMinor } from '../domain/amount.ts';
import { availableAccount } from '../domain/journal.ts';
import type { AppDeps } from './deps.ts';
import { postBatch } from './journal-repo.ts';
import { appendTrace, lockTransfer } from './trace.ts';

export const OPERATION_KIND = 'create_transfer';

export interface AcceptTransferInput {
  accountId: string;
  idempotencyKey: string;
  requestId: string;
  asset: string;
  amountMinor: bigint;
  destination: string;
  note: string | null;
}

export interface AcceptanceBody {
  transferId: string;
  accepted: true;
  statusUrl: string;
}

export type AcceptTransferResult =
  | { kind: 'accepted'; body: AcceptanceBody }
  | { kind: 'replayed'; body: AcceptanceBody }
  | { kind: 'idempotency_conflict'; transferId: string }
  | { kind: 'insufficient_funds' }
  | { kind: 'unknown_account' }
  | { kind: 'unknown_destination' };

class Rejected extends Error {
  readonly result: AcceptTransferResult;
  constructor(result: AcceptTransferResult) {
    super(result.kind);
    this.result = result;
  }
}

/**
 * One transaction commits the transfer, its reservation, the idempotency result, trace events
 * and the job intent together. Concurrent requests with the same scoped key are resolved by the
 * primary key on idempotency_keys: losers block on the winner's insert, then replay its result
 * without repeating the balance check. A request rejected before acceptance rolls everything
 * back, so it does not reserve the key.
 */
export async function acceptTransfer(deps: AppDeps, input: AcceptTransferInput): Promise<AcceptTransferResult> {
  const fingerprint = economicFingerprint(input);
  try {
    return await withTransaction(deps.pool, async (client) => {
      const account = await client.query<{ run_id: string }>('SELECT run_id FROM demo_accounts WHERE account_id = $1', [input.accountId]);
      const runId = account.rows[0]?.run_id;
      if (!runId) throw new Rejected({ kind: 'unknown_account' });

      const transferId = deps.ids.next('tr');
      const body: AcceptanceBody = { transferId, accepted: true, statusUrl: `/v1/transfers/${transferId}` };
      const now = deps.clock.now();

      const claimed = await client.query(
        `INSERT INTO idempotency_keys
           (account_id, operation_kind, idem_key, fingerprint, transfer_id, response_body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (account_id, operation_kind, idem_key) DO NOTHING`,
        [input.accountId, OPERATION_KIND, input.idempotencyKey, fingerprint, transferId, JSON.stringify(body), now],
      );

      if (claimed.rowCount === 0) {
        const existing = await client.query<{ fingerprint: string; transfer_id: string; response_body: AcceptanceBody }>(
          `SELECT fingerprint, transfer_id, response_body FROM idempotency_keys
            WHERE account_id = $1 AND operation_kind = $2 AND idem_key = $3`,
          [input.accountId, OPERATION_KIND, input.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) throw new Error('idempotency key vanished between conflict and read');
        await lockTransfer(client, row.transfer_id);
        const matches = row.fingerprint === fingerprint;
        await appendTrace(client, deps, {
          transferId: row.transfer_id,
          runId,
          type: matches ? 'request_replayed' : 'idempotency_conflict_rejected',
          source: 'api',
          correlationId: input.requestId,
          facts: {
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            fingerprintMatches: matches,
            effect: 'none',
          },
        });
        return matches ? { kind: 'replayed', body: row.response_body } : { kind: 'idempotency_conflict', transferId: row.transfer_id };
      }

      const destination = await client.query('SELECT 1 FROM destinations WHERE destination_id = $1', [input.destination]);
      if (!destination.rowCount) throw new Rejected({ kind: 'unknown_destination' });

      // Stable per-account lock: distinct transfers check and reserve funds one at a time.
      // NO KEY UPDATE: a plain FOR UPDATE would deadlock against the KEY SHARE locks that the
      // foreign-key inserts above take on this same row in concurrent transactions.
      await client.query('SELECT 1 FROM demo_accounts WHERE account_id = $1 FOR NO KEY UPDATE', [input.accountId]);
      const balance = await client.query<{ balance_minor: string }>(
        'SELECT balance_minor FROM account_balances WHERE run_id = $1 AND ledger_account = $2 AND asset = $3',
        [runId, availableAccount(input.accountId), input.asset],
      );
      const available = BigInt(balance.rows[0]?.balance_minor ?? '0');
      if (available < input.amountMinor) throw new Rejected({ kind: 'insufficient_funds' });

      await client.query(
        `INSERT INTO transfers
           (transfer_id, run_id, account_id, asset, amount_minor, destination, note, state,
            provider_reference, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, 'reserved', $8, $9, $9)`,
        [
          transferId,
          runId,
          input.accountId,
          input.asset,
          serializeMinor(input.amountMinor),
          input.destination,
          input.note,
          deps.ids.next('pref'),
          now,
        ],
      );
      const accepted = await appendTrace(client, deps, {
        transferId,
        runId,
        type: 'request_accepted',
        source: 'api',
        correlationId: input.requestId,
        facts: {
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          asset: input.asset,
          amountMinor: serializeMinor(input.amountMinor),
          destination: input.destination,
          fingerprint,
        },
        untrusted: input.note === null ? null : { clientNote: input.note },
      });
      const batch = await postBatch(client, deps, {
        runId,
        transferId,
        phase: 'reserve',
        accountId: input.accountId,
        amountMinor: input.amountMinor,
      });
      await appendTrace(client, deps, {
        transferId,
        runId,
        type: 'funds_reserved',
        source: 'api',
        correlationId: input.requestId,
        causationId: accepted,
        facts: {
          batchId: batch.batchId,
          postingIds: batch.postingIds,
          phase: 'reserve',
          amountMinor: serializeMinor(input.amountMinor),
          asset: input.asset,
        },
      });
      const jobId = deps.ids.next('job');
      await client.query(
        `INSERT INTO jobs (job_id, run_id, transfer_id, kind, state, run_after, created_at, updated_at)
         VALUES ($1, $2, $3, 'drive_transfer', 'pending', $4, $4, $4)`,
        [jobId, runId, transferId, now],
      );
      await appendTrace(client, deps, {
        transferId,
        runId,
        type: 'job_scheduled',
        source: 'api',
        correlationId: input.requestId,
        causationId: accepted,
        facts: { jobId },
      });
      return { kind: 'accepted', body };
    });
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}
