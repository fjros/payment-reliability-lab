/**
 * Named fault checkpoints. Production entry points use `noCheckpoints`; only the scenario and
 * test harness inject behaviour (block on a barrier, simulate a crash, drop a connection).
 * Checkpoints are constructor-injected and are never reachable through an HTTP route.
 */
export type CheckpointName =
  | 'api.accept.after_commit'
  | 'worker.job.after_attempt_persisted'
  | 'worker.job.after_provider_response'
  | 'worker.job.after_result_committed'
  | 'worker.inbox.in_transaction'
  | 'worker.inbox.after_commit';

export interface CheckpointContext {
  transferId?: string;
  /** Present for API checkpoints: abruptly closes the client connection without a response. */
  dropConnection?: () => void;
}

export interface Checkpoints {
  hit(name: CheckpointName, context: CheckpointContext): Promise<void>;
}

export const noCheckpoints: Checkpoints = { hit: async () => {} };

/** Thrown by harness checkpoints to abandon in-process work exactly as a process crash would. */
export class SimulatedCrash extends Error {
  constructor(checkpoint: string) {
    super(`simulated crash at ${checkpoint}`);
    this.name = 'SimulatedCrash';
  }
}
