import { withTransaction, type Pool, type PoolClient } from '../db/pool.ts';
import type { Clock } from '../shared/clock.ts';
import type { IdGenerator } from '../shared/ids.ts';

/** Deterministic behaviour for one provider reference ('*' = default). Set only by the harness. */
export interface FaultPlan {
  /** What a first submission does: complete immediately, stay pending, or finally reject. */
  onSubmit: 'complete' | 'pending' | 'reject';
  /** Drop this many submit responses AFTER durable acceptance (socket destroyed). */
  loseSubmitResponses: number;
  /** Hold this many submit responses until the client gives up (deadline exceeded). */
  hangSubmitResponses: number;
  /** Lookup behaviour: authoritative answer, 503, or a 200 that carries no usable status. */
  lookup: 'ok' | 'unavailable' | 'inconclusive';
  /** Untrusted free text attached to responses and webhooks (S7). */
  providerNote: string | null;
}

export const DEFAULT_PLAN: FaultPlan = {
  onSubmit: 'complete',
  loseSubmitResponses: 0,
  hangSubmitResponses: 0,
  lookup: 'ok',
  providerNote: null,
};

export interface SimTransfer {
  providerReference: string;
  asset: string;
  amountMinor: string;
  destination: string;
  status: 'pending' | 'completed' | 'rejected';
  sequence: number;
  providerNote: string | null;
  updatedAt: Date;
}

export interface SubmitRequest {
  providerReference: string;
  asset: string;
  amountMinor: string;
  destination: string;
}

export type SubmitOutcome =
  { kind: 'created' | 'existing'; transfer: SimTransfer; respond: 'normal' | 'lose' | 'hang' } | { kind: 'conflict' };

export interface SimDeps {
  pool: Pool;
  clock: Clock;
  ids: IdGenerator;
}

interface SimRow {
  provider_reference: string;
  asset: string;
  amount_minor: string;
  destination: string;
  status: SimTransfer['status'];
  sequence: number;
  provider_note: string | null;
  updated_at: Date;
}

const toTransfer = (r: SimRow): SimTransfer => ({
  providerReference: r.provider_reference,
  asset: r.asset,
  amountMinor: r.amount_minor,
  destination: r.destination,
  status: r.status,
  sequence: r.sequence,
  providerNote: r.provider_note,
  updatedAt: r.updated_at,
});

export function webhookBody(eventId: string, t: SimTransfer, status: string, sequence: number, occurredAt: Date): string {
  return JSON.stringify({
    eventId,
    type: 'provider.transfer.updated',
    providerReference: t.providerReference,
    status,
    providerSequence: sequence,
    occurredAt: occurredAt.toISOString(),
    asset: t.asset,
    amountMinor: t.amountMinor,
    destination: t.destination,
    finalNoEffect: status === 'rejected',
    ...(t.providerNote === null ? {} : { note: t.providerNote }),
  });
}

export async function loadPlan(q: Pool | PoolClient, reference: string): Promise<{ key: string; plan: FaultPlan }> {
  const result = await q.query<{ provider_reference: string; plan: Partial<FaultPlan> }>(
    `SELECT provider_reference, plan FROM sim_fault_plans WHERE provider_reference IN ($1, '*')
      ORDER BY (provider_reference = '*') LIMIT 1`,
    [reference],
  );
  const row = result.rows[0];
  return { key: row?.provider_reference ?? '*', plan: { ...DEFAULT_PLAN, ...(row?.plan ?? {}) } };
}

async function emitEvent(
  client: PoolClient,
  deps: SimDeps,
  t: SimTransfer,
  status: string,
  sequence: number,
  forced: boolean,
): Promise<string> {
  const eventId = deps.ids.next('evt');
  const occurredAt = deps.clock.now();
  await client.query(
    `INSERT INTO sim_webhook_outbox (event_id, provider_reference, status, sequence, occurred_at, body, forced, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`,
    [eventId, t.providerReference, status, sequence, occurredAt, webhookBody(eventId, t, status, sequence, occurredAt), forced],
  );
  return eventId;
}

/** Moves a pending operation to a final status. Completion applies the single external effect. */
export async function finalize(
  client: PoolClient,
  deps: SimDeps,
  reference: string,
  status: 'completed' | 'rejected',
): Promise<SimTransfer> {
  const locked = await client.query<SimRow>('SELECT * FROM sim_transfers WHERE provider_reference = $1 FOR UPDATE', [reference]);
  const row = locked.rows[0];
  if (!row) throw new Error(`simulator has no operation ${reference}`);
  if (row.status !== 'pending') {
    if (row.status === status) return toTransfer(row);
    throw new Error(`simulator operation ${reference} is already ${row.status}`);
  }
  const now = deps.clock.now();
  const updated = await client.query<SimRow>(
    'UPDATE sim_transfers SET status = $2, sequence = sequence + 1, updated_at = $3 WHERE provider_reference = $1 RETURNING *',
    [reference, status, now],
  );
  const transfer = toTransfer(updated.rows[0]!);
  if (status === 'completed') {
    // Primary key on provider_reference: a second effect for the same reference cannot exist.
    await client.query('INSERT INTO sim_effects (provider_reference, asset, amount_minor, applied_at) VALUES ($1, $2, $3::numeric, $4)', [
      reference,
      transfer.asset,
      transfer.amountMinor,
      now,
    ]);
  }
  await emitEvent(client, deps, transfer, status, transfer.sequence, false);
  return transfer;
}

/**
 * Idempotent submission keyed by provider reference. The acceptance (and any immediate final
 * status) commits BEFORE the HTTP layer decides whether the response gets lost.
 */
export async function submit(deps: SimDeps, request: SubmitRequest): Promise<SubmitOutcome> {
  return withTransaction(deps.pool, async (client) => {
    const { key, plan } = await loadPlan(client, request.providerReference);
    // Serialize concurrent first submissions of one reference.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [request.providerReference]);
    const existing = await client.query<SimRow>('SELECT * FROM sim_transfers WHERE provider_reference = $1 FOR UPDATE', [
      request.providerReference,
    ]);

    let kind: 'created' | 'existing' = 'existing';
    let transfer: SimTransfer;
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.asset !== request.asset || row.amount_minor !== request.amountMinor || row.destination !== request.destination) {
        return { kind: 'conflict' };
      }
      transfer = toTransfer(row);
    } else {
      kind = 'created';
      const now = deps.clock.now();
      const inserted = await client.query<SimRow>(
        `INSERT INTO sim_transfers (provider_reference, asset, amount_minor, destination, status, sequence, provider_note, created_at, updated_at)
         VALUES ($1, $2, $3::numeric, $4, 'pending', 1, $5, $6, $6) RETURNING *`,
        [request.providerReference, request.asset, request.amountMinor, request.destination, plan.providerNote, now],
      );
      transfer = toTransfer(inserted.rows[0]!);
      await emitEvent(client, deps, transfer, 'pending', 1, false);
      if (plan.onSubmit === 'complete') transfer = await finalize(client, deps, request.providerReference, 'completed');
      if (plan.onSubmit === 'reject') transfer = await finalize(client, deps, request.providerReference, 'rejected');
    }

    let respond: 'normal' | 'lose' | 'hang' = 'normal';
    if (plan.loseSubmitResponses > 0) respond = 'lose';
    else if (plan.hangSubmitResponses > 0) respond = 'hang';
    if (respond !== 'normal') {
      const field = respond === 'lose' ? 'loseSubmitResponses' : 'hangSubmitResponses';
      await client.query(
        `UPDATE sim_fault_plans SET plan = jsonb_set(plan, ARRAY[$2::text], to_jsonb((plan->>$2)::int - 1)), updated_at = $3
          WHERE provider_reference = $1`,
        [key, field, deps.clock.now()],
      );
    }
    return { kind, transfer, respond };
  });
}

export async function lookup(deps: SimDeps, reference: string): Promise<{ plan: FaultPlan; transfer: SimTransfer | null }> {
  const { plan } = await loadPlan(deps.pool, reference);
  const result = await deps.pool.query<SimRow>('SELECT * FROM sim_transfers WHERE provider_reference = $1', [reference]);
  return { plan, transfer: result.rows[0] ? toTransfer(result.rows[0]) : null };
}

export { emitEvent as emitSimEvent, toTransfer as simRowToTransfer };
export type { SimRow };
