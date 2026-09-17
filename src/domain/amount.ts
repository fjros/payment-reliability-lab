/** Exact money handling for the single synthetic asset. No JavaScript `number` ever holds an amount. */
export const ASSET = 'DEMO_USD';
export const ASSET_SCALE = 2;
export const MAX_TRANSFER_MINOR = 10n ** 12n;

const MINOR_UNITS = /^[1-9][0-9]*$/;

export type AmountError = 'not_a_string' | 'malformed' | 'exceeds_maximum';

export type AmountResult = { ok: true; minor: bigint } | { ok: false; error: AmountError };

/**
 * Accepts only positive integer minor-unit strings. Rejects numbers, fractions, exponents,
 * signs, leading zeros, whitespace and anything above 10^12.
 */
export function parseAmountMinor(input: unknown): AmountResult {
  if (typeof input !== 'string') return { ok: false, error: 'not_a_string' };
  if (!MINOR_UNITS.test(input)) return { ok: false, error: 'malformed' };
  // Length guard before BigInt: 10^12 has 13 digits, so anything longer is out of range.
  if (input.length > 13) return { ok: false, error: 'exceeds_maximum' };
  const minor = BigInt(input);
  if (minor > MAX_TRANSFER_MINOR) return { ok: false, error: 'exceeds_maximum' };
  return { ok: true, minor };
}

export function serializeMinor(minor: bigint): string {
  return minor.toString(10);
}

/** Display helper only (e.g. "12.50"); never parsed back into a business amount. */
export function formatMinorForDisplay(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString(10).padStart(ASSET_SCALE + 1, '0');
  const whole = digits.slice(0, -ASSET_SCALE);
  const fraction = digits.slice(-ASSET_SCALE);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
