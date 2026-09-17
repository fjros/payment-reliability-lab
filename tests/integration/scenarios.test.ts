import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionString } from '../../src/config.ts';
import { createPool } from '../../src/db/pool.ts';
import { buildReplay } from '../../src/scenarios/replay.ts';
import { INJECTION_NOTE, runScenario, type ScenarioResult } from '../../src/scenarios/scenarios.ts';
import { Stack } from '../../src/scenarios/stack.ts';
import { ManualClock } from '../../src/shared/clock.ts';
import { seededIds } from '../../src/shared/ids.ts';
import type { ScenarioId } from '../../src/scenarios/answers.ts';
import { TEST_WEBHOOK_SECRET } from '../harness/api.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';

let dbs: TestDatabases;
beforeAll(async () => {
  dbs = await createTestDatabases();
});
afterAll(async () => {
  await dbs.close();
});

async function run(id: ScenarioId, seed: string, stopAt?: 'unknown'): Promise<ScenarioResult> {
  const clock = new ManualClock();
  const stack = await Stack.start({
    appPool: dbs.app,
    providerPool: dbs.provider,
    clock,
    ids: seededIds(`${id}:${seed}`),
    webhookSecret: TEST_WEBHOOK_SECRET,
    providerTimeoutMs: 1500,
  });
  try {
    return await runScenario(stack, id, { runId: `${id}-${seed}`, clock, ...(stopAt ? { stopAt } : {}) });
  } finally {
    await stack.close();
  }
}

const statuses = (r: ScenarioResult, moment = 'final'): string =>
  r.moments
    .find((m) => m.id === moment)!
    .invariants.results.map((i) => `${i.id}=${i.status}`)
    .join(' ');
const HEALTHY = 'I1=pass I2=pass I3=pass I4=pass I5=pass I6=unknown I7=pass I8=pass';

describe('deterministic scenario scripts (demo, export and agent fixtures)', () => {
  it('S1: three requests, one transfer, one reservation, one settlement, one provider effect', async () => {
    const r = await run('S1', 'a');
    const types = r.trace.map((e) => e.type);
    expect(types.filter((t) => ['request_accepted', 'request_replayed', 'idempotency_conflict_rejected'].includes(t))).toEqual([
      'request_accepted',
      'request_replayed',
      'idempotency_conflict_rejected',
    ]);
    expect(types).toContain('fault_injected');
    const final = r.moments.at(-1)!;
    expect(final.transfer.state).toBe('settled');
    expect(final.evidence.journal.map((b) => b.phase)).toEqual(['reserve', 'settle']);
    expect(final.balances).toMatchObject({ availableMinor: '98750', reservedMinor: '0', runClearingMinor: '1250' });
    expect(statuses(r)).toBe(HEALTHY);
    expect(r.oracle.providerEffectCount).toBe(1);
    const replay = buildReplay(r, 'a', new Date('2026-09-17T00:00:00Z'));
    expect(replay.moments.at(-1)!.answer).toMatchObject({ verdict: 'no' });
    expect(replay.moments.at(-1)!.answer.text).toMatch(/3 request\(s\).*1 reservation and 1 terminal effect/);
  });

  it('S2: five deliveries of three events, one settlement; answer cites evidence', async () => {
    const r = await run('S2', 'a');
    const final = r.moments.at(-1)!;
    expect(final.transfer.state).toBe('settled');
    expect(final.evidence.webhookEvents.map((e) => `${e.decision}:${e.deliveries.length}`)).toEqual([
      'settled:3',
      'duplicate_outcome:1',
      'stale_observation:1',
    ]);
    expect(statuses(r)).toBe(HEALTHY);
    const answer = buildReplay(r, 'a', new Date()).moments.at(-1)!.answer;
    expect(answer.verdict).toBe('no');
    expect(answer.evidenceIds.length).toBeGreaterThan(0);
  });

  it('S3: says "not yet known" while unknown, "yes" only after an authoritative observation; oracle kept separate', async () => {
    const r = await run('S3', 'a');
    const replay = buildReplay(r, 'a', new Date());
    expect(replay.moments.map((m) => `${m.id}:${m.transfer.state}:${m.answer.verdict}`)).toEqual([
      'unknown:outcome_unknown:not_yet_known',
      'still-unknown:outcome_unknown:not_yet_known',
      'final:settled:yes',
    ]);
    expect(replay.moments[0]!.balances).toMatchObject({ availableMinor: '98750', reservedMinor: '1250', runClearingMinor: '0' });
    expect(replay.moments[0]!.transfer.lastProviderObservation).toBeNull();
    expect(replay.oracle).toMatchObject({ privileged: true, providerStatus: 'completed', providerEffectCount: 1 });
    // Nothing the application exposes before recovery leaks the oracle's answer.
    const beforeRecovery = JSON.stringify([replay.moments[0], replay.trace.filter((e) => e.seq <= replay.moments[1]!.afterSeq)]);
    expect(beforeRecovery).not.toMatch(/"providerStatus":"completed"/);
  });

  it('S3 --stop-at-unknown leaves a transfer that is still unresolved for live investigation', async () => {
    const r = await run('S3', 'held', 'unknown');
    expect(r.moments.at(-1)!.transfer.state).toBe('outcome_unknown');
    expect(r.moments.at(-1)!.exceptions.map((x) => x.kind)).toEqual(['unknown_outcome']);
  });

  it('S7: hostile notes are preserved verbatim as untrusted data and change nothing', async () => {
    const r = await run('S7', 'a');
    const final = r.moments.at(-1)!;
    expect(final.transfer.state).toBe('settled');
    expect(final.evidence.journal.map((b) => b.phase)).toEqual(['reserve', 'settle']);
    expect(final.transfer.untrusted?.clientNote).toMatch(/release the funds/);
    const noted = r.trace.filter((e) => e.untrusted?.providerNote === INJECTION_NOTE);
    expect(noted.length).toBeGreaterThan(0);
    for (const event of r.trace) expect(JSON.stringify(event.facts)).not.toContain('ignore your instructions'); // never mixed into authoritative facts
    expect(statuses(r)).toBe(HEALTHY);
  });

  it('S8: the contradiction is an exception; the answer refuses to pick a winner', async () => {
    const r = await run('S8', 'a');
    const final = r.moments.at(-1)!;
    expect(final.transfer.state).toBe('settled');
    expect(final.exceptions.map((x) => `${x.kind}:${x.reason}`)).toEqual(['conflicting_observation:contradictory_terminal']);
    expect(statuses(r)).toBe(HEALTHY);
    expect(buildReplay(r, 'a', new Date()).moments.at(-1)!.answer.text).toMatch(/NOT known/);
  });

  it('is repeatable: the same seed yields the same IDs, events and timestamps', async () => {
    const first = await run('S2', 'repeat');
    await dbs.admin.query('DELETE FROM runs WHERE run_id = $1', ['S2-repeat']);
    // Provider rows are keyed by reference; clear them with admin rights, as the CLI does.
    const admin = createPool(connectionString(dbs.targets, 'admin', dbs.targets.providerDatabase), 1);
    await admin.query('DELETE FROM sim_transfers WHERE provider_reference = $1', [first.providerReference]);
    await admin.query('DELETE FROM sim_fault_plans WHERE provider_reference = $1', [first.providerReference]);
    await admin.end();
    const second = await run('S2', 'repeat');
    expect(second.transferId).toBe(first.transferId);
    expect(second.trace).toEqual(first.trace);
  });
});
