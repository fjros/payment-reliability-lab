import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { TestDatabases } from './databases.ts';
import { TEST_WEBHOOK_SECRET } from './api.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface Child {
  process: ChildProcess;
  /** Resolves with the `url` field of the first JSON log line whose message matches. */
  waitForLog(message: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
  kill(): Promise<void>;
}

export function dbEnv(dbs: TestDatabases): Record<string, string> {
  const t = dbs.targets;
  return {
    PRL_PG_HOST: t.host,
    PRL_PG_PORT: String(t.port),
    PRL_APP_DB: t.appDatabase,
    PRL_PROVIDER_DB: t.providerDatabase,
    PRL_APP_DB_PASSWORD: t.appPassword,
    PRL_MCP_DB_PASSWORD: t.mcpPassword,
    PRL_PROVIDER_DB_PASSWORD: t.providerPassword,
    PRL_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  };
}

/** Spawns a real Node process running a TypeScript entry (native type stripping). */
export function spawnNode(entry: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<{ message: string; resolve: (line: Record<string, unknown>) => void }> = [];
  let buffer = '';
  let raw = '';
  child.stderr.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const line = JSON.parse(text) as Record<string, unknown>;
        lines.push(line);
        for (const waiter of waiters.filter((w) => w.message === line.message)) waiter.resolve(line);
      } catch {
        // non-JSON diagnostics are kept in `raw` for error messages
      }
    }
  });
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  return {
    process: child,
    exited,
    waitForLog(message, timeoutMs = 15_000) {
      const seen = lines.find((l) => l.message === message);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for log "${message}" from ${entry}. stderr:\n${raw}`)),
          timeoutMs,
        );
        waiters.push({
          message,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
        void exited.then((code) => {
          clearTimeout(timer);
          reject(new Error(`${entry} exited with ${code} before logging "${message}". stderr:\n${raw}`));
        });
      });
    },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

/** Bounded wait on an observable condition (never a bare sleep as the synchronization). */
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}
