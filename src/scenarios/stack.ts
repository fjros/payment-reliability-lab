import type { FastifyInstance } from 'fastify';
import { buildApi } from '../api/server.ts';
import type { AppDeps } from '../app/deps.ts';
import type { Pool } from '../db/pool.ts';
import { SimulatorControl } from '../provider-sim/control.ts';
import { buildProviderSim } from '../provider-sim/server.ts';
import type { Clock } from '../shared/clock.ts';
import type { IdGenerator } from '../shared/ids.ts';
import { silentLogger, type Logger } from '../shared/logger.ts';
import { ProviderClient } from '../worker/provider-client.ts';
import { Worker } from '../worker/worker.ts';
import { ScriptedCheckpoints } from './scripted-checkpoints.ts';

export interface StackOptions {
  appPool: Pool;
  providerPool: Pool;
  clock: Clock;
  ids: IdGenerator;
  webhookSecret: string;
  providerTimeoutMs?: number;
  logger?: Logger;
}

/**
 * The whole lab wired together in one process for deterministic scenarios: the API and the
 * provider simulator are real HTTP servers on ephemeral loopback ports, PostgreSQL is real, and
 * workers are stepped explicitly instead of racing timers. "Restart" closes a component and
 * rebuilds it from nothing but the database, which is what a process restart preserves.
 * (Separate tests kill real child processes; see tests/integration/process-crash.test.ts.)
 */
export class Stack {
  readonly options: StackOptions;
  readonly checkpoints = new ScriptedCheckpoints();
  readonly deps: AppDeps;
  private api!: FastifyInstance;
  private sim!: FastifyInstance;
  apiUrl = '';
  simUrl = '';
  control!: SimulatorControl;

  private constructor(options: StackOptions) {
    this.options = options;
    this.deps = {
      pool: options.appPool,
      clock: options.clock,
      ids: options.ids,
      checkpoints: this.checkpoints,
      logger: options.logger ?? silentLogger,
    };
  }

  static async start(options: StackOptions): Promise<Stack> {
    const stack = new Stack(options);
    await stack.startApi();
    await stack.startSim();
    return stack;
  }

  private async startApi(port = 0): Promise<void> {
    this.api = buildApi({ deps: this.deps, webhookSecret: this.options.webhookSecret });
    this.apiUrl = await this.api.listen({ host: '127.0.0.1', port });
  }

  private async startSim(port = 0): Promise<void> {
    const simDeps = { pool: this.options.providerPool, clock: this.options.clock, ids: this.options.ids };
    this.sim = buildProviderSim(simDeps);
    this.simUrl = await this.sim.listen({ host: '127.0.0.1', port });
    this.control = new SimulatorControl(simDeps, {
      webhookUrl: `${this.apiUrl}/v1/provider/webhooks`,
      webhookSecret: this.options.webhookSecret,
    });
  }

  /** Same port, fresh objects: only durable state survives. */
  async restartApi(): Promise<void> {
    const port = Number(new URL(this.apiUrl).port);
    await this.api.close();
    await this.startApi(port);
  }

  async restartSim(): Promise<void> {
    const port = Number(new URL(this.simUrl).port);
    await this.sim.close();
    await this.startSim(port);
  }

  /** A new worker instance is a "restarted worker": it knows only what the database knows. */
  newWorker(workerId: string, options: { leaseMs?: number; retryDelayMs?: number } = {}): Worker {
    return new Worker(this.deps, new ProviderClient(this.simUrl, this.options.providerTimeoutMs ?? 1500), { workerId, ...options });
  }

  async close(): Promise<void> {
    await Promise.all([this.api.close(), this.sim.close()]);
  }
}
