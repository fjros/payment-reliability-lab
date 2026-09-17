import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedRun } from '../../src/app/seed.ts';
import { ScriptedCheckpoints } from '../../src/scenarios/scripted-checkpoints.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import { balances, testDeps, uniqueName } from '../harness/deps.ts';
import { defaultBody, getJson, postTransfer, startApi, type RunningApi } from '../harness/api.ts';

let dbs: TestDatabases;
let api: RunningApi;
const checkpoints = new ScriptedCheckpoints();

beforeAll(async () => {
  dbs = await createTestDatabases();
  api = await startApi(testDeps(dbs.app, { checkpoints }));
});
afterAll(async () => {
  await api.close();
  await dbs.close();
});

async function newAccount(fundMinor?: bigint): Promise<{ runId: string; account: string }> {
  const runId = uniqueName('run');
  const account = `${runId}-A`;
  await seedRun(testDeps(dbs.app), runId, [fundMinor === undefined ? { accountId: account } : { accountId: account, fundMinor }]);
  return { runId, account };
}

const count = async (sql: string, params: unknown[]): Promise<number> => (await dbs.app.query<{ n: number }>(sql, params)).rows[0]!.n;
const reservations = (runId: string) =>
  count("SELECT count(*)::int AS n FROM journal_batches WHERE run_id = $1 AND phase = 'reserve'", [runId]);
const transfers = (runId: string) => count('SELECT count(*)::int AS n FROM transfers WHERE run_id = $1', [runId]);

describe('S1: accepted locally, response lost, client retries', () => {
  it('really loses the response after commit, then the retry returns the original transfer and no second reservation', async () => {
    const { runId, account } = await newAccount();
    checkpoints.dropConnectionOnce('api.accept.after_commit');

    // The client observes a transport failure, not an HTTP status: it cannot know what happened.
    await expect(postTransfer(api.url, { account, key: 'K' })).rejects.toThrow(/fetch failed/);
    expect(await transfers(runId)).toBe(1); // ...yet the acceptance was durably committed.

    const retry = await postTransfer(api.url, { account, key: 'K' });
    expect(retry.status).toBe(202);
    expect(retry.headers.get('idempotent-replayed')).toBe('true');
    const body = (await retry.json()) as { transferId: string; accepted: boolean; statusUrl: string };
    const original = await dbs.app.query('SELECT transfer_id FROM transfers WHERE run_id = $1', [runId]);
    expect(body).toEqual({
      transferId: original.rows[0].transfer_id,
      accepted: true,
      statusUrl: `/v1/transfers/${original.rows[0].transfer_id}`,
    });

    expect(await transfers(runId)).toBe(1);
    expect(await reservations(runId)).toBe(1);
    expect(await balances(dbs.app, runId)).toMatchObject({ [`user:${account}:available`]: '98750', [`user:${account}:reserved`]: '1250' });

    // Evidence: two request attempts with different request IDs, one logical transfer.
    const trace = await getJson<{ events: Array<{ type: string; facts: { requestId?: string } }> }>(
      api.url,
      `/v1/transfers/${body.transferId}/trace`,
      account,
    );
    const requests = trace.body.events.filter((e) => e.type === 'request_accepted' || e.type === 'request_replayed');
    expect(requests.map((e) => e.type)).toEqual(['request_accepted', 'request_replayed']);
    expect(new Set(requests.map((e) => e.facts.requestId)).size).toBe(2);
  });

  it('converges twenty concurrent identical requests on one accepted operation', async () => {
    const { runId, account } = await newAccount();
    const responses = await Promise.all(Array.from({ length: 20 }, () => postTransfer(api.url, { account, key: 'K-concurrent' })));
    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(202));
    const ids = new Set((await Promise.all(responses.map((r) => r.json() as Promise<{ transferId: string }>))).map((b) => b.transferId));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(19);
    expect(await transfers(runId)).toBe(1);
    expect(await reservations(runId)).toBe(1);
    expect((await balances(dbs.app, runId))[`user:${account}:reserved`]).toBe('1250');
  });

  it('rejects the same key with a changed economic payload without creating or changing a transfer', async () => {
    const { runId, account } = await newAccount();
    const first = await postTransfer(api.url, { account, key: 'K' });
    const { transferId } = (await first.json()) as { transferId: string };
    const before = await dbs.app.query('SELECT * FROM transfers WHERE transfer_id = $1', [transferId]);

    for (const body of [
      { ...defaultBody, amountMinor: '1251' },
      { ...defaultBody, destination: 'demo:merchant-2' },
    ]) {
      const conflict = await postTransfer(api.url, { account, key: 'K', body });
      expect(conflict.status).toBe(409);
      const envelope = (await conflict.json()) as { error: { code: string; requestId: string } };
      expect(envelope.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(envelope.error.requestId).toMatch(/^req_/);
    }
    expect(await transfers(runId)).toBe(1);
    expect(await reservations(runId)).toBe(1);
    const after = await dbs.app.query('SELECT * FROM transfers WHERE transfer_id = $1', [transferId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('treats the note as ancillary: first write wins and a changed note is a replay, not a conflict', async () => {
    const { account } = await newAccount();
    const first = await postTransfer(api.url, { account, key: 'K', body: { ...defaultBody, note: 'first note' } });
    const replay = await postTransfer(api.url, { account, key: 'K', body: { ...defaultBody, note: 'different note' } });
    expect(replay.status).toBe(202);
    const { transferId } = (await first.json()) as { transferId: string };
    expect(((await replay.json()) as { transferId: string }).transferId).toBe(transferId);
    const view = await getJson<{ untrusted: { clientNote: string } }>(api.url, `/v1/transfers/${transferId}`, account);
    expect(view.body.untrusted.clientNote).toBe('first note');
  });

  it('scopes the key to the demo account: the same key under another account is a different operation', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const ra = (await (await postTransfer(api.url, { account: a.account, key: 'shared-key' })).json()) as { transferId: string };
    const rb = (await (await postTransfer(api.url, { account: b.account, key: 'shared-key' })).json()) as { transferId: string };
    expect(ra.transferId).not.toBe(rb.transferId);
    expect(await reservations(a.runId)).toBe(1);
    expect(await reservations(b.runId)).toBe(1);
    // ...and neither account can read the other's transfer.
    expect((await getJson(api.url, `/v1/transfers/${ra.transferId}`, b.account)).status).toBe(404);
    expect((await getJson(api.url, `/v1/transfers/${ra.transferId}/trace`, b.account)).status).toBe(404);
  });

  it('does not consume the key when rejected before acceptance: a later retry can be accepted', async () => {
    const { runId, account } = await newAccount(1000n);
    const rejected = await postTransfer(api.url, { account, key: 'K' });
    expect(rejected.status).toBe(409);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await transfers(runId)).toBe(0);
    const smaller = await postTransfer(api.url, { account, key: 'K', body: { ...defaultBody, amountMinor: '1000' } });
    expect(smaller.status).toBe(202);
  });
});

describe('S4: distinct keys racing to overspend', () => {
  it('cannot both reserve more than the available funds', async () => {
    const { runId, account } = await newAccount(2000n);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => postTransfer(api.url, { account, key: `race-${i}` })));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 202)).toHaveLength(1); // 2000 funds, 1250 each: exactly one fits
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await balances(dbs.app, runId)).toMatchObject({ [`user:${account}:available`]: '750', [`user:${account}:reserved`]: '1250' });
    expect(await reservations(runId)).toBe(1);
  });
});

describe('HTTP contract', () => {
  it.each([
    ['number amount', { ...defaultBody, amountMinor: 1250 }],
    ['fractional', { ...defaultBody, amountMinor: '12.50' }],
    ['exponent', { ...defaultBody, amountMinor: '1e3' }],
    ['negative', { ...defaultBody, amountMinor: '-5' }],
    ['zero', { ...defaultBody, amountMinor: '0' }],
    ['overflow', { ...defaultBody, amountMinor: '1000000000001' }],
    ['unsupported asset', { ...defaultBody, asset: 'USD' }],
    ['url destination', { ...defaultBody, destination: 'https://example.invalid/pay' }],
    ['unseeded destination', { ...defaultBody, destination: 'demo:unknown' }],
    ['unknown field', { ...defaultBody, priority: 'high' }],
    ['oversized note', { ...defaultBody, note: 'x'.repeat(513) }],
  ])('rejects %s with 400 INVALID_REQUEST and no side effects', async (_name, body) => {
    const { runId, account } = await newAccount();
    const response = await postTransfer(api.url, { account, key: 'K', body });
    expect(response.status).toBe(400);
    const envelope = (await response.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('INVALID_REQUEST');
    expect(envelope.error.message).not.toMatch(/at .*\.ts|node_modules/);
    expect(await transfers(runId)).toBe(0);
  });

  it('requires a demo identity and a well-formed idempotency key', async () => {
    const { account } = await newAccount();
    const noAccount = await fetch(`${api.url}/v1/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'K' },
      body: JSON.stringify(defaultBody),
    });
    expect(noAccount.status).toBe(401);
    expect((await postTransfer(api.url, { account: 'not-seeded', key: 'K' })).status).toBe(401);
    expect((await postTransfer(api.url, { account, key: 'has space' })).status).toBe(400);
    expect((await postTransfer(api.url, { account, key: 'k'.repeat(129) })).status).toBe(400);
  });

  it('bounds body size and rejects malformed JSON with the standard envelope', async () => {
    const { account } = await newAccount();
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'K', 'x-demo-account': account };
    const huge = await fetch(`${api.url}/v1/transfers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...defaultBody, note: 'x'.repeat(20000) }),
    });
    expect(huge.status).toBe(413);
    const broken = await fetch(`${api.url}/v1/transfers`, { method: 'POST', headers, body: '{"asset":' });
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('paginates the trace with a cursor and honest completeness metadata', async () => {
    const { account } = await newAccount();
    const { transferId } = (await (await postTransfer(api.url, { account, key: 'K' })).json()) as { transferId: string };
    for (let i = 0; i < 4; i += 1) await postTransfer(api.url, { account, key: 'K' });
    type Page = { events: Array<{ seq: number }>; nextCursor: string | null; reachedEnd: boolean; totalEvents: number };
    const first = await getJson<Page>(api.url, `/v1/transfers/${transferId}/trace?limit=3`, account);
    expect(first.body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(first.body).toMatchObject({ reachedEnd: false, totalEvents: 7 });
    const second = await getJson<Page>(api.url, `/v1/transfers/${transferId}/trace?limit=100&cursor=${first.body.nextCursor}`, account);
    expect(second.body.events.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    expect(second.body).toMatchObject({ reachedEnd: true, nextCursor: null });
    expect((await getJson(api.url, `/v1/transfers/${transferId}/trace?limit=101`, account)).status).toBe(400);
    expect((await getJson(api.url, `/v1/transfers/${transferId}/trace?cursor=not-a-cursor!`, account)).status).toBe(400);
  });

  it('reports all invariants for a freshly reserved transfer, with I6 external effect provably absent', async () => {
    const { account } = await newAccount();
    const { transferId } = (await (await postTransfer(api.url, { account, key: 'K' })).json()) as { transferId: string };
    const report = await getJson<{ results: Array<{ id: string; status: string }>; summary: { fail: number } }>(
      api.url,
      `/v1/transfers/${transferId}/invariants`,
      account,
    );
    expect(report.body.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'I1:pass',
      'I2:pass',
      'I3:pass',
      'I4:pass',
      'I5:pass',
      'I6:pass',
      'I7:pass',
      'I8:pass',
    ]);
  });
});
