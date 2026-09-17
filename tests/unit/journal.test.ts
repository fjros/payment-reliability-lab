import { describe, expect, it } from 'vitest';
import { batchTotals, isBalanced, postingsFor, type JournalPhase } from '../../src/domain/journal.ts';

const phases: JournalPhase[] = ['seed', 'reserve', 'settle', 'release'];

describe('journal posting rules', () => {
  it.each(phases)('%s batches sum to zero for any positive amount', (phase) => {
    for (const amount of [1n, 1250n, 10n ** 12n]) {
      const postings = postingsFor(phase, 'A', amount);
      expect(isBalanced(postings)).toBe(true);
      expect([...batchTotals(postings).values()]).toEqual([0n]);
    }
  });

  it('reserve then settle moves funds available -> reserved -> clearing', () => {
    const net = new Map<string, bigint>();
    for (const phase of ['seed', 'reserve', 'settle'] as const) {
      for (const p of postingsFor(phase, 'A', phase === 'seed' ? 100000n : 1250n)) {
        net.set(p.ledgerAccount, (net.get(p.ledgerAccount) ?? 0n) + p.amountMinor);
      }
    }
    expect(Object.fromEntries(net)).toEqual({
      'user:A:available': 98750n,
      'demo:funding': -100000n,
      'user:A:reserved': 0n,
      'provider:clearing': 1250n,
    });
  });

  it('reserve then release restores available funds exactly', () => {
    const net = new Map<string, bigint>();
    for (const phase of ['reserve', 'release'] as const) {
      for (const p of postingsFor(phase, 'A', 777n)) net.set(p.ledgerAccount, (net.get(p.ledgerAccount) ?? 0n) + p.amountMinor);
    }
    expect([...net.values()]).toEqual([0n, 0n]);
  });

  it('refuses non-positive amounts', () => {
    expect(() => postingsFor('reserve', 'A', 0n)).toThrow();
    expect(() => postingsFor('reserve', 'A', -1n)).toThrow();
  });
});
