import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature format (header `X-Provider-Signature`): `t=<unix seconds>,v1=<hex hmac-sha256>`
 * computed over the UTF-8 bytes of `<t>.<raw request body>` with the shared local demo secret.
 * `t` is the transport signing time and is fresh on every redelivery; the business occurrence
 * time lives inside the body and may be much older.
 */
export const SIGNATURE_HEADER = 'x-provider-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, timestampSeconds: number, rawBody: string | Buffer): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'malformed' | 'mismatch' | 'expired' };

export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer,
  now: Date,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): SignatureCheck {
  const match = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return { ok: false, reason: 'malformed' };
  const timestamp = Number(match[1]);
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody).split('v1=')[1]!, 'hex');
  const provided = Buffer.from(match[2]!, 'hex');
  // Constant-time comparison; lengths are equal by construction of the regex.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return { ok: false, reason: 'mismatch' };
  // Freshness is checked only after authenticity so an attacker learns nothing from timing.
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: 'expired' };
  return { ok: true };
}
