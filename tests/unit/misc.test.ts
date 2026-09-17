import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../../src/app/read-models.ts';
import { assertResettableTarget, loadConfig } from '../../src/config.ts';
import { answerFor, type AnswerInputs } from '../../src/scenarios/answers.ts';
import { redact } from '../../src/shared/logger.ts';
import { seededIds } from '../../src/shared/ids.ts';

describe('cursors', () => {
  it('round-trips and rejects forged or mistyped cursors', () => {
    expect(decodeCursor(encodeCursor(42), 'number')).toBe(42);
    expect(decodeCursor(encodeCursor('exc_1'), 'string')).toBe('exc_1');
    for (const bad of [
      '',
      '!!!',
      encodeCursor('x'),
      Buffer.from('{"v":2,"k":1}').toString('base64url'),
      Buffer.from('{"v":1,"k":-1}').toString('base64url'),
      'a'.repeat(300),
    ]) {
      expect(() => decodeCursor(bad, 'number')).toThrow(InvalidCursorError);
    }
  });
});

describe('configuration and safety guards', () => {
  it('defaults to loopback and refuses destructive operations elsewhere', () => {
    const config = loadConfig({});
    expect([config.apiHost, config.providerHost, config.db.host]).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1']);
    expect(() => assertResettableTarget(config.db)).not.toThrow();
    expect(() => assertResettableTarget(loadConfig({ PRL_PG_HOST: '10.0.0.5' }).db)).toThrow(/non-loopback/);
    expect(() => assertResettableTarget(loadConfig({ PRL_APP_DB: 'production' }).db)).toThrow(/Refusing/);
    expect(() => loadConfig({ PRL_API_PORT: '80; rm -rf' })).toThrow();
  });

  it('redacts secret-looking log fields, including nested ones', () => {
    expect(redact({ webhookSecret: 's', nested: { password: 'p', signature: 'x', ok: 1 }, url: 'u' })).toEqual({
      webhookSecret: '[redacted]',
      nested: { password: '[redacted]', signature: '[redacted]', ok: 1 },
      url: 'u',
    });
  });

  it('seeded IDs are reproducible and distinct per prefix and seed', () => {
    const a = seededIds('s');
    const b = seededIds('s');
    const c = seededIds('other');
    const first = a.next('tr');
    expect(b.next('tr')).toBe(first);
    expect(c.next('tr')).not.toBe(first);
    expect(a.next('tr')).not.toBe(first);
    expect(first).toMatch(/^tr_[0-9a-f]{20}$/);
  });
});

describe('answers are shown only when evidence supports them', () => {
  const base: AnswerInputs = {
    state: 'settled',
    requestEvents: 3,
    webhookDeliveries: 0,
    webhookEvents: 0,
    journalPhases: ['reserve', 'settle'],
    settlingObservationId: 'obs_1',
    exceptionReasons: [],
    exceptionEvidenceIds: [],
    unknownEvidenceIds: [],
    invariants: ['I1', 'I2', 'I3', 'I4', 'I5', 'I7', 'I8'].map((id) => ({ id, status: 'pass', evidenceIds: [`ev_${id}`] })),
  };
  it('withholds the S1 answer when a supporting invariant fails', () => {
    expect(answerFor('S1', base).verdict).toBe('no');
    const failing = { ...base, invariants: base.invariants.map((r) => (r.id === 'I3' ? { ...r, status: 'fail' } : r)) };
    expect(answerFor('S1', failing).verdict).toBe('unsupported');
  });
  it('never turns an unknown outcome into yes or no', () => {
    expect(answerFor('S3', { ...base, state: 'outcome_unknown', journalPhases: ['reserve'], settlingObservationId: null }).verdict).toBe(
      'not_yet_known',
    );
    expect(answerFor('S3', { ...base, settlingObservationId: null }).verdict).toBe('unsupported'); // settled but no observation to cite
  });
});
