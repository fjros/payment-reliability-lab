import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withTransaction } from '../db/pool.ts';
import type { AppDeps } from './deps.ts';
import { recordException } from './observations.ts';
import { appendTrace, lockTransfer } from './trace.ts';

/** Provider webhook envelope. Strict: unknown fields are rejected; `status` tolerates new enums. */
export const WebhookEnvelope = z.strictObject({
  eventId: z.string().regex(/^evt_[0-9a-f]{20,32}$/),
  type: z.literal('provider.transfer.updated'),
  providerReference: z.string().regex(/^pref_[0-9a-f]{20,32}$/),
  status: z.string().min(1).max(32),
  providerSequence: z.number().int().min(0).max(1_000_000),
  occurredAt: z.iso.datetime(),
  asset: z.string().min(1).max(16),
  amountMinor: z.string().regex(/^[1-9][0-9]{0,12}$/),
  destination: z.string().min(1).max(64),
  finalNoEffect: z.boolean(),
  note: z.string().max(512).optional(),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

/** Hash of the validated content in a fixed field order, so whitespace cannot fake a conflict. */
export function envelopeHash(e: WebhookEnvelope): string {
  const canonical = JSON.stringify([
    e.eventId,
    e.type,
    e.providerReference,
    e.status,
    e.providerSequence,
    e.occurredAt,
    e.asset,
    e.amountMinor,
    e.destination,
    e.finalNoEffect,
    e.note ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export type IntakeResult =
  { kind: 'accepted'; deliveryId: string } | { kind: 'duplicate'; deliveryId: string } | { kind: 'event_id_conflict'; deliveryId: string };

/**
 * Durably records a verified envelope before it is acknowledged. Effects are applied later by
 * the inbox processor. An exact redelivery is acknowledged as a duplicate; a reused event ID
 * with different content is kept as conflicting evidence and never overwrites the original.
 */
export async function intakeWebhook(deps: AppDeps, envelope: WebhookEnvelope, rawBody: string): Promise<IntakeResult> {
  const hash = envelopeHash(envelope);
  return withTransaction(deps.pool, async (client) => {
    const found = await client.query<{ transfer_id: string }>('SELECT transfer_id FROM transfers WHERE provider_reference = $1', [
      envelope.providerReference,
    ]);
    const transfer = found.rows[0] ? await lockTransfer(client, found.rows[0].transfer_id) : null;
    const receivedAt = deps.clock.now();
    const deliveryId = deps.ids.next('dlv');

    const inserted = await client.query(
      `INSERT INTO webhook_inbox
         (event_id, payload_hash, raw_body, provider_reference, transfer_id, run_id, status,
          provider_sequence, occurred_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        envelope.eventId,
        hash,
        rawBody,
        envelope.providerReference,
        transfer?.transfer_id ?? null,
        transfer?.run_id ?? null,
        envelope.status,
        envelope.providerSequence,
        new Date(envelope.occurredAt),
        receivedAt,
      ],
    );
    let kind: IntakeResult['kind'] = 'accepted';
    if (inserted.rowCount === 0) {
      const existing = await client.query<{ payload_hash: string }>('SELECT payload_hash FROM webhook_inbox WHERE event_id = $1', [
        envelope.eventId,
      ]);
      kind = existing.rows[0]?.payload_hash === hash ? 'duplicate' : 'event_id_conflict';
    }
    await client.query(
      `INSERT INTO webhook_deliveries (delivery_id, event_id, transfer_id, payload_hash, received_at, result)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [deliveryId, envelope.eventId, transfer?.transfer_id ?? null, hash, receivedAt, kind],
    );

    if (transfer) {
      const facts = {
        deliveryId,
        providerEventId: envelope.eventId,
        providerStatus: envelope.status,
        providerSequence: envelope.providerSequence,
        providerOccurredAt: envelope.occurredAt,
        payloadHash: hash,
      };
      if (kind === 'accepted') {
        await appendTrace(client, deps, {
          transferId: transfer.transfer_id,
          runId: transfer.run_id,
          type: 'webhook_accepted',
          source: 'webhook',
          correlationId: deliveryId,
          facts,
        });
      } else if (kind === 'duplicate') {
        await appendTrace(client, deps, {
          transferId: transfer.transfer_id,
          runId: transfer.run_id,
          type: 'duplicate_ignored',
          source: 'webhook',
          correlationId: deliveryId,
          facts: { ...facts, level: 'delivery', effect: 'none' },
        });
      } else {
        await recordException(client, deps, {
          transfer,
          reason: 'event_id_payload_mismatch',
          detail: `Provider event ${envelope.eventId} was redelivered with different content. The original is kept; nothing was overwritten or applied.`,
          evidenceIds: [envelope.eventId, deliveryId],
          source: 'webhook',
          correlationId: deliveryId,
          causationId: null,
        });
      }
    }
    return { kind, deliveryId };
  });
}
