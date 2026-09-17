import { describe, expect, it } from 'vitest';
import { economicFingerprint } from '../../src/domain/fingerprint.ts';

const base = { asset: 'DEMO_USD', amountMinor: 1250n, destination: 'demo:merchant-1' };

describe('economicFingerprint', () => {
  it('is stable for the same economic request regardless of property order or extra fields', () => {
    const reordered = { destination: 'demo:merchant-1', note: 'ignored', amountMinor: 1250n, asset: 'DEMO_USD' };
    expect(economicFingerprint(reordered)).toBe(economicFingerprint(base));
  });

  it('changes when any economic field changes', () => {
    const prints = new Set([
      economicFingerprint(base),
      economicFingerprint({ ...base, amountMinor: 1251n }),
      economicFingerprint({ ...base, destination: 'demo:merchant-2' }),
      economicFingerprint({ ...base, asset: 'OTHER' }),
    ]);
    expect(prints.size).toBe(4);
  });

  it('does not confuse field boundaries', () => {
    expect(economicFingerprint({ asset: 'A', amountMinor: 11n, destination: '1' })).not.toBe(
      economicFingerprint({ asset: 'A', amountMinor: 1n, destination: '11' }),
    );
  });
});
