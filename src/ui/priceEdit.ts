import { Money } from '../core/money';

/**
 * What the price box currently means.
 *
 * Derived from the text on screen rather than kept alongside it. Holding a parsed price in its
 * own state lets the two drift: clear the box after typing $6.25 and the box is empty while the
 * state still says $6.25, so Save writes a number nobody can see. Deriving it makes that
 * impossible to express.
 *
 * `negative` and `too-precise` are refusals, not corrections. Quietly turning -3.00 into 0.00,
 * or 6.2549 into 6.25, saves a price the owner never chose and never saw.
 */
export type PriceEditState = 'blank' | 'incomplete' | 'negative' | 'too-precise' | 'valid';

export interface PriceEdit {
  /** The price the box is showing, or null when it is not showing one. */
  readonly value: Money | null;
  readonly state: PriceEditState;
  /** Short, plain reason the box cannot be saved, for the owner to read. Null when there is none. */
  readonly message: string | null;
  /** The box differs from the price that is stored. */
  readonly dirty: boolean;
  /** Safe to write down: a real price, and a change. */
  readonly canSave: boolean;
  /**
   * There is unsaved work here.
   *
   * True for a rejected or emptied box as well as a changed one: all of them are states a
   * reload would throw away, and an automatic update reloads the page.
   */
  readonly holdsUpdates: boolean;
}

/** Digits after the point, counted the way the parser reads them. */
function fractionDigits(text: string): number {
  let body = text;
  if (body.startsWith('(') && body.endsWith(')')) body = body.slice(1, -1);
  if (body.startsWith('-')) body = body.slice(1);
  body = body.replaceAll('$', '').replaceAll(',', '').replaceAll(' ', '').trim();
  // A trailing dot carries no cents, so "6." is two decimal places' worth of nothing.
  if (body.endsWith('.')) body = body.slice(0, -1);
  const point = body.indexOf('.');
  return point === -1 ? 0 : body.length - point - 1;
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
      message: storedText.length > 0 ? 'Type a price, or press Cancel to put it back.' : null,
      dirty: storedText.length > 0,
      canSave: false,
      holdsUpdates: storedText.length > 0,
    };
  }

  const rejected = (state: PriceEditState, message: string): PriceEdit => ({
    value: null,
    state,
    message,
    dirty: true,
    canSave: false,
    holdsUpdates: true,
  });

  const parsed = Money.parseOrNull(trimmed);
  if (parsed === null) return rejected('incomplete', 'That is not a price yet.');

  // Written as a debt, whether with a minus or in brackets. Zero is not a correction of -3.00.
  const writtenNegative = trimmed.startsWith('-') || (trimmed.startsWith('(') && trimmed.endsWith(')'));
  if (parsed.isNegative || writtenNegative) {
    return rejected('negative', 'A price cannot be negative.');
  }

  // Checked against the text, not the parsed amount: the parser itself rounds away anything
  // past four decimals, so 6.25004 would arrive already indistinguishable from $6.25.
  if (fractionDigits(trimmed) > Money.DISPLAY_SCALE) {
    return rejected('too-precise', 'Prices go to the cent - two decimal places at most.');
  }

  // Non-negative and already whole cents, so this keeps the amount exactly as typed.
  const value = parsed.roundedToCents();
  const dirty = stored === null || !value.equals(stored);

  return { value, state: 'valid', message: null, dirty, canSave: dirty, holdsUpdates: dirty };
}

/**
 * Whether a row is holding unsaved work that an automatic update would throw away.
 *
 * The price box is not the only place work is held. A profit-per-case target being typed into
 * the exact box is the owner's reasoning in progress - it has not produced a price yet, so
 * nothing on the row looks dirty, and a reload would silently take it.
 */
export function holdsUnsavedWork(
  edit: PriceEdit,
  targetText: string,
  discountText = '',
): boolean {
  // A discount half-typed off the paper is the same kind of work: unsaved, and only in the box.
  return edit.holdsUpdates || targetText.trim().length > 0 || discountText.trim().length > 0;
}

/**
 * What the discount box currently means.
 *
 * The same reading as a price, with the two rules a discount adds: it is money off, so it may
 * not exceed the case it comes off, and an empty box is simply nothing to apply rather than a
 * change to be rescued. Shares the parsing above on purpose - a second reader would eventually
 * disagree with the first about what "6." means.
 */
export function readDiscountEdit(text: string, casePrice: Money | null): PriceEdit {
  const edit = readPriceEdit(text, null);

  if (edit.state === 'negative') {
    return { ...edit, message: 'A discount is money off - enter it without the minus sign.' };
  }
  if (edit.state === 'too-precise') {
    return { ...edit, message: 'Discounts go to the cent - two decimal places at most.' };
  }
  if (edit.state === 'incomplete') {
    return { ...edit, message: 'That is not an amount yet.' };
  }
  if (edit.value === null) return edit;

  if (edit.value.isZero) {
    return {
      ...edit,
      value: null,
      state: 'incomplete',
      message: 'Nothing off is not a discount.',
      canSave: false,
    };
  }
  // A discount larger than the case is a misread, and applying it would invent money.
  if (casePrice !== null && edit.value.greaterThan(casePrice)) {
    return {
      ...edit,
      value: null,
      state: 'incomplete',
      message: `That is more than the ${casePrice.format()} case.`,
      canSave: false,
    };
  }

  return edit;
}
