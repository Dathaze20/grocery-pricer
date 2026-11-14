import { describe, expect, it, vi } from 'vitest';
import { UpdateCoordinator } from '../updates';

function coordinator(): { updates: UpdateCoordinator; apply: ReturnType<typeof vi.fn> } {
  const updates = new UpdateCoordinator();
  const apply = vi.fn();
  updates.setApplier(apply);
  return { updates, apply };
}

describe('UpdateCoordinator', () => {
  it('applies an update straight away when nothing is going on', () => {
    const { updates, apply } = coordinator();

    updates.noteAvailable();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('will not reload while work is in progress', () => {
    const { updates, apply } = coordinator();
    updates.hold();

    updates.noteAvailable();

    // A receipt mid-upload is worth more than a current interface.
    expect(apply).not.toHaveBeenCalled();
    expect(updates.status.available).toBe(true);
    expect(updates.status.held).toBe(true);
  });

  it('applies as soon as the work finishes', () => {
    const { updates, apply } = coordinator();
    const release = updates.hold();
    updates.noteAvailable();

    release();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('waits for the last of several holds', () => {
    const { updates, apply } = coordinator();
    const first = updates.hold();
    const second = updates.hold();
    updates.noteAvailable();

    first();
    expect(apply).not.toHaveBeenCalled();

    second();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('ignores a hold released twice, so a real hold cannot fall off the count', () => {
    const { updates, apply } = coordinator();
    const first = updates.hold();
    updates.hold();

    first();
    first();

    expect(updates.holdCount).toBe(1);
    updates.noteAvailable();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does nothing when work finishes and no update is waiting', () => {
    const { updates, apply } = coordinator();
    const release = updates.hold();

    release();

    expect(apply).not.toHaveBeenCalled();
  });

  it('applies once and only once, however often it is asked', () => {
    const { updates, apply } = coordinator();

    updates.noteAvailable();
    updates.noteAvailable();
    updates.applyNow();
    updates.applyNow();

    // Reloading in a loop would make the app unusable, which is worse than being out of date.
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not report an update as still available once it has been applied', () => {
    const { updates } = coordinator();

    updates.noteAvailable();

    expect(updates.status.available).toBe(false);
  });

  it('applies on request even while held, because the user asked for it', () => {
    const { updates, apply } = coordinator();
    updates.hold();
    updates.noteAvailable();

    updates.applyNow();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not apply an update that has not arrived', () => {
    const { updates, apply } = coordinator();

    updates.applyNow();

    expect(apply).not.toHaveBeenCalled();
  });

  it('still applies an update that arrived before the worker was registered', () => {
    const updates = new UpdateCoordinator();
    const apply = vi.fn();

    updates.noteAvailable();
    expect(apply).not.toHaveBeenCalled();

    updates.setApplier(apply);

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('holds an early update until the work in hand is done', () => {
    const updates = new UpdateCoordinator();
    const apply = vi.fn();
    const release = updates.hold();

    updates.noteAvailable();
    updates.setApplier(apply);
    expect(apply).not.toHaveBeenCalled();

    release();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('tells the interface when to offer the update and when to stop', () => {
    const { updates } = coordinator();
    const seen: Array<{ available: boolean; held: boolean }> = [];
    updates.subscribe((status) => seen.push({ ...status }));

    const release = updates.hold();
    updates.noteAvailable();
    release();

    expect(seen[0]).toEqual({ available: false, held: false });
    expect(seen).toContainEqual({ available: true, held: true });
    // Once applied the page is reloading, so the offer goes away rather than repeating.
    expect(seen.at(-1)).toEqual({ available: false, held: false });
  });

  it('stops talking to a listener that has unsubscribed', () => {
    const { updates } = coordinator();
    const listener = vi.fn();
    const unsubscribe = updates.subscribe(listener);
    listener.mockClear();

    unsubscribe();
    updates.hold();

    expect(listener).not.toHaveBeenCalled();
  });
});
