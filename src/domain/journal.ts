import { ASSET } from './amount.ts';

/** Educational signed-posting model. Positive adds to an account, negative removes from it. */
export type JournalPhase = 'seed' | 'reserve' | 'settle' | 'release';

export interface Posting {
  ledgerAccount: string;
  asset: string;
  amountMinor: bigint;
}

export const FUNDING_ACCOUNT = 'demo:funding';
export const CLEARING_ACCOUNT = 'provider:clearing';
export const availableAccount = (accountId: string): string => `user:${accountId}:available`;
export const reservedAccount = (accountId: string): string => `user:${accountId}:reserved`;

/** User sub-accounts must never go negative; funding and clearing intentionally can. */
export function mustBeNonNegative(ledgerAccount: string): boolean {
  return ledgerAccount.startsWith('user:');
}

export function postingsFor(phase: JournalPhase, accountId: string, amountMinor: bigint): Posting[] {
  if (amountMinor <= 0n) throw new Error('journal amounts must be positive');
  const p = (ledgerAccount: string, signed: bigint): Posting => ({ ledgerAccount, asset: ASSET, amountMinor: signed });
  switch (phase) {
    case 'seed':
      return [p(availableAccount(accountId), amountMinor), p(FUNDING_ACCOUNT, -amountMinor)];
    case 'reserve':
      return [p(availableAccount(accountId), -amountMinor), p(reservedAccount(accountId), amountMinor)];
    case 'settle':
      return [p(reservedAccount(accountId), -amountMinor), p(CLEARING_ACCOUNT, amountMinor)];
    case 'release':
      return [p(reservedAccount(accountId), -amountMinor), p(availableAccount(accountId), amountMinor)];
  }
}

/** Sum per asset; a balanced batch returns only zeros. */
export function batchTotals(postings: readonly Posting[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const posting of postings) totals.set(posting.asset, (totals.get(posting.asset) ?? 0n) + posting.amountMinor);
  return totals;
}

export function isBalanced(postings: readonly Posting[]): boolean {
  return postings.length > 0 && [...batchTotals(postings).values()].every((total) => total === 0n);
}
