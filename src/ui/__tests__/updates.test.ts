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
    updates.requestApply();
    updates.requestApply();

    // Reloading in a loop would make the app unusable, which is worse than being out of date.
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not report an update as still available once it has been applied', () => {
    const { updates } = coordinator();

    updates.noteAvailable();

    expect(updates.status.available).toBe(false);
  });

  it('applies on request when the hold is only about where you are standing', () => {
    const { updates, apply } = coordinator();
    updates.hold('soft');
    updates.noteAvailable();

    updates.requestApply();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('refuses to interrupt work in flight even when asked outright', () => {
    const { updates, apply } = coordinator();
    const release = updates.hold('blocking');
    updates.noteAvailable();

    updates.requestApply();

    // Tapping a button is not consent to lose a receipt that is still being read: the person
    // tapping cannot see that a request is in the air.
    expect(apply).not.toHaveBeenCalled();
    expect(updates.status.requested).toBe(true);

    release();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not apply an update that has not arrived', () => {
    const { updates, apply } = coordinator();

    updates.requestApply();

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

  it('keeps holding when the screen goes away while the work carries on', () => {
    const { updates, apply } = coordinator();
    // What an operation does: take the hold before starting, release it in a finally.
    const release = updates.hold('blocking');

    // Back is pressed. The screen unmounts, and anything it had registered goes with it.
    const screenHold = updates.hold('soft');
    screenHold();

    updates.noteAvailable();

    // The request is still in the air, so nothing reloads.
    expect(apply).not.toHaveBeenCalled();
    expect(updates.blockingCount).toBe(1);

    release();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('lets a soft hold through while a blocking one still stands', () => {
    const { updates, apply } = coordinator();
    const work = updates.hold('blocking');
    const screen = updates.hold('soft');
    updates.noteAvailable();

    screen();
    expect(apply).not.toHaveBeenCalled();

    work();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('reports work in flight separately from merely being somewhere', () => {
    const { updates } = coordinator();
    const screen = updates.hold('soft');
    expect(updates.status).toMatchObject({ held: true, blocked: false });

    const work = updates.hold('blocking');
    expect(updates.status).toMatchObject({ held: true, blocked: true });

    work();
    expect(updates.status).toMatchObject({ held: true, blocked: false });
    screen();
    expect(updates.status).toMatchObject({ held: false, blocked: false });
  });

  it('tells the interface when to offer the update and when to stop', () => {
    const { updates } = coordinator();
    const seen: Array<Record<string, boolean>> = [];
    updates.subscribe((status) => seen.push({ ...status }));

    const release = updates.hold();
    updates.noteAvailable();
    release();

    expect(seen[0]).toMatchObject({ available: false, held: false });
    expect(seen).toContainEqual(expect.objectContaining({ available: true, held: true }));
    // Once applied the page is reloading, so the offer goes away rather than repeating.
    expect(seen.at(-1)).toMatchObject({ available: false, held: false });
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
