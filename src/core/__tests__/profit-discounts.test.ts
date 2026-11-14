import { describe, expect, it } from 'vitest';
import { CostCalculator } from '../cost';
import { Money } from '../money';
import { DiscountScope, makeDiscount } from '../models';
import { caseEconomics } from '../profit';

/**
 * Profit per case has to agree with the engine that priced the order.
 *
 * The figures are invented. What matters is that the net case cost behind PC comes from
 * CostCalculator for every discount scope, rather than the screen subtracting the printed
 * discount from the case price - which is right only for a whole-case discount and wrong,
 * quietly and in the shop's favour, for every other kind.
 */

const CASE_PRICE = Money.of('24.00');
const UNITS = 12;
const RETAIL = Money.of('4.00');

function pcFor(discount: Parameters<typeof CostCalculator.calculate>[0]['discount']): {
  net: Money;
  pc: Money;
} {
  const breakdown = CostCalculator.calculate({
    casePrice: CASE_PRICE,
    unitsPerCase: UNITS,
    casesPurchased: 1,
    discount,
  });
  const economics = caseEconomics({
    netCaseCost: breakdown.netCaseCost,
    sellableUnits: UNITS,
    retailPrice: RETAIL,
  });
  return { net: breakdown.netCaseCost, pc: economics.profitPerCase! };
}

describe('profit per case across every discount scope', () => {
  it('no discount at all', () => {
    const { net, pc } = pcFor(null);
    expect(net.format()).toBe('$24.00');
    expect(pc.format()).toBe('$24.00');
  });

  it('a whole-case discount comes off the case once', () => {
    const { net, pc } = pcFor(
      makeDiscount('Flyer', Money.of('3.00'), DiscountScope.WHOLE_CASE),
    );
    expect(net.format()).toBe('$21.00');
    expect(pc.format()).toBe('$27.00');
  });

  it('a per-unit discount comes off every unit in the case', () => {
    const { net, pc } = pcFor(makeDiscount('Flyer', Money.of('0.50'), DiscountScope.PER_UNIT));
    // $0.50 x 12, not $0.50 once. Subtracting the printed figure would understate the saving
    // by $5.50 and the profit with it.
    expect(net.format()).toBe('$18.00');
    expect(pc.format()).toBe('$30.00');
  });

  it('a subset discount applies only to the units it names', () => {
    const { net, pc } = pcFor(
      makeDiscount('Flyer', Money.of('0.50'), DiscountScope.UNITS_SUBSET, 4),
    );
    expect(net.format()).toBe('$22.00');
    expect(pc.format()).toBe('$26.00');
  });

  it('a custom discount is spread over the cases bought', () => {
    const breakdown = CostCalculator.calculate({
      casePrice: CASE_PRICE,
      unitsPerCase: UNITS,
      casesPurchased: 4,
      discount: makeDiscount('Deal', Money.of('8.00'), DiscountScope.CUSTOM),
    });
    const economics = caseEconomics({
      netCaseCost: breakdown.netCaseCost,
      sellableUnits: UNITS,
      retailPrice: RETAIL,
      casesPurchased: 4,
    });

    // $8.00 off four cases is $2.00 off each, not $8.00 off each.
    expect(breakdown.netCaseCost.format()).toBe('$22.00');
    expect(economics.profitPerCase?.format()).toBe('$26.00');
    expect(economics.totalProfit?.format()).toBe('$104.00');
  });

  it('an unknown scope does not move the cost at all', () => {
    const { net, pc } = pcFor(makeDiscount('Flyer', Money.of('3.00'), DiscountScope.UNKNOWN));
    // Until somebody says what it applies to, guessing would change what a customer is charged.
    expect(net.format()).toBe('$24.00');
    expect(pc.format()).toBe('$24.00');
  });

  it('an ignored discount does not move the cost either', () => {
    const { net } = pcFor(makeDiscount('Flyer', Money.of('3.00'), DiscountScope.IGNORED));
    expect(net.format()).toBe('$24.00');
  });

  it('a discount bigger than the case cannot drive the cost below zero', () => {
    const { net, pc } = pcFor(makeDiscount('Flyer', Money.of('99.00'), DiscountScope.WHOLE_CASE));
    expect(net.format()).toBe('$0.00');
    expect(pc.format()).toBe('$48.00');
  });

  it('agrees with the cost engine on the unit cost as well', () => {
    const breakdown = CostCalculator.calculate({
      casePrice: CASE_PRICE,
      unitsPerCase: UNITS,
      discount: makeDiscount('Flyer', Money.of('0.50'), DiscountScope.PER_UNIT),
    });
    const economics = caseEconomics({
      netCaseCost: breakdown.netCaseCost,
      sellableUnits: UNITS,
      retailPrice: RETAIL,
    });

    expect(economics.unitCost.format()).toBe(breakdown.trueUnitCost.format());
    expect(economics.unitCost.format()).toBe('$1.50');
  });
});
