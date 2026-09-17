/**
 * Minimal structured logger. Always writes to stderr so stdout stays clean for the MCP stdio
 * protocol. Secret-looking fields are redacted by key name.
 */
const REDACTED_KEYS = /secret|password|signature|authorization|token|databaseurl|connectionstring/i;

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.test(key)) out[key] = '[redacted]';
    else if (value instanceof Error) out[key] = { name: value.name, message: value.message };
    else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date))
      out[key] = redact(value as Record<string, unknown>);
    else out[key] = value;
  }
  return out;
}

export function createLogger(component: string, enabled = true): Logger {
  const write = (level: string, message: string, fields?: Record<string, unknown>): void => {
    if (!enabled) return;
    const line = { ts: new Date().toISOString(), level, component, message, ...redact(fields ?? {}) };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent', false);
