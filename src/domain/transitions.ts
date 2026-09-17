/** Transfer state machine. Pure: no HTTP, no database. See docs/DOMAIN.md for the table. */
export const TRANSFER_STATES = ['reserved', 'submitting', 'provider_pending', 'outcome_unknown', 'settled', 'rejected'] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export const PROVIDER_STATUSES = ['pending', 'completed', 'rejected'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export function isTerminal(state: TransferState): boolean {
  return state === 'settled' || state === 'rejected';
}

export function isProviderStatus(value: string): value is ProviderStatus {
  return (PROVIDER_STATUSES as readonly string[]).includes(value);
}

/** Provider evidence as the application observed it, whatever channel delivered it. */
export interface ProviderEvidence {
  /** Raw status string; unknown enum values are tolerated and carry no evidential weight. */
  status: string;
  /** True only when the provider explicitly guarantees a final rejection had no external effect. */
  finalNoEffect: boolean;
  /** Provider-side ordering, when supplied. Arrival order is a different thing. */
  sequence: number | null;
}

export type JournalEffect = 'settle' | 'release';

export type EvidenceDecision =
  | { action: 'transition'; to: TransferState; journal: JournalEffect | null; decision: string }
  | { action: 'ignore'; decision: 'duplicate_outcome' | 'stale_observation' | 'no_change' | 'unrecognized_status' }
  | {
      action: 'exception';
      decision: 'contradictory_terminal' | 'evidence_before_submission' | 'rejection_without_no_effect_guarantee';
    };

/**
 * Decides what one piece of provider evidence means for a transfer in `state`.
 * - completion settles once from any nonterminal state after submission began;
 * - only an explicit no-effect final rejection releases the reservation;
 * - duplicates and older observations never change a terminal state;
 * - contradictions become exceptions, never automatic corrections.
 */
export function decideOnEvidence(state: TransferState, lastSequence: number | null, evidence: ProviderEvidence): EvidenceDecision {
  if (!isProviderStatus(evidence.status)) return { action: 'ignore', decision: 'unrecognized_status' };
  if (state === 'reserved') return { action: 'exception', decision: 'evidence_before_submission' };

  switch (evidence.status) {
    case 'completed':
      if (state === 'settled') return { action: 'ignore', decision: 'duplicate_outcome' };
      if (state === 'rejected') return { action: 'exception', decision: 'contradictory_terminal' };
      return { action: 'transition', to: 'settled', journal: 'settle', decision: 'settled' };
    case 'rejected':
      if (state === 'rejected') return { action: 'ignore', decision: 'duplicate_outcome' };
      if (state === 'settled') return { action: 'exception', decision: 'contradictory_terminal' };
      if (!evidence.finalNoEffect) return { action: 'exception', decision: 'rejection_without_no_effect_guarantee' };
      return { action: 'transition', to: 'rejected', journal: 'release', decision: 'released' };
    case 'pending':
      if (isTerminal(state)) return { action: 'ignore', decision: 'stale_observation' };
      if (evidence.sequence !== null && lastSequence !== null && evidence.sequence < lastSequence) {
        return { action: 'ignore', decision: 'stale_observation' };
      }
      if (state === 'provider_pending') return { action: 'ignore', decision: 'no_change' };
      return { action: 'transition', to: 'provider_pending', journal: null, decision: 'provider_pending' };
  }
}

/** Transitions the worker makes without provider evidence. A timeout never appears here as a release. */
export function canBeginSubmission(state: TransferState): boolean {
  return state === 'reserved';
}

export function canMarkOutcomeUnknown(state: TransferState): boolean {
  return state === 'submitting';
}
