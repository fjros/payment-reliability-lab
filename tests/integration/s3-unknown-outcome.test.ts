import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../../src/shared/checkpoints.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import {
  acceptedTransfer,
  attempts,
  expectConservation,
  HEALTHY_AFTER_SUBMISSION,
  invariantStatuses,
  journalPhases,
  startLab,
  traceTypes,
  transferRow,
  userBalances,
  type Lab,
  type Subject,
} from '../harness/lab.ts';
import { getJson } from '../harness/api.ts';

let dbs: TestDatabases;
let lab: Lab;
beforeAll(async () => {
  dbs = await createTestDatabases();
  lab = await startLab(dbs, { providerTimeoutMs: 400 });
});
afterAll(async () => {
  await lab.close();
  await dbs.close();
});

const RETRY = 2_500;
const RESERVED = { available: '98750', reserved: '1250', clearing: '0' };

/** Provider durably accepts (and per plan finalizes) but the response never arrives; lookup is down. */
async function lostResponse(onSubmit: 'complete' | 'pending' | 'reject'): Promise<Subject> {
  const s = await acceptedTransfer(lab);
  await lab.stack.control.setPlan(s.reference, { onSubmit, loseSubmitResponses: 1, lookup: 'unavailable' });
  await lab.stack.newWorker('w-original').runJobOnce({ transferId: s.transferId });
  return s;
}

async function stepRestartedWorker(s: Subject, id = 'w-restarted'): Promise<void> {
  lab.clock.advance(RETRY);
  expect(await lab.stack.newWorker(id).runJobOnce({ transferId: s.transferId })).toBe('worked');
}

describe('S3: provider accepts, response disappears, outcome remains unknown', () => {
  it('persists outcome_unknown, keeps funds reserved and says "unknown" although the oracle knows better', async () => {
    const s = await lostResponse('complete');

    // Privileged oracle: the provider DID complete and apply its single effect.
    expect(await lab.stack.control.oracleTransfer(s.reference)).toMatchObject({ status: 'completed' });
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);

    // Application view: it only saw a dead connection. It must not guess either way.
    expect(await attempts(lab, s.transferId)).toEqual([{ kind: 'submit', outcome: 'response_lost', provider_reference: s.reference }]);
    const view = await getJson<{ state: string; lastProviderObservation: unknown }>(
      lab.stack.apiUrl,
      `/v1/transfers/${s.transferId}`,
      s.account,
    );
    expect(view.body).toMatchObject({ state: 'outcome_unknown', lastProviderObservation: null });
    expect(await userBalances(lab, s)).toEqual(RESERVED);
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);

    const exceptions = await getJson<{ items: Array<{ kind: string; transferId: string; evidenceIds: string[] }> }>(
      lab.stack.apiUrl,
      '/v1/exceptions',
      s.account,
    );
    expect(exceptions.body.items).toMatchObject([{ kind: 'unknown_outcome', transferId: s.transferId }]);
    expect(exceptions.body.items[0]!.evidenceIds.length).toBeGreaterThan(0);

    // Unknown is a valid state, not an invariant failure.
    const { statuses, report } = await invariantStatuses(lab, s);
    expect(statuses).toEqual(HEALTHY_AFTER_SUBMISSION);
    expect(report.unresolvedExternalOutcome).toBe(true);
    expect(report.results.find((r) => r.id === 'I7')!.explanation).toMatch(/UNKNOWN/);

    // Restarted worker, lookup still unavailable: still unknown, same reference, nothing released.
    await stepRestartedWorker(s, 'w-restart-1');
    await stepRestartedWorker(s, 'w-restart-2');
    expect((await transferRow(lab, s.transferId)).state).toBe('outcome_unknown');
    expect(await userBalances(lab, s)).toEqual(RESERVED);
    const calls = await attempts(lab, s.transferId);
    expect(calls.map((c) => `${c.kind}:${c.outcome}`)).toEqual(['submit:response_lost', 'lookup:http_error', 'lookup:http_error']);
    expect(new Set(calls.map((c) => c.provider_reference))).toEqual(new Set([s.reference]));

    // Lookup recovers and is authoritative: settle exactly once.
    await lab.stack.control.setPlan(s.reference, { lookup: 'ok' });
    await stepRestartedWorker(s, 'w-restart-3');
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect(await userBalances(lab, s)).toEqual({ available: '98750', reserved: '0', clearing: '1250' });
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);
    expect((await getJson<{ items: unknown[] }>(lab.stack.apiUrl, '/v1/exceptions', s.account)).body.items).toEqual([]);
    await expectConservation(lab, s.runId);
  });

  it('moves to provider_pending on a pending lookup and still holds the reservation', async () => {
    const s = await lostResponse('pending');
    await lab.stack.control.setPlan(s.reference, { lookup: 'ok' });
    await stepRestartedWorker(s);
    expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending');
    expect(await userBalances(lab, s)).toEqual(RESERVED);

    await lab.stack.control.complete(s.reference);
    await stepRestartedWorker(s, 'w-poller');
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
  });

  it('releases the reservation only on an explicit no-effect final rejection', async () => {
    const s = await lostResponse('reject');
    expect((await transferRow(lab, s.transferId)).state).toBe('outcome_unknown');
    expect(await userBalances(lab, s)).toEqual(RESERVED); // a lost response released nothing

    await lab.stack.control.setPlan(s.reference, { lookup: 'ok' });
    await stepRestartedWorker(s);
    expect((await transferRow(lab, s.transferId)).state).toBe('rejected');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'release']);
    expect(await userBalances(lab, s)).toEqual({ available: '100000', reserved: '0', clearing: '0' });
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(0);
    const { statuses, report } = await invariantStatuses(lab, s);
    expect(statuses).toEqual(HEALTHY_AFTER_SUBMISSION);
    expect(report.results.find((r) => r.id === 'I7')!.explanation).toMatch(/explicit final rejection/);
    await expectConservation(lab, s.runId);
  });

  it('treats an inconclusive lookup answer as no evidence', async () => {
    const s = await lostResponse('complete');
    await lab.stack.control.setPlan(s.reference, { lookup: 'inconclusive' });
    await stepRestartedWorker(s);
    expect((await transferRow(lab, s.transferId)).state).toBe('outcome_unknown');
    expect(await userBalances(lab, s)).toEqual(RESERVED);
    expect((await attempts(lab, s.transferId)).at(-1)).toMatchObject({ kind: 'lookup', outcome: 'inconclusive' });
  });

  it('treats a deadline exceeded exactly like a lost response: unknown, not rejected', async () => {
    const s = await acceptedTransfer(lab);
    await lab.stack.control.setPlan(s.reference, { onSubmit: 'complete', hangSubmitResponses: 1 });
    await lab.stack.newWorker('w').runJobOnce({ transferId: s.transferId });
    expect(await attempts(lab, s.transferId)).toEqual([{ kind: 'submit', outcome: 'timeout', provider_reference: s.reference }]);
    expect((await transferRow(lab, s.transferId)).state).toBe('outcome_unknown');
    expect(await userBalances(lab, s)).toEqual(RESERVED);
    await stepRestartedWorker(s);
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);
  });

  it('recovers a crash before the submission was sent: "not found" is not rejection, resubmit the SAME reference', async () => {
    const s = await acceptedTransfer(lab);
    lab.stack.checkpoints.crashOnce('worker.job.after_attempt_persisted');
    await expect(lab.stack.newWorker('w-crashing', { leaseMs: 1000 }).runJobOnce({ transferId: s.transferId })).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    expect((await transferRow(lab, s.transferId)).state).toBe('submitting');
    expect(await lab.stack.control.oracleTransfer(s.reference)).toBeNull(); // nothing ever reached the provider

    // The dead worker's lease must expire before anyone else may touch the job.
    expect(await lab.stack.newWorker('w-early').runJobOnce({ transferId: s.transferId })).toBe('idle');
    await stepRestartedWorker(s, 'w-2'); // lookup -> 404
    expect((await transferRow(lab, s.transferId)).state).toBe('outcome_unknown');
    expect(await userBalances(lab, s)).toEqual(RESERVED);

    await stepRestartedWorker(s, 'w-3'); // resubmission under the provider's idempotency contract
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    const calls = await attempts(lab, s.transferId);
    expect(calls.map((c) => `${c.kind}:${c.outcome}`)).toEqual(['submit:null', 'lookup:not_found', 'submit:completed']);
    expect(new Set(calls.map((c) => c.provider_reference)).size).toBe(1);
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);
    await expectConservation(lab, s.runId);
  });

  it('recovers a crash after the provider answered but before the result was committed', async () => {
    const s = await acceptedTransfer(lab);
    lab.stack.checkpoints.crashOnce('worker.job.after_provider_response');
    await expect(lab.stack.newWorker('w-crashing', { leaseMs: 1000 }).runJobOnce({ transferId: s.transferId })).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    expect((await transferRow(lab, s.transferId)).state).toBe('submitting');
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1); // provider already paid

    await stepRestartedWorker(s);
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await traceTypes(lab, s.transferId)).toContain('outcome_unknown'); // recovery went through explicit uncertainty
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);
  });

  it('lets a completion webhook overtake the delayed submission response without regressing the terminal state', async () => {
    const s = await acceptedTransfer(lab);
    await lab.stack.control.setPlan(s.reference, { onSubmit: 'pending' });
    const barrier = lab.stack.checkpoints.barrierOnce('worker.job.after_provider_response');
    const slow = lab.stack.newWorker('w-slow').runJobOnce({ transferId: s.transferId }); // holds a "pending" response
    await barrier.reached;

    await lab.stack.control.complete(s.reference);
    await lab.stack.control.deliver((await lab.stack.control.eventFor(s.reference, 'completed')).eventId);
    await lab.stack.newWorker('w-inbox').processInboxOnce({ transferId: s.transferId });
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');

    barrier.release();
    await slow;
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect(await traceTypes(lab, s.transferId)).toContain('stale_worker_result_discarded');
    expect((await invariantStatuses(lab, s)).statuses).toEqual(HEALTHY_AFTER_SUBMISSION);
  });

  it('keeps provider acceptance across a simulator restart and enforces idempotency by reference', async () => {
    const s = await lostResponse('complete');
    await lab.stack.restartSim();
    await lab.stack.control.setPlan(s.reference, { lookup: 'ok' });

    const submitAgain = (body: Record<string, unknown>) =>
      fetch(`${lab.stack.simUrl}/provider/transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const same = await submitAgain({
      providerReference: s.reference,
      asset: 'DEMO_USD',
      amountMinor: '1250',
      destination: 'demo:merchant-1',
    });
    expect(same.status).toBe(200); // existing operation, not a new one
    expect(await same.json()).toMatchObject({ status: 'completed', providerSequence: 2 });
    const mismatch = await submitAgain({
      providerReference: s.reference,
      asset: 'DEMO_USD',
      amountMinor: '9999',
      destination: 'demo:merchant-1',
    });
    expect(mismatch.status).toBe(409);
    expect(await lab.stack.control.oracleEffectCount(s.reference)).toBe(1);
  });
});

describe('S4: lease expiry plus an old worker', () => {
  it('fences the stale worker: its late "pending" result cannot regress a settled transfer', async () => {
    const s = await acceptedTransfer(lab);
    await lab.stack.control.setPlan(s.reference, { onSubmit: 'pending' });
    const barrier = lab.stack.checkpoints.barrierOnce('worker.job.after_provider_response');
    const stale = lab.stack.newWorker('w-stale', { leaseMs: 1000 }).runJobOnce({ transferId: s.transferId });
    await barrier.reached; // w-stale holds a "pending" answer and stalls (GC pause, partition...)

    lab.clock.advance(5_000); // its lease expires
    await lab.stack.control.complete(s.reference);
    expect(await lab.stack.newWorker('w-new').runJobOnce({ transferId: s.transferId })).toBe('worked');
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');

    barrier.release();
    await stale;
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    const discarded = await dbs.app.query(
      "SELECT facts FROM trace_events WHERE transfer_id = $1 AND type = 'stale_worker_result_discarded'",
      [s.transferId],
    );
    expect(discarded.rows).toHaveLength(1);
    expect(discarded.rows[0].facts).toMatchObject({ workerId: 'w-stale', staleLeaseToken: 1, reportedOutcome: 'pending', effect: 'none' });
    await expectConservation(lab, s.runId);
  });

  it('fences by token even while the job is still open', async () => {
    const s = await acceptedTransfer(lab);
    await lab.stack.control.setPlan(s.reference, { onSubmit: 'pending' });
    const barrier = lab.stack.checkpoints.barrierOnce('worker.job.after_provider_response');
    const stale = lab.stack.newWorker('w-stale', { leaseMs: 1000 }).runJobOnce({ transferId: s.transferId });
    await barrier.reached;
    lab.clock.advance(5_000);
    await lab.stack.newWorker('w-new').runJobOnce({ transferId: s.transferId }); // recovers: unknown -> lookup pending
    expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending');
    const versionBefore = (await transferRow(lab, s.transferId)).version;

    barrier.release();
    await stale;
    expect((await transferRow(lab, s.transferId)).version).toBe(versionBefore); // stale write changed nothing
    expect(await traceTypes(lab, s.transferId)).toContain('stale_worker_result_discarded');
  });

  it('never lets two workers lease the same job at once', async () => {
    const s = await acceptedTransfer(lab);
    const leases = await Promise.all(
      Array.from({ length: 6 }, (_, i) => lab.stack.newWorker(`w-${i}`).leaseNextJob({ transferId: s.transferId })),
    );
    expect(leases.filter((l) => l !== null)).toHaveLength(1);
  });
});
