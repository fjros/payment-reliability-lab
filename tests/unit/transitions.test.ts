import { describe, expect, it } from 'vitest';
import { decideOnEvidence, isTerminal, TRANSFER_STATES, type ProviderEvidence, type TransferState } from '../../src/domain/transitions.ts';

const ev = (status: string, extra: Partial<ProviderEvidence> = {}): ProviderEvidence => ({
  status,
  finalNoEffect: status === 'rejected',
  sequence: null,
  ...extra,
});

describe('decideOnEvidence', () => {
  it('settles from every nonterminal state after submission began', () => {
    for (const state of ['submitting', 'provider_pending', 'outcome_unknown'] as const) {
      expect(decideOnEvidence(state, null, ev('completed'))).toMatchObject({ action: 'transition', to: 'settled', journal: 'settle' });
    }
  });

  it('releases only on an explicit no-effect final rejection', () => {
    expect(decideOnEvidence('outcome_unknown', null, ev('rejected'))).toMatchObject({ to: 'rejected', journal: 'release' });
    expect(decideOnEvidence('outcome_unknown', null, ev('rejected', { finalNoEffect: false }))).toEqual({
      action: 'exception',
      decision: 'rejection_without_no_effect_guarantee',
    });
  });

  it('treats duplicates and stale pending evidence as no-ops on terminal states', () => {
    expect(decideOnEvidence('settled', 2, ev('completed', { sequence: 2 }))).toEqual({ action: 'ignore', decision: 'duplicate_outcome' });
    expect(decideOnEvidence('settled', 2, ev('pending', { sequence: 1 }))).toEqual({ action: 'ignore', decision: 'stale_observation' });
    expect(decideOnEvidence('rejected', 2, ev('rejected'))).toEqual({ action: 'ignore', decision: 'duplicate_outcome' });
  });

  it('turns contradictory terminal evidence into an exception, never a correction', () => {
    expect(decideOnEvidence('settled', 2, ev('rejected'))).toEqual({ action: 'exception', decision: 'contradictory_terminal' });
    expect(decideOnEvidence('rejected', 2, ev('completed'))).toEqual({ action: 'exception', decision: 'contradictory_terminal' });
  });

  it('gives unknown enum values no evidential weight', () => {
    expect(decideOnEvidence('outcome_unknown', null, ev('reversed'))).toEqual({ action: 'ignore', decision: 'unrecognized_status' });
  });

  it('flags provider evidence for a transfer whose submission never began', () => {
    expect(decideOnEvidence('reserved', null, ev('completed'))).toEqual({ action: 'exception', decision: 'evidence_before_submission' });
  });

  it('invariant: for ANY evidence sequence, terminal states never regress and at most one journal effect is decided', () => {
    // Deterministic generator (LCG) so failures are reproducible.
    let seed = 20260917;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const statuses = ['pending', 'completed', 'rejected', 'weird'];
    for (let run = 0; run < 2000; run += 1) {
      let state: TransferState = (['submitting', 'provider_pending', 'outcome_unknown'] as const)[rand(3)]!;
      let lastSequence: number | null = null;
      let effects = 0;
      let terminal: TransferState | null = null;
      for (let step = 0; step < 12; step += 1) {
        const evidence = ev(statuses[rand(4)]!, { sequence: rand(2) ? rand(4) : null, finalNoEffect: rand(4) !== 0 });
        const decision = decideOnEvidence(state, lastSequence, evidence);
        if (decision.action === 'transition') {
          expect(isTerminal(state)).toBe(false);
          if (decision.journal) effects += 1;
          state = decision.to;
          if (evidence.sequence !== null) lastSequence = Math.max(lastSequence ?? 0, evidence.sequence);
        }
        if (terminal) expect(state).toBe(terminal);
        if (isTerminal(state)) terminal = state;
      }
      expect(effects).toBeLessThanOrEqual(1);
      expect(TRANSFER_STATES).toContain(state);
    }
  });
});
