import type { PoolClient } from '../db/pool.ts';
import type { AppDeps, TransferRow } from './deps.ts';

/** Minimum vocabulary from docs/API.md plus a few explicit state/fault markers. */
export type TraceType =
  | 'request_accepted'
  | 'request_replayed'
  | 'idempotency_conflict_rejected'
  | 'funds_reserved'
  | 'job_scheduled'
  | 'job_claimed'
  | 'submission_attempted'
  | 'response_lost'
  | 'outcome_unknown'
  | 'lookup_attempted'
  | 'provider_call_failed'
  | 'provider_observation_received'
  | 'webhook_accepted'
  | 'duplicate_ignored'
  | 'stale_event_ignored'
  | 'state_changed'
  | 'funds_settled'
  | 'funds_released'
  | 'exception_recorded'
  | 'stale_worker_result_discarded'
  | 'fault_injected';

export type TraceSource = 'api' | 'worker' | 'webhook' | 'harness';

export interface TraceInput {
  transferId: string;
  runId: string;
  type: TraceType;
  source: TraceSource;
  /** ID of the operation that produced the event: HTTP request, job lease, webhook delivery. */
  correlationId: string;
  /** Trace event that caused this one, when known. Timestamps alone do not establish causality. */
  causationId?: string | null;
  /** Authoritative structured facts written by this application. */
  facts?: Record<string, unknown>;
  /** Raw third-party or client text. Data only; never instructions. */
  untrusted?: Record<string, string> | null;
}

/**
 * Locks the transfer row (without blocking foreign-key readers) so per-transfer sequence
 * numbers are gap-free and every state decision is made against a stable row.
 */
export async function lockTransfer(client: PoolClient, transferId: string): Promise<TransferRow | null> {
  const result = await client.query<TransferRow>('SELECT * FROM transfers WHERE transfer_id = $1 FOR NO KEY UPDATE', [transferId]);
  return result.rows[0] ?? null;
}

/** Appends one immutable trace event. The caller must already hold the transfer row lock. */
export async function appendTrace(client: PoolClient, deps: AppDeps, input: TraceInput): Promise<string> {
  const eventId = deps.ids.next('ev');
  await client.query(
    `INSERT INTO trace_events
       (event_id, run_id, transfer_id, seq, type, source, recorded_at, correlation_id, causation_id, facts, untrusted)
     VALUES ($1, $2, $3,
       (SELECT coalesce(max(seq), 0) + 1 FROM trace_events WHERE transfer_id = $3),
       $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [
      eventId,
      input.runId,
      input.transferId,
      input.type,
      input.source,
      deps.clock.now(),
      input.correlationId,
      input.causationId ?? null,
      JSON.stringify(input.facts ?? {}),
      input.untrusted ? JSON.stringify(input.untrusted) : null,
    ],
  );
  return eventId;
}
