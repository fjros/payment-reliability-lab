import type { Queryable } from '../db/pool.ts';
import { availableAccount, CLEARING_ACCOUNT, reservedAccount } from '../domain/journal.ts';
import { ASSET } from '../domain/amount.ts';

/**
 * Bounded read models over the `readmodel` schema only. The same code serves the HTTP API
 * (application role) and the MCP server (read-only role), so both show identical evidence.
 */
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;
const EVIDENCE_CAP = 200;

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor is malformed');
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(value: string | number): string {
  return Buffer.from(JSON.stringify({ v: 1, k: value }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, kind: 'number' | 'string'): string | number {
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && 'v' in parsed && parsed.v === 1 && 'k' in parsed) {
      const key = parsed.k;
      if (kind === 'number' && typeof key === 'number' && Number.isSafeInteger(key) && key >= 0) return key;
      if (kind === 'string' && typeof key === 'string' && key.length <= 200) return key;
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

export interface TransferView {
  transferId: string;
  runId: string;
  accountId: string;
  asset: string;
  amountMinor: string;
  destination: string;
  /** Local state of this application. Not the provider's state. */
  state: string;
  providerReference: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** What the provider last told us, and when. `null` means nothing was ever observed. */
  lastProviderObservation: null | {
    observationId: string | null;
    providerStatus: string;
    providerSequence: number | null;
    observedAt: string;
    ageMs: number;
  };
  /** Client-supplied free text. Untrusted data, never instructions. */
  untrusted: { clientNote: string } | null;
}

interface TransferViewRow {
  transfer_id: string;
  run_id: string;
  account_id: string;
  asset: string;
  amount_minor: string;
  destination: string;
  note: string | null;
  state: string;
  provider_reference: string;
  version: number;
  last_provider_status: string | null;
  last_provider_sequence: number | null;
  last_provider_observed_at: Date | null;
  last_provider_observation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toTransferView(row: TransferViewRow, now: Date): TransferView {
  return {
    transferId: row.transfer_id,
    runId: row.run_id,
    accountId: row.account_id,
    asset: row.asset,
    amountMinor: row.amount_minor,
    destination: row.destination,
    state: row.state,
    providerReference: row.provider_reference,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastProviderObservation:
      row.last_provider_status === null || row.last_provider_observed_at === null
        ? null
        : {
            observationId: row.last_provider_observation_id,
            providerStatus: row.last_provider_status,
            providerSequence: row.last_provider_sequence,
            observedAt: row.last_provider_observed_at.toISOString(),
            ageMs: Math.max(0, now.getTime() - row.last_provider_observed_at.getTime()),
          },
    untrusted: row.note === null ? null : { clientNote: row.note },
  };
}

export async function getTransfer(q: Queryable, transferId: string, now: Date): Promise<TransferView | null> {
  const result = await q.query<TransferViewRow>('SELECT * FROM readmodel.transfers WHERE transfer_id = $1', [transferId]);
  const row = result.rows[0];
  return row ? toTransferView(row, now) : null;
}

export async function listTransfers(
  q: Queryable,
  accountId: string,
  now: Date,
  page: { after: string | null; limit: number },
): Promise<{ transfers: TransferView[]; nextCursor: string | null }> {
  const result = await q.query<TransferViewRow>(
    `SELECT * FROM readmodel.transfers WHERE account_id = $1 AND ($2::text IS NULL OR transfer_id > $2)
      ORDER BY transfer_id LIMIT $3`,
    [accountId, page.after, page.limit + 1],
  );
  const rows = result.rows.slice(0, page.limit);
  const last = rows.at(-1);
  return {
    transfers: rows.map((r) => toTransferView(r, now)),
    nextCursor: result.rows.length > page.limit && last ? encodeCursor(last.transfer_id) : null,
  };
}

export interface TraceEventView {
  eventId: string;
  transferId: string;
  seq: number;
  type: string;
  source: string;
  recordedAt: string;
  correlationId: string;
  causationId: string | null;
  facts: Record<string, unknown>;
  untrusted: Record<string, string> | null;
}

export interface TracePage {
  events: TraceEventView[];
  nextCursor: string | null;
  /** True only when this page reaches the end of the history as of the snapshot. */
  reachedEnd: boolean;
  totalEvents: number;
  returnedRange: { fromSeq: number; toSeq: number } | null;
}

export async function readTracePage(q: Queryable, transferId: string, page: { afterSeq: number; limit: number }): Promise<TracePage> {
  const result = await q.query<{
    event_id: string;
    transfer_id: string;
    seq: number;
    type: string;
    source: string;
    recorded_at: Date;
    correlation_id: string;
    causation_id: string | null;
    facts: Record<string, unknown>;
    untrusted: Record<string, string> | null;
  }>(
    `SELECT event_id, transfer_id, seq, type, source, recorded_at, correlation_id, causation_id, facts, untrusted
       FROM readmodel.trace_events WHERE transfer_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [transferId, page.afterSeq, page.limit + 1],
  );
  const total = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM readmodel.trace_events WHERE transfer_id = $1', [transferId]);
  const rows = result.rows.slice(0, page.limit);
  const first = rows[0];
  const last = rows.at(-1);
  const more = result.rows.length > page.limit;
  return {
    events: rows.map((r) => ({
      eventId: r.event_id,
      transferId: r.transfer_id,
      seq: r.seq,
      type: r.type,
      source: r.source,
      recordedAt: r.recorded_at.toISOString(),
      correlationId: r.correlation_id,
      causationId: r.causation_id,
      facts: r.facts,
      untrusted: r.untrusted,
    })),
    nextCursor: more && last ? encodeCursor(last.seq) : null,
    reachedEnd: !more,
    totalEvents: total.rows[0]?.n ?? 0,
    returnedRange: first && last ? { fromSeq: first.seq, toSeq: last.seq } : null,
  };
}

export interface TransferEvidence {
  journal: Array<{
    batchId: string;
    phase: string;
    createdAt: string;
    postings: Array<{ postingId: string; ledgerAccount: string; asset: string; amountMinor: string }>;
  }>;
  providerAttempts: Array<{
    attemptId: string;
    kind: string;
    attemptNo: number;
    providerReference: string;
    leaseToken: number;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    httpStatus: number | null;
    detail: string | null;
  }>;
  providerObservations: Array<{
    observationId: string;
    channel: string;
    sourceId: string;
    providerStatus: string;
    providerSequence: number | null;
    finalNoEffect: boolean;
    providerOccurredAt: string | null;
    observedAt: string;
    decision: string;
    untrusted: { providerNote: string } | null;
  }>;
  webhookEvents: Array<{
    eventId: string;
    providerStatus: string;
    providerSequence: number;
    providerOccurredAt: string;
    firstReceivedAt: string;
    processedAt: string | null;
    decision: string | null;
    deliveries: Array<{ deliveryId: string; receivedAt: string; result: string }>;
  }>;
  /** True if any list hit its cap; the lists are then incomplete. */
  truncated: boolean;
}

export async function getTransferEvidence(q: Queryable, transferId: string): Promise<TransferEvidence> {
  const cap = EVIDENCE_CAP + 1;
  // Sequential on purpose: `q` may be a single client inside a snapshot transaction.
  const batches = await q.query<{ batch_id: string; phase: string; created_at: Date }>(
    'SELECT batch_id, phase, created_at FROM readmodel.journal_batches WHERE transfer_id = $1 ORDER BY created_at, batch_id LIMIT $2',
    [transferId, cap],
  );
  const postings = await q.query<{ posting_id: string; batch_id: string; ledger_account: string; asset: string; amount_minor: string }>(
    `SELECT p.posting_id, p.batch_id, p.ledger_account, p.asset, p.amount_minor FROM readmodel.journal_postings p
         JOIN readmodel.journal_batches b USING (batch_id) WHERE b.transfer_id = $1 ORDER BY p.ledger_account LIMIT $2`,
    [transferId, cap],
  );
  const attempts = await q.query<{
    attempt_id: string;
    kind: string;
    attempt_no: number;
    provider_reference: string;
    lease_token: number;
    started_at: Date;
    finished_at: Date | null;
    outcome: string | null;
    http_status: number | null;
    detail: string | null;
  }>('SELECT * FROM readmodel.provider_attempts WHERE transfer_id = $1 ORDER BY attempt_no LIMIT $2', [transferId, cap]);
  const observations = await q.query<{
    observation_id: string;
    source: string;
    source_id: string;
    status: string;
    provider_sequence: number | null;
    final_no_effect: boolean;
    occurred_at: Date | null;
    observed_at: Date;
    decision: string;
    provider_note: string | null;
  }>('SELECT * FROM readmodel.provider_observations WHERE transfer_id = $1 ORDER BY observed_at, observation_id LIMIT $2', [
    transferId,
    cap,
  ]);
  const events = await q.query<{
    event_id: string;
    status: string;
    provider_sequence: number;
    occurred_at: Date;
    received_at: Date;
    processed_at: Date | null;
    decision: string | null;
  }>('SELECT * FROM readmodel.webhook_events WHERE transfer_id = $1 ORDER BY received_at, event_id LIMIT $2', [transferId, cap]);
  const deliveries = await q.query<{ delivery_id: string; event_id: string; received_at: Date; result: string }>(
    'SELECT delivery_id, event_id, received_at, result FROM readmodel.webhook_deliveries WHERE transfer_id = $1 ORDER BY received_at, delivery_id LIMIT $2',
    [transferId, cap],
  );
  const truncated = [batches, postings, attempts, observations, events, deliveries].some((r) => r.rows.length > EVIDENCE_CAP);
  const take = <T>(rows: T[]): T[] => rows.slice(0, EVIDENCE_CAP);
  return {
    journal: take(batches.rows).map((b) => ({
      batchId: b.batch_id,
      phase: b.phase,
      createdAt: b.created_at.toISOString(),
      postings: take(postings.rows)
        .filter((p) => p.batch_id === b.batch_id)
        .map((p) => ({ postingId: p.posting_id, ledgerAccount: p.ledger_account, asset: p.asset, amountMinor: p.amount_minor })),
    })),
    providerAttempts: take(attempts.rows).map((a) => ({
      attemptId: a.attempt_id,
      kind: a.kind,
      attemptNo: a.attempt_no,
      providerReference: a.provider_reference,
      leaseToken: a.lease_token,
      startedAt: a.started_at.toISOString(),
      finishedAt: a.finished_at?.toISOString() ?? null,
      outcome: a.outcome,
      httpStatus: a.http_status,
      detail: a.detail,
    })),
    providerObservations: take(observations.rows).map((o) => ({
      observationId: o.observation_id,
      channel: o.source,
      sourceId: o.source_id,
      providerStatus: o.status,
      providerSequence: o.provider_sequence,
      finalNoEffect: o.final_no_effect,
      providerOccurredAt: o.occurred_at?.toISOString() ?? null,
      observedAt: o.observed_at.toISOString(),
      decision: o.decision,
      untrusted: o.provider_note === null ? null : { providerNote: o.provider_note },
    })),
    webhookEvents: take(events.rows).map((e) => ({
      eventId: e.event_id,
      providerStatus: e.status,
      providerSequence: e.provider_sequence,
      providerOccurredAt: e.occurred_at.toISOString(),
      firstReceivedAt: e.received_at.toISOString(),
      processedAt: e.processed_at?.toISOString() ?? null,
      decision: e.decision,
      deliveries: take(deliveries.rows)
        .filter((d) => d.event_id === e.event_id)
        .map((d) => ({ deliveryId: d.delivery_id, receivedAt: d.received_at.toISOString(), result: d.result })),
    })),
    truncated,
  };
}

export const EXCEPTION_KINDS = ['unknown_outcome', 'conflicting_observation', 'invariant_failure'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export interface ExceptionItem {
  itemId: string;
  kind: ExceptionKind;
  reason: string;
  transferId: string | null;
  detail: string;
  evidenceIds: string[];
  since: string | null;
  ageMs: number | null;
}

export async function listExceptions(
  q: Queryable,
  scope: { runId?: string; accountId?: string },
  filter: { kind: ExceptionKind | null; after: string | null; limit: number },
  now: Date,
): Promise<{ items: ExceptionItem[]; nextCursor: string | null; reachedEnd: boolean }> {
  const result = await q.query<{
    item_id: string;
    kind: ExceptionKind;
    reason: string;
    transfer_id: string | null;
    detail: string;
    evidence_ids: string[];
    since: Date | null;
  }>(
    `SELECT item_id, kind, reason, transfer_id, detail, evidence_ids, since FROM readmodel.exception_items
      WHERE ($1::text IS NULL OR run_id = $1) AND ($2::text IS NULL OR account_id = $2)
        AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR item_id > $4)
      ORDER BY item_id LIMIT $5`,
    [scope.runId ?? null, scope.accountId ?? null, filter.kind, filter.after, filter.limit + 1],
  );
  const rows = result.rows.slice(0, filter.limit);
  const more = result.rows.length > filter.limit;
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({
      itemId: r.item_id,
      kind: r.kind,
      reason: r.reason,
      transferId: r.transfer_id,
      detail: r.detail,
      evidenceIds: r.evidence_ids,
      since: r.since?.toISOString() ?? null,
      ageMs: r.since ? Math.max(0, now.getTime() - r.since.getTime()) : null,
    })),
    nextCursor: more && last ? encodeCursor(last.item_id) : null,
    reachedEnd: !more,
  };
}

export interface BalancesView {
  asset: string;
  availableMinor: string;
  reservedMinor: string;
  /** Run-wide clearing total: everything settled to the simulated provider in this run. */
  runClearingMinor: string;
}

export async function getBalances(q: Queryable, runId: string, accountId: string): Promise<BalancesView> {
  const result = await q.query<{ ledger_account: string; balance_minor: string }>(
    'SELECT ledger_account, balance_minor FROM readmodel.account_balances WHERE run_id = $1 AND asset = $2 AND ledger_account = ANY($3)',
    [runId, ASSET, [availableAccount(accountId), reservedAccount(accountId), CLEARING_ACCOUNT]],
  );
  const by = new Map(result.rows.map((r) => [r.ledger_account, r.balance_minor]));
  return {
    asset: ASSET,
    availableMinor: by.get(availableAccount(accountId)) ?? '0',
    reservedMinor: by.get(reservedAccount(accountId)) ?? '0',
    runClearingMinor: by.get(CLEARING_ACCOUNT) ?? '0',
  };
}
