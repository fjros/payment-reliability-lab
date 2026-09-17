import { describe, expect, it } from 'vitest';
import { formatMinorForDisplay, parseAmountMinor, serializeMinor } from '../../src/domain/amount.ts';

describe('parseAmountMinor', () => {
  it('accepts positive integer minor-unit strings exactly', () => {
    expect(parseAmountMinor('1')).toEqual({ ok: true, minor: 1n });
    expect(parseAmountMinor('1250')).toEqual({ ok: true, minor: 1250n });
    expect(parseAmountMinor('1000000000000')).toEqual({ ok: true, minor: 10n ** 12n });
  });

  it('keeps values above Number.MAX_SAFE_INTEGER digits exact on the way out', () => {
    expect(serializeMinor(9007199254740993n)).toBe('9007199254740993');
  });

  it.each([
    ['0'],
    ['-5'],
    ['+5'],
    ['012'],
    ['12.5'],
    ['12.50'],
    ['1e3'],
    ['1E3'],
    [' 12'],
    ['12 '],
    [''],
    ['١٢'],
    ['0x10'],
    ['1_000'],
    ['1,000'],
    ['NaN'],
    ['Infinity'],
  ])('rejects malformed input %j', (input) => {
    expect(parseAmountMinor(input)).toEqual({ ok: false, error: 'malformed' });
  });

  it.each([[1250], [12.5], [null], [undefined], [{}], [['1']], [1250n], [true]])('rejects non-string input %s', (input) => {
    expect(parseAmountMinor(input)).toEqual({ ok: false, error: 'not_a_string' });
  });

  it('rejects overflow beyond 10^12 without going through number', () => {
    expect(parseAmountMinor('1000000000001')).toEqual({ ok: false, error: 'exceeds_maximum' });
    expect(parseAmountMinor('9'.repeat(400))).toEqual({ ok: false, error: 'exceeds_maximum' });
  });

  it('formats for display without floating point', () => {
    expect(formatMinorForDisplay(1250n)).toBe('12.50');
    expect(formatMinorForDisplay(5n)).toBe('0.05');
    expect(formatMinorForDisplay(-100000n)).toBe('-1000.00');
  });
});
