import { describe, expect, it } from 'vitest';
import { WarningKind, sortWarnings, warningKind } from '../warnings';

/**
 * The notes a real order came back with.
 *
 * Twenty-four of them, most saying a discount had been listed twice and counted once - the app
 * working correctly, filed under "What could not be read" alongside the two that mattered.
 */
describe('telling the three kinds of note apart', () => {
  it('files a duplicate the app collapsed as handled', () => {
    expect(
      warningKind('The $1.00 discount for SOAP was listed twice on the receipt and has been counted once.'),
    ).toBe(WarningKind.HANDLED);
  });

  it('files a photograph that never came back as unread', () => {
    expect(warningKind('Photo 3 could not be read: Gemini is busy right now.')).toBe(
      WarningKind.UNREAD,
    );
    expect(warningKind('Photos 5 and 6 could not be read: the reply was cut off.')).toBe(
      WarningKind.UNREAD,
    );
  });

  it('files a discount nobody could place as needing review', () => {
    expect(
      warningKind(
        'A discount of $7.00 was printed, but I could not tell which product it belongs to.',
      ),
    ).toBe(WarningKind.REVIEW);
  });

  it('files a note it does not recognise as needing review', () => {
    // An unknown note is likelier to be a problem than a success story, so it stays loud.
    expect(warningKind('Something nobody has written a rule for yet.')).toBe(WarningKind.REVIEW);
  });

  it('keeps a conflicting-evidence note loud', () => {
    expect(
      warningKind(
        'A discount of $7.00 was printed, but the line names one product and points at another.',
      ),
    ).toBe(WarningKind.REVIEW);
  });
});

describe('sorting a real order\'s notes', () => {
  const order = [
    'The $1.00 discount was listed twice on the receipt and has been counted once.',
    'The $0.50 discount for AIR FRESH was listed twice on the receipt and has been counted once.',
    'Photo 7 could not be read: the reply was cut off before it finished.',
    'A discount of $2.00 was printed, but I could not tell which product it belongs to.',
  ];

  it('puts each note in exactly one group', () => {
    const sorted = sortWarnings(order);

    expect(sorted.handled).toHaveLength(2);
    expect(sorted.unread).toHaveLength(1);
    expect(sorted.review).toHaveLength(1);
    expect(sorted.handled.length + sorted.unread.length + sorted.review.length).toBe(order.length);
  });

  it('loses nothing', () => {
    const sorted = sortWarnings(order);
    const all = [...sorted.handled, ...sorted.unread, ...sorted.review];

    for (const warning of order) expect(all).toContain(warning);
  });

  it('copes with an order that has none', () => {
    expect(sortWarnings([])).toEqual({ handled: [], review: [], unread: [] });
  });
});
