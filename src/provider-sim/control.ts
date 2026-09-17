import { signWebhook, SIGNATURE_HEADER } from '../api/webhook-signature.ts';
import { withTransaction } from '../db/pool.ts';
import {
  DEFAULT_PLAN,
  emitSimEvent,
  finalize,
  simRowToTransfer,
  type FaultPlan,
  type SimDeps,
  type SimRow,
  type SimTransfer,
} from './store.ts';

export interface OutboxEvent {
  eventId: string;
  providerReference: string;
  status: string;
  sequence: number;
  occurredAt: Date;
  forced: boolean;
  deliveryCount: number;
}

export interface DeliveryOptions {
  /** Replace the stored body (tampering tests). The signature is still computed honestly. */
  bodyOverride?: string;
  /** Sign with this secret instead of the real one (bad-signature tests). */
  secretOverride?: string;
  /** Sign with this transport time instead of "now" (expired-envelope tests). */
  signedAt?: Date;
}

/**
 * Privileged harness access to the simulator: fault plans, state changes, webhook delivery and
 * the ORACLE (what the provider really did). Nothing here is reachable over HTTP, and oracle
 * data must never be handed to an investigation that is supposed to see only the
 * application's own observations.
 */
export class SimulatorControl {
  private readonly deps: SimDeps;
  private readonly webhookUrl: string;
  private readonly webhookSecret: string;

  constructor(deps: SimDeps, options: { webhookUrl: string; webhookSecret: string }) {
    this.deps = deps;
    this.webhookUrl = options.webhookUrl;
    this.webhookSecret = options.webhookSecret;
  }

  async setPlan(reference: string, plan: Partial<FaultPlan>): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO sim_fault_plans (provider_reference, plan, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (provider_reference) DO UPDATE SET plan = sim_fault_plans.plan || EXCLUDED.plan, updated_at = EXCLUDED.updated_at`,
      [reference, JSON.stringify({ ...(await this.currentPlan(reference)), ...plan }), this.deps.clock.now()],
    );
  }

  private async currentPlan(reference: string): Promise<FaultPlan> {
    const row = await this.deps.pool.query<{ plan: Partial<FaultPlan> }>('SELECT plan FROM sim_fault_plans WHERE provider_reference = $1', [
      reference,
    ]);
    return { ...DEFAULT_PLAN, ...(row.rows[0]?.plan ?? {}) };
  }

  complete(reference: string): Promise<SimTransfer> {
    return withTransaction(this.deps.pool, (client) => finalize(client, this.deps, reference, 'completed'));
  }

  reject(reference: string): Promise<SimTransfer> {
    return withTransaction(this.deps.pool, (client) => finalize(client, this.deps, reference, 'rejected'));
  }

  /**
   * Fabricates an extra event WITHOUT changing provider state: a second event ID for the same
   * outcome, or a contradictory terminal claim.
   */
  async forgeEvent(reference: string, status: 'pending' | 'completed' | 'rejected', sequence?: number): Promise<string> {
    return withTransaction(this.deps.pool, async (client) => {
      const row = await client.query<SimRow>('SELECT * FROM sim_transfers WHERE provider_reference = $1', [reference]);
      if (!row.rows[0]) throw new Error(`simulator has no operation ${reference}`);
      const transfer = simRowToTransfer(row.rows[0]);
      return emitSimEvent(client, this.deps, transfer, status, sequence ?? transfer.sequence, true);
    });
  }

  async events(reference: string): Promise<OutboxEvent[]> {
    const result = await this.deps.pool.query<{
      event_id: string;
      provider_reference: string;
      status: string;
      sequence: number;
      occurred_at: Date;
      forced: boolean;
      delivery_count: number;
    }>('SELECT * FROM sim_webhook_outbox WHERE provider_reference = $1 ORDER BY created_at, sequence, event_id', [reference]);
    return result.rows.map((r) => ({
      eventId: r.event_id,
      providerReference: r.provider_reference,
      status: r.status,
      sequence: r.sequence,
      occurredAt: r.occurred_at,
      forced: r.forced,
      deliveryCount: r.delivery_count,
    }));
  }

  async eventFor(reference: string, status: string, options: { forced?: boolean } = {}): Promise<OutboxEvent> {
    const match = (await this.events(reference)).find((e) => e.status === status && e.forced === (options.forced ?? false));
    if (!match) throw new Error(`no ${status} event for ${reference}`);
    return match;
  }

  /** Delivers one stored event over real HTTP with a fresh transport signature. Repeatable. */
  async deliver(eventId: string, options: DeliveryOptions = {}): Promise<{ status: number; body: unknown }> {
    const stored = await this.deps.pool.query<{ body: string }>('SELECT body FROM sim_webhook_outbox WHERE event_id = $1', [eventId]);
    if (!stored.rows[0]) throw new Error(`no outbox event ${eventId}`);
    const body = options.bodyOverride ?? stored.rows[0].body;
    const signedAt = Math.floor((options.signedAt ?? this.deps.clock.now()).getTime() / 1000);
    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signWebhook(options.secretOverride ?? this.webhookSecret, signedAt, body),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await this.deps.pool.query(
      'UPDATE sim_webhook_outbox SET delivery_count = delivery_count + 1, last_delivery_status = $2 WHERE event_id = $1',
      [eventId, response.status],
    );
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** Dev-mode convenience: deliver every event that was never delivered successfully. */
  async deliverPending(): Promise<number> {
    const pending = await this.deps.pool.query<{ event_id: string }>(
      'SELECT event_id FROM sim_webhook_outbox WHERE last_delivery_status IS DISTINCT FROM 202 AND delivery_count < 10 ORDER BY created_at, sequence LIMIT 50',
    );
    for (const row of pending.rows) await this.deliver(row.event_id).catch(() => undefined);
    return pending.rows.length;
  }

  async storedBody(eventId: string): Promise<string> {
    const stored = await this.deps.pool.query<{ body: string }>('SELECT body FROM sim_webhook_outbox WHERE event_id = $1', [eventId]);
    if (!stored.rows[0]) throw new Error(`no outbox event ${eventId}`);
    return stored.rows[0].body;
  }

  // ---- ORACLE: privileged ground truth, for tests and clearly-labelled exports only ----------
  async oracleTransfer(reference: string): Promise<SimTransfer | null> {
    const result = await this.deps.pool.query<SimRow>('SELECT * FROM sim_transfers WHERE provider_reference = $1', [reference]);
    return result.rows[0] ? simRowToTransfer(result.rows[0]) : null;
  }

  async oracleEffectCount(reference: string): Promise<number> {
    const result = await this.deps.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_effects WHERE provider_reference = $1', [
      reference,
    ]);
    return result.rows[0]!.n;
  }
}
