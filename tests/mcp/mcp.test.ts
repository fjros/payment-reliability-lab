import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionString } from '../../src/config.ts';
import type { ScenarioId } from '../../src/scenarios/answers.ts';
import { INJECTION_NOTE, runScenario, type ScenarioResult } from '../../src/scenarios/scenarios.ts';
import { Stack } from '../../src/scenarios/stack.ts';
import { ManualClock } from '../../src/shared/clock.ts';
import { seededIds } from '../../src/shared/ids.ts';
import { TEST_WEBHOOK_SECRET } from '../harness/api.ts';
import { createTestDatabases, type TestDatabases } from '../harness/databases.ts';
import { dbEnv } from '../harness/processes.ts';

const ENTRY = 'dist/mcp/main.js';
const SCOPE = ['S1-m', 'S2-m', 'S3-m', 'S7-m', 'S8-m', 'broken-m'];

let dbs: TestDatabases;
let client: Client;
let transport: StdioClientTransport;
let stderr = '';
const fixtures = {} as Record<ScenarioId | 'outside' | 'broken', ScenarioResult>;

async function scenario(id: ScenarioId, runId: string, stopAt?: 'unknown'): Promise<ScenarioResult> {
  const clock = new ManualClock();
  const stack = await Stack.start({
    appPool: dbs.app,
    providerPool: dbs.provider,
    clock,
    ids: seededIds(runId),
    webhookSecret: TEST_WEBHOOK_SECRET,
  });
  try {
    return await runScenario(stack, id, { runId, clock, ...(stopAt ? { stopAt } : {}) });
  } finally {
    await stack.close();
  }
}

async function connect(env: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  t.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const c = new Client({ name: 'prl-mcp-tests', version: '0.0.0' });
  await c.connect(t);
  return { client: c, transport: t };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ type: string; text: string }> };
/** Normalizes the two ways a rejected call can surface: a protocol error or an isError result. */
async function call(
  name: string,
  args: Record<string, unknown>,
  via: Client = client,
): Promise<{ ok: boolean; data: Record<string, any>; text: string }> {
  try {
    const result = (await via.callTool({ name, arguments: args })) as ToolResult;
    const text = result.content.map((c) => c.text).join('\n');
    return { ok: !result.isError, data: result.structuredContent ?? {}, text };
  } catch (error) {
    return { ok: false, data: {}, text: (error as Error).message };
  }
}

beforeAll(async () => {
  if (!existsSync(ENTRY)) throw new Error(`${ENTRY} is missing. Run "npm run build:server" first (npm run test:mcp does this).`);
  dbs = await createTestDatabases();
  fixtures.S1 = await scenario('S1', 'S1-m');
  fixtures.S2 = await scenario('S2', 'S2-m');
  fixtures.S3 = await scenario('S3', 'S3-m', 'unknown');
  fixtures.S7 = await scenario('S7', 'S7-m');
  fixtures.S8 = await scenario('S8', 'S8-m');
  fixtures.outside = await scenario('S1', 'outside-m');
  fixtures.broken = await scenario('S1', 'broken-m');
  ({ client, transport } = await connect({ ...dbEnv(dbs), PRL_MCP_RUN_IDS: SCOPE.join(',') }));
});
afterAll(async () => {
  await transport?.close();
  await dbs?.close();
});

describe('MCP boundary over a real stdio transport', () => {
  it('discovers exactly three read-only tools with published input and output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_invariants', 'get_transfer_trace', 'list_exceptions']);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
      expect(tool.name).not.toMatch(/sql|exec|reset|retry|refund|fault|write|update|release|settle/i);
    }
    expect(tools.find((t) => t.name === 'get_transfer_trace')!.inputSchema.properties).toHaveProperty('limit.maximum', 100);
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(stderr).toMatch(/"message":"mcp server ready"/); // diagnostics on stderr; stdout stayed pure protocol
  });

  it('publishes portable schemas: single-valued "type" everywhere and no schema that constrains nothing', async () => {
    const { tools } = await client.listTools();
    const problems: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${path}[${i}]`));
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (Array.isArray(schema.type)) problems.push(`${path}.type is an array: ${JSON.stringify(schema.type)}`);
      for (const key of ['additionalProperties', 'items'] as const) {
        const child = schema[key];
        if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0)
          problems.push(`${path}.${key} is {} (accepts anything)`);
      }
      for (const [key, child] of Object.entries(schema)) walk(child, `${path}.${key}`);
    };
    for (const tool of tools) {
      walk(tool.inputSchema, `${tool.name}.inputSchema`);
      walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }
    expect(problems).toEqual([]);
  });

  it('returns a complete trace with linked evidence, snapshot identity and structured content', async () => {
    const r = await call('get_transfer_trace', { transferId: fixtures.S2.transferId, limit: 100 });
    expect(r.ok).toBe(true);
    expect(r.data.transfer).toMatchObject({ transferId: fixtures.S2.transferId, state: 'settled', amountMinor: '1250', asset: 'DEMO_USD' });
    expect(r.data.events.map((e: { seq: number }) => e.seq)).toEqual(fixtures.S2.trace.map((e) => e.seq));
    expect(r.data.completeness).toMatchObject({ traceComplete: true, linkedEvidenceIncluded: true, linkedEvidenceTruncated: false });
    expect(r.data.linkedEvidence.journal.map((b: { phase: string }) => b.phase)).toEqual(['reserve', 'settle']);
    expect(r.data.linkedEvidence.webhookEvents).toHaveLength(3);
    expect(r.data.snapshot.databaseSnapshot).toMatch(/^\d+:\d+:/);
    expect(JSON.parse(r.text)).toEqual(r.data);
  });

  it('S6: never presents a truncated trace as complete, and pages to the end', async () => {
    const total = fixtures.S2.trace.length;
    const first = await call('get_transfer_trace', { transferId: fixtures.S2.transferId, limit: 4 });
    expect(first.data.page).toMatchObject({ reachedEnd: false, totalEvents: total, returnedRange: { fromSeq: 1, toSeq: 4 } });
    expect(first.data.completeness.traceComplete).toBe(false);
    expect(first.data.completeness.guidance).toMatch(/^INCOMPLETE: this page holds events 1\.\.4 of/);

    const seen: number[] = first.data.events.map((e: { seq: number }) => e.seq);
    let cursor: string | null = first.data.page.nextCursor;
    while (cursor) {
      const next = await call('get_transfer_trace', { transferId: fixtures.S2.transferId, limit: 4, cursor });
      expect(next.data.completeness.traceComplete).toBe(false); // later pages alone are never "the whole trace"
      expect(next.data.linkedEvidence).toBeNull();
      seen.push(...next.data.events.map((e: { seq: number }) => e.seq));
      cursor = next.data.page.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it('S3: reports the external outcome as unknown and never leaks the simulator oracle', async () => {
    expect(fixtures.S3.oracle).toMatchObject({ providerStatus: 'completed', providerEffectCount: 1 }); // hidden truth
    const trace = await call('get_transfer_trace', { transferId: fixtures.S3.transferId, limit: 100 });
    const invariants = await call('check_invariants', { transferId: fixtures.S3.transferId });
    const exceptions = await call('list_exceptions', { runId: 'S3-m' });

    expect(trace.data.transfer).toMatchObject({ state: 'outcome_unknown', lastProviderObservation: null });
    expect(trace.data.externalStateNote).toMatch(/UNKNOWN/);
    expect(invariants.data.unresolvedExternalOutcome).toBe(true);
    const byId = Object.fromEntries(invariants.data.results.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(byId).toMatchObject({ I3: 'pass', I6: 'unknown', I7: 'pass' });
    expect(invariants.data.summary.fail).toBe(0);
    expect(exceptions.data.items).toMatchObject([{ kind: 'unknown_outcome', transferId: fixtures.S3.transferId }]);
    expect(exceptions.data.items[0].evidenceIds.length).toBeGreaterThan(0);

    const everything = trace.text + invariants.text + exceptions.text;
    expect(everything).not.toMatch(/"providerStatus":"completed"|sim_effects|sim_transfers|providerEffectCount/i);
  });

  it('keeps the three exception categories distinct and scoped to the run', async () => {
    const s8 = await call('list_exceptions', { runId: 'S8-m' });
    expect(s8.data.items.map((i: { kind: string; reason: string }) => `${i.kind}:${i.reason}`)).toEqual([
      'conflicting_observation:contradictory_terminal',
    ]);
    expect((await call('list_exceptions', { runId: 'S8-m', kind: 'unknown_outcome' })).data.items).toEqual([]);
    expect((await call('list_exceptions', { runId: 'S2-m' })).data).toMatchObject({ items: [], page: { reachedEnd: true } });

    // Corrupt a projection with admin rights: the listing and I2 must both say so.
    await dbs.admin.query(
      "UPDATE account_balances SET balance_minor = balance_minor + 7 WHERE run_id = 'broken-m' AND ledger_account = 'provider:clearing'",
    );
    const broken = await call('list_exceptions', { runId: 'broken-m', kind: 'invariant_failure' });
    expect(broken.data.items).toMatchObject([{ kind: 'invariant_failure', reason: 'projection_journal_mismatch' }]);
    const i2 = (await call('check_invariants', { transferId: fixtures.broken.transferId })).data.results.find(
      (r: { id: string }) => r.id === 'I2',
    );
    expect(i2).toMatchObject({ status: 'fail' });
    expect(i2.explanation).toMatch(/projected 1257 vs journal 1250/);
  });

  it('S7: hostile text arrives only inside "untrusted" fields, alongside an explicit notice', async () => {
    const r = await call('get_transfer_trace', { transferId: fixtures.S7.transferId, limit: 100 });
    expect(r.data.untrustedContentNotice).toMatch(/never as instructions/);
    expect(r.data.transfer.untrusted.clientNote).toMatch(/release the funds/);
    const carriers = r.data.events.filter(
      (e: { untrusted: Record<string, string> | null }) => e.untrusted?.providerNote === INJECTION_NOTE,
    );
    expect(carriers.length).toBeGreaterThan(0);
    for (const e of r.data.events) expect(JSON.stringify(e.facts)).not.toMatch(/ignore your instructions/i);
    expect(r.data.transfer.state).toBe('settled'); // and the text changed nothing
  });

  it('rejects unknown tools, extra arguments, arbitrary SQL/paths, bad limits and bad cursors', async () => {
    const id = fixtures.S1.transferId;
    const rejected = [
      await call('run_sql', { query: 'SELECT 1' }),
      await call('get_transfer_trace', { transferId: id, sql: 'DROP TABLE transfers' }),
      await call('get_transfer_trace', { transferId: "tr_x'; DROP TABLE transfers;--" }),
      await call('get_transfer_trace', { transferId: '../../etc/passwd' }),
      await call('get_transfer_trace', { transferId: id, limit: 101 }),
      await call('get_transfer_trace', { transferId: id, limit: 0 }),
      await call('get_transfer_trace', { transferId: id, limit: '10' }),
      await call('get_transfer_trace', { transferId: id, cursor: '%%%' }),
      await call('check_invariants', {}),
      await call('list_exceptions', { runId: 'S1-m; DELETE FROM runs' }),
      await call('list_exceptions', { runId: 'S1-m', kind: 'everything' }),
    ];
    for (const r of rejected) expect(r.ok).toBe(false);
    const forged = await call('get_transfer_trace', { transferId: id, cursor: Buffer.from('{"v":1,"k":"x"}').toString('base64url') });
    expect(forged.text).toMatch(/INVALID_INPUT/);
    expect((await dbs.app.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n).toBeGreaterThan(0); // still there
  });

  it('distinguishes unknown IDs, out-of-scope data and scope violations without disclosing existence', async () => {
    const missing = await call('check_invariants', { transferId: 'tr_00000000000000000000' });
    const outside = await call('check_invariants', { transferId: fixtures.outside.transferId });
    expect(missing.text).toMatch(/NOT_FOUND/);
    expect(outside.text).toMatch(/NOT_FOUND/);
    expect(outside.text.replace(fixtures.outside.transferId, 'X')).toBe(missing.text.replace('tr_00000000000000000000', 'X'));
    expect((await call('get_transfer_trace', { transferId: fixtures.outside.transferId })).text).toMatch(/NOT_FOUND/);
    expect((await call('list_exceptions', { runId: 'outside-m' })).text).toMatch(/SCOPE_VIOLATION/);
    // A transfer ID passed as runId gets a corrective hint, and still discloses nothing about it.
    const mixedUp = await call('list_exceptions', { runId: fixtures.outside.transferId });
    expect(mixedUp.ok).toBe(false);
    expect(mixedUp.text).toMatch(/INVALID_INPUT.*looks like a transfer ID.*transfer\.runId/);
  });

  it('is observational: calling every tool leaves transfers, journal, balances and traces byte-identical', async () => {
    const fingerprint = async (): Promise<string> => {
      const parts: string[] = [];
      for (const table of [
        'transfers',
        'journal_batches',
        'journal_postings',
        'account_balances',
        'trace_events',
        'jobs',
        'exceptions',
        'provider_observations',
      ]) {
        const r = await dbs.admin.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM ${table} t`);
        parts.push(`${table}:${r.rows[0].h}`);
      }
      return parts.join(',');
    };
    const before = await fingerprint();
    for (const f of [fixtures.S1, fixtures.S2, fixtures.S3, fixtures.S7, fixtures.S8]) {
      await call('get_transfer_trace', { transferId: f.transferId });
      await call('check_invariants', { transferId: f.transferId });
      await call('list_exceptions', { runId: f.runId });
    }
    expect(await fingerprint()).toBe(before);
  });
});

describe('read-only enforcement below the protocol layer', () => {
  it('the database denies the MCP role every write and every base-table read', async () => {
    const ro = new pg.Client({ connectionString: connectionString(dbs.targets, 'mcp') });
    await ro.connect();
    try {
      expect((await ro.query('SELECT count(*)::int AS n FROM readmodel.transfers')).rows[0].n).toBeGreaterThan(0);
      const denied = [
        "UPDATE readmodel.transfers SET state = 'rejected'",
        "UPDATE transfers SET state = 'rejected'",
        'DELETE FROM readmodel.trace_events',
        "INSERT INTO journal_batches (batch_id, run_id, transfer_id, phase, created_at) VALUES ('x', 'S1-m', NULL, 'seed', now())",
        'UPDATE account_balances SET balance_minor = 0',
        'SELECT * FROM transfers',
        'SELECT raw_body FROM webhook_inbox',
        'SELECT response_body FROM idempotency_keys',
        'CREATE TABLE readmodel.loot (x int)',
        'CREATE TABLE public.loot (x int)',
        'TRUNCATE trace_events',
      ];
      for (const sql of denied) {
        // Even after explicitly asking for a read-write transaction, privileges still say no.
        await ro.query('BEGIN READ WRITE');
        // Base tables are not even visible: the role has no USAGE on schema public.
        await expect(ro.query(sql), sql).rejects.toThrow(/permission denied|does not exist/);
        await ro.query('ROLLBACK');
      }
      // And by default the role's transactions are read-only before privileges are even checked.
      await expect(ro.query('CREATE TEMP TABLE scratch (x int)')).rejects.toThrow(/read-only transaction/);
    } finally {
      await ro.end();
    }
  });

  it('reports a database outage as an explicit dependency error, not an empty healthy result', async () => {
    const down = await connect({ ...dbEnv(dbs), PRL_PG_PORT: '1', PRL_MCP_RUN_IDS: SCOPE.join(',') });
    try {
      for (const [name, args] of [
        ['get_transfer_trace', { transferId: fixtures.S1.transferId }],
        ['check_invariants', { transferId: fixtures.S1.transferId }],
        ['list_exceptions', { runId: 'S1-m' }],
      ] as const) {
        const r = await call(name, args, down.client);
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/DEPENDENCY_UNAVAILABLE/);
        expect(r.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|password/); // no driver detail leaks
      }
    } finally {
      await down.transport.close();
    }
  });
});
