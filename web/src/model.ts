import { answerFor, answerInputsFrom, SCENARIOS, type Answer, type ScenarioId } from '../../src/scenarios/answers.ts';

/** Mirrors src/scenarios/replay.ts (kept structural so the viewer has no Node dependencies). */
export interface TraceEvent {
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

export interface InvariantResult {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'unknown';
  explanation: string;
  evidenceIds: string[];
}

export interface Evidence {
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
    outcome: string | null;
    httpStatus: number | null;
  }>;
  providerObservations: Array<{
    observationId: string;
    channel: string;
    providerStatus: string;
    providerSequence: number | null;
    observedAt: string;
    decision: string;
  }>;
  webhookEvents: Array<{
    eventId: string;
    providerStatus: string;
    providerSequence: number;
    providerOccurredAt: string;
    firstReceivedAt: string;
    decision: string | null;
    deliveries: Array<{ deliveryId: string; receivedAt: string; result: string }>;
  }>;
  truncated: boolean;
}

export interface Moment {
  id: string;
  label: string;
  afterSeq: number;
  transfer: {
    transferId: string;
    state: string;
    asset: string;
    amountMinor: string;
    destination: string;
    providerReference: string;
    lastProviderObservation: null | { providerStatus: string; observedAt: string; ageMs: number };
    untrusted: { clientNote: string } | null;
  };
  balances: { asset: string; availableMinor: string; reservedMinor: string; runClearingMinor: string };
  invariants: { results: InvariantResult[]; unresolvedExternalOutcome: boolean; observedAt: string };
  exceptions: Array<{ itemId: string; kind: string; reason: string; detail: string; evidenceIds: string[] }>;
  evidence: Evidence;
  answer: Answer | null;
}

export interface ReplayDocument {
  format: string;
  version: number;
  scenario: { id: string; title: string; question: string; summary: string };
  seed: string;
  runId: string;
  accountId: string;
  transferId: string;
  generatedAt: string;
  scenarioClock: string;
  implementationRevision: string;
  provenance: { kind: string; synthetic: boolean; generator: string; note: string };
  steps: Array<{ n: number; actor: string; text: string; afterSeq: number }>;
  trace: TraceEvent[];
  moments: Moment[];
  oracle: null | {
    privileged: true;
    notice: string;
    providerStatus: string | null;
    providerEffectCount: number;
    providerEvents: Array<{ eventId: string; status: string; sequence: number; forced: boolean; deliveryCount: number }>;
  };
  agentDiagnosis: null | { provenance: string; model: string; recordedAt: string; text: string };
}

export type Source = { kind: 'replay'; file: string } | { kind: 'live'; fetchedAt: string; stale: boolean; error: string | null };

export interface Loaded {
  doc: ReplayDocument;
  source: Source;
}

export interface ReplayIndexEntry {
  id: string;
  title: string;
  file: string;
}

export const REPLAY_FORMAT = 'payment-reliability-lab/replay';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function loadIndex(): Promise<ReplayIndexEntry[]> {
  return json<ReplayIndexEntry[]>('./replays/index.json');
}

export async function loadReplay(file: string): Promise<Loaded> {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) throw new Error('unexpected replay file name');
  const doc = await json<ReplayDocument>(`./replays/${file}`);
  if (doc.format !== REPLAY_FORMAT || doc.version !== 1)
    throw new Error(`Unsupported replay format "${String(doc.format)}" v${String(doc.version)}`);
  return { doc, source: { kind: 'replay', file } };
}

/** Live mode: composes the same document shape from the read API. One "moment": right now. */
export async function loadLive(accountId: string, transferId: string, question: ScenarioId | 'none'): Promise<Loaded> {
  const headers = { 'x-demo-account': accountId };
  const base = `/v1/transfers/${encodeURIComponent(transferId)}`;
  const get = <T>(path: string): Promise<T> => json<T>(path, { headers });
  const transfer = await get<Moment['transfer'] & { runId: string; accountId: string }>(base);
  const trace: TraceEvent[] = [];
  let cursor: string | null = null;
  do {
    const page: { events: TraceEvent[]; nextCursor: string | null } = await get(
      `${base}/trace?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    trace.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  const invariants = await get<Moment['invariants']>(`${base}/invariants`);
  const evidence = await get<Evidence>(`${base}/evidence`);
  const balances = await get<Moment['balances']>('/v1/balances');
  const exceptions = (await get<{ items: Moment['exceptions'] }>('/v1/exceptions?limit=100')).items.filter(
    (x) => x.evidenceIds.length >= 0,
  );
  const moment: Moment = {
    id: 'live',
    label: 'Live observation',
    afterSeq: trace.at(-1)?.seq ?? 0,
    transfer,
    balances,
    invariants,
    exceptions,
    evidence,
    answer: null,
  };
  if (question !== 'none') moment.answer = answerFor(question, answerInputsFrom(moment, trace));
  const meta =
    question === 'none'
      ? { title: 'Live transfer', question: 'No scenario question selected', summary: 'Observed through the local read API.' }
      : SCENARIOS[question];
  const fetchedAt = new Date().toISOString();
  return {
    doc: {
      format: REPLAY_FORMAT,
      version: 1,
      scenario: { id: question === 'none' ? 'LIVE' : question, ...meta },
      seed: '-',
      runId: transfer.runId,
      accountId,
      transferId,
      generatedAt: fetchedAt,
      scenarioClock: 'Timestamps come from the running services.',
      implementationRevision: 'n/a (live)',
      provenance: {
        kind: 'live-api-observation',
        synthetic: true,
        generator: 'GET /v1/transfers/:id, /trace, /evidence, /invariants',
        note: 'Live observation of the local API. Not an export; refresh to observe again.',
      },
      steps: [],
      trace,
      moments: [moment],
      oracle: null,
      agentDiagnosis: null,
    },
    source: { kind: 'live', fetchedAt, stale: false, error: null },
  };
}

// ---- Derived view state ---------------------------------------------------------------------

export type Lane = 'client' | 'ledger' | 'worker' | 'provider';
export const LANES: Array<{ id: Lane; title: string; hint: string }> = [
  { id: 'client', title: 'Client / API', hint: 'HTTP requests and replies' },
  { id: 'ledger', title: 'Local database / journal', hint: 'State and balanced postings' },
  { id: 'worker', title: 'Worker', hint: 'Leases and provider calls' },
  { id: 'provider', title: 'Provider observations', hint: 'What the provider told us, in arrival order' },
];

const LANE_BY_TYPE: Record<string, Lane> = {
  request_accepted: 'client',
  request_replayed: 'client',
  idempotency_conflict_rejected: 'client',
  fault_injected: 'client',
  funds_reserved: 'ledger',
  funds_settled: 'ledger',
  funds_released: 'ledger',
  state_changed: 'ledger',
  job_scheduled: 'ledger',
  exception_recorded: 'ledger',
  job_claimed: 'worker',
  submission_attempted: 'worker',
  lookup_attempted: 'worker',
  response_lost: 'worker',
  provider_call_failed: 'worker',
  outcome_unknown: 'worker',
  stale_worker_result_discarded: 'worker',
  webhook_accepted: 'provider',
  duplicate_ignored: 'provider',
  stale_event_ignored: 'provider',
  provider_observation_received: 'provider',
};
export const laneOf = (event: TraceEvent): Lane => LANE_BY_TYPE[event.type] ?? 'ledger';

export type FilterId = 'requests' | 'state' | 'notifications' | 'journal' | 'calls';
export const FILTERS: Array<{ id: FilterId; label: string; types: string[] }> = [
  { id: 'requests', label: 'Requests', types: ['request_accepted', 'request_replayed', 'idempotency_conflict_rejected', 'fault_injected'] },
  { id: 'state', label: 'State changes', types: ['state_changed', 'outcome_unknown', 'exception_recorded', 'job_scheduled'] },
  {
    id: 'notifications',
    label: 'Notifications',
    types: ['webhook_accepted', 'duplicate_ignored', 'stale_event_ignored', 'provider_observation_received'],
  },
  { id: 'journal', label: 'Journal effects', types: ['funds_reserved', 'funds_settled', 'funds_released'] },
  {
    id: 'calls',
    label: 'Worker and provider calls',
    types: [
      'job_claimed',
      'submission_attempted',
      'lookup_attempted',
      'response_lost',
      'provider_call_failed',
      'stale_worker_result_discarded',
    ],
  },
];

export function visibleEvents(doc: ReplayDocument, position: number, filters: Set<FilterId>): TraceEvent[] {
  const allowed = new Set(FILTERS.filter((f) => filters.has(f.id)).flatMap((f) => f.types));
  const known = new Set(FILTERS.flatMap((f) => f.types));
  return doc.trace.filter((e) => e.seq <= position && (allowed.has(e.type) || !known.has(e.type)));
}

/** The most recent captured application view at or before `position`. */
export function momentAt(doc: ReplayDocument, position: number): Moment | null {
  return [...doc.moments].reverse().find((m) => m.afterSeq <= position) ?? null;
}

/**
 * Balances at any playback position, rebuilt from journal effects in the trace (exact BigInt
 * arithmetic on minor-unit strings), anchored on a recorded snapshot.
 */
export function balancesAt(
  doc: ReplayDocument,
  position: number,
): { available: bigint; reserved: bigint; settled: bigint; asset: string } | null {
  const anchor = doc.moments[0];
  if (!anchor) return null;
  const delta = (from: number, to: number): { available: bigint; reserved: bigint; settled: bigint } => {
    const d = { available: 0n, reserved: 0n, settled: 0n };
    for (const e of doc.trace) {
      if (e.seq <= from || e.seq > to || typeof e.facts.amountMinor !== 'string' || !/^[0-9]+$/.test(e.facts.amountMinor)) continue;
      const amount = BigInt(e.facts.amountMinor);
      if (e.type === 'funds_reserved') {
        d.available -= amount;
        d.reserved += amount;
      }
      if (e.type === 'funds_settled') {
        d.reserved -= amount;
        d.settled += amount;
      }
      if (e.type === 'funds_released') {
        d.reserved -= amount;
        d.available += amount;
      }
    }
    return d;
  };
  const upToAnchor = delta(0, anchor.afterSeq);
  const upToPosition = delta(0, position);
  return {
    asset: anchor.balances.asset,
    available: BigInt(anchor.balances.availableMinor) - upToAnchor.available + upToPosition.available,
    reserved: BigInt(anchor.balances.reservedMinor) - upToAnchor.reserved + upToPosition.reserved,
    settled: BigInt(anchor.balances.runClearingMinor) - upToAnchor.settled + upToPosition.settled,
  };
}

export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${digits.slice(-2)}`;
}
