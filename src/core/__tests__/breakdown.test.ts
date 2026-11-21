import { describe, expect, it } from 'vitest';
import { Category, DiscountScope, ItemConfidence } from '../models';
import { Money } from '../money';
import { PricingSource } from '../pricing';
import { breakdownOf, breakdownRows, breakdownSentences, netCaseCost } from '../breakdown';
import { nameWithSize } from '../matching';
import type { StoredItem } from '../../data/schema';

/** A row as the receipt was read into it. Invented names, real arithmetic. */
function row(over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: 1,
    orderId: 1,
    productId: 1,
    rawName: 'DRYNITE JUMBO #6 21CT',
    displayName: 'DryNite Jumbo #6',
    size: '21 CT',
    upc: null,
    supplierSku: null,
    category: Category.OTHER,
    casePrice: Money.of('45.99').toStorage(),
    unitsPerCase: 4,
    casesPurchased: 1,
    looseUnits: 0,
    discount: {
      description: 'Receipt discount',
      amount: Money.of('7.00').toStorage(),
      scope: DiscountScope.WHOLE_CASE,
      appliesToUnits: null,
    },
    trueUnitCost: Money.of('9.7475').toStorage(),
    totalWholesaleCost: Money.of('38.99').toStorage(),
    suggestedPrice: Money.of('13.99').toStorage(),
    pricingSource: PricingSource.COST_TIER,
    pricingRationale: null,
    approvedPrice: null,
    previousPrice: null,
    confidence: ItemConfidence.HIGH,
    aiConfidence: 0.9,
    issues: [],
    sourcePhotoIds: [],
    sourceText: [],
    ...over,
  };
}

describe('what one purchase came to', () => {
  it('works out the case, the money off and what is left', () => {
    const breakdown = breakdownOf(row());

    expect(breakdown.casePrice!.format()).toBe('$45.99');
    expect(breakdown.discount!.amount.format()).toBe('$7.00');
    expect(breakdown.netCase!.format()).toBe('$38.99');
    expect(breakdown.unitsPerCase).toBe(4);
    expect(breakdown.unitCost!.roundedToCents().format()).toBe('$9.75');
  });

  it('works out what the case earns at the suggested price', () => {
    const breakdown = breakdownOf(row());

    expect(breakdown.retail!.format()).toBe('$13.99');
    expect(breakdown.caseRevenue!.format()).toBe('$55.96');
    expect(breakdown.profitPerCase!.format()).toBe('$16.97');
    expect(breakdown.profitPerUnit!.roundedToCents().format()).toBe('$4.24');
  });

  it('prefers the price the owner approved, and says it is theirs', () => {
    const breakdown = breakdownOf(row({ approvedPrice: Money.of('12.99').toStorage() }));

    expect(breakdown.approved!.format()).toBe('$12.99');
    expect(breakdown.retail!.format()).toBe('$12.99');
    expect(breakdownSentences(breakdown)).toContain('Your price is $12.99');
  });

  it('calls an unapproved price a suggestion', () => {
    expect(breakdownSentences(breakdownOf(row()))).toContain('The suggested price is $13.99');
  });
});

describe('a case whose pack count nobody has established', () => {
  /** The real Febreze case: the receipt gives the money, not the number of bottles. */
  const febreze = row({
    displayName: 'Air Fresh Spring',
    size: '8.1 OZ',
    casePrice: Money.of('9.89').toStorage(),
    unitsPerCase: null,
    discount: {
      description: 'Receipt discount',
      amount: Money.of('0.50').toStorage(),
      scope: DiscountScope.WHOLE_CASE,
      appliesToUnits: null,
    },
    trueUnitCost: null,
    totalWholesaleCost: null,
    suggestedPrice: null,
  });

  it('still knows what the case cost after the flyer money', () => {
    // $9.89 less $0.50 is $9.39 whether the case holds four bottles or forty.
    expect(breakdownOf(febreze).netCase!.format()).toBe('$9.39');
  });

  it('works out no cost each, and says why', () => {
    const breakdown = breakdownOf(febreze);

    expect(breakdown.unitCost).toBeNull();
    expect(breakdown.profitPerCase).toBeNull();
    expect(breakdown.missing.join(' ')).toContain('how many sellable units are in the case');
  });

  it('shows the missing count in amber rather than inventing one', () => {
    const laid = breakdownRows(breakdownOf(febreze));
    const units = laid.rows.find((r) => r.label === 'In the case');

    expect(units).toEqual({ label: 'In the case', value: 'not established', tone: 'warn' });
    expect(laid.rows.some((r) => r.label === 'Net case' && r.value === '$9.39')).toBe(true);
  });

  it('needs the count for a discount that comes off each one', () => {
    const perUnit = netCaseCost(
      Money.of('9.89'),
      { description: 'x', amount: Money.of('0.50').toStorage(), scope: DiscountScope.PER_UNIT, appliesToUnits: null },
      null,
    );

    // That subtraction genuinely depends on how many there are, so it is not guessed.
    expect(perUnit).toBeNull();
  });
});

describe('where the money off came from', () => {
  it('says the receipt showed it when it was read', () => {
    expect(breakdownSentences(breakdownOf(row()))).toContain('The receipt shows $7.00');
  });

  it('says the owner entered it when they did', () => {
    const entered = row({
      discount: {
        description: 'Entered from the receipt',
        amount: Money.of('7.00').toStorage(),
        scope: DiscountScope.WHOLE_CASE,
        appliesToUnits: null,
      },
    });

    // Never claimed as something that was read: it was typed in, and the answer says so.
    expect(breakdownSentences(breakdownOf(entered))).toContain('You entered $7.00');
    expect(breakdownRows(breakdownOf(entered)).rows.some((r) => r.label === 'Discount you entered')).toBe(true);
  });

  it('says plainly when there was none', () => {
    const plain = row({ discount: null, trueUnitCost: Money.of('11.4975').toStorage() });

    expect(breakdownSentences(breakdownOf(plain))).toContain('No discount was recorded');
    expect(breakdownRows(breakdownOf(plain)).rows.some((r) => r.label === 'Flyer discount')).toBe(false);
  });

  it('does not take off money nobody has said what to do with', () => {
    const open = row({
      discount: {
        description: 'Receipt discount',
        amount: Money.of('7.00').toStorage(),
        scope: DiscountScope.UNKNOWN,
        appliesToUnits: null,
      },
      trueUnitCost: Money.of('11.4975').toStorage(),
    });
    const breakdown = breakdownOf(open);

    expect(breakdown.netCase!.format()).toBe('$45.99');
    expect(breakdown.missing.join(' ')).toContain('not in the cost yet');
  });
});

describe('the figure rows', () => {
  it('colour nothing that the words do not already say', () => {
    const laid = breakdownRows(breakdownOf(row()));

    // Every row names what it is, so the tone only repeats the label.
    for (const entry of laid.rows) expect(entry.label.trim().length).toBeGreaterThan(0);
    expect(laid.rows.find((r) => r.label === 'Flyer discount')).toEqual({
      label: 'Flyer discount',
      value: '−$7.00',
      tone: 'off',
    });
    expect(laid.rows.find((r) => r.label === 'Profit per case')).toEqual({
      label: 'Profit per case',
      value: '$16.97',
      tone: 'keep',
    });
  });

  it('are short enough to read at a glance', () => {
    expect(breakdownRows(breakdownOf(row())).rows.length).toBeLessThanOrEqual(7);
  });
});

describe('saying a size once', () => {
  it('does not repeat a size the name already carries', () => {
    expect(nameWithSize('Pampers Jumbo Diapers #5 24 ct', '24 CT')).toBe(
      'Pampers Jumbo Diapers #5 24 ct',
    );
    expect(nameWithSize('DRYNITE JUMBO #6 21CT', '21 CT')).toBe('DRYNITE JUMBO #6 21CT');
  });

  it('adds a size the name does not have', () => {
    expect(nameWithSize('Example Overnight Pads', '20 CT')).toBe('Example Overnight Pads 20 CT');
  });

  it('is not fooled by a size hiding inside a longer number', () => {
    // "1 CT" is not in "21CT": the digit before it is part of another number.
    expect(nameWithSize('DRYNITE JUMBO 21CT', '1 CT')).toBe('DRYNITE JUMBO 21CT 1 CT');
  });

  it('leaves a product with no size alone', () => {
    expect(nameWithSize('Example Corn Oil', null)).toBe('Example Corn Oil');
  });
});
