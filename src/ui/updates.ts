/**
 * Decides *when* a downloaded update is allowed to take over.
 *
 * Kept free of browser APIs so the policy can be tested directly. The service-worker plumbing
 * lives in pwa.ts and calls into this.
 *
 * The policy exists because applying an update means reloading the page, and a reload at the
 * wrong moment is destructive in a way that a stale interface is not: a receipt mid-upload, a
 * question mid-flight, an API key typed but not yet saved. So an update is applied only at a
 * moment where a reload costs nothing, and until then it waits and says so.
 */

export interface UpdateStatus {
  /** A newer version has downloaded and is waiting to take over. */
  readonly available: boolean;
  /** Something is going on that a reload would interrupt. */
  readonly held: boolean;
}

export type UpdateListener = (status: UpdateStatus) => void;

export class UpdateCoordinator {
  private holds = 0;
  private available = false;
  private applied = false;
  private applier: (() => void) | null = null;
  private readonly listeners = new Set<UpdateListener>();

  /** Supplied by the service-worker layer once registration has happened. */
  setApplier(applier: () => void): void {
    this.applier = applier;
    // An update that arrived before the applier was wired up still has to land.
    if (this.available && this.holds === 0) this.applyNow();
  }

  /**
   * Marks the current moment as unsafe to reload. The returned function releases the hold, and
   * releasing the last one applies any update that has been waiting.
   */
  hold(): () => void {
    this.holds += 1;
    this.notify();
    let released = false;
    return () => {
      // Guarded: a double release would let a hold that is still needed fall off the count.
      if (released) return;
      released = true;
      this.holds -= 1;
      this.notify();
      if (this.holds === 0 && this.available) this.applyNow();
    };
  }

  /** Called when the browser reports that a new version has finished downloading. */
  noteAvailable(): void {
    if (this.available) return;
    this.available = true;
    this.notify();
    if (this.holds === 0) this.applyNow();
  }

  /**
   * Hands over to the new version, which reloads the page.
   *
   * Applies once and once only. The reload brings the page back with the new worker in control,
   * where a second attempt would do nothing useful and a loop would make the app unusable.
   */
  applyNow(): void {
    if (!this.available || this.applied || this.applier === null) return;
    this.applied = true;
    this.notify();
    this.applier();
  }

  get status(): UpdateStatus {
    return { available: this.available && !this.applied, held: this.holds > 0 };
  }

  /** Test seam: how many holds are outstanding. */
  get holdCount(): number {
    return this.holds;
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const status = this.status;
    for (const listener of this.listeners) listener(status);
  }
}

/** The one coordinator the app uses. */
export const updates = new UpdateCoordinator();
