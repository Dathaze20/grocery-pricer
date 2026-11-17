import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../cost';
import { Money } from '../money';
import { DiscountScope, makeDiscount } from '../models';

/**
 * Three products checked against real Jetro receipts, with the figures the shop verified.
 *
 * These exist to answer one question precisely: is the arithmetic wrong, or is the scope of
 * the discount never arriving? Every expected figure here came off a receipt, not out of this
 * file.
 */
const PAMPERS = { casePrice: '45.99', unitsPerCase: 4, discount: '7.00', correct: '9.75' };
const CESAR = { casePrice: '29.39', unitsPerCase: 4, discount: '1.40', correct: '7.00' };
const FEBREZE = { casePrice: '9.89', unitsPerCase: 4, discount: '0.50', correct: '2.35' };

function unitCost(
  input: { casePrice: string; unitsPerCase: number; discount: string },
  scope: DiscountScope,
): Money {
  return CostCalculator.calculate({
    casePrice: Money.of(input.casePrice),
    unitsPerCase: input.unitsPerCase,
    casesPurchased: 1,
    discount: makeDiscount('Flyer', Money.of(input.discount), scope),
  }).trueUnitCost;
}

describe('the calculator, given the scope the receipt actually means', () => {
  it('Pampers Jumbo Size 6: $45.99 case, 4 packages, $7.00 flyer', () => {
    expect(unitCost(PAMPERS, DiscountScope.WHOLE_CASE).format()).toBe('$9.75');
  });

  it('Cesar Filet Mignon 2.7 lb: $29.39 case, 4 units, $1.40 flyer', () => {
    expect(unitCost(CESAR, DiscountScope.WHOLE_CASE).format()).toBe('$7.00');
  });

  it('Febreze Air Spring Clean 8.1 oz: $9.89 pack, 4 bottles, $0.50 flyer', () => {
    expect(unitCost(FEBREZE, DiscountScope.WHOLE_CASE).format()).toBe('$2.35');
  });
});

describe('the same products when the scope never arrives', () => {
  it('reproduces the exact wrong figures the shop saw on its phone', () => {
    // This is the whole diagnosis. UNKNOWN does not move the cost, so the discount is simply
    // absent from the arithmetic - and these are, to the cent, the numbers that were wrong.
    expect(unitCost(PAMPERS, DiscountScope.UNKNOWN).format()).toBe('$11.50');
    expect(unitCost(CESAR, DiscountScope.UNKNOWN).format()).toBe('$7.35');
  });

  it('is not the calculator being wrong - the same input with a scope is right', () => {
    const withoutScope = unitCost(PAMPERS, DiscountScope.UNKNOWN);
    const withScope = unitCost(PAMPERS, DiscountScope.WHOLE_CASE);

    expect(withoutScope.format()).toBe('$11.50');
    expect(withScope.format()).toBe('$9.75');
    // The difference is exactly the discount spread over the four packages.
    expect(withoutScope.minus(withScope).format()).toBe('$1.75');
    expect(Money.of('7.00').divideBy(4).roundedToCents().format()).toBe('$1.75');
  });

  it('an ignored discount behaves the same way, by design', () => {
    expect(unitCost(CESAR, DiscountScope.IGNORED).format()).toBe('$7.35');
  });
});
