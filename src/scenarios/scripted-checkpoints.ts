import { SimulatedCrash, type CheckpointContext, type CheckpointName, type Checkpoints } from '../shared/checkpoints.ts';

type Handler = (context: CheckpointContext) => Promise<void> | void;

/**
 * Harness-only checkpoint script. Handlers are one-shot and consumed in order, which keeps
 * fault injection deterministic: "the next time X happens, do Y" rather than timing games.
 */
export class ScriptedCheckpoints implements Checkpoints {
  private readonly queues = new Map<CheckpointName, Handler[]>();
  readonly hits: Array<{ name: CheckpointName; transferId: string | undefined }> = [];

  once(name: CheckpointName, handler: Handler): this {
    const queue = this.queues.get(name) ?? [];
    queue.push(handler);
    this.queues.set(name, queue);
    return this;
  }

  /** Next hit abandons the in-process work the way a process crash would. */
  crashOnce(name: CheckpointName): this {
    return this.once(name, () => {
      throw new SimulatedCrash(name);
    });
  }

  /** Next hit drops the client connection after the transaction committed (API only). */
  dropConnectionOnce(name: CheckpointName): this {
    return this.once(name, (context) => context.dropConnection?.());
  }

  /** Next hit blocks until `release()` is called; `reached` resolves when the code gets there. */
  barrierOnce(name: CheckpointName): { reached: Promise<void>; release: () => void } {
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    this.once(name, async () => {
      reached.resolve();
      await gate.promise;
    });
    return { reached: reached.promise, release: () => gate.resolve() };
  }

  async hit(name: CheckpointName, context: CheckpointContext): Promise<void> {
    this.hits.push({ name, transferId: context.transferId });
    const handler = this.queues.get(name)?.shift();
    if (handler) await handler(context);
  }
}
