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
    // Refused outright. Clamping to $0.00 used to let a typed debt be saved as a free product.
    const edit = readPriceEdit('-3.00', stored);

    expect(edit.value).toBeNull();
    expect(edit.canSave).toBe(false);
  });

  it('refuses an amount finer than a cent rather than rounding it', () => {
    const edit = readPriceEdit('6.2549', stored);

    expect(edit.value).toBeNull();
    expect(edit.canSave).toBe(false);
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

describe('a negative price is refused, not corrected', () => {
  const stored = Money.of('4.99');

  it('does not turn -3.00 into 0.00', () => {
    const edit = readPriceEdit('-3.00', stored);
    expect(edit.state).toBe('negative');
    expect(edit.value).toBeNull();
    expect(edit.canSave).toBe(false);
    expect(edit.message).toBe('A price cannot be negative.');
  });

  it('refuses a minus however it is written', () => {
    for (const text of ['-3.00', '-0.01', '(3.00)', '-6', ' -6.25 ']) {
      const edit = readPriceEdit(text, stored);
      expect(edit.state, text).toBe('negative');
      expect(edit.canSave, text).toBe(false);
    }
  });

  it('refuses a minus that would have parsed to exactly zero', () => {
    // -0.00 reads as $0.00, so the old clamp let it through as a saveable price.
    expect(readPriceEdit('-0.00', stored).state).toBe('negative');
  });

  it('keeps a rejected negative as unsaved work', () => {
    expect(readPriceEdit('-3.00', stored).holdsUpdates).toBe(true);
  });

  it('still accepts the price it was refusing to mangle', () => {
    expect(readPriceEdit('3.00', stored).value?.format()).toBe('$3.00');
  });
});

describe('more than two decimal places is refused, not rounded', () => {
  const stored = Money.of('4.99');

  it('does not turn 6.2549 into 6.25', () => {
    const edit = readPriceEdit('6.2549', stored);
    expect(edit.state).toBe('too-precise');
    expect(edit.value).toBeNull();
    expect(edit.canSave).toBe(false);
    expect(edit.message).toBe('Prices go to the cent - two decimal places at most.');
  });

  it('catches precision the parser would already have rounded away', () => {
    // Money.parseOrNull keeps four decimals and rounds the rest, so 6.25004 arrives as exactly
    // $6.25. Comparing the parsed amount to its own rounding would call this valid; the digits
    // have to be counted in the text the owner typed.
    expect(Money.parseOrNull('6.25004')?.equals(Money.of('6.25'))).toBe(true);
    expect(readPriceEdit('6.25004', stored).state).toBe('too-precise');
    expect(readPriceEdit('6.25004', stored).canSave).toBe(false);
  });

  it('refuses three decimals or more', () => {
    for (const text of ['6.251', '6.2500', '0.001', '$1,234.5678']) {
      const edit = readPriceEdit(text, stored);
      expect(edit.state, text).toBe('too-precise');
      expect(edit.canSave, text).toBe(false);
    }
  });

  it('accepts one and two decimals, and a bare dollar amount', () => {
    expect(readPriceEdit('6.2', stored).value?.format()).toBe('$6.20');
    expect(readPriceEdit('6.25', stored).value?.format()).toBe('$6.25');
    expect(readPriceEdit('6', stored).value?.format()).toBe('$6.00');
    expect(readPriceEdit('6.', stored).value?.format()).toBe('$6.00');
  });

  it('keeps a rejected amount as unsaved work', () => {
    expect(readPriceEdit('6.2549', stored).holdsUpdates).toBe(true);
  });
});

describe('what can be saved is exactly what is displayed', () => {
  it('never saves an amount that differs from the one it shows', () => {
    const stored = Money.of('4.99');
    const texts = [
      '', '   ', '.', '$', 'abc', '6.2.5', '-', '1.2.3',
      '-3.00', '-0.00', '(3.00)', '6.2549', '6.25004', '6.251', '6.2500',
      '6.25', '6.2', '6', '6.', '0.00', '$6.25', ' $6.25 ', '1,234.56',
    ];

    for (const text of texts) {
      const edit = readPriceEdit(text, stored);
      if (!edit.canSave) continue;

      // The row renders edit.value, and save() writes edit.value. The guarantee is that the
      // amount is a faithful reading of the text - never a silent substitution for it.
      const value = edit.value;
      expect(value, text).not.toBeNull();
      expect(value!.isNegative, text).toBe(false);
      expect(value!.equals(value!.roundedToCents()), text).toBe(true);
      expect(Money.parseOrNull(text)!.equals(value!), text).toBe(true);
      expect(readPriceEdit(value!.toPlainString(), stored).value!.equals(value!), text).toBe(true);
    }
  });
});
