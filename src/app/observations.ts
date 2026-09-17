import type { PoolClient } from '../db/pool.ts';
import { decideOnEvidence, isTerminal, type ProviderEvidence } from '../domain/transitions.ts';
import type { AppDeps, TransferRow } from './deps.ts';
import { DuplicateJournalPhaseError, postBatch } from './journal-repo.ts';
import { appendTrace, type TraceSource } from './trace.ts';

export type ObservationSource = 'submit_response' | 'lookup' | 'webhook';

export interface ObservedEvidence extends ProviderEvidence {
  source: ObservationSource;
  /** Attempt ID for responses/lookups, provider event ID for webhooks. */
  sourceId: string;
  occurredAt: Date | null;
  /** Economic fields the provider echoed back; checked before any journal effect. */
  echo: { asset: string; amountMinor: string; destination: string } | null;
  /** Untrusted provider text. Stored and displayed as data only. */
  providerNote: string | null;
}

export interface EvidenceOutcome {
  observationId: string;
  decision: string;
  state: TransferRow['state'];
  journalBatchId: string | null;
  exceptionId: string | null;
}

export async function recordException(
  client: PoolClient,
  deps: AppDeps,
  input: {
    transfer: Pick<TransferRow, 'transfer_id' | 'run_id'>;
    reason: string;
    detail: string;
    evidenceIds: string[];
    source: TraceSource;
    correlationId: string;
    causationId: string | null;
  },
): Promise<string> {
  const exceptionId = deps.ids.next('exc');
  await client.query(
    `INSERT INTO exceptions (exception_id, run_id, transfer_id, kind, reason, detail, evidence_ids, created_at)
     VALUES ($1, $2, $3, 'conflicting_observation', $4, $5, $6::jsonb, $7)`,
    [
      exceptionId,
      input.transfer.run_id,
      input.transfer.transfer_id,
      input.reason,
      input.detail,
      JSON.stringify(input.evidenceIds),
      deps.clock.now(),
    ],
  );
  await appendTrace(client, deps, {
    transferId: input.transfer.transfer_id,
    runId: input.transfer.run_id,
    type: 'exception_recorded',
    source: input.source,
    correlationId: input.correlationId,
    causationId: input.causationId,
    facts: {
      exceptionId,
      kind: 'conflicting_observation',
      reason: input.reason,
      evidenceIds: input.evidenceIds,
      automaticCorrection: 'none',
    },
  });
  return exceptionId;
}

function echoMismatch(transfer: TransferRow, echo: ObservedEvidence['echo']): string | null {
  if (!echo) return null;
  const differing = [
    echo.asset !== transfer.asset ? 'asset' : null,
    echo.amountMinor !== transfer.amount_minor ? 'amountMinor' : null,
    echo.destination !== transfer.destination ? 'destination' : null,
  ].filter((f) => f !== null);
  return differing.length ? differing.join(',') : null;
}

/**
 * The single place where provider evidence (submit response, lookup or verified webhook) can
 * change a transfer. The caller holds the transfer row lock; state change, journal effect, trace
 * and job completion all commit in the caller's transaction or not at all.
 */
export async function applyProviderEvidence(
  client: PoolClient,
  deps: AppDeps,
  transfer: TransferRow,
  evidence: ObservedEvidence,
  context: { source: TraceSource; correlationId: string; causationId: string | null },
): Promise<EvidenceOutcome> {
  const mismatch = echoMismatch(transfer, evidence.echo);
  const verdict = mismatch
    ? ({ action: 'exception', decision: 'correlation_mismatch' } as const)
    : decideOnEvidence(transfer.state, transfer.last_provider_sequence, evidence);

  const observationId = deps.ids.next('obs');
  const observedAt = deps.clock.now();
  await client.query(
    `INSERT INTO provider_observations
       (observation_id, run_id, transfer_id, source, source_id, status, provider_sequence,
        final_no_effect, occurred_at, observed_at, decision, provider_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      observationId,
      transfer.run_id,
      transfer.transfer_id,
      evidence.source,
      evidence.sourceId,
      evidence.status,
      evidence.sequence,
      evidence.finalNoEffect,
      evidence.occurredAt,
      observedAt,
      verdict.decision,
      evidence.providerNote,
    ],
  );
  const observed = await appendTrace(client, deps, {
    transferId: transfer.transfer_id,
    runId: transfer.run_id,
    type: 'provider_observation_received',
    source: context.source,
    correlationId: context.correlationId,
    causationId: context.causationId,
    facts: {
      observationId,
      channel: evidence.source,
      sourceId: evidence.sourceId,
      providerStatus: evidence.status,
      providerSequence: evidence.sequence,
      finalNoEffect: evidence.finalNoEffect,
      providerOccurredAt: evidence.occurredAt?.toISOString() ?? null,
      stateWhenObserved: transfer.state,
      decision: verdict.decision,
    },
    untrusted: evidence.providerNote === null ? null : { providerNote: evidence.providerNote },
  });

  const outcome: EvidenceOutcome = {
    observationId,
    decision: verdict.decision,
    state: transfer.state,
    journalBatchId: null,
    exceptionId: null,
  };

  if (verdict.action === 'exception') {
    outcome.exceptionId = await recordException(client, deps, {
      transfer,
      reason: verdict.decision,
      detail: mismatch
        ? `Provider evidence for ${transfer.provider_reference} disagrees on: ${mismatch}. No journal effect applied.`
        : `Provider reported "${evidence.status}" while the transfer is ${transfer.state}. History preserved; no automatic correction.`,
      evidenceIds: [observed, observationId, evidence.sourceId],
      source: context.source,
      correlationId: context.correlationId,
      causationId: observed,
    });
    return outcome;
  }

  if (verdict.action === 'ignore') {
    if (verdict.decision === 'duplicate_outcome' || verdict.decision === 'stale_observation') {
      await appendTrace(client, deps, {
        transferId: transfer.transfer_id,
        runId: transfer.run_id,
        type: verdict.decision === 'duplicate_outcome' ? 'duplicate_ignored' : 'stale_event_ignored',
        source: context.source,
        correlationId: context.correlationId,
        causationId: observed,
        facts: { observationId, level: 'business_outcome', state: transfer.state, effect: 'none' },
      });
    } else if (verdict.decision === 'no_change') {
      await touchLastObservation(client, transfer, evidence, observationId, observedAt);
    }
    return outcome;
  }

  let batchId: string | null = null;
  if (verdict.journal) {
    try {
      const batch = await postBatch(client, deps, {
        runId: transfer.run_id,
        transferId: transfer.transfer_id,
        phase: verdict.journal,
        accountId: transfer.account_id,
        amountMinor: BigInt(transfer.amount_minor),
      });
      batchId = batch.batchId;
      await appendTrace(client, deps, {
        transferId: transfer.transfer_id,
        runId: transfer.run_id,
        type: verdict.journal === 'settle' ? 'funds_settled' : 'funds_released',
        source: context.source,
        correlationId: context.correlationId,
        causationId: observed,
        facts: { batchId, postingIds: batch.postingIds, phase: verdict.journal, amountMinor: transfer.amount_minor, asset: transfer.asset },
      });
    } catch (error) {
      // Unreachable while the row lock and state machine hold; the unique index is the backstop.
      if (error instanceof DuplicateJournalPhaseError)
        throw new Error(`terminal effect already exists for ${transfer.transfer_id}`, { cause: error });
      throw error;
    }
  }

  await client.query(`UPDATE transfers SET state = $2, version = version + 1, updated_at = $3 WHERE transfer_id = $1`, [
    transfer.transfer_id,
    verdict.to,
    observedAt,
  ]);
  await touchLastObservation(client, transfer, evidence, observationId, observedAt);
  await appendTrace(client, deps, {
    transferId: transfer.transfer_id,
    runId: transfer.run_id,
    type: 'state_changed',
    source: context.source,
    correlationId: context.correlationId,
    causationId: observed,
    facts: { from: transfer.state, to: verdict.to, journalBatchId: batchId },
  });
  if (isTerminal(verdict.to)) {
    await client.query(`UPDATE jobs SET state = 'done', updated_at = $2 WHERE transfer_id = $1`, [transfer.transfer_id, observedAt]);
  }
  outcome.state = verdict.to;
  outcome.journalBatchId = batchId;
  return outcome;
}

async function touchLastObservation(
  client: PoolClient,
  transfer: TransferRow,
  evidence: ObservedEvidence,
  observationId: string,
  observedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE transfers SET last_provider_status = $2, last_provider_sequence = greatest(last_provider_sequence, $3::int),
            last_provider_observed_at = $4, last_provider_observation_id = $5
      WHERE transfer_id = $1`,
    [transfer.transfer_id, evidence.status, evidence.sequence, observedAt, observationId],
  );
}
