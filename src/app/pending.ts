/** A question asked while the receipt was still being read. */
export interface PendingQuestion {
  readonly id: number;
  readonly question: string;
  /**
   * The photograph's row in the database, not a File.
   *
   * A File is a handle to something the page is holding; navigate away and the only copy of
   * what the owner photographed goes with it. The image is written to the database the moment
   * it is picked, so what survives here is a number pointing at a row that already exists.
   */
  readonly photoId: number | null;
}

type Listener = (queue: readonly PendingQuestion[]) => void;

/**
 * Questions waiting for the receipt to be read, owned by the application.
 *
 * Outside the chat component on purpose, and for the same reason the job is: a queue held in a
 * screen's state is emptied by walking to another screen. Several questions are kept, in the
 * order they were asked, because a shopkeeper unpacking a delivery asks about one thing and
 * then the next without waiting to be invited.
 *
 * In memory only. A closed tab loses this, and nothing here pretends otherwise - the chat says
 * the question is waiting, not that it is saved.
 */
class PendingQuestions {
  private readonly queues = new Map<number, PendingQuestion[]>();
  private readonly listeners = new Map<number, Set<Listener>>();
  private readonly inFlight = new Set<number>();
  private nextId = 1;

  queue(orderId: number): readonly PendingQuestion[] {
    return this.queues.get(orderId) ?? [];
  }

  add(orderId: number, question: string, photoId: number | null): PendingQuestion {
    const entry: PendingQuestion = { id: this.nextId++, question, photoId };
    const existing = this.queues.get(orderId) ?? [];
    // Appended, never replaced: the second question does not evict the first.
    this.queues.set(orderId, [...existing, entry]);
    this.publish(orderId);
    return entry;
  }

  /**
   * Claims the oldest question without removing it.
   *
   * Taking it off the queue before the answer exists loses it outright if answering throws -
   * the owner's question is gone and nothing ever says so. It stays until `complete` says the
   * answer was saved, and the claim stops a second render answering the same one at the same
   * time.
   */
  claimNext(orderId: number): PendingQuestion | null {
    const first = (this.queues.get(orderId) ?? [])[0];
    if (first === undefined || this.inFlight.has(first.id)) return null;
    this.inFlight.add(first.id);
    return first;
  }

  /** The answer is saved. Now it can go. */
  complete(orderId: number, id: number): void {
    this.inFlight.delete(id);
    const remaining = (this.queues.get(orderId) ?? []).filter((q) => q.id !== id);
    this.queues.set(orderId, remaining);
    this.publish(orderId);
  }

  /** Answering failed. The question keeps its place, and its photograph is still stored. */
  release(id: number): void {
    this.inFlight.delete(id);
  }

  isInFlight(id: number): boolean {
    return this.inFlight.has(id);
  }

  clear(orderId: number): void {
    if ((this.queues.get(orderId) ?? []).length === 0) return;
    for (const entry of this.queues.get(orderId) ?? []) this.inFlight.delete(entry.id);
    this.queues.set(orderId, []);
    this.publish(orderId);
  }

  subscribe(orderId: number, listener: Listener): () => void {
    const set = this.listeners.get(orderId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(orderId, set);
    listener(this.queue(orderId));
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(orderId);
    };
  }

  private publish(orderId: number): void {
    const queue = this.queue(orderId);
    for (const listener of this.listeners.get(orderId) ?? []) listener(queue);
  }
}

export const pending = new PendingQuestions();
