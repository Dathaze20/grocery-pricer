import { describe, expect, it } from 'vitest';
import {
  associateDiscountLines,
  attachCarriedDiscountLines,
  attachDiscountLines,
} from '../discount-lines';
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

  it('refuses the index when the name it gives fits no product at all', () => {
    /*
     * "Matches nothing" is not "contradicts nothing".
     *
     * A name nobody can place is the very case where the index is least likely to be right -
     * something on that line was misread, and there is no telling which part. The layout alone
     * was enough to apply it here, which is money off a product on the strength of evidence
     * that is known to be damaged.
     */
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 1, productName: 'MYSTERY ITEM' })],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings).toHaveLength(1);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('refuses the index when the name belongs to a different product entirely', () => {
    const placed = associateDiscountLines(
      [sizeSix, other()],
      [line({ appliesToIndex: 0, productName: 'KETTLE CRISPS SEA SALT' })],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('refuses the index when the product the name fits already has its discount', () => {
    /*
     * The quiet one.
     *
     * The product the name really belongs to is already holding a discount, so it is not among
     * the candidates any more - and with nothing left for the name to match, the line was
     * applied to whatever the index said instead. That is a second deduction landing on an
     * innocent product because the first one was already spoken for.
     */
    const spokenFor = other({
      discount: { amount: '2.00', scope: DiscountScope.WHOLE_CASE, appliesToUnits: null },
    });
    const placed = associateDiscountLines(
      [spokenFor, sizeSix],
      [line({ appliesToIndex: 1, productName: 'KETTLE CRISPS SEA SALT' })],
    );

    // The crisps keep the $2.00 they came with, and the nappies get nothing.
    expect(placed.items[0]!.discount?.amount).toBe('2.00');
    expect(placed.items[1]!.discount).toBeNull();
    expect(placed.warnings).toHaveLength(1);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('still takes the index for a flyer line that names nothing at all', () => {
    // Unchanged, and the shape the real receipt prints: the words, a reference, the amount.
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [line({ appliesToIndex: 1, productName: null })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
  });

  it('still takes it when the line names nothing and a product is already spoken for', () => {
    const spokenFor = other({
      discount: { amount: '2.00', scope: DiscountScope.WHOLE_CASE, appliesToUnits: null },
    });
    const placed = associateDiscountLines(
      [spokenFor, sizeSix],
      [line({ appliesToIndex: 1, productName: null })],
    );

    expect(placed.items[0]!.discount?.amount).toBe('2.00');
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.warnings).toEqual([]);
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

  it('holds back a line whose product is not in this photograph', () => {
    // Not refused yet: the receipt is read two photographs at a time, and the product this
    // names may be in the next one. Inventing nothing, reporting nothing, keeping it.
    const placed = associateDiscountLines(
      [other()],
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO' })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.warnings).toEqual([]);
    expect(placed.carried).toHaveLength(1);
  });

  it('reports it once the whole order has been looked at', () => {
    const merged = attachCarriedDiscountLines(
      { supplier: 'SUPPLIER', items: [other()], warnings: [] },
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO' })],
    );

    expect(merged.items[0]!.discount).toBeNull();
    expect(merged.warnings).toHaveLength(1);
    expect(merged.warnings[0]).toContain('could not tell which product');
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

    expect(attachDiscountLines(extraction).extraction).toBe(extraction);
  });

  it('adds what could not be placed to the batch warnings', () => {
    const { extraction: attached } = attachDiscountLines({
      supplier: 'SUPPLIER',
      items: [item()],
      discountLines: [line({ appliesToIndex: null, productName: null })],
      warnings: ['something else'],
    });

    expect(attached.warnings).toHaveLength(2);
    expect(attached.warnings[0]).toBe('something else');
  });
});


describe('a discount whose product is in the next photograph', () => {
  it('finds it once the photographs have been stitched together', () => {
    // The flyer line was at the bottom of one photograph, its product at the top of the next.
    const merged = attachCarriedDiscountLines(
      { supplier: 'SUPPLIER', items: [other(), item()], warnings: [] },
      [line({ appliesToIndex: null, productLineAbove: 'DRYNITE JUMBO #6 21CT', productName: null })],
    );

    expect(merged.items[1]!.discount?.amount).toBe('7.00');
    expect(merged.warnings).toEqual([]);
  });

  it('does not use a position from a batch that no longer exists', () => {
    /*
     * The index counted rows in two photographs. In the finished order it points at whatever
     * product happens to sit at that number - which is how a discount lands on something
     * nobody bought it for.
     */
    const merged = attachCarriedDiscountLines(
      { supplier: 'SUPPLIER', items: [other(), item()], warnings: [] },
      [line({ appliesToIndex: 0, productName: 'SOMETHING NOT HERE' })],
    );

    expect(merged.items.every((i) => i.discount === null)).toBe(true);
    expect(merged.warnings).toHaveLength(1);
  });

  it('counts a discount seen in two overlapping photographs once', () => {
    const twice = line({
      appliesToIndex: null,
      productLineAbove: 'DRYNITE JUMBO #6 21CT',
      productName: null,
    });
    const merged = attachCarriedDiscountLines(
      { supplier: 'SUPPLIER', items: [item(), item()], warnings: [] },
      [twice, { ...twice }],
    );

    // One printed discount, seen twice, applied once - not handed to the second case.
    expect(merged.items[0]!.discount?.amount).toBe('7.00');
    expect(merged.items[1]!.discount).toBeNull();
    expect(merged.warnings).toEqual([]);
  });

  it('leaves a product that already has its discount alone', () => {
    const merged = attachCarriedDiscountLines(
      {
        supplier: 'SUPPLIER',
        items: [
          item({ discount: { amount: '7.00', scope: DiscountScope.WHOLE_CASE, appliesToUnits: null } }),
        ],
        warnings: [],
      },
      [line({ appliesToIndex: null, productLineAbove: 'DRYNITE JUMBO #6 21CT', productName: null })],
    );

    expect(merged.items[0]!.discount?.amount).toBe('7.00');
  });
});

describe('a barcode printed with the discount', () => {
  const sixes = item({ upc: '0003700074565' });
  const fives = item({
    rawName: 'DRYNITE JUMBO #5 24CT',
    canonicalName: 'DryNite Jumbo Size 5',
    size: '24 CT',
    upc: '0003700074572',
  });

  it('settles which size the money comes off', () => {
    // The one thing on a receipt that identifies rather than describes: two sizes share every
    // word of their name and nothing of their barcode.
    const placed = associateDiscountLines(
      [sixes, fives],
      [line({ appliesToIndex: null, productName: 'DRYNITE JUMBO', upc: '0003700074572' })],
    );

    expect(placed.items[0]!.discount).toBeNull();
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
  });

  it('beats a position that says otherwise', () => {
    const placed = associateDiscountLines(
      [sixes, fives],
      [line({ appliesToIndex: 0, productName: null, upc: '0003700074572' })],
    );

    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.items[0]!.discount).toBeNull();
  });

  it('is ignored when no product on the receipt carries it', () => {
    const placed = associateDiscountLines(
      [sixes, fives],
      [line({ appliesToIndex: 1, productName: null, upc: '9999999999999' })],
    );

    // Falls back to what else the line has: a position, with nothing contradicting it.
    expect(placed.items[1]!.discount?.amount).toBe('7.00');
  });

  it('does not take the same barcode twice', () => {
    const placed = associateDiscountLines(
      [sixes, sixes],
      [
        line({ appliesToIndex: null, productName: null, upc: '0003700074565' }),
        line({ appliesToIndex: null, productName: null, upc: '0003700074565' }),
      ],
    );

    // Two cases of one product, two printed lines: one each.
    expect(placed.items.map((i) => i.discount?.amount)).toEqual(['7.00', '7.00']);
  });
});

describe('the line printed above the discount', () => {
  it('names the product when the discount line itself names nothing', () => {
    // What the real receipt prints: FLYER DISCOUNT, a reference, the amount - and above it,
    // the product. Copying that line is reading, not bookkeeping.
    const placed = associateDiscountLines(
      [other(), item()],
      [
        line({
          appliesToIndex: null,
          productName: null,
          productLineAbove: 'DRYNITE JUMBO #6 21CT',
        }),
      ],
    );

    expect(placed.items[1]!.discount?.amount).toBe('7.00');
    expect(placed.items[0]!.discount).toBeNull();
  });

  it('has to agree with a position, like any other name', () => {
    const placed = associateDiscountLines(
      [other(), item()],
      [
        line({
          appliesToIndex: 0,
          productName: null,
          productLineAbove: 'DRYNITE JUMBO #6 21CT',
        }),
      ],
    );

    expect(placed.items.every((i) => i.discount === null)).toBe(true);
    expect(placed.warnings[0]).toContain('names one product and points at another');
  });

  it('is preferred over nothing but never over the line\'s own name', () => {
    const placed = associateDiscountLines(
      [other(), item()],
      [
        line({
          appliesToIndex: null,
          productName: 'KETTLE CRISPS SEA SALT',
          productLineAbove: 'DRYNITE JUMBO #6 21CT',
        }),
      ],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
    expect(placed.items[1]!.discount).toBeNull();
  });
});
