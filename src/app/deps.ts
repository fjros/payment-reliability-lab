import type { Pool } from '../db/pool.ts';
import type { Clock } from '../shared/clock.ts';
import type { IdGenerator } from '../shared/ids.ts';
import type { Checkpoints } from '../shared/checkpoints.ts';
import type { Logger } from '../shared/logger.ts';
import type { TransferState } from '../domain/transitions.ts';

export interface AppDeps {
  pool: Pool;
  clock: Clock;
  ids: IdGenerator;
  checkpoints: Checkpoints;
  logger: Logger;
}

/** Row shape of `transfers`. numeric columns arrive as exact strings. */
export interface TransferRow {
  transfer_id: string;
  run_id: string;
  account_id: string;
  asset: string;
  amount_minor: string;
  destination: string;
  note: string | null;
  state: TransferState;
  provider_reference: string;
  version: number;
  last_provider_status: string | null;
  last_provider_sequence: number | null;
  last_provider_observed_at: Date | null;
  last_provider_observation_id: string | null;
  created_at: Date;
  updated_at: Date;
}
