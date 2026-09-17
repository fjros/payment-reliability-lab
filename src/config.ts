/**
 * Environment-driven configuration with loopback, obviously-synthetic defaults. The default
 * passwords protect nothing: they exist so a fresh clone can run the local demo. Override them
 * through environment variables (see .env.example); never reuse them anywhere real.
 */
export interface DbTargets {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  adminDatabase: string;
  appDatabase: string;
  providerDatabase: string;
  appPassword: string;
  mcpPassword: string;
  providerPassword: string;
}

export const ROLES = { app: 'prl_app', mcp: 'prl_mcp_ro', provider: 'prl_provider' } as const;

export interface ServiceConfig {
  db: DbTargets;
  apiHost: string;
  apiPort: number;
  providerHost: string;
  providerPort: number;
  webhookSecret: string;
  mcpRunIds: string[];
}

type Env = Record<string, string | undefined>;

function intFrom(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,5}$/.test(raw)) throw new Error(`${name} must be a port-sized integer`);
  return Number(raw);
}

export function loadConfig(env: Env = process.env): ServiceConfig {
  return {
    db: {
      host: env.PRL_PG_HOST ?? '127.0.0.1',
      port: intFrom(env, 'PRL_PG_PORT', 54329),
      adminUser: env.PRL_PG_ADMIN_USER ?? 'postgres',
      adminPassword: env.PRL_PG_ADMIN_PASSWORD ?? 'local-demo-admin',
      adminDatabase: env.PRL_PG_ADMIN_DB ?? 'postgres',
      appDatabase: env.PRL_APP_DB ?? 'prl_demo_app',
      providerDatabase: env.PRL_PROVIDER_DB ?? 'prl_demo_provider',
      appPassword: env.PRL_APP_DB_PASSWORD ?? 'local-demo-app',
      mcpPassword: env.PRL_MCP_DB_PASSWORD ?? 'local-demo-mcp-readonly',
      providerPassword: env.PRL_PROVIDER_DB_PASSWORD ?? 'local-demo-provider',
    },
    apiHost: env.PRL_API_HOST ?? '127.0.0.1',
    apiPort: intFrom(env, 'PRL_API_PORT', 4010),
    providerHost: env.PRL_PROVIDER_HOST ?? '127.0.0.1',
    providerPort: intFrom(env, 'PRL_PROVIDER_PORT', 4020),
    webhookSecret: env.PRL_WEBHOOK_SECRET ?? 'local-demo-webhook-secret-not-for-production',
    mcpRunIds: (env.PRL_MCP_RUN_IDS ?? 'S1-1,S2-1,S3-1,S7-1,S8-1')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

export type DbRole = 'admin' | 'app' | 'mcp' | 'provider';

export function connectionString(db: DbTargets, role: DbRole, database?: string): string {
  const [user, password, defaultDb] =
    role === 'admin'
      ? [db.adminUser, db.adminPassword, db.adminDatabase]
      : role === 'app'
        ? [ROLES.app, db.appPassword, db.appDatabase]
        : role === 'mcp'
          ? [ROLES.mcp, db.mcpPassword, db.appDatabase]
          : [ROLES.provider, db.providerPassword, db.providerDatabase];
  const name = database ?? defaultDb;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${db.host}:${db.port}/${encodeURIComponent(name)}`;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const RESETTABLE_DB = /^prl_(demo|test)_[a-z0-9_]{1,40}$/;

/**
 * Destructive commands (reset, purge, bootstrap) refuse anything that is not an explicitly named
 * local lab database. `allowHost` exists for Testcontainers, whose host may be a Docker gateway.
 */
export function assertResettableTarget(db: DbTargets, allowHost?: string): void {
  if (!LOOPBACK_HOSTS.has(db.host) && db.host !== allowHost) {
    throw new Error(`Refusing destructive database operation on non-loopback host "${db.host}".`);
  }
  for (const name of [db.appDatabase, db.providerDatabase]) {
    if (!RESETTABLE_DB.test(name)) {
      throw new Error(`Refusing destructive database operation on "${name}": name must match ${RESETTABLE_DB}.`);
    }
  }
}
