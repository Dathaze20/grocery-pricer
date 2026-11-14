import { Money } from '../core/money';

/**
 * What the price box currently means.
 *
 * Derived from the text on screen rather than kept alongside it. Holding a parsed price in its
 * own state lets the two drift: clear the box after typing $6.25 and the box is empty while the
 * state still says $6.25, so Save writes a number nobody can see. Deriving it makes that
 * impossible to express.
 */
export type PriceEditState = 'blank' | 'incomplete' | 'valid';

export interface PriceEdit {
  /** The price the box is showing, or null when it is not showing one. */
  readonly value: Money | null;
  readonly state: PriceEditState;
  /** The box differs from the price that is stored. */
  readonly dirty: boolean;
  /** Safe to write down: a real price, and a change. */
  readonly canSave: boolean;
  /**
   * There is unsaved work here.
   *
   * True for a half-typed or emptied box as well as a changed one: all three are states a
   * reload would throw away, and an automatic update reloads the page.
   */
  readonly holdsUpdates: boolean;
}

/**
 * @param text what is in the box
 * @param stored the price currently saved for this product, if any
 */
export function readPriceEdit(text: string, stored: Money | null): PriceEdit {
  const trimmed = text.trim();
  const storedText = stored === null ? '' : stored.toPlainString();

  if (trimmed.length === 0) {
    return {
      value: null,
      state: 'blank',
      // An empty box is a change when there was a price in it, and that change cannot be
      // saved - there is nothing to save - but it must not be lost to a reload either.
      dirty: storedText.length > 0,
      canSave: false,
      holdsUpdates: storedText.length > 0,
    };
  }

  const parsed = Money.parseOrNull(trimmed);
  if (parsed === null) {
    return {
      value: null,
      state: 'incomplete',
      dirty: true,
      canSave: false,
      holdsUpdates: true,
    };
  }

  // A shelf price is never negative. Typing a minus gives zero, not a debt.
  const value = parsed.isNegative ? Money.ZERO : parsed.roundedToCents();
  const dirty = stored === null || !value.equals(stored);

  return { value, state: 'valid', dirty, canSave: dirty, holdsUpdates: dirty };
}

/**
 * Whether a row is holding unsaved work that an automatic update would throw away.
 *
 * The price box is not the only place work is held. A profit-per-case target being typed into
 * the exact box is the owner's reasoning in progress - it has not produced a price yet, so
 * nothing on the row looks dirty, and a reload would silently take it.
 */
export function holdsUnsavedWork(edit: PriceEdit, targetText: string): boolean {
  return edit.holdsUpdates || targetText.trim().length > 0;
}
