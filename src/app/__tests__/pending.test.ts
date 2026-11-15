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
    pending.add(ORDER, 'first', null);
    pending.add(ORDER, 'second', null);

    expect(pending.takeNext(ORDER)?.question).toBe('first');
    expect(pending.takeNext(ORDER)?.question).toBe('second');
    expect(pending.takeNext(ORDER)).toBeNull();
    expect(pending.queue(ORDER)).toHaveLength(0);
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

    pending.add(ORDER, 'one', null);
    pending.add(ORDER, 'two', null);
    pending.takeNext(ORDER);
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
