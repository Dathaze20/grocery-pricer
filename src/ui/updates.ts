/**
 * Decides *when* a downloaded update is allowed to take over.
 *
 * Kept free of browser APIs so the policy can be tested directly. The service-worker plumbing
 * lives in pwa.ts and calls into this.
 *
 * The policy exists because applying an update means reloading the page, and a reload at the
 * wrong moment is destructive in a way that a stale interface is not: a receipt mid-upload, a
 * question mid-flight, an API key typed but not yet saved.
 *
 * Holds come in two strengths, because those situations are not the same:
 *
 *   'blocking' - work that a reload would destroy. A receipt being read, a question in flight,
 *     a delivery being counted, text typed but not saved. Nothing overrides these, including
 *     the person tapping "update now": they cannot see that a request is still running, and
 *     answering a prompt is not consent to lose an order.
 *
 *   'soft' - merely being somewhere a reload would be unwelcome, such as reading an order. The
 *     update waits, but someone who asks for it explicitly gets it.
 */

export type HoldKind = 'blocking' | 'soft';

export interface UpdateStatus {
  /** A newer version has downloaded and is waiting to take over. */
  readonly available: boolean;
  /** Something, of either strength, is holding the update off. */
  readonly held: boolean;
  /** Work is in progress that a reload would destroy. */
  readonly blocked: boolean;
  /** Someone has asked for the update; it applies as soon as that is safe. */
  readonly requested: boolean;
}

export type UpdateListener = (status: UpdateStatus) => void;

export class UpdateCoordinator {
  private blocking = 0;
  private soft = 0;
  private available = false;
  private applied = false;
  private requested = false;
  private applier: (() => void) | null = null;
  private readonly listeners = new Set<UpdateListener>();

  /** Supplied by the service-worker layer once registration has happened. */
  setApplier(applier: () => void): void {
    this.applier = applier;
    // An update that arrived before the applier was wired up still has to land.
    this.maybeApply();
  }

  /**
   * Marks the current moment as unsafe to reload.
   *
   * The returned release function is what ties a hold to the work rather than to a screen: an
   * operation takes a hold before it starts and releases it in a finally, so leaving the screen
   * part way through changes nothing. Releasing the last hold applies any waiting update.
   */
  hold(kind: HoldKind = 'soft'): () => void {
    if (kind === 'blocking') this.blocking += 1;
    else this.soft += 1;
    this.notify();

    let released = false;
    return () => {
      // Guarded: a double release would let a hold that is still needed fall off the count.
      if (released) return;
      released = true;
      if (kind === 'blocking') this.blocking -= 1;
      else this.soft -= 1;
      this.notify();
      this.maybeApply();
    };
  }

  /** Called when the browser reports that a new version has finished downloading. */
  noteAvailable(): void {
    if (this.available) return;
    this.available = true;
    this.notify();
    this.maybeApply();
  }

  /**
   * Someone asked for the update.
   *
   * Honoured as soon as nothing is mid-flight. If something is, this is remembered rather than
   * obeyed, and the update lands the moment that work settles.
   */
  requestApply(): void {
    if (this.requested) return;
    this.requested = true;
    this.notify();
    this.maybeApply();
  }

  get status(): UpdateStatus {
    return {
      available: this.available && !this.applied,
      held: this.blocking + this.soft > 0,
      blocked: this.blocking > 0,
      requested: this.requested && !this.applied,
    };
  }

  /** Test seams. */
  get holdCount(): number {
    return this.blocking + this.soft;
  }

  get blockingCount(): number {
    return this.blocking;
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  /**
   * Hands over to the new version, which reloads the page.
   *
   * Applies once and once only. The reload brings the page back with the new worker in control,
   * where a second attempt would do nothing useful and a loop would make the app unusable.
   */
  private maybeApply(): void {
    if (!this.available || this.applied || this.applier === null) return;
    // Work that a reload would destroy is never overridden, by anyone.
    if (this.blocking > 0) return;
    // A soft hold yields only to someone actually asking for the update.
    if (this.soft > 0 && !this.requested) return;

    this.applied = true;
    this.notify();
    this.applier();
  }

  private notify(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }
}

/** The one coordinator the app uses. */
export const updates = new UpdateCoordinator();
