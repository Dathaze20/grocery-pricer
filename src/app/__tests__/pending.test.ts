import { beforeEach, describe, expect, it } from 'vitest';
import { pending } from '../pending';

const ORDER = 7;

describe('questions asked while the receipt is still being read', () => {
  beforeEach(() => pending.clear(ORDER));

  it('keeps every question, in the order they were asked', () => {
    // The bug: a single slot, so the second question silently replaced the first.
    pending.add(ORDER, 'how much is the mayonnaise', null);
    pending.add(ORDER, 'what about the corn oil', null);
    pending.add(ORDER, 'profit per case on the rice', null);

    expect(pending.queue(ORDER).map((q) => q.question)).toEqual([
      'how much is the mayonnaise',
      'what about the corn oil',
      'profit per case on the rice',
    ]);
  });

  it('hands them back oldest first, one at a time', () => {
    const first = pending.add(ORDER, 'first', null);
    pending.add(ORDER, 'second', null);

    const claimed = pending.claimNext(ORDER);
    expect(claimed?.question).toBe('first');
    // Still on the queue: it has been claimed, not answered.
    expect(pending.queue(ORDER)).toHaveLength(2);

    pending.complete(ORDER, first.id);
    expect(pending.claimNext(ORDER)?.question).toBe('second');
  });

  it('keeps a question whose answer failed, photograph and all', () => {
    const entry = pending.add(ORDER, 'how much is this', 42);

    const claimed = pending.claimNext(ORDER);
    expect(claimed?.id).toBe(entry.id);

    // Answering threw. The question must still be here, photograph and all.
    pending.fail(ORDER, entry.id);
    expect(pending.queue(ORDER)).toHaveLength(1);
    expect(pending.queue(ORDER)[0]?.photoId).toBe(42);

    // And it is NOT picked up again on its own - that is the retry loop.
    expect(pending.claimNext(ORDER)).toBeNull();
    expect(pending.claimNext(ORDER)).toBeNull();

    // Only an explicit retry frees it.
    pending.retry(ORDER);
    expect(pending.claimNext(ORDER)?.id).toBe(entry.id);
  });

  it('a failed question stalls the queue rather than being stepped over', () => {
    const first = pending.add(ORDER, 'first', null);
    pending.add(ORDER, 'second', null);

    pending.claimNext(ORDER);
    pending.fail(ORDER, first.id);

    // The second question is not answered ahead of the first: order is the promise.
    expect(pending.claimNext(ORDER)).toBeNull();
    expect(pending.queue(ORDER).map((q) => q.question)).toEqual(['first', 'second']);

    pending.retry(ORDER);
    expect(pending.claimNext(ORDER)?.question).toBe('first');
  });

  it('a retry that works clears the block for good', () => {
    const entry = pending.add(ORDER, 'only once', null);
    pending.claimNext(ORDER);
    pending.fail(ORDER, entry.id);
    expect(pending.isBlocked(entry.id)).toBe(true);

    pending.retry(ORDER);
    pending.claimNext(ORDER);
    pending.complete(ORDER, entry.id);

    expect(pending.isBlocked(entry.id)).toBe(false);
    expect(pending.queue(ORDER)).toHaveLength(0);
  });

  it('will not let the same question be answered twice at once', () => {
    pending.add(ORDER, 'only once please', null);

    expect(pending.claimNext(ORDER)).not.toBeNull();
    // A second render while the first answer is still in flight gets nothing.
    expect(pending.claimNext(ORDER)).toBeNull();
  });

  it('removes a question only once its answer is saved', () => {
    const entry = pending.add(ORDER, 'first', null);
    pending.claimNext(ORDER);
    expect(pending.queue(ORDER)).toHaveLength(1);

    pending.complete(ORDER, entry.id);
    expect(pending.queue(ORDER)).toHaveLength(0);
    expect(pending.isInFlight(entry.id)).toBe(false);
  });

  it('remembers a photograph by its row, not by a handle the page is holding', () => {
    const entry = pending.add(ORDER, 'how much is this', 42);

    // A File would be gone the moment the screen unmounts; a row id still points at an image.
    expect(entry.photoId).toBe(42);
    expect(pending.queue(ORDER)[0]?.photoId).toBe(42);
  });

  it('survives the chat screen being unmounted and remounted', () => {
    pending.add(ORDER, 'how much is this', 42);

    // Subscribing is what a screen does on mount; unsubscribing is what leaving does.
    const seen: number[] = [];
    const stop = pending.subscribe(ORDER, (q) => seen.push(q.length));
    stop();

    // Walking away and coming back finds the question still waiting.
    expect(pending.queue(ORDER)).toHaveLength(1);
    expect(seen[0]).toBe(1);
  });

  it('tells whoever is listening when the queue changes', () => {
    const sizes: number[] = [];
    const stop = pending.subscribe(ORDER, (q) => sizes.push(q.length));

    const one = pending.add(ORDER, 'one', null);
    pending.add(ORDER, 'two', null);
    pending.claimNext(ORDER);
    pending.complete(ORDER, one.id);
    stop();

    expect(sizes).toEqual([0, 1, 2, 1]);
  });

  it('keeps one order\'s questions out of another\'s', () => {
    pending.add(ORDER, 'mine', null);
    pending.add(99, 'someone else', null);

    expect(pending.queue(ORDER).map((q) => q.question)).toEqual(['mine']);
    expect(pending.queue(99).map((q) => q.question)).toEqual(['someone else']);
    pending.clear(99);
  });
});
