import type { FastifyInstance } from 'fastify';
import { buildApi } from '../../src/api/server.ts';
import type { AppDeps } from '../../src/app/deps.ts';

export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

export interface RunningApi {
  app: FastifyInstance;
  url: string;
  close(): Promise<void>;
}

export async function startApi(deps: AppDeps): Promise<RunningApi> {
  const app = buildApi({ deps, webhookSecret: TEST_WEBHOOK_SECRET });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, url, close: () => app.close() };
}

export interface TransferRequest {
  account: string;
  key: string;
  body?: Record<string, unknown>;
}

export const defaultBody = { asset: 'DEMO_USD', amountMinor: '1250', destination: 'demo:merchant-1' };

export async function postTransfer(url: string, request: TransferRequest): Promise<Response> {
  return fetch(`${url}/v1/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': request.key, 'x-demo-account': request.account },
    body: JSON.stringify(request.body ?? defaultBody),
  });
}

export async function getJson<T = Record<string, unknown>>(
  url: string,
  path: string,
  account: string,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${url}${path}`, { headers: { 'x-demo-account': account } });
  return { status: response.status, body: (await response.json()) as T };
}
