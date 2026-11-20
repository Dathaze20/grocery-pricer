import { describe, expect, it } from 'vitest';
import { associateDiscountLines, attachDiscountLines } from '../discount-lines';
import { DiscountScope } from '../models';
import { Money } from '../money';
import type { AiDiscountLine, AiExtractedItem } from '../ai-types';

/**
 * Synthetic receipts shaped like the real paper.
 *
 * The layout is what matters and it is reproduced exactly: product, barcode, case price and
 * pack, the flyer words, a reference number, the amount off, then a units line. The names are
 * invented - no real receipt text lives in this repository.
 */
function item(over: Partial<AiExtractedItem> = {}): AiExtractedItem {
  return {
    rawName: 'DRYNITE JUMBO #6 21CT',
    canonicalName: 'DryNite Jumbo Size 6',
    brand: 'DRYNITE',
    size: '21 CT',
    upc: null,
    supplierSku: null,
    casePrice: '45.99',
    unitsPerCase: 4,
    printedUnitCost: null,
    casesPurchased: 1,
    discount: null,
    category: null,
    sourcePhotoIds: [1],
    sourceText: ['DRYNITE JUMBO #6 21CT', '45.99   4'],
    confidence: 0.9,
    ...over,
  };
}

/** A clearly different product: nothing about it resembles the one above. */
function other(over: Partial<AiExtractedItem> = {}): AiExtractedItem {
  return item({
    rawName: 'KETTLE CRISPS SEA SALT',
    canonicalName: 'Kettle Crisps Sea Salt',
    brand: 'KETTLE',
    size: '12 CT',
    casePrice: '18.49',
    sourceText: ['KETTLE CRISPS SEA SALT', '18.49   12'],
    ...over,
  });
}

function line(over: Partial<AiDiscountLine> = {}): AiDiscountLine {
  return {
    amount: '7.00',
    productName: 'DRYNITE JUMBO',
    appliesToIndex: 0,
    reference: 'F12',
    sourcePhotoIds: [1],
    sourceText: ['FLYER DISCOUNT', 'F12', '-7.00'],
    ...over,
  };
}

describe('placing a printed discount line', () => {
  it('takes a flyer line four lines below its product', () => {
    const placed = associateDiscountLines([item()], [line()]);

    expect(placed.items[0]!.discount).toEqual({
      amount: '7.00',
      scope: DiscountScope.WHOLE_CASE,
      appliesToUnits: null,
    });
    expect(placed.warnings).toEqual([]);
  });

  it('keeps the reference-number line as evidence of why the cost is what it is', () => {
    const placed = associateDiscountLines([item()], [line()]);

    expect(placed.items[0]!.sourceText).toContain('-7.00');
    expect(placed.items[0]!.sourceText).toContain('F12');
    // And the product's own lines are still there, first.
    expect(placed.items[0]!.sourceText[0]).toBe('DRYNITE JUMBO #6 21CT');
  });

  it('places a line by name when the model could not say which product', () => {
    const placed = associateDiscountLines(
      [other(), item()],
      [line({ appliesToIndex: null })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
  });

  it('asks rather than guesses when the scope is not printed', () => {
    const placed = associateDiscountLines(
      [item()],
      [line({ sourceText: ['SAVINGS', 'R4', '-7.00'] })],
    );

    // Nothing on the line says what the money comes off, so the owner is asked.
    expect(placed.items[0]!.discount?.scope).toBe(DiscountScope.UNKNOWN);
  });
});

describe('two sizes of one product on the same receipt', () => {
  const sizeSix = item({ rawName: 'DRYNITE JUMBO #6 21CT', size: '21 CT' });
  const sizeFive = item({
    rawName: 'DRYNITE JUMBO #5 24CT',
    canonicalName: 'DryNite Jumbo Size 5',
    size: '24 CT',
  });

  it('refuses a line that names both of them equally well', () => {
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO' })],
    );

    // Half of a coin flip here is money off the wrong product, on two products at once.
    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
    expect(placed.warnings[0]).toContain('could not tell which product');
    expect(placed.warnings[0]).toContain('$7.00');
  });

  it('will not let a bare position settle it when the name fits both', () => {
    /*
     * An index is evidence of layout, not of identity.
     *
     * "FLYER DISCOUNT - DRYNITE JUMBO" names the size 6 and the size 5 equally well. A model
     * index pointing at one of them adds nothing printed about which, and taking it as proof
     * would be the same coin flip as before with a number attached to make it look settled.
     */
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [
        line({ appliesToIndex: 0, productName: 'DRYNITE JUMBO' }),
        line({ appliesToIndex: 1, productName: 'DRYNITE JUMBO' }),
      ],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings).toHaveLength(2);
  });

  it('places each size when the paper itself tells them apart', () => {
    // The flyer line carries the pack, which belongs to one of the two and not the other.
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [
        line({
          appliesToIndex: 0,
          productName: 'DRYNITE JUMBO',
          sourceText: ['FLYER DISCOUNT DRYNITE JUMBO 21CT', 'F12', '-7.00'],
        }),
        line({
          appliesToIndex: 1,
          productName: 'DRYNITE JUMBO',
          sourceText: ['FLYER DISCOUNT DRYNITE JUMBO 24CT', 'F13', '-7.00'],
        }),
      ],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
  });

  it('places each size from the layout when the line names nothing', () => {
    // What the real paper prints: the words, a reference, the amount. No product name at all,
    // so the position below its product is the only evidence there is - and it is evidence.
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [
        line({ appliesToIndex: 0, productName: null }),
        line({ appliesToIndex: 1, productName: null }),
      ],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
  });

  it('refuses a position that contradicts the name on the line', () => {
    // The review's case: the line says size 5 and the index says size 6. Two different
    // answers, and reading the index first takes $7.00 off the wrong product.
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 0, productName: 'DRYNITE JUMBO #5 24CT' })],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings).toHaveLength(1);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('refuses it the other way round too', () => {
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 1, productName: 'DRYNITE JUMBO #6 21CT' })],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('follows the name when the index agrees with it', () => {
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 1, productName: 'DRYNITE JUMBO #5 24CT' })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
  });

  it('still takes the index when the name matches nothing on the receipt', () => {
    // A name that answers to no row contradicts no row either. The layout stands.
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 1, productName: 'MYSTERY ITEM' })],
    );

    expect(placed.items[1]!.discount?.amount).toBe('7.00');
  });

  it('places a line that names the size itself', () => {
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO #5 24CT' })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
  });
});

describe('the same product bought twice, each with its own discount', () => {
  it('gives each purchase its own line', () => {
    const placed = associateDiscountLines(
      [item(), item()],
      [
        line({ appliesToIndex: null, amount: '7.00' }),
        line({ appliesToIndex: null, amount: '7.00' }),
      ],
    );

    expect(placed.items.map((i) => i.discount?.amount)).toEqual(['7.00', '7.00']);
    expect(placed.warnings).toEqual([]);
  });

  it('does not put one line on both of them', () => {
    const placed = associateDiscountLines([item(), item()], [line({ appliesToIndex: null })]);

    expect(placed.items.filter((i) => i.discount !== null)).toHaveLength(1);
  });

  it('gives each its own amount when the two differ', () => {
    const placed = associateDiscountLines(
      [item(), item()],
      [
        line({ appliesToIndex: 0, amount: '7.00' }),
        line({ appliesToIndex: 1, amount: '4.50' }),
      ],
    );

    expect(placed.items.map((i) => i.discount?.amount)).toEqual(['7.00', '4.50']);
  });
});

describe('the same discount listed twice', () => {
  it('does not hand the duplicate to the next purchase of the same product', () => {
    /*
     * The fallback that gave a second case a discount nobody printed.
     *
     * The prompt asks for every money-off line even when it has already been nested, so the
     * same deduction arrives twice pointing at the same product. Falling back to matching by
     * name sent the second copy to the next identical purchase - a case with no discount
     * printed against it quietly got $7.00 off, and the order total with it.
     */
    const placed = associateDiscountLines(
      [item(), item()],
      [line({ appliesToIndex: 0 }), line({ appliesToIndex: 0 })],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.items[1]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
    expect(placed.warnings[0]).toContain('listed twice');
  });

  it('says it was counted once rather than leaving it unexplained', () => {
    const placed = associateDiscountLines([item()], [line(), line()]);

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.warnings[0]).toContain('counted once');
  });

  it('still gives two printed purchases their own discounts', () => {
    // Two real lines, one per purchase. Neither is a duplicate of the other.
    const placed = associateDiscountLines(
      [item(), item()],
      [line({ appliesToIndex: 0 }), line({ appliesToIndex: 1, amount: '4.50' })],
    );

    expect(placed.items.map((i) => i.discount?.amount)).toEqual(['7.00', '4.50']);
    expect(placed.warnings).toEqual([]);
  });

  it('gives two purchases their own discounts when neither line gives a position', () => {
    const placed = associateDiscountLines(
      [item(), item()],
      [
        line({ appliesToIndex: null, amount: '7.00' }),
        line({ appliesToIndex: null, amount: '4.50' }),
      ],
    );

    expect(placed.items.map((i) => i.discount?.amount)).toEqual(['7.00', '4.50']);
  });

  it('does not pass a duplicate along to a different product either', () => {
    const placed = associateDiscountLines(
      [item(), other()],
      [line({ appliesToIndex: 0 }), line({ appliesToIndex: 0 })],
    );

    expect(placed.items[1]!.discount).toBeNull();
  });
});

describe('a minus sign the receipt printed', () => {
  it('reads -7.00 on a flyer line as seven dollars off', () => {
    // The paper prints it with the sign and the model copies what it sees. Throwing that away
    // loses a discount that was printed perfectly plainly.
    const placed = associateDiscountLines(
      [item()],
      [line({ amount: '-7.00' })],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
  });

  it('keeps the minus in the evidence, exactly as it was printed', () => {
    const placed = associateDiscountLines([item()], [line({ amount: '-7.00' })]);

    // The card shows what the receipt said, not a tidied version of it.
    expect(placed.items[0]!.sourceText).toContain('-7.00');
  });

  it('takes it off the case, not added on to it', () => {
    const placed = associateDiscountLines([item()], [line({ amount: '-7.00' })]);
    const discount = placed.items[0]!.discount!;

    expect(discount.scope).toBe(DiscountScope.WHOLE_CASE);
    expect(Money.of(discount.amount!).isNegative).toBe(false);
  });

  it('reads it from a line that says savings rather than flyer', () => {
    const placed = associateDiscountLines(
      [item()],
      [line({ amount: '-1.40', sourceText: ['SAVINGS', 'S9', '-1.40'] })],
    );

    expect(placed.items[0]!.discount?.amount).toBe('1.40');
  });

  it('refuses a negative figure on a line that does not say it is money off', () => {
    // A minus on a line with no such word could be a credit, a correction or a misread, and
    // none of those should lower what a case cost.
    const placed = associateDiscountLines(
      [item()],
      [line({ amount: '-7.00', productName: null, reference: null, sourceText: ['ADJ 4471'] })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
  });

  it('normalises the magnitude and leaves judging it to the validator', () => {
    const placed = associateDiscountLines([item()], [line({ amount: '-99.99' })]);

    // Whose line it is, is this module's question; whether $99.99 can come off a $45.99 case is
    // the validator's, and it already refuses that. Two places deciding it would disagree.
    expect(placed.items[0]!.discount?.amount).toBe('99.99');
  });

  it('still treats a negative zero as no discount', () => {
    const placed = associateDiscountLines([item()], [line({ amount: '-0.00' })]);

    expect(placed.items[0]!.discount).toBeNull();
  });
});

describe('what it refuses to do', () => {
  it('invents nothing when the amount cannot be read', () => {
    const placed = associateDiscountLines(
      [item()],
      [line({ amount: 'FLYER', sourceText: ['FLYER DISCOUNT', 'F12'] })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.warnings[0]).toContain('could not be read');
  });

  it('treats a zero as no discount at all', () => {
    const placed = associateDiscountLines([item()], [line({ amount: '0.00' })]);

    expect(placed.items[0]!.discount).toBeNull();
  });

  it('refuses a line it can place on nothing', () => {
    const placed = associateDiscountLines(
      [other()],
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO' })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
  });

  it('refuses a line that names nothing and has no position', () => {
    const placed = associateDiscountLines(
      [item(), other()],
      [line({ appliesToIndex: null, productName: null })],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings).toHaveLength(1);
  });

  it('ignores an index that points outside the order', () => {
    const placed = associateDiscountLines([item()], [line({ appliesToIndex: 9, productName: null })]);

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
  });

  it('leaves a discount the model already attached alone', () => {
    const already = item({
      discount: { amount: '3.00', scope: DiscountScope.WHOLE_CASE, appliesToUnits: null },
    });
    const placed = associateDiscountLines([already], [line()]);

    // The listed line is the same money twice over; it must not double up or overwrite.
    expect(placed.items[0]!.discount?.amount).toBe('3.00');
    expect(placed.warnings).toHaveLength(1);
  });

  it('never takes off more lines than were printed', () => {
    const placed = associateDiscountLines(
      [item(), other()],
      [line({ appliesToIndex: 0 })],
    );

    expect(placed.items.filter((i) => i.discount !== null)).toHaveLength(1);
  });
});

describe('a whole batch', () => {
  it('passes a batch with no discount lines straight through', () => {
    const extraction = { supplier: 'SUPPLIER', items: [item()], warnings: [] };

    expect(attachDiscountLines(extraction)).toBe(extraction);
  });

  it('adds what could not be placed to the batch warnings', () => {
    const attached = attachDiscountLines({
      supplier: 'SUPPLIER',
      items: [item()],
      discountLines: [line({ appliesToIndex: null, productName: null })],
      warnings: ['something else'],
    });

    expect(attached.warnings).toHaveLength(2);
    expect(attached.warnings[0]).toBe('something else');
  });
});
