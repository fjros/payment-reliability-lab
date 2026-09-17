import type { Logger } from './logger.ts';

/** Runs `close` once on SIGINT/SIGTERM, then exits. */
export function onShutdown(logger: Logger, close: () => Promise<void>): void {
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      logger.info('shutting down', { signal });
      close().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('shutdown failed', { error });
          process.exit(1);
        },
      );
    });
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}
