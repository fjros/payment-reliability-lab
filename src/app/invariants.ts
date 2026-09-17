import type { Queryable } from '../db/pool.ts';
import { economicFingerprint } from '../domain/fingerprint.ts';
import { availableAccount, CLEARING_ACCOUNT, FUNDING_ACCOUNT, reservedAccount } from '../domain/journal.ts';

/**
 * Executable invariants I1-I8 (docs/DOMAIN.md) for one transfer. Observational only: reads the
 * `readmodel` views, never calls the provider, never resolves anything. Every check runs
 * server-side over the complete history, so a paginated trace cannot distort the verdict.
 *
 * `unknown` is a first-class answer: the application cannot count external effects it cannot
 * query, and must say so instead of reporting `pass`.
 */
export type InvariantStatus = 'pass' | 'fail' | 'unknown';

export interface InvariantPart {
  id: string;
  status: InvariantStatus;
  explanation: string;
}

export interface InvariantResult {
  id: 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8';
  title: string;
  status: InvariantStatus;
  explanation: string;
  evidenceIds: string[];
  parts?: InvariantPart[];
}

export interface InvariantReport {
  transferId: string;
  transferState: string;
  observedAt: string;
  results: InvariantResult[];
  summary: { pass: number; fail: number; unknown: number };
  /** An unresolved external outcome is a valid state, not a violation. */
  unresolvedExternalOutcome: boolean;
}

const worst = (statuses: InvariantStatus[]): InvariantStatus =>
  statuses.includes('fail') ? 'fail' : statuses.includes('unknown') ? 'unknown' : 'pass';

export async function checkInvariants(q: Queryable, transferId: string, now: Date): Promise<InvariantReport | null> {
  const found = await q.query<{
    transfer_id: string;
    run_id: string;
    account_id: string;
    asset: string;
    amount_minor: string;
    destination: string;
    state: string;
    provider_reference: string;
  }>(
    'SELECT transfer_id, run_id, account_id, asset, amount_minor, destination, state, provider_reference FROM readmodel.transfers WHERE transfer_id = $1',
    [transferId],
  );
  const t = found.rows[0];
  if (!t) return null;

  const batches = (
    await q.query<{ batch_id: string; phase: string; total: string }>(
      `SELECT b.batch_id, b.phase, coalesce(sum(p.amount_minor), 0)::text AS total
       FROM readmodel.journal_batches b LEFT JOIN readmodel.journal_postings p USING (batch_id)
      WHERE b.transfer_id = $1 GROUP BY b.batch_id, b.phase ORDER BY b.batch_id`,
      [transferId],
    )
  ).rows;
  const byPhase = (phase: string) => batches.filter((b) => b.phase === phase);
  const batchIds = batches.map((b) => b.batch_id);

  const events = (
    await q.query<{ type: string; ids: string[] }>(
      `SELECT type, array_agg(event_id ORDER BY seq) AS ids FROM readmodel.trace_events
      WHERE transfer_id = $1 AND type IN ('request_accepted', 'request_replayed', 'idempotency_conflict_rejected', 'outcome_unknown')
      GROUP BY type`,
      [transferId],
    )
  ).rows;
  const eventIds = (type: string): string[] => events.find((e) => e.type === type)?.ids ?? [];

  // ---- I1 identity ------------------------------------------------------------------------
  const keys = (
    await q.query<{ fingerprint: string; idem_key: string }>(
      'SELECT fingerprint, idem_key FROM readmodel.idempotency_keys WHERE transfer_id = $1',
      [transferId],
    )
  ).rows;
  const expectedPrint = economicFingerprint({ asset: t.asset, amountMinor: BigInt(t.amount_minor), destination: t.destination });
  const i1ok = keys.length === 1 && keys[0]!.fingerprint === expectedPrint && eventIds('request_accepted').length === 1;
  const i1: InvariantResult = {
    id: 'I1',
    title: 'Identity: one accepted logical transfer per scoped idempotency key and payload',
    status: i1ok ? 'pass' : 'fail',
    explanation: i1ok
      ? `One idempotency record maps to this transfer and its stored fingerprint matches the transfer's asset, amount and destination. ` +
        `${eventIds('request_replayed').length} replayed request(s) and ${eventIds('idempotency_conflict_rejected').length} conflicting request(s) were answered without creating another transfer.`
      : `Expected exactly one idempotency record with a matching fingerprint and one acceptance event; found ${keys.length} record(s) and ${eventIds('request_accepted').length} acceptance event(s).`,
    evidenceIds: [...eventIds('request_accepted'), ...eventIds('request_replayed'), ...eventIds('idempotency_conflict_rejected')],
  };

  // ---- I2 conservation --------------------------------------------------------------------
  const unbalanced = batches.filter((b) => b.total !== '0');
  const ledgers = [availableAccount(t.account_id), reservedAccount(t.account_id), CLEARING_ACCOUNT, FUNDING_ACCOUNT];
  const drift = (
    await q.query<{ ledger_account: string; balance_minor: string; total_minor: string }>(
      `SELECT b.ledger_account, b.balance_minor::text, coalesce(j.total_minor, 0)::text AS total_minor
       FROM readmodel.account_balances b
       LEFT JOIN readmodel.journal_account_totals j USING (run_id, ledger_account, asset)
      WHERE b.run_id = $1 AND b.ledger_account = ANY($2) AND b.balance_minor <> coalesce(j.total_minor, 0)`,
      [t.run_id, ledgers],
    )
  ).rows;
  const i2ok = unbalanced.length === 0 && drift.length === 0;
  const i2: InvariantResult = {
    id: 'I2',
    title: 'Conservation: every journal batch balances and projections equal journal totals',
    status: i2ok ? 'pass' : 'fail',
    explanation: i2ok
      ? `${batches.length} posting batch(es) each sum to zero in ${t.asset}; projected balances equal journal totals for the accounts this transfer touches.`
      : `Unbalanced batches: [${unbalanced.map((b) => b.batch_id).join(', ')}]; projection drift on: [${drift.map((d) => `${d.ledger_account} projected ${d.balance_minor} vs journal ${d.total_minor}`).join('; ')}].`,
    evidenceIds: batchIds,
  };

  // ---- I3 effects -------------------------------------------------------------------------
  const reserves = byPhase('reserve').length;
  const settles = byPhase('settle').length;
  const releases = byPhase('release').length;
  const i3ok = reserves === 1 && settles + releases <= 1;
  const i3: InvariantResult = {
    id: 'I3',
    title: 'Effects: one reservation, at most one terminal effect, settle and release mutually exclusive',
    status: i3ok ? 'pass' : 'fail',
    explanation: `Journal shows ${reserves} reservation, ${settles} settlement and ${releases} release batch(es) for this transfer.`,
    evidenceIds: batchIds,
  };

  // ---- I4 availability --------------------------------------------------------------------
  const userLedgers = [availableAccount(t.account_id), reservedAccount(t.account_id)];
  const negatives = (
    await q.query<{ ledger_account: string; projected: string; journal: string }>(
      `SELECT b.ledger_account, b.balance_minor::text AS projected, coalesce(j.total_minor, 0)::text AS journal
       FROM readmodel.account_balances b
       LEFT JOIN readmodel.journal_account_totals j USING (run_id, ledger_account, asset)
      WHERE b.run_id = $1 AND b.ledger_account = ANY($2) AND (b.balance_minor < 0 OR coalesce(j.total_minor, 0) < 0)`,
      [t.run_id, userLedgers],
    )
  ).rows;
  const i4: InvariantResult = {
    id: 'I4',
    title: 'Availability: accepted transfers cannot overdraw available or reserved funds',
    status: negatives.length === 0 ? 'pass' : 'fail',
    explanation:
      negatives.length === 0
        ? 'Available and reserved balances are nonnegative in both the projection and the journal.'
        : `Negative balances: ${negatives.map((n) => `${n.ledger_account} (projected ${n.projected}, journal ${n.journal})`).join('; ')}.`,
    evidenceIds: [],
  };

  // ---- I5 state ---------------------------------------------------------------------------
  const regressions = (
    await q.query<{ event_id: string }>(
      `SELECT e.event_id FROM readmodel.trace_events e
      WHERE e.transfer_id = $1 AND e.type = 'state_changed'
        AND EXISTS (SELECT 1 FROM readmodel.trace_events prior
                     WHERE prior.transfer_id = e.transfer_id AND prior.type = 'state_changed'
                       AND prior.seq < e.seq AND prior.facts->>'to' IN ('settled', 'rejected'))`,
      [transferId],
    )
  ).rows;
  const stateAgrees = (t.state === 'settled') === (settles === 1) && (t.state === 'rejected') === (releases === 1);
  const i5ok = stateAgrees && regressions.length === 0;
  const i5: InvariantResult = {
    id: 'I5',
    title: 'State: terminal states never regress and agree with journal postings',
    status: i5ok ? 'pass' : 'fail',
    explanation: i5ok
      ? `State "${t.state}" agrees with the journal (${settles} settlement, ${releases} release) and no state change follows a terminal state.`
      : `State "${t.state}" vs journal (${settles} settlement, ${releases} release); state changes after a terminal state: [${regressions.map((r) => r.event_id).join(', ')}].`,
    evidenceIds: [...byPhase('settle'), ...byPhase('release')].map((b) => b.batch_id).concat(regressions.map((r) => r.event_id)),
  };

  // ---- I6 external identity ---------------------------------------------------------------
  const attempts = (
    await q.query<{ attempt_id: string; kind: string; provider_reference: string; outcome: string | null }>(
      'SELECT attempt_id, kind, provider_reference, outcome FROM readmodel.provider_attempts WHERE transfer_id = $1 ORDER BY attempt_no',
      [transferId],
    )
  ).rows;
  const foreignRefs = attempts.filter((a) => a.provider_reference !== t.provider_reference);
  const submits = attempts.filter((a) => a.kind === 'submit');
  const localPart: InvariantPart = {
    id: 'I6.local',
    status: foreignRefs.length === 0 ? 'pass' : 'fail',
    explanation:
      foreignRefs.length === 0
        ? `All ${attempts.length} provider call(s) (${submits.length} submission(s)) used the single provider reference ${t.provider_reference}.`
        : `Attempts used other references: [${foreignRefs.map((a) => `${a.attempt_id}:${a.provider_reference}`).join(', ')}].`,
  };
  const externalPart: InvariantPart =
    submits.length === 0
      ? { id: 'I6.external', status: 'pass', explanation: 'No submission was ever sent, so no external effect can exist.' }
      : {
          id: 'I6.external',
          status: 'unknown',
          explanation:
            "The application cannot count effects inside the provider. At-most-one effect per reference relies on the provider's idempotency contract; only the simulator test oracle can prove it.",
        };
  const i6: InvariantResult = {
    id: 'I6',
    title: 'External identity: one provider reference for all attempts; at most one external effect per reference',
    status: worst([localPart.status, externalPart.status]),
    explanation: `${localPart.explanation} ${externalPart.explanation}`,
    evidenceIds: attempts.map((a) => a.attempt_id),
    parts: [localPart, externalPart],
  };

  // ---- I7 uncertainty ---------------------------------------------------------------------
  const inconclusive = attempts.filter(
    (a) => a.outcome !== null && ['response_lost', 'timeout', 'http_error', 'not_found', 'inconclusive'].includes(a.outcome),
  );
  const releasingEvidence = (
    await q.query<{ observation_id: string }>(
      `SELECT observation_id FROM readmodel.provider_observations
      WHERE transfer_id = $1 AND status = 'rejected' AND final_no_effect AND decision = 'released'`,
      [transferId],
    )
  ).rows;
  const releasedWithoutProof = releases > 0 && releasingEvidence.length === 0;
  const unresolved = t.state === 'outcome_unknown';
  const holdsReservation = !unresolved || (reserves === 1 && settles + releases === 0);
  const i7ok = !releasedWithoutProof && holdsReservation;
  const i7: InvariantResult = {
    id: 'I7',
    title: 'Uncertainty: timeouts never imply rejection or release; incomplete evidence stays unresolved',
    status: i7ok ? 'pass' : 'fail',
    explanation: !i7ok
      ? releasedWithoutProof
        ? 'Funds were released without a recorded final no-effect rejection.'
        : 'Outcome is unknown but the reservation is no longer intact.'
      : unresolved
        ? `${inconclusive.length} inconclusive provider call(s) recorded. The outcome is explicitly UNKNOWN: funds remain reserved and nothing was released. This is a valid unresolved state, not a failure.`
        : releases > 0
          ? 'The release is backed by an explicit final rejection that guarantees no external effect.'
          : `${inconclusive.length} inconclusive provider call(s) recorded; none led to a release.`,
    evidenceIds: [
      ...inconclusive.map((a) => a.attempt_id),
      ...releasingEvidence.map((o) => o.observation_id),
      ...eventIds('outcome_unknown'),
    ],
  };

  // ---- I8 traceability --------------------------------------------------------------------
  const shape = (
    await q.query<{ n: number; lo: number | null; hi: number | null }>(
      'SELECT count(*)::int AS n, min(seq) AS lo, max(seq) AS hi FROM readmodel.trace_events WHERE transfer_id = $1',
      [transferId],
    )
  ).rows[0]!;
  const danglingCauses = (
    await q.query<{ event_id: string }>(
      `SELECT e.event_id FROM readmodel.trace_events e
      WHERE e.transfer_id = $1 AND e.causation_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM readmodel.trace_events c
                         WHERE c.event_id = e.causation_id AND c.transfer_id = e.transfer_id AND c.seq < e.seq)`,
      [transferId],
    )
  ).rows;
  const untracedBatches = (
    await q.query<{ id: string }>(
      `SELECT b.batch_id AS id FROM readmodel.journal_batches b
      WHERE b.transfer_id = $1 AND NOT EXISTS (SELECT 1 FROM readmodel.trace_events e
                                                WHERE e.transfer_id = $1 AND e.facts->>'batchId' = b.batch_id)`,
      [transferId],
    )
  ).rows;
  const untracedAttempts = (
    await q.query<{ id: string }>(
      `SELECT a.attempt_id AS id FROM readmodel.provider_attempts a
      WHERE a.transfer_id = $1 AND NOT EXISTS (SELECT 1 FROM readmodel.trace_events e
                                                WHERE e.transfer_id = $1 AND e.facts->>'attemptId' = a.attempt_id)`,
      [transferId],
    )
  ).rows;
  const contiguous = shape.n > 0 && shape.lo === 1 && shape.hi === shape.n;
  const i8ok =
    contiguous &&
    danglingCauses.length === 0 &&
    untracedBatches.length === 0 &&
    untracedAttempts.length === 0 &&
    eventIds('request_accepted').length === 1;
  const i8: InvariantResult = {
    id: 'I8',
    title: 'Traceability: requests, attempts, observations and transitions have stable linked evidence IDs',
    status: i8ok ? 'pass' : 'fail',
    explanation: i8ok
      ? `${shape.n} trace events form a gap-free sequence; every journal batch and provider call is referenced by a trace event and every causation link resolves to an earlier event.`
      : `Sequence contiguous: ${contiguous}; dangling causation: [${danglingCauses.map((d) => d.event_id).join(', ')}]; untraced batches: [${untracedBatches.map((b) => b.id).join(', ')}]; untraced attempts: [${untracedAttempts.map((a) => a.id).join(', ')}].`,
    evidenceIds: [...danglingCauses.map((d) => d.event_id), ...untracedBatches.map((b) => b.id), ...untracedAttempts.map((a) => a.id)],
  };

  const results = [i1, i2, i3, i4, i5, i6, i7, i8];
  return {
    transferId,
    transferState: t.state,
    observedAt: now.toISOString(),
    results,
    summary: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      unknown: results.filter((r) => r.status === 'unknown').length,
    },
    unresolvedExternalOutcome: unresolved,
  };
}
