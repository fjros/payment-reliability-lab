import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../../src/shared/checkpoints.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import {
  acceptedTransfer,
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
  lab = await startLab(dbs);
});
afterAll(async () => {
  await lab.close();
  await dbs.close();
});

/** A transfer the provider holds as pending, then completes; nothing delivered yet. */
async function submittedAndCompletedAtProvider(): Promise<Subject> {
  const s = await acceptedTransfer(lab);
  await lab.stack.control.setPlan(s.reference, { onSubmit: 'pending' });
  await lab.stack.newWorker('w-submit').runJobOnce({ transferId: s.transferId });
  expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending');
  await lab.stack.control.complete(s.reference);
  return s;
}

const inboxRows = async (reference: string): Promise<number> =>
  (await dbs.app.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_inbox WHERE provider_reference = $1', [reference])).rows[0]!
    .n;

describe('S2: duplicate and out-of-order provider notifications', () => {
  it('settles once across an exact redelivery, a second event ID for the same outcome and an older pending event', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const worker = lab.stack.newWorker('w-inbox');
    const completed = await control.eventFor(s.reference, 'completed');
    const pending = await control.eventFor(s.reference, 'pending');

    expect(await control.deliver(completed.eventId)).toMatchObject({ status: 202, body: { duplicate: false } });
    expect(await worker.processInboxOnce({ transferId: s.transferId })).toBe('worked');
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');

    for (let i = 0; i < 3; i += 1) {
      expect(await control.deliver(completed.eventId)).toMatchObject({ status: 202, body: { duplicate: true } });
    }
    const sameOutcomeNewId = await control.forgeEvent(s.reference, 'completed');
    expect(await control.deliver(sameOutcomeNewId)).toMatchObject({ status: 202, body: { duplicate: false } });
    expect(await control.deliver(pending.eventId)).toMatchObject({ status: 202 }); // older event arrives last
    await worker.drain({ transferId: s.transferId });

    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect(await userBalances(lab, s)).toEqual({ available: '98750', reserved: '0', clearing: '1250' });
    expect(await control.oracleEffectCount(s.reference)).toBe(1);

    // Duplicates and the stale observation are retained as evidence, not dropped.
    const types = await traceTypes(lab, s.transferId);
    expect(types.filter((t) => t === 'funds_settled')).toHaveLength(1);
    expect(types.filter((t) => t === 'duplicate_ignored')).toHaveLength(4); // 3 redeliveries + 1 duplicate business outcome
    expect(types.filter((t) => t === 'stale_event_ignored')).toHaveLength(1);
    const evidence = await getJson<{
      webhookEvents: Array<{ eventId: string; decision: string; providerSequence: number; deliveries: unknown[] }>;
    }>(lab.stack.apiUrl, `/v1/transfers/${s.transferId}/evidence`, s.account);
    const byId = new Map(evidence.body.webhookEvents.map((e) => [e.eventId, e]));
    expect(byId.get(completed.eventId)).toMatchObject({ decision: 'settled', providerSequence: 2 });
    expect(byId.get(completed.eventId)!.deliveries).toHaveLength(4);
    expect(byId.get(sameOutcomeNewId)).toMatchObject({ decision: 'duplicate_outcome' });
    expect(byId.get(pending.eventId)).toMatchObject({ decision: 'stale_observation', providerSequence: 1 });
    // Arrival order (completed first) differs from provider occurrence order (pending first).
    expect(evidence.body.webhookEvents.map((e) => e.providerSequence)).toEqual([2, 2, 1]);

    expect((await invariantStatuses(lab, s)).statuses).toEqual(HEALTHY_AFTER_SUBMISSION);
    await expectConservation(lab, s.runId);
  });

  it('survives an inbox worker crash after commit but before it reports completion', async () => {
    const s = await submittedAndCompletedAtProvider();
    const completed = await lab.stack.control.eventFor(s.reference, 'completed');
    await lab.stack.control.deliver(completed.eventId);

    lab.stack.checkpoints.crashOnce('worker.inbox.after_commit');
    await expect(lab.stack.newWorker('w-crashing').processInboxOnce({ eventId: completed.eventId })).rejects.toBeInstanceOf(SimulatedCrash);

    const restarted = lab.stack.newWorker('w-restarted');
    expect(await restarted.processInboxOnce({ eventId: completed.eventId })).toBe('already_processed');
    expect(await restarted.processInboxOnce({ transferId: s.transferId })).toBe('idle');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    await expectConservation(lab, s.runId);
  });

  it('redoes the whole unit of work when the crash happens before commit', async () => {
    const s = await submittedAndCompletedAtProvider();
    const completed = await lab.stack.control.eventFor(s.reference, 'completed');
    await lab.stack.control.deliver(completed.eventId);

    lab.stack.checkpoints.crashOnce('worker.inbox.in_transaction');
    await expect(lab.stack.newWorker('w-crashing').processInboxOnce({ eventId: completed.eventId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending'); // rolled back atomically
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);

    expect(await lab.stack.newWorker('w-restarted').processInboxOnce({ eventId: completed.eventId })).toBe('worked');
    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
  });

  it('lets two workers race on the same inbox item without repeating the effect', async () => {
    const s = await submittedAndCompletedAtProvider();
    const completed = await lab.stack.control.eventFor(s.reference, 'completed');
    await lab.stack.control.deliver(completed.eventId);

    const barrier = lab.stack.checkpoints.barrierOnce('worker.inbox.in_transaction');
    const first = lab.stack.newWorker('w-1').processInboxOnce({ eventId: completed.eventId });
    await barrier.reached; // w-1 holds the row inside its transaction
    const second = lab.stack.newWorker('w-2').processInboxOnce({ eventId: completed.eventId });
    barrier.release();

    expect((await Promise.all([first, second])).sort()).toEqual(['already_processed', 'worked']);
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect((await traceTypes(lab, s.transferId)).filter((t) => t === 'funds_settled')).toHaveLength(1);
  });

  it('rejects malformed signatures and old signing timestamps before persisting anything', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const completed = await control.eventFor(s.reference, 'completed');

    expect(await control.deliver(completed.eventId, { secretOverride: 'wrong-secret' })).toMatchObject({
      status: 401,
      body: { error: { code: 'INVALID_SIGNATURE' } },
    });
    const tenMinutesAgo = new Date(lab.clock.now().getTime() - 10 * 60_000);
    expect(await control.deliver(completed.eventId, { signedAt: tenMinutesAgo })).toMatchObject({
      status: 401,
      body: { error: { code: 'SIGNATURE_EXPIRED' } },
    });
    const unsigned = await fetch(`${lab.stack.apiUrl}/v1/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await control.storedBody(completed.eventId),
    });
    expect(unsigned.status).toBe(401);

    expect(await inboxRows(s.reference)).toBe(0);
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);

    // Business occurrence time may be old as long as the transport signature is fresh.
    lab.clock.advance(24 * 3600_000);
    expect(await control.deliver(completed.eventId)).toMatchObject({ status: 202 });
  });

  it('keeps an altered payload under an existing event ID as conflicting evidence, never an overwrite', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const pending = await control.eventFor(s.reference, 'pending');
    expect((await control.deliver(pending.eventId)).status).toBe(202);

    const altered = JSON.stringify({ ...JSON.parse(await control.storedBody(pending.eventId)), status: 'completed', providerSequence: 2 });
    expect(await control.deliver(pending.eventId, { bodyOverride: altered })).toMatchObject({
      status: 409,
      body: { error: { code: 'EVENT_ID_CONFLICT' } },
    });

    const stored = await dbs.app.query('SELECT status FROM webhook_inbox WHERE event_id = $1', [pending.eventId]);
    expect(stored.rows[0].status).toBe('pending'); // original preserved
    await lab.stack.newWorker('w').drain({ transferId: s.transferId });
    expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);
    const exceptions = await getJson<{ items: Array<{ kind: string; reason: string; evidenceIds: string[] }> }>(
      lab.stack.apiUrl,
      '/v1/exceptions',
      s.account,
    );
    expect(exceptions.body.items).toMatchObject([{ kind: 'conflicting_observation', reason: 'event_id_payload_mismatch' }]);
    expect(exceptions.body.items[0]!.evidenceIds).toContain(pending.eventId);
  });

  it('refuses to settle on wrong transfer correlation (amount mismatch)', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const completed = await control.eventFor(s.reference, 'completed');
    const wrongAmount = JSON.stringify({ ...JSON.parse(await control.storedBody(completed.eventId)), amountMinor: '999999' });
    expect((await control.deliver(completed.eventId, { bodyOverride: wrongAmount })).status).toBe(202); // authentic, so durably recorded
    await lab.stack.newWorker('w').drain({ transferId: s.transferId });

    expect((await transferRow(lab, s.transferId)).state).toBe('provider_pending');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);
    const exceptions = await getJson<{ items: Array<{ reason: string }> }>(
      lab.stack.apiUrl,
      '/v1/exceptions?kind=conflicting_observation',
      s.account,
    );
    expect(exceptions.body.items.map((i) => i.reason)).toEqual(['correlation_mismatch']);
  });

  it('records a webhook for an unknown provider reference without any effect', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const completed = await control.eventFor(s.reference, 'completed');
    const foreign = JSON.stringify({
      ...JSON.parse(await control.storedBody(completed.eventId)),
      eventId: 'evt_00000000000000000000aaaa',
      providerReference: 'pref_00000000000000000000ffff',
    });
    expect((await control.deliver(completed.eventId, { bodyOverride: foreign })).status).toBe(202);
    expect(await lab.stack.newWorker('w').processInboxOnce({ eventId: 'evt_00000000000000000000aaaa' })).toBe('worked');
    const row = await dbs.app.query('SELECT decision, transfer_id FROM webhook_inbox WHERE event_id = $1', [
      'evt_00000000000000000000aaaa',
    ]);
    expect(row.rows[0]).toEqual({ decision: 'unknown_reference', transfer_id: null });
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve']);
  });

  it('turns a contradictory final rejection after settlement into an exception, not a release', async () => {
    const s = await submittedAndCompletedAtProvider();
    const { control } = lab.stack;
    const worker = lab.stack.newWorker('w');
    await control.deliver((await control.eventFor(s.reference, 'completed')).eventId);
    await worker.drain({ transferId: s.transferId });
    const before = await userBalances(lab, s);

    const contradiction = await control.forgeEvent(s.reference, 'rejected', 3);
    expect((await control.deliver(contradiction)).status).toBe(202);
    await worker.drain({ transferId: s.transferId });

    expect((await transferRow(lab, s.transferId)).state).toBe('settled');
    expect(await journalPhases(lab, s.transferId)).toEqual(['reserve', 'settle']);
    expect(await userBalances(lab, s)).toEqual(before);
    const exceptions = await getJson<{ items: Array<{ kind: string; reason: string; evidenceIds: string[] }> }>(
      lab.stack.apiUrl,
      '/v1/exceptions',
      s.account,
    );
    expect(exceptions.body.items).toMatchObject([{ kind: 'conflicting_observation', reason: 'contradictory_terminal' }]);
    expect(exceptions.body.items[0]!.evidenceIds).toContain(contradiction);
    // A recorded contradiction is not an invariant failure: local effects are still exactly-once.
    expect((await invariantStatuses(lab, s)).statuses).toEqual(HEALTHY_AFTER_SUBMISSION);
    await expectConservation(lab, s.runId);
  });

  it('bounds webhook payload size', async () => {
    const big = await fetch(`${lab.stack.apiUrl}/v1/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(9000) }),
    });
    expect(big.status).toBe(413);
  });
});
