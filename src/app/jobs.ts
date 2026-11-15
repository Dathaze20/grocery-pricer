import { updates } from '../ui/updates';
import type { Repository } from '../data/repository';
import type { AiProvider } from '../ai/provider';
import { processOrder, type ProcessResult } from './processing';

export type JobState =
  | { readonly kind: 'running'; readonly step: string }
  | { readonly kind: 'done'; readonly result: ProcessResult }
  | { readonly kind: 'failed'; readonly result: ProcessResult };

type Listener = (state: JobState) => void;

/**
 * Receipt reading, owned by the application rather than by a screen.
 *
 * This is the whole reason the chat can open the moment the owner presses the button. A job
 * started here is not tied to the component that started it: the New Order screen unmounts,
 * the chat mounts and subscribes, and the request carries on untouched in between. Work that
 * lives in a component is cancelled by navigation, and "wait here, do not touch anything" is
 * not something to ask of somebody standing in their own shop.
 *
 * What this does NOT do is survive the page being closed. A browser tab that goes away takes
 * its fetches with it, and nothing on a static site can promise otherwise. The update hold
 * below covers the one interruption that is ours to prevent.
 */
class ProcessingJobs {
  private readonly states = new Map<number, JobState>();
  private readonly listeners = new Map<number, Set<Listener>>();
  private readonly running = new Set<number>();

  /** What this order is doing, if anything. */
  stateOf(orderId: number): JobState | null {
    return this.states.get(orderId) ?? null;
  }

  isRunning(orderId: number): boolean {
    return this.running.has(orderId);
  }

  subscribe(orderId: number, listener: Listener): () => void {
    const set = this.listeners.get(orderId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(orderId, set);

    const current = this.states.get(orderId);
    if (current !== undefined) listener(current);

    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orderId);
    };
  }

  /**
   * Starts reading this order, unless it is already being read.
   *
   * The guard is the point: pressing the button twice, or arriving back at the chat while the
   * first run is still going, must not put the same photographs through twice. The second call
   * is simply ignored and the caller watches the job that already exists.
   */
  start(
    repo: Repository,
    providerFor: (repo: Repository) => Promise<AiProvider>,
    orderId: number,
    options: { reprocess?: boolean } = {},
  ): void {
    if (this.running.has(orderId)) return;
    this.running.add(orderId);
    this.publish(orderId, { kind: 'running', step: 'Starting' });

    // Held for as long as the work runs, not for as long as a screen is mounted. An automatic
    // update reloads the page, and a reload here loses the receipt mid-read.
    const release = updates.hold('blocking');

    void (async () => {
      try {
        const provider = await providerFor(repo);
        const result = await processOrder(repo, provider, orderId, {
          reprocess: options.reprocess,
          onProgress: (step) => this.publish(orderId, { kind: 'running', step }),
        });
        this.publish(orderId, { kind: result.ok ? 'done' : 'failed', result });
      } catch (error) {
        this.publish(orderId, {
          kind: 'failed',
          result: {
            ok: false,
            outcome: 'failed',
            itemCount: 0,
            warnings: [],
            error: null,
            summary: shortReason(error),
            timings: [],
          },
        });
      } finally {
        this.running.delete(orderId);
        release();
      }
    })();
  }

  /** Clears a finished job so the chat stops showing yesterday's outcome. */
  forget(orderId: number): void {
    if (this.running.has(orderId)) return;
    this.states.delete(orderId);
  }

  private publish(orderId: number, state: JobState): void {
    this.states.set(orderId, state);
    for (const listener of this.listeners.get(orderId) ?? []) listener(state);
  }
}

function shortReason(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? `Reading the receipt stopped: ${error.message.slice(0, 120)}`
    : 'Reading the receipt stopped unexpectedly.';
}

export const jobs = new ProcessingJobs();
