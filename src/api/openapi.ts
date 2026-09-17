import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { WebhookEnvelope } from '../app/webhook-intake.ts';
import { CreateTransferBody, PageQuery } from './server.ts';

/**
 * OpenAPI description generated from the SAME zod schemas the server validates with, so request
 * contracts cannot drift. Response bodies are described by hand at the level the tests assert.
 * Regenerate with `npm run openapi`; a unit test fails if docs/openapi.json is stale.
 */
const schema = (s: z.ZodType): unknown => z.toJSONSchema(s, { target: 'draft-2020-12', io: 'input' });
const str = { type: 'string' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (s: unknown) => ({ content: { 'application/json': { schema: s } } });
const error = (description: string) => ({ description, ...json(ref('Error')) });
const account = {
  name: 'X-Demo-Account',
  in: 'header',
  required: true,
  schema: str,
  description: 'Seeded demo account. A local identity stub, NOT authentication.',
};
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^tr_[0-9a-f]{20,32}$' } };
const page = [
  { name: 'cursor', in: 'query', required: false, schema: str, description: 'Opaque cursor from a previous page.' },
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
];
const read = (summary: string, extra: unknown[] = []) => ({
  summary,
  parameters: [account, ...extra],
  responses: {
    200: { description: 'OK', ...json({ type: 'object' }) },
    400: error('Invalid query'),
    401: error('Missing or unknown demo account'),
    404: error('Unknown or inaccessible transfer'),
  },
});

export function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Payment Reliability Lab — local demo API',
      version: '1.0.0',
      description:
        'Synthetic, loopback-only demo API. No production authentication is claimed. Amounts are exact integer minor units serialized as strings. ' +
        'Versioning: breaking changes get a new /v2 prefix. Clients must tolerate unknown response fields and unknown enum values (for example new transfer states or trace event types).',
    },
    paths: {
      '/v1/transfers': {
        post: {
          summary: 'Accept a transfer (idempotent)',
          description:
            '202 means durably accepted locally, not paid externally. The same scoped key with the same asset, amount and destination replays the original body (header Idempotent-Replayed: true), ' +
            'also after restarts or settlement. `note` is ancillary: first write wins and it is excluded from the fingerprint. A request rejected before acceptance does not consume the key.',
          parameters: [
            account,
            { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' } },
          ],
          requestBody: { required: true, ...json(ref('CreateTransfer')) },
          responses: {
            202: { description: 'Accepted (new or replayed)', ...json(ref('Acceptance')) },
            400: error('INVALID_REQUEST'),
            401: error('UNKNOWN_DEMO_ACCOUNT'),
            409: error('IDEMPOTENCY_CONFLICT or INSUFFICIENT_FUNDS'),
            413: error('PAYLOAD_TOO_LARGE'),
          },
        },
        get: read("List this account's transfers", page),
      },
      '/v1/transfers/{id}': {
        get: read('Current local state, exact amount, provider reference and last provider observation with its age', [id]),
      },
      '/v1/transfers/{id}/trace': {
        get: read('Cursor-paginated append-only trace (stable IDs, per-transfer sequence, causation links)', [id, ...page]),
      },
      '/v1/transfers/{id}/evidence': {
        get: read('Linked journal batches, provider attempts, observations and webhook deliveries (bounded)', [id]),
      },
      '/v1/transfers/{id}/invariants': { get: read('Invariants I1-I8 as pass / fail / unknown with evidence IDs', [id]) },
      '/v1/balances': { get: read('Available, reserved and run clearing balances for the demo account') },
      '/v1/exceptions': {
        get: read('Unknown outcomes, conflicting observations and invariant failures (distinct kinds)', [
          ...page,
          {
            name: 'kind',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['unknown_outcome', 'conflicting_observation', 'invariant_failure'] },
          },
        ]),
      },
      '/v1/provider/webhooks': {
        post: {
          summary: 'Signed provider webhook receiver',
          description:
            'Header X-Provider-Signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, 300 s tolerance. The event is durably stored before 202. ' +
            'An exact redelivery returns 202 with duplicate=true; a reused event ID with different content returns 409 and is kept as conflicting evidence.',
          parameters: [{ name: 'X-Provider-Signature', in: 'header', required: true, schema: str }],
          requestBody: { required: true, ...json(ref('WebhookEnvelope')) },
          responses: {
            202: {
              description: 'Persisted (or verified duplicate)',
              ...json({ type: 'object', properties: { received: { type: 'boolean' }, duplicate: { type: 'boolean' }, deliveryId: str } }),
            },
            400: error('INVALID_REQUEST'),
            401: error('INVALID_SIGNATURE or SIGNATURE_EXPIRED'),
            409: error('EVENT_ID_CONFLICT'),
            413: error('PAYLOAD_TOO_LARGE'),
            503: error('TEMPORARILY_UNAVAILABLE: not persisted, retry'),
          },
        },
      },
    },
    components: {
      schemas: {
        CreateTransfer: schema(CreateTransferBody),
        PageQuery: schema(PageQuery),
        WebhookEnvelope: schema(WebhookEnvelope),
        Acceptance: {
          type: 'object',
          required: ['transferId', 'accepted', 'statusUrl'],
          properties: { transferId: str, accepted: { const: true }, statusUrl: str },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: str, message: str, requestId: str } },
          },
        },
      },
    },
  };
}

export const OPENAPI_PATH = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(OPENAPI_PATH, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
  process.stdout.write(`wrote ${OPENAPI_PATH}\n`);
}
