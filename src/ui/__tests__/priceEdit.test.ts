import { describe, expect, it } from 'vitest';
import { Money } from '../../core/money';
import { holdsUnsavedWork, readPriceEdit } from '../priceEdit';

/**
 * What the price box means, and what may be done with it.
 *
 * The case that matters most: a box emptied after typing something. Nothing can be saved from
 * it, because there is nothing in it - and in particular it must not save whatever was typed
 * before it was cleared.
 */

const stored = Money.of('4.99');

describe('an emptied box', () => {
  it('has no price to save', () => {
    const edit = readPriceEdit('', stored);

    expect(edit.value).toBeNull();
    expect(edit.state).toBe('blank');
    expect(edit.canSave).toBe(false);
  });

  it('cannot save the number that was typed before it was cleared', () => {
    // Type $6.25, then delete it. The box shows nothing, so nothing is what Save has to work
    // with - $6.25 is gone from the screen and must be gone from the save too.
    const typed = readPriceEdit('6.25', stored);
    expect(typed.canSave).toBe(true);
    expect(typed.value?.format()).toBe('$6.25');

    const cleared = readPriceEdit('', stored);
    expect(cleared.canSave).toBe(false);
    expect(cleared.value).toBeNull();
  });

  it('counts as unsaved work, so an update must not reload it away', () => {
    expect(readPriceEdit('', stored).holdsUpdates).toBe(true);
    expect(readPriceEdit('', stored).dirty).toBe(true);
  });

  it('is not a change when there was no price to begin with', () => {
    const edit = readPriceEdit('', null);

    expect(edit.dirty).toBe(false);
    expect(edit.holdsUpdates).toBe(false);
    expect(edit.canSave).toBe(false);
  });

  it('treats a box of spaces as empty', () => {
    expect(readPriceEdit('   ', stored).state).toBe('blank');
    expect(readPriceEdit('   ', stored).canSave).toBe(false);
  });
});

describe('a half-typed box', () => {
  it('has no price to save', () => {
    for (const text of ['.', '$', 'abc', '6.2.5', '-', '1.2.3']) {
      const edit = readPriceEdit(text, stored);
      expect(edit.state, text).toBe('incomplete');
      expect(edit.canSave, text).toBe(false);
      expect(edit.value, text).toBeNull();
    }
  });

  it('holds off an update while it is being typed', () => {
    expect(readPriceEdit('abc', stored).holdsUpdates).toBe(true);
  });

  it('reads a trailing dot as whole dollars, because it can only mean that', () => {
    const edit = readPriceEdit('6.', stored);

    expect(edit.state).toBe('valid');
    expect(edit.value?.format()).toBe('$6.00');
    // $6.00 is what the row shows while that is in the box, so saving it saves what is on
    // screen rather than something else.
    expect(edit.canSave).toBe(true);
  });
});

describe('a box with a price in it', () => {
  it('can be saved when it differs from what is stored', () => {
    const edit = readPriceEdit('6.25', stored);

    expect(edit.state).toBe('valid');
    expect(edit.value?.format()).toBe('$6.25');
    expect(edit.dirty).toBe(true);
    expect(edit.canSave).toBe(true);
    expect(edit.holdsUpdates).toBe(true);
  });

  it('is not worth saving when it matches what is stored', () => {
    const edit = readPriceEdit('4.99', stored);

    expect(edit.dirty).toBe(false);
    expect(edit.canSave).toBe(false);
    // Nothing unsaved, so an update may land.
    expect(edit.holdsUpdates).toBe(false);
  });

  it('can always be saved when nothing is stored yet', () => {
    const edit = readPriceEdit('4.99', null);

    expect(edit.dirty).toBe(true);
    expect(edit.canSave).toBe(true);
  });

  it('never yields a negative price', () => {
    const edit = readPriceEdit('-3.00', stored);

    expect(edit.value?.format()).toBe('$0.00');
    expect(edit.value?.isNegative).toBe(false);
  });

  it('holds a price to whole cents', () => {
    expect(readPriceEdit('6.2549', stored).value?.format()).toBe('$6.25');
  });

  it('accepts a dollar sign and surrounding space', () => {
    expect(readPriceEdit(' $6.25 ', stored).value?.format()).toBe('$6.25');
  });
});

describe('holdsUnsavedWork', () => {
  const settled = readPriceEdit('4.99', Money.of('4.99'));

  it('holds nothing when the row is settled and no target is being typed', () => {
    expect(settled.dirty).toBe(false);
    expect(holdsUnsavedWork(settled, '')).toBe(false);
  });

  it('protects an exact profit target being typed, before it has produced a price', () => {
    // Nothing on the row is dirty yet - the target has not been applied. A reload would still
    // take the number the owner was in the middle of entering.
    expect(holdsUnsavedWork(settled, '12.8')).toBe(true);
  });

  it('ignores whitespace left in the target box', () => {
    expect(holdsUnsavedWork(settled, '   ')).toBe(false);
  });

  it('protects an emptied price box even with the target box untouched', () => {
    expect(holdsUnsavedWork(readPriceEdit('', Money.of('4.99')), '')).toBe(true);
  });

  it('protects a half-typed price', () => {
    expect(holdsUnsavedWork(readPriceEdit('6.', Money.of('4.99')), '')).toBe(true);
  });
});
