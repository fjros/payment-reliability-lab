import { z } from 'zod';

/** Tolerant of unknown fields and unknown status values; strict about types and bounds. */
const ProviderResponse = z.object({
  providerReference: z.string().max(64),
  status: z.string().min(1).max(32),
  providerSequence: z.number().int().min(0).max(1_000_000).optional(),
  finalNoEffect: z.boolean().optional(),
  asset: z.string().max(16).optional(),
  amountMinor: z
    .string()
    .regex(/^[1-9][0-9]{0,12}$/)
    .optional(),
  destination: z.string().max(64).optional(),
  updatedAt: z.iso.datetime().optional(),
  note: z.string().max(512).optional(),
});

export type ProviderCallResult =
  | {
      kind: 'status';
      httpStatus: number;
      status: string;
      sequence: number | null;
      finalNoEffect: boolean;
      echo: { asset: string; amountMinor: string; destination: string } | null;
      occurredAt: Date | null;
      note: string | null;
    }
  | { kind: 'not_found'; httpStatus: 404 }
  | { kind: 'conflict'; httpStatus: 409 }
  | { kind: 'http_error'; httpStatus: number }
  | { kind: 'invalid_response'; httpStatus: number }
  /** The connection died. The request may or may not have been processed. */
  | { kind: 'response_lost'; detail: string }
  /** Our deadline fired. The request may or may not have been processed. */
  | { kind: 'timeout' };

export interface ProviderSubmission {
  providerReference: string;
  asset: string;
  amountMinor: string;
  destination: string;
}

/**
 * HTTP client for the one fixed provider base URL given at construction. Destinations are
 * symbolic IDs inside the body; nothing user-supplied ever becomes a URL.
 */
export class ProviderClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 2000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  submit(submission: ProviderSubmission): Promise<ProviderCallResult> {
    return this.call(submission.providerReference, `${this.baseUrl}/provider/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(submission),
    });
  }

  lookup(providerReference: string): Promise<ProviderCallResult> {
    return this.call(providerReference, `${this.baseUrl}/provider/transfers/${encodeURIComponent(providerReference)}`, { method: 'GET' });
  }

  private async call(reference: string, url: string, init: RequestInit): Promise<ProviderCallResult> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'timeout' };
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
      return { kind: 'response_lost', detail: `${(error as Error).message}${cause ? `: ${cause}` : ''}`.slice(0, 200) };
    }
    if (response.status === 404) return { kind: 'not_found', httpStatus: 404 };
    if (response.status === 409) return { kind: 'conflict', httpStatus: 409 };
    if (!response.ok) return { kind: 'http_error', httpStatus: response.status };
    if (text.length > 8192) return { kind: 'invalid_response', httpStatus: response.status };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'invalid_response', httpStatus: response.status };
    }
    const parsed = ProviderResponse.safeParse(json);
    if (!parsed.success || parsed.data.providerReference !== reference) return { kind: 'invalid_response', httpStatus: response.status };
    const d = parsed.data;
    return {
      kind: 'status',
      httpStatus: response.status,
      status: d.status,
      sequence: d.providerSequence ?? null,
      finalNoEffect: d.finalNoEffect ?? false,
      echo:
        d.asset !== undefined && d.amountMinor !== undefined && d.destination !== undefined
          ? { asset: d.asset, amountMinor: d.amountMinor, destination: d.destination }
          : null,
      occurredAt: d.updatedAt ? new Date(d.updatedAt) : null,
      note: d.note ?? null,
    };
  }
}
