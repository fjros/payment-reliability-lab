import { createHash } from 'node:crypto';
import { serializeMinor } from './amount.ts';

export interface EconomicRequest {
  asset: string;
  amountMinor: bigint;
  destination: string;
}

/**
 * Fingerprint of the canonical, validated economic request: asset, amount and destination in a
 * fixed field order. The ancillary `note` is deliberately excluded (first write wins), so a
 * changed note can never silently change, or conflict with, the economic request.
 */
export function economicFingerprint(request: EconomicRequest): string {
  const canonical = JSON.stringify({
    v: 1,
    asset: request.asset,
    amountMinor: serializeMinor(request.amountMinor),
    destination: request.destination,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
