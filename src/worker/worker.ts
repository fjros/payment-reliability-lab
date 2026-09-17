import { setTimeout as sleep } from 'node:timers/promises';
import type { AppDeps, TransferRow } from '../app/deps.ts';
import { applyProviderEvidence, recordException } from '../app/observations.ts';
import { appendTrace, lockTransfer } from '../app/trace.ts';
import { WebhookEnvelope } from '../app/webhook-intake.ts';
import { withTransaction, type PoolClient } from '../db/pool.ts';
import { canBeginSubmission, canMarkOutcomeUnknown, isTerminal } from '../domain/transitions.ts';
import { SimulatedCrash } from '../shared/checkpoints.ts';
import type { ProviderCallResult, ProviderClient } from './provider-client.ts';

export interface WorkerOptions {
  workerId: string;
  leaseMs?: number;
  retryDelayMs?: number;
  pollMs?: number;
}

export interface JobLease {
  jobId: string;
  transferId: string;
  runId: string;
  leaseToken: number;
}

interface PlannedCall {
  kind: 'submit' | 'lookup';
  attemptId: string;
  attemptNo: number;
  transfer: TransferRow;
  claimEventId: string;
}

type StepResult = 'idle' | 'worked';

/**
 * Recoverable worker. Durable truth lives in PostgreSQL: jobs, attempts, inbox rows. Timers are
 * wakeups only. No database transaction is ever held open across a provider HTTP call, so
 * every step is "commit intent -> call -> commit result", and each half can be lost to a crash.
 *
 * Safety relies on: (1) a persisted `submitting` state before any bytes leave, so recovery
 * treats the transfer as possibly accepted externally; (2) one provider reference for every
 * attempt; (3) lease tokens that fence stale workers; (4) monotonic domain transitions.
 */
export class Worker {
  private readonly deps: AppDeps;
  private readonly provider: ProviderClient;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly pollMs: number;
  private stopping: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(deps: AppDeps, provider: ProviderClient, options: WorkerOptions) {
    this.deps = deps;
    this.provider = provider;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.pollMs = options.pollMs ?? 250;
  }

  // ---- Job leasing ------------------------------------------------------------------------

  async leaseNextJob(scope: { transferId?: string } = {}): Promise<JobLease | null> {
    const now = this.deps.clock.now();
    const result = await this.deps.pool.query<{ job_id: string; transfer_id: string; run_id: string; lease_token: number }>(
      `UPDATE jobs SET lease_owner = $1, lease_token = lease_token + 1, lease_expires_at = $2, attempts = attempts + 1, updated_at = $3
        WHERE job_id = (
          SELECT job_id FROM jobs
           WHERE state = 'pending' AND run_after <= $3 AND (lease_expires_at IS NULL OR lease_expires_at <= $3)
             AND ($4::text IS NULL OR transfer_id = $4)
           ORDER BY run_after, job_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING job_id, transfer_id, run_id, lease_token`,
      [this.workerId, new Date(now.getTime() + this.leaseMs), now, scope.transferId ?? null],
    );
    const row = result.rows[0];
    return row ? { jobId: row.job_id, transferId: row.transfer_id, runId: row.run_id, leaseToken: row.lease_token } : null;
  }

  /** True while this worker's lease is the newest one. Must run inside the writing transaction. */
  private async leaseStillHeld(client: PoolClient, lease: JobLease): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM jobs WHERE job_id = $1 AND lease_token = $2 AND lease_owner = $3 AND state = 'pending' FOR UPDATE`,
      [lease.jobId, lease.leaseToken, this.workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private correlation(lease: JobLease): string {
    return `${lease.jobId}#${lease.leaseToken}`;
  }

  async runJobOnce(scope: { transferId?: string } = {}): Promise<StepResult> {
    const lease = await this.leaseNextJob(scope);
    if (!lease) return 'idle';
    await this.driveTransfer(lease);
    return 'worked';
  }

  /** One "intent -> provider call -> result" step for a leased job. */
  async driveTransfer(lease: JobLease): Promise<void> {
    const planned = await withTransaction(this.deps.pool, (client) => this.planCall(client, lease));
    if (!planned) return;
    await this.deps.checkpoints.hit('worker.job.after_attempt_persisted', { transferId: lease.transferId });

    const t = planned.transfer;
    const result =
      planned.kind === 'submit'
        ? await this.provider.submit({
            providerReference: t.provider_reference,
            asset: t.asset,
            amountMinor: t.amount_minor,
            destination: t.destination,
          })
        : await this.provider.lookup(t.provider_reference);
    await this.deps.checkpoints.hit('worker.job.after_provider_response', { transferId: lease.transferId });

    await withTransaction(this.deps.pool, (client) => this.recordResult(client, lease, planned, result));
    await this.deps.checkpoints.hit('worker.job.after_result_committed', { transferId: lease.transferId });
  }

  private async planCall(client: PoolClient, lease: JobLease): Promise<PlannedCall | null> {
    const transfer = await lockTransfer(client, lease.transferId);
    if (!transfer || !(await this.leaseStillHeld(client, lease))) return null;
    const now = this.deps.clock.now();
    const correlationId = this.correlation(lease);

    if (isTerminal(transfer.state)) {
      await client.query(`UPDATE jobs SET state = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = $2 WHERE job_id = $1`, [
        lease.jobId,
        now,
      ]);
      return null;
    }
    const claimEventId = await appendTrace(client, this.deps, {
      transferId: transfer.transfer_id,
      runId: transfer.run_id,
      type: 'job_claimed',
      source: 'worker',
      correlationId,
      facts: { jobId: lease.jobId, leaseToken: lease.leaseToken, workerId: this.workerId, stateWhenClaimed: transfer.state },
    });

    let kind: PlannedCall['kind'];
    let state = transfer.state;
    if (canBeginSubmission(state)) {
      kind = 'submit';
      state = await this.changeState(client, transfer, 'submitting', correlationId, claimEventId);
    } else {
      if (canMarkOutcomeUnknown(state)) {
        // A persisted `submitting` with no recorded result means a previous worker may have
        // reached the provider. Treat it as potentially accepted externally; never as failed.
        state = await this.markOutcomeUnknown(client, transfer, 'recovered_in_flight_submission', correlationId, claimEventId);
      }
      const last = await client.query<{ kind: string; outcome: string | null }>(
        `SELECT kind, outcome FROM provider_attempts WHERE transfer_id = $1 AND finished_at IS NOT NULL ORDER BY attempt_no DESC LIMIT 1`,
        [transfer.transfer_id],
      );
      // "Not found" is not proof of rejection. The only safe way forward is to submit the SAME
      // reference again under the provider's idempotency contract.
      kind = state === 'outcome_unknown' && last.rows[0]?.kind === 'lookup' && last.rows[0].outcome === 'not_found' ? 'submit' : 'lookup';
    }

    const attemptId = this.deps.ids.next('att');
    const numbered = await client.query<{ attempt_no: number }>(
      `INSERT INTO provider_attempts (attempt_id, run_id, transfer_id, provider_reference, kind, attempt_no, lease_token, started_at)
       VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(attempt_no), 0) + 1 FROM provider_attempts WHERE transfer_id = $3), $6, $7)
       RETURNING attempt_no`,
      [attemptId, transfer.run_id, transfer.transfer_id, transfer.provider_reference, kind, lease.leaseToken, now],
    );
    const attemptNo = numbered.rows[0]!.attempt_no;
    await appendTrace(client, this.deps, {
      transferId: transfer.transfer_id,
      runId: transfer.run_id,
      type: kind === 'submit' ? 'submission_attempted' : 'lookup_attempted',
      source: 'worker',
      correlationId,
      causationId: claimEventId,
      facts: {
        attemptId,
        attemptNo,
        providerReference: transfer.provider_reference,
        resubmission: kind === 'submit' && transfer.state !== 'reserved',
      },
    });
    return { kind, attemptId, attemptNo, transfer: { ...transfer, state }, claimEventId };
  }

  private async recordResult(client: PoolClient, lease: JobLease, planned: PlannedCall, result: ProviderCallResult): Promise<void> {
    const transfer = await lockTransfer(client, lease.transferId);
    if (!transfer) return;
    const now = this.deps.clock.now();
    const correlationId = this.correlation(lease);
    const outcome =
      result.kind === 'status'
        ? ['pending', 'completed', 'rejected'].includes(result.status)
          ? result.status
          : 'inconclusive'
        : result.kind;
    const httpStatus = 'httpStatus' in result ? result.httpStatus : null;
    const detail = result.kind === 'response_lost' ? result.detail : null;

    if (!(await this.leaseStillHeld(client, lease))) {
      // Fenced: a newer lease owns this transfer. Keep the evidence, change nothing.
      await client.query(
        `UPDATE provider_attempts SET finished_at = $2, outcome = $3, http_status = $4, detail = $5 WHERE attempt_id = $1`,
        [planned.attemptId, now, outcome, httpStatus, 'result discarded: lease superseded by a newer worker'],
      );
      await appendTrace(client, this.deps, {
        transferId: transfer.transfer_id,
        runId: transfer.run_id,
        type: 'stale_worker_result_discarded',
        source: 'worker',
        correlationId,
        causationId: planned.claimEventId,
        facts: {
          attemptId: planned.attemptId,
          staleLeaseToken: lease.leaseToken,
          workerId: this.workerId,
          reportedOutcome: outcome,
          effect: 'none',
        },
      });
      return;
    }

    await client.query(`UPDATE provider_attempts SET finished_at = $2, outcome = $3, http_status = $4, detail = $5 WHERE attempt_id = $1`, [
      planned.attemptId,
      now,
      outcome,
      httpStatus,
      detail,
    ]);

    let current: TransferRow = transfer;
    if (result.kind === 'status') {
      const applied = await applyProviderEvidence(
        client,
        this.deps,
        transfer,
        {
          source: planned.kind === 'submit' ? 'submit_response' : 'lookup',
          sourceId: planned.attemptId,
          status: result.status,
          finalNoEffect: result.finalNoEffect,
          sequence: result.sequence,
          occurredAt: result.occurredAt,
          echo: result.echo,
          providerNote: result.note,
        },
        { source: 'worker', correlationId, causationId: planned.claimEventId },
      );
      current = { ...transfer, state: applied.state };
    } else {
      const lost = result.kind === 'response_lost' || result.kind === 'timeout';
      const failureEvent = await appendTrace(client, this.deps, {
        transferId: transfer.transfer_id,
        runId: transfer.run_id,
        type: lost ? 'response_lost' : 'provider_call_failed',
        source: 'worker',
        correlationId,
        causationId: planned.claimEventId,
        facts: {
          attemptId: planned.attemptId,
          call: planned.kind,
          outcome,
          httpStatus,
          detail,
          meaning: lost ? 'The provider may or may not have processed the request.' : 'No usable provider evidence was obtained.',
        },
      });
      if (result.kind === 'conflict') {
        await recordException(client, this.deps, {
          transfer,
          reason: 'provider_reference_conflict',
          detail: `Provider says reference ${transfer.provider_reference} was used with different data. No journal effect applied.`,
          evidenceIds: [failureEvent, planned.attemptId],
          source: 'worker',
          correlationId,
          causationId: failureEvent,
        });
      }
    }

    if (canMarkOutcomeUnknown(current.state)) {
      // The submission left without a usable answer. Unknown, not failed: funds stay reserved.
      const reason = result.kind === 'status' ? 'unrecognized_provider_status' : `submit_${result.kind}`;
      await this.markOutcomeUnknown(client, current, reason, correlationId, planned.claimEventId);
    }

    await client.query(
      `UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL, run_after = $2, updated_at = $3 WHERE job_id = $1 AND state = 'pending'`,
      [lease.jobId, new Date(now.getTime() + this.retryDelayMs), now],
    );
  }

  private async changeState(
    client: PoolClient,
    transfer: TransferRow,
    to: TransferRow['state'],
    correlationId: string,
    causationId: string | null,
  ): Promise<TransferRow['state']> {
    await client.query('UPDATE transfers SET state = $2, version = version + 1, updated_at = $3 WHERE transfer_id = $1', [
      transfer.transfer_id,
      to,
      this.deps.clock.now(),
    ]);
    await appendTrace(client, this.deps, {
      transferId: transfer.transfer_id,
      runId: transfer.run_id,
      type: 'state_changed',
      source: 'worker',
      correlationId,
      causationId,
      facts: { from: transfer.state, to, journalBatchId: null },
    });
    return to;
  }

  private async markOutcomeUnknown(
    client: PoolClient,
    transfer: TransferRow,
    reason: string,
    correlationId: string,
    causationId: string | null,
  ): Promise<TransferRow['state']> {
    const marker = await appendTrace(client, this.deps, {
      transferId: transfer.transfer_id,
      runId: transfer.run_id,
      type: 'outcome_unknown',
      source: 'worker',
      correlationId,
      causationId,
      facts: {
        reason,
        providerReference: transfer.provider_reference,
        reservation: 'kept',
        release: 'not permitted without a final no-effect rejection',
      },
    });
    return this.changeState(client, transfer, 'outcome_unknown', correlationId, marker);
  }

  // ---- Webhook inbox ----------------------------------------------------------------------

  /**
   * Applies one inbox event. The valid transition, journal effect, trace and processing marker
   * commit in a single transaction; a crash before commit redoes it, a crash after commit finds
   * the marker. A racing worker blocks on the row (or skips it) and then sees it processed.
   */
  async processInboxOnce(scope: { eventId?: string; transferId?: string } = {}): Promise<StepResult | 'already_processed'> {
    let transferId: string | undefined;
    const worked = await withTransaction(this.deps.pool, async (client): Promise<StepResult | 'already_processed'> => {
      const picked = await client.query<{ event_id: string; raw_body: string; transfer_id: string | null; processed_at: Date | null }>(
        scope.eventId
          ? 'SELECT event_id, raw_body, transfer_id, processed_at FROM webhook_inbox WHERE event_id = $1 FOR UPDATE'
          : `SELECT event_id, raw_body, transfer_id, processed_at FROM webhook_inbox
              WHERE processed_at IS NULL AND ($1::text IS NULL OR transfer_id = $1)
              ORDER BY received_at, event_id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [scope.eventId ?? scope.transferId ?? null],
      );
      const row = picked.rows[0];
      if (!row) return 'idle';
      if (row.processed_at) return 'already_processed';
      transferId = row.transfer_id ?? undefined;
      let decision = 'unknown_reference';
      const transfer = row.transfer_id ? await lockTransfer(client, row.transfer_id) : null;
      if (transfer) {
        const envelope = WebhookEnvelope.parse(JSON.parse(row.raw_body));
        const accepted = await client.query<{ event_id: string }>(
          `SELECT event_id FROM trace_events WHERE transfer_id = $1 AND type = 'webhook_accepted' AND facts->>'providerEventId' = $2 LIMIT 1`,
          [transfer.transfer_id, row.event_id],
        );
        const applied = await applyProviderEvidence(
          client,
          this.deps,
          transfer,
          {
            source: 'webhook',
            sourceId: row.event_id,
            status: envelope.status,
            finalNoEffect: envelope.finalNoEffect,
            sequence: envelope.providerSequence,
            occurredAt: new Date(envelope.occurredAt),
            echo: { asset: envelope.asset, amountMinor: envelope.amountMinor, destination: envelope.destination },
            providerNote: envelope.note ?? null,
          },
          { source: 'webhook', correlationId: row.event_id, causationId: accepted.rows[0]?.event_id ?? null },
        );
        decision = applied.decision;
      }
      await this.deps.checkpoints.hit('worker.inbox.in_transaction', transferId === undefined ? {} : { transferId });
      await client.query('UPDATE webhook_inbox SET processed_at = $2, decision = $3 WHERE event_id = $1', [
        row.event_id,
        this.deps.clock.now(),
        decision,
      ]);
      return 'worked';
    });
    if (worked === 'worked') await this.deps.checkpoints.hit('worker.inbox.after_commit', transferId === undefined ? {} : { transferId });
    return worked;
  }

  /** Runs due work until nothing is immediately runnable. Deterministic driver for scenarios. */
  async drain(scope: { transferId?: string } = {}, maxSteps = 100): Promise<number> {
    let steps = 0;
    while (steps < maxSteps) {
      const inbox = await this.processInboxOnce(scope);
      const job = await this.runJobOnce(scope);
      if (inbox === 'idle' && job === 'idle') break;
      steps += 1;
    }
    return steps;
  }

  // ---- Long-running mode ------------------------------------------------------------------

  start(): void {
    if (this.loop) return;
    const stopping = new AbortController();
    this.stopping = stopping;
    this.loop = (async () => {
      while (!stopping.signal.aborted) {
        try {
          await this.drain();
        } catch (error) {
          if (error instanceof SimulatedCrash) throw error;
          this.deps.logger.error('worker step failed; will retry', { workerId: this.workerId, error });
        }
        await sleep(this.pollMs, undefined, { signal: stopping.signal }).catch(() => undefined);
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopping?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
}
