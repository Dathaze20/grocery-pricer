import { describe, expect, it } from 'vitest';
import { associateDiscountLines, attachDiscountLines } from '../discount-lines';
import { DiscountScope } from '../models';
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

  it('places each size when the layout says which is which', () => {
    const placed = associateDiscountLines(
      [sizeSix, sizeFive],
      [
        line({ appliesToIndex: 0, productName: 'DRYNITE JUMBO' }),
        line({ appliesToIndex: 1, productName: 'DRYNITE JUMBO' }),
      ],
    );

    expect(placed.items[0]!.discount?.amount).toBe('7.00');
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
