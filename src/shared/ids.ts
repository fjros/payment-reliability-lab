import { createHash, randomUUID } from 'node:crypto';

/**
 * Distinct identities get distinct prefixes so they are never confused in traces:
 * tr (transfer), pref (provider reference), req (HTTP request), ev (trace event), jb (journal
 * batch), jp (posting), job, att (provider attempt), obs (observation), dlv (webhook delivery),
 * exc (exception), evt (provider webhook event).
 */
export interface IdGenerator {
  next(prefix: string): string;
}

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`,
};

/** Seeded, counter-based IDs so a scenario run with the same seed produces comparable traces. */
export function seededIds(seed: string, component = 'main'): IdGenerator {
  let counter = 0;
  return {
    next(prefix) {
      counter += 1;
      const digest = createHash('sha256').update(`${seed}:${component}:${prefix}:${counter}`).digest('hex');
      return `${prefix}_${digest.slice(0, 20)}`;
    },
  };
}

export const ID_PATTERN = /^[a-z]{2,5}_[0-9a-f]{20,32}$/;

export function isWellFormedId(value: string, prefix: string): boolean {
  return ID_PATTERN.test(value) && value.startsWith(`${prefix}_`);
}
