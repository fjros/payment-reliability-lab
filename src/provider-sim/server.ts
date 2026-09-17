import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lookup, submit, type SimDeps, type SimTransfer } from './store.ts';

const SubmitBody = z.strictObject({
  providerReference: z.string().regex(/^pref_[0-9a-f]{20,32}$/),
  asset: z.string().min(1).max(16),
  amountMinor: z.string().regex(/^[1-9][0-9]{0,12}$/),
  destination: z.string().regex(/^demo:[a-z0-9-]{1,48}$/),
});

function present(t: SimTransfer): Record<string, unknown> {
  return {
    providerReference: t.providerReference,
    status: t.status,
    providerSequence: t.sequence,
    asset: t.asset,
    amountMinor: t.amountMinor,
    destination: t.destination,
    // Only a final rejection carries the explicit guarantee that nothing happened externally.
    finalNoEffect: t.status === 'rejected',
    updatedAt: t.updatedAt.toISOString(),
    ...(t.providerNote === null ? {} : { note: t.providerNote }),
  };
}

/**
 * Deterministic external provider. It owns separate persistent state and exposes only the
 * provider contract: no fault-control routes exist. Fault plans are rows written by the
 * scenario harness directly into the provider database.
 */
export function buildProviderSim(deps: SimDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024, forceCloseConnections: true });

  app.setErrorHandler((error: unknown, _request, reply) => {
    const status =
      error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.status(status).send({ error: { code: status === 500 ? 'PROVIDER_ERROR' : 'INVALID_REQUEST' } });
  });

  app.post('/provider/transfers', async (request, reply) => {
    const parsed = SubmitBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: { code: 'INVALID_REQUEST' } });
    const outcome = await submit(deps, parsed.data);
    if (outcome.kind === 'conflict') {
      return reply
        .status(409)
        .send({ error: { code: 'REFERENCE_CONFLICT', message: 'providerReference was already used with different data.' } });
    }
    if (outcome.respond === 'lose') {
      // Acceptance is already committed. The caller sees a dead connection, not a status.
      reply.hijack();
      request.raw.socket.destroy();
      return reply;
    }
    if (outcome.respond === 'hang') {
      // Never answer; release resources once the caller's deadline fires and it disconnects.
      reply.hijack();
      request.raw.socket.on('close', () => {});
      return reply;
    }
    return reply.status(outcome.kind === 'created' ? 201 : 200).send(present(outcome.transfer));
  });

  app.get('/provider/transfers/:reference', async (request, reply) => {
    const { reference } = request.params as { reference: string };
    if (!/^pref_[0-9a-f]{20,32}$/.test(reference)) return reply.status(400).send({ error: { code: 'INVALID_REQUEST' } });
    const { plan, transfer } = await lookup(deps, reference);
    if (plan.lookup === 'unavailable') return reply.status(503).send({ error: { code: 'LOOKUP_UNAVAILABLE' } });
    if (plan.lookup === 'inconclusive') return reply.status(200).send({ providerReference: reference, status: 'inconclusive' });
    if (!transfer) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });
    return reply.status(200).send(present(transfer));
  });

  return app;
}
