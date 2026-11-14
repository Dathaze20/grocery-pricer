import { describe, expect, it } from 'vitest';
import { Money } from '../money';
import { PROFIT_STEP, caseEconomics, priceForTargetProfit, stepProfitTarget } from '../profit';

/**
 * The figures here are invented. They are shaped like a wholesale receipt - a case price, a
 * pack count, a flyer discount - because that is what the arithmetic has to survive, but no
 * real supplier's prices or any shop's pricing decisions appear in this repository.
 */

describe('profit per case', () => {
  it('is case revenue minus what the case cost', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('41.99'),
      sellableUnits: 12,
      retailPrice: Money.of('7.99'),
    });

    expect(result.caseRevenue?.format()).toBe('$95.88');
    expect(result.profitPerCase?.format()).toBe('$53.89');
  });

  it('is not a unit price, a margin or a markup', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('24.00'),
      sellableUnits: 12,
      retailPrice: Money.of('4.00'),
    });

    // Unit cost $2.00, sell at $4.00: a 50% margin and a 100% markup, and $24.00 of PC. The
    // three numbers are different things and only one of them is PC.
    expect(result.unitCost.format()).toBe('$2.00');
    expect(result.profitPerCase?.format()).toBe('$24.00');
  });

  it('keeps the unit cost exact rather than rounding it into the profit', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('10.00'),
      sellableUnits: 3,
      retailPrice: Money.of('5.00'),
    });

    // $3.3333 a unit. Rounding that to $3.33 and multiplying back would lose a cent of cost
    // and overstate the profit by the same cent.
    expect(result.unitCost.formatPrecise()).toBe('$3.3333');
    expect(result.profitPerCase?.format()).toBe('$5.00');
  });

  it('has no profit to report until a price is set', () => {
    const result = caseEconomics({ netCaseCost: Money.of('20.00'), sellableUnits: 10, retailPrice: null });

    expect(result.profitPerCase).toBeNull();
    expect(result.caseRevenue).toBeNull();
    expect(result.unitCost.format()).toBe('$2.00');
    expect(result.belowCost).toBe(false);
  });

  it('separates profit on one case from profit on everything bought', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('30.00'),
      sellableUnits: 6,
      retailPrice: Money.of('8.00'),
      casesPurchased: 4,
    });

    expect(result.profitPerCase?.format()).toBe('$18.00');
    expect(result.totalProfit?.format()).toBe('$72.00');
  });

  it('says when a price sells below cost', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('24.00'),
      sellableUnits: 12,
      retailPrice: Money.of('1.99'),
    });

    expect(result.belowCost).toBe(true);
    expect(result.profitPerCase?.isNegative).toBe(true);
    expect(result.profitPerCase?.format()).toBe('-$0.12');
  });

  it('counts a fraction of a cent under cost as below cost', () => {
    const result = caseEconomics({
      netCaseCost: Money.of('10.00'),
      sellableUnits: 3,
      retailPrice: Money.of('3.33'),
    });

    // $3.3333 a unit against a $3.33 price: three hundredths of a cent lost on every sale.
    expect(result.belowCost).toBe(true);
  });

  it('refuses a case that contains nothing to sell', () => {
    expect(() =>
      caseEconomics({ netCaseCost: Money.of('10.00'), sellableUnits: 0, retailPrice: null }),
    ).toThrow(RangeError);
  });
});

describe('a target profit per case', () => {
  const netCaseCost = Money.of('24.00');
  const units = 12;

  it('moves a dollar at a time', () => {
    const start = Money.of('18.00');
    expect(stepProfitTarget(start, 1).format()).toBe('$19.00');
    expect(stepProfitTarget(start, -1).format()).toBe('$17.00');
    expect(PROFIT_STEP.format()).toBe('$1.00');
  });

  it('raises the shelf price when the target goes up by a dollar', () => {
    const before = priceForTargetProfit(netCaseCost, units, Money.of('24.00'));
    const after = priceForTargetProfit(netCaseCost, units, stepProfitTarget(Money.of('24.00'), 1));

    expect(before.retailPrice.format()).toBe('$4.00');
    expect(after.retailPrice.format()).toBe('$4.09');
    expect(after.achieved.format()).toBe('$25.08');
  });

  it('lowers it when the target goes down by a dollar', () => {
    const after = priceForTargetProfit(netCaseCost, units, stepProfitTarget(Money.of('24.00'), -1));

    expect(after.retailPrice.format()).toBe('$3.92');
    expect(after.achieved.format()).toBe('$23.04');
  });

  it('takes an exact amount with cents', () => {
    for (const target of ['5.47', '12.83', '25.00', '150.00']) {
      const result = priceForTargetProfit(netCaseCost, units, Money.of(target));
      expect(result.achieved.greaterThan(Money.of(target)) || result.exact).toBe(true);
    }
  });

  it('never promises a profit the price cannot produce', () => {
    const result = priceForTargetProfit(netCaseCost, units, Money.of('12.83'));

    // A case of 12 moves in 12-cent steps, so $12.83 is not reachable. The price asked for is
    // the one that clears it, and what it really earns is reported alongside.
    expect(result.exact).toBe(false);
    expect(result.retailPrice.format()).toBe('$3.07');
    expect(result.achieved.format()).toBe('$12.84');
    expect(result.achieved.greaterThan(result.target)).toBe(true);
  });

  it('reports an exact hit as exact', () => {
    const result = priceForTargetProfit(netCaseCost, units, Money.of('12.00'));

    expect(result.exact).toBe(true);
    expect(result.retailPrice.format()).toBe('$3.00');
    expect(result.achieved.format()).toBe('$12.00');
  });

  it('rounds the price up, so a case never earns less than was asked', () => {
    for (const target of ['1.01', '7.77', '19.99', '33.33']) {
      const result = priceForTargetProfit(netCaseCost, units, Money.of(target));
      expect(result.achieved.lessThan(Money.of(target))) .toBe(false);
    }
  });

  it('does not force a price to end in .99', () => {
    const result = priceForTargetProfit(Money.of('30.00'), 6, Money.of('18.00'));
    expect(result.retailPrice.format()).toBe('$8.00');
  });

  it('never returns a negative shelf price', () => {
    const result = priceForTargetProfit(Money.of('10.00'), 10, Money.of('-50.00'));

    expect(result.retailPrice.format()).toBe('$0.00');
    expect(result.retailPrice.isNegative).toBe(false);
    // Giving it away still loses the whole case, and the owner is told so rather than shown a
    // price that would earn the impossible target.
    expect(result.achieved.format()).toBe('-$10.00');
    expect(result.exact).toBe(false);
  });

  it('warns when the target is so low the price falls under cost', () => {
    const result = priceForTargetProfit(Money.of('24.00'), 12, Money.of('-6.00'));

    expect(result.retailPrice.format()).toBe('$1.50');
    expect(result.belowCost).toBe(true);
  });

  it('works for an odd pack count where most targets are unreachable', () => {
    const result = priceForTargetProfit(Money.of('11.85'), 7, Money.of('10.00'));

    // $21.85 over 7 is $3.1214 a unit, so the price is $3.13 and the case earns six cents more
    // than was asked. Seven is a bad number for hitting a target on the nose.
    expect(result.retailPrice.format()).toBe('$3.13');
    expect(result.achieved.format()).toBe('$10.06');
    expect(result.exact).toBe(false);
  });

  it('handles a hundred-count case without drifting', () => {
    const result = priceForTargetProfit(Money.of('52.25'), 100, Money.of('40.00'));

    expect(result.retailPrice.format()).toBe('$0.93');
    expect(result.achieved.format()).toBe('$40.75');
  });
});
