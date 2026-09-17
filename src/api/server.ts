import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { acceptTransfer } from '../app/accept-transfer.ts';
import type { AppDeps } from '../app/deps.ts';
import { checkInvariants } from '../app/invariants.ts';
import {
  decodeCursor,
  DEFAULT_PAGE,
  EXCEPTION_KINDS,
  getBalances,
  getTransfer,
  getTransferEvidence,
  InvalidCursorError,
  listExceptions,
  listTransfers,
  MAX_PAGE,
  readTracePage,
} from '../app/read-models.ts';
import { intakeWebhook, WebhookEnvelope } from '../app/webhook-intake.ts';
import { ASSET, parseAmountMinor } from '../domain/amount.ts';
import { SIGNATURE_HEADER, verifyWebhookSignature } from './webhook-signature.ts';

export interface ApiOptions {
  deps: AppDeps;
  webhookSecret: string;
}

interface DemoAccount {
  accountId: string;
  runId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    demoAccount?: DemoAccount;
  }
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TRANSFER_ID = /^tr_[0-9a-f]{20,32}$/;

export const CreateTransferBody = z.strictObject({
  asset: z.literal(ASSET),
  amountMinor: z.string().max(64),
  destination: z.string().regex(/^demo:[a-z0-9-]{1,48}$/),
  note: z.string().max(512).optional(),
});

export const PageQuery = z.strictObject({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
});
const ExceptionsQuery = PageQuery.extend({ kind: z.enum(EXCEPTION_KINDS).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new ApiError(400, 'INVALID_REQUEST', `Invalid ${what}${path ? ` at "${path}"` : ''}: ${issue?.message ?? 'validation failed'}`);
  }
  return result.data;
}

function sendError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message, requestId: request.id } });
}

/**
 * Local demo API. `X-Demo-Account` is an identity stub, not authentication. There are no fault
 * or reset routes here: fault injection is constructor-injected through `deps.checkpoints`.
 */
export function buildApi(options: ApiOptions): FastifyInstance {
  const { deps } = options;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    genReqId: () => deps.ids.next('req'),
    forceCloseConnections: true,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) return sendError(reply, request, error.status, error.code, error.message);
    if (error instanceof InvalidCursorError) return sendError(reply, request, 400, 'INVALID_REQUEST', 'Invalid cursor.');
    const fastifyCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return sendError(reply, request, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the limit.');
    if (fastifyCode.startsWith('FST_ERR_CTP') || error instanceof SyntaxError) {
      return sendError(reply, request, 400, 'INVALID_REQUEST', 'Request body must be valid JSON with a JSON content type.');
    }
    deps.logger.error('unhandled api error', { requestId: request.id, error });
    // No stack traces or driver messages leave the process.
    return sendError(reply, request, 500, 'INTERNAL_ERROR', 'Unexpected error.');
  });
  app.setNotFoundHandler((request, reply) => sendError(reply, request, 404, 'NOT_FOUND', 'Resource not found.'));

  app.get('/healthz', async () => {
    await deps.pool.query('SELECT 1');
    return { ok: true };
  });

  // ---- Account-scoped demo routes -------------------------------------------------------
  void app.register(async (scoped) => {
    scoped.addHook('onRequest', async (request) => {
      const header = request.headers['x-demo-account'];
      if (typeof header !== 'string' || !ACCOUNT_ID.test(header)) {
        throw new ApiError(401, 'UNKNOWN_DEMO_ACCOUNT', 'X-Demo-Account header with a seeded demo account is required.');
      }
      const found = await deps.pool.query<{ run_id: string }>('SELECT run_id FROM demo_accounts WHERE account_id = $1', [header]);
      const row = found.rows[0];
      if (!row) throw new ApiError(401, 'UNKNOWN_DEMO_ACCOUNT', 'X-Demo-Account header with a seeded demo account is required.');
      request.demoAccount = { accountId: header, runId: row.run_id };
    });

    const account = (request: FastifyRequest): DemoAccount => {
      if (!request.demoAccount) throw new ApiError(401, 'UNKNOWN_DEMO_ACCOUNT', 'Demo account required.');
      return request.demoAccount;
    };

    /** 404 (not 403) for other accounts' transfers: existence is not disclosed. */
    const ownedTransfer = async (request: FastifyRequest) => {
      const { id } = request.params as { id: string };
      if (!TRANSFER_ID.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Transfer not found.');
      const transfer = await getTransfer(deps.pool, id, deps.clock.now());
      if (!transfer || transfer.accountId !== account(request).accountId) throw new ApiError(404, 'NOT_FOUND', 'Transfer not found.');
      return transfer;
    };

    scoped.post('/v1/transfers', async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
        throw new ApiError(400, 'INVALID_REQUEST', 'Idempotency-Key header is required: 1-128 printable ASCII characters without spaces.');
      }
      const body = parse(CreateTransferBody, request.body, 'body');
      const amount = parseAmountMinor(body.amountMinor);
      if (!amount.ok) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          `Invalid body at "amountMinor": expected a positive integer string of minor units up to 10^12 (${amount.error}).`,
        );
      }
      const result = await acceptTransfer(deps, {
        accountId: account(request).accountId,
        idempotencyKey: key,
        requestId: request.id,
        asset: body.asset,
        amountMinor: amount.minor,
        destination: body.destination,
        note: body.note ?? null,
      });
      switch (result.kind) {
        case 'accepted': {
          let dropped = false;
          await deps.checkpoints.hit('api.accept.after_commit', {
            transferId: result.body.transferId,
            dropConnection: () => {
              dropped = true;
              reply.hijack();
              request.raw.socket.destroy();
            },
          });
          if (dropped) return reply;
          return reply.status(202).send(result.body);
        }
        case 'replayed':
          return reply.status(202).header('Idempotent-Replayed', 'true').send(result.body);
        case 'idempotency_conflict':
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This Idempotency-Key was already used with a different asset, amount or destination.',
          );
        case 'insufficient_funds':
          throw new ApiError(
            409,
            'INSUFFICIENT_FUNDS',
            'Available balance is lower than the requested amount. The idempotency key was not consumed.',
          );
        case 'unknown_destination':
          throw new ApiError(400, 'INVALID_REQUEST', 'Invalid body at "destination": not a seeded demo destination.');
        case 'unknown_account':
          throw new ApiError(401, 'UNKNOWN_DEMO_ACCOUNT', 'Demo account required.');
      }
    });

    scoped.get('/v1/transfers', async (request) => {
      const query = parse(PageQuery, request.query, 'query');
      const after = query.cursor ? (decodeCursor(query.cursor, 'string') as string) : null;
      return listTransfers(deps.pool, account(request).accountId, deps.clock.now(), { after, limit: query.limit });
    });

    scoped.get('/v1/transfers/:id', async (request) => ownedTransfer(request));

    scoped.get('/v1/transfers/:id/trace', async (request) => {
      const transfer = await ownedTransfer(request);
      const query = parse(PageQuery, request.query, 'query');
      const afterSeq = query.cursor ? (decodeCursor(query.cursor, 'number') as number) : 0;
      const page = await readTracePage(deps.pool, transfer.transferId, { afterSeq, limit: query.limit });
      return { transferId: transfer.transferId, observedAt: deps.clock.now().toISOString(), ...page };
    });

    scoped.get('/v1/transfers/:id/evidence', async (request) => {
      const transfer = await ownedTransfer(request);
      return {
        transferId: transfer.transferId,
        observedAt: deps.clock.now().toISOString(),
        ...(await getTransferEvidence(deps.pool, transfer.transferId)),
      };
    });

    scoped.get('/v1/transfers/:id/invariants', async (request) => {
      const transfer = await ownedTransfer(request);
      const report = await checkInvariants(deps.pool, transfer.transferId, deps.clock.now());
      if (!report) throw new ApiError(404, 'NOT_FOUND', 'Transfer not found.');
      return report;
    });

    scoped.get('/v1/balances', async (request) => {
      const who = account(request);
      return {
        accountId: who.accountId,
        observedAt: deps.clock.now().toISOString(),
        ...(await getBalances(deps.pool, who.runId, who.accountId)),
      };
    });

    scoped.get('/v1/exceptions', async (request) => {
      const query = parse(ExceptionsQuery, request.query, 'query');
      const after = query.cursor ? (decodeCursor(query.cursor, 'string') as string) : null;
      const now = deps.clock.now();
      const page = await listExceptions(
        deps.pool,
        { accountId: account(request).accountId },
        { kind: query.kind ?? null, after, limit: query.limit },
        now,
      );
      return { observedAt: now.toISOString(), ...page };
    });
  });

  // ---- Provider webhook receiver ---------------------------------------------------------
  void app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    // Keep the exact bytes: the signature covers the raw body, not a re-serialization.
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 8 * 1024 }, (_req, body, done) => done(null, body));

    hooks.post('/v1/provider/webhooks', async (request, reply) => {
      const raw = request.body;
      if (!Buffer.isBuffer(raw)) throw new ApiError(400, 'INVALID_REQUEST', 'Webhook body must be JSON.');
      const signature = request.headers[SIGNATURE_HEADER];
      const check = verifyWebhookSignature(
        options.webhookSecret,
        typeof signature === 'string' ? signature : undefined,
        raw,
        deps.clock.now(),
      );
      if (!check.ok) {
        throw new ApiError(
          401,
          check.reason === 'expired' ? 'SIGNATURE_EXPIRED' : 'INVALID_SIGNATURE',
          'Webhook signature verification failed.',
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ApiError(400, 'INVALID_REQUEST', 'Webhook body must be valid JSON.');
      }
      const envelope = parse(WebhookEnvelope, json, 'webhook envelope');
      let result;
      try {
        result = await intakeWebhook(deps, envelope, raw.toString('utf8'));
      } catch (error) {
        deps.logger.error('webhook persistence failed', { requestId: request.id, error });
        // Not acknowledged: the provider must retry.
        return reply
          .header('Retry-After', '1')
          .status(503)
          .send({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Event was not persisted; retry.', requestId: request.id } });
      }
      if (result.kind === 'event_id_conflict') {
        throw new ApiError(409, 'EVENT_ID_CONFLICT', 'This event ID was already received with different content.');
      }
      return reply.status(202).send({ received: true, duplicate: result.kind === 'duplicate', deliveryId: result.deliveryId });
    });
  });

  return app;
}
