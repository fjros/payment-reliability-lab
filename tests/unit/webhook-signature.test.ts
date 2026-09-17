import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../../src/api/webhook-signature.ts';

const secret = 'unit-test-secret';
const body = Buffer.from('{"eventId":"evt_x","status":"completed"}');
const now = new Date('2026-01-01T00:00:00Z');
const t = Math.floor(now.getTime() / 1000);

describe('webhook signature (HMAC over "<t>.<raw body>")', () => {
  it('accepts a fresh, authentic signature', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, t, body), body, now)).toEqual({ ok: true });
  });

  it('rejects a body altered by a single byte, a wrong secret and a truncated MAC', () => {
    const header = signWebhook(secret, t, body);
    expect(verifyWebhookSignature(secret, header, Buffer.from(body.toString().replace('completed', 'completee')), now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature('other', header, body, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyWebhookSignature(secret, header.slice(0, -2), body, now)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('covers the raw bytes: re-serialized JSON with different whitespace does not verify', () => {
    const header = signWebhook(secret, t, body);
    expect(verifyWebhookSignature(secret, header, Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1)), now).ok).toBe(false);
  });

  it('rejects expired and far-future signing times with an injected clock, but only after authenticity', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, t - 301, body), body, now)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyWebhookSignature(secret, signWebhook(secret, t + 301, body), body, now)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyWebhookSignature(secret, signWebhook(secret, t - 299, body), body, now)).toEqual({ ok: true });
    expect(verifyWebhookSignature('other', signWebhook(secret, t - 9999, body), body, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it.each([undefined, '', 'v1=abc', 't=abc,v1=00', `t=${t}`, `t=${t},v1=${'g'.repeat(64)}`])('rejects malformed header %j', (header) => {
    expect(verifyWebhookSignature(secret, header, body, now)).toEqual({ ok: false, reason: 'malformed' });
  });
});
