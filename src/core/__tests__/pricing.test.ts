import { describe, expect, it } from 'vitest';
import { Money } from '../money';
import { CostCalculator, ProfitCalculator } from '../cost';
import { Category, DiscountScope, makeDiscount } from '../models';
import {
  defaultPricingRules,
  PriceEndings,
  PriceRounding,
  PricingEngine,
  PricingSource,
  tierFor,
} from '../pricing';

describe('CostCalculator', () => {
  it('works out the true unit cost after a whole-case discount', () => {
    // The receipt prints $2.83 a unit. That is the price BEFORE the flyer discount.
    const cost = CostCalculator.calculate({
      casePrice: Money.of('33.99'),
      unitsPerCase: 12,
      discount: makeDiscount('Flyer 43', Money.of('8.00'), DiscountScope.WHOLE_CASE),
    });
    expect(cost.netCaseCost.format()).toBe('$25.99');
    expect(cost.trueUnitCost.format()).toBe('$2.17');
    expect(cost.totalUnits).toBe(12);
  });

  it('a fully discounted case is free, not unpriced', () => {
    const cost = CostCalculator.calculate({
      casePrice: Money.of('33.99'),
      unitsPerCase: 12,
      discount: makeDiscount('All off', Money.of('33.99'), DiscountScope.WHOLE_CASE),
    });
    expect(cost.netCaseCost.isZero).toBe(true);
    expect(cost.trueUnitCost.isZero).toBe(true);
  });

  it('a discount larger than the case never produces a negative cost', () => {
    const cost = CostCalculator.calculate({
      casePrice: Money.of('33.99'),
      unitsPerCase: 12,
      discount: makeDiscount('Misread', Money.of('50.00'), DiscountScope.WHOLE_CASE),
    });
    expect(cost.netCaseCost.isZero).toBe(true);
    expect(cost.netCaseCost.isNegative).toBe(false);
  });

  it('an unknown or ignored discount deliberately does not move the cost', () => {
    // Guessing how a discount applies is how a shelf price ends up wrong.
    for (const scope of [DiscountScope.UNKNOWN, DiscountScope.IGNORED]) {
      const cost = CostCalculator.calculate({
        casePrice: Money.of('33.99'),
        unitsPerCase: 12,
        discount: makeDiscount('Unclear', Money.of('8.00'), scope),
      });
      expect(cost.netCaseCost.format()).toBe('$33.99');
      expect(cost.discountPerCase.isZero).toBe(true);
    }
  });

  it('applies per-unit and subset discounts to the right number of units', () => {
    const perUnit = CostCalculator.calculate({
      casePrice: Money.of('24.00'),
      unitsPerCase: 12,
      discount: makeDiscount('Per unit', Money.of('0.50'), DiscountScope.PER_UNIT),
    });
    expect(perUnit.netCaseCost.format()).toBe('$18.00');

    const subset = CostCalculator.calculate({
      casePrice: Money.of('24.00'),
      unitsPerCase: 12,
      discount: makeDiscount('Six of them', Money.of('0.50'), DiscountScope.UNITS_SUBSET, 6),
    });
    expect(subset.netCaseCost.format()).toBe('$21.00');
  });

  it('a subset discount cannot claim more units than the case holds', () => {
    const cost = CostCalculator.calculate({
      casePrice: Money.of('24.00'),
      unitsPerCase: 12,
      discount: makeDiscount('Forty units', Money.of('0.50'), DiscountScope.UNITS_SUBSET, 40),
    });
    // Capped at 12 x $0.50, not 40 x $0.50.
    expect(cost.netCaseCost.format()).toBe('$18.00');
  });

  it('spreads a flat order-line discount across the cases bought', () => {
    const cost = CostCalculator.calculate({
      casePrice: Money.of('20.00'),
      unitsPerCase: 10,
      casesPurchased: 4,
      discount: makeDiscount('Flat', Money.of('8.00'), DiscountScope.CUSTOM),
    });
    expect(cost.netCaseCost.format()).toBe('$18.00');
    expect(cost.totalWholesaleCost.format()).toBe('$72.00');
  });

  it('a fraction of a cent does not accumulate into a wrong order total', () => {
    const cost = CostCalculator.calculate({
      casePrice: Money.of('10.00'),
      unitsPerCase: 3,
      casesPurchased: 3,
    });
    expect(cost.trueUnitCost.formatPrecise()).toBe('$3.3333');
    // Three cases at ten dollars is thirty dollars. Not $29.9997.
    expect(cost.totalWholesaleCost.format()).toBe('$30.00');
  });

  it('refuses impossible inputs rather than inventing a cost', () => {
    expect(() => CostCalculator.calculate({ casePrice: Money.of('10'), unitsPerCase: 0 })).toThrow();
    expect(() => CostCalculator.calculate({ casePrice: Money.of('10'), unitsPerCase: -1 })).toThrow();
    expect(() =>
      CostCalculator.calculate({ casePrice: Money.of('10'), unitsPerCase: 2, casesPurchased: -1 }),
    ).toThrow();
  });
});

describe('ProfitCalculator', () => {
  it('keeps margin and markup as the different numbers they are', () => {
    const summary = ProfitCalculator.summarise(Money.of('4.20'), Money.of('7.99'));
    expect(summary.grossProfit.format()).toBe('$3.79');
    // margin = 3.79 / 7.99 = 47.4%;  markup = 3.79 / 4.20 = 90.2%
    expect(summary.grossMarginPercent).toBeCloseTo(47.43, 1);
    expect(summary.markupPercent).toBeCloseTo(90.24, 1);
    expect(summary.grossMarginPercent).not.toBeCloseTo(summary.markupPercent ?? 0, 1);
  });

  it('returns null rather than dividing by zero', () => {
    expect(ProfitCalculator.grossMarginPercent(Money.of('1'), Money.ZERO)).toBeNull();
    expect(ProfitCalculator.markupPercent(Money.ZERO, Money.of('5'))).toBeNull();
  });
});

describe('PriceRounding', () => {
  it('moves a target up to the next price with the wanted ending', () => {
    expect(PriceRounding.applyEnding(Money.of('5.16'), PriceEndings.NINETY_NINE).format()).toBe('$5.99');
    expect(PriceRounding.applyEnding(Money.of('7.12'), PriceEndings.NINETY_NINE).format()).toBe('$7.99');
    // Already correct: left alone rather than pushed up a dollar.
    expect(PriceRounding.applyEnding(Money.of('5.99'), PriceEndings.NINETY_NINE).format()).toBe('$5.99');
  });

  it('honours other endings', () => {
    expect(PriceRounding.applyEnding(Money.of('5.16'), PriceEndings.FORTY_NINE).format()).toBe('$5.49');
    expect(PriceRounding.applyEnding(Money.of('5.60'), PriceEndings.WHOLE).format()).toBe('$6.00');
  });

  it('never produces a negative price', () => {
    expect(PriceRounding.applyEnding(Money.of('-1'), PriceEndings.NINETY_NINE).isZero).toBe(true);
    expect(PriceRounding.step(Money.of('0.99'), -5, PriceEndings.NINETY_NINE).isZero).toBe(true);
  });
});

describe('the cost ladder', () => {
  const rules = defaultPricingRules();

  it('resolves every documented boundary to the tier it is printed in', () => {
    expect(tierFor(rules, Money.of('0.00'))?.suggestedPrice.format()).toBe('$2.99');
    expect(tierFor(rules, Money.of('1.24'))?.suggestedPrice.format()).toBe('$2.99');
    expect(tierFor(rules, Money.of('1.25'))?.suggestedPrice.format()).toBe('$3.99');
    expect(tierFor(rules, Money.of('9.99'))?.suggestedPrice.format()).toBe('$13.99');
  });

  it('closes the gaps between printed tiers', () => {
    // A true unit cost is a case price over a pack count and rarely lands on a whole cent.
    // $1.2450 matches neither printed range; it must not fall through to the markup rule.
    expect(tierFor(rules, Money.of('1.2450'))?.suggestedPrice.format()).toBe('$2.99');
    expect(tierFor(rules, Money.of('1.999'))?.suggestedPrice.format()).toBe('$3.99');
  });

  it('has no tier above the top of the ladder', () => {
    expect(tierFor(rules, Money.of('10.00'))).toBeNull();
    expect(tierFor(rules, Money.of('50.00'))).toBeNull();
  });
});

describe('PricingEngine', () => {
  const engine = new PricingEngine();

  it('prices a cost from the ladder', () => {
    const suggestion = engine.suggest({ unitCost: Money.of('2.17') });
    expect(suggestion.suggestedPrice.format()).toBe('$4.99');
    expect(suggestion.source).toBe(PricingSource.COST_TIER);
  });

  it('prices a free case rather than treating zero as no cost', () => {
    // A fully discounted case has a known cost of zero, and the ladder starts at $0.00.
    const suggestion = engine.suggest({ unitCost: Money.ZERO });
    expect(suggestion.suggestedPrice.format()).toBe('$2.99');
    expect(suggestion.source).toBe(PricingSource.COST_TIER);
  });

  it('says so when there is no cost at all', () => {
    const suggestion = engine.suggest({ unitCost: null });
    expect(suggestion.source).toBe(PricingSource.NO_COST);
    expect(suggestion.suggestedPrice.isZero).toBe(true);
  });

  it('a product override beats everything', () => {
    const suggestion = engine.suggest({
      unitCost: Money.of('2.17'),
      productOverridePrice: Money.of('3.49'),
      previousRetailPrice: Money.of('4.99'),
    });
    expect(suggestion.suggestedPrice.format()).toBe('$3.49');
    expect(suggestion.source).toBe(PricingSource.PRODUCT_OVERRIDE);
  });

  it('keeps the price the shop already charges while the margin holds', () => {
    const suggestion = engine.suggest({
      unitCost: Money.of('2.39'),
      previousRetailPrice: Money.of('4.99'),
    });
    expect(suggestion.suggestedPrice.format()).toBe('$4.99');
    expect(suggestion.source).toBe(PricingSource.PREVIOUS_PRICE);
  });

  it('raises the price when the old one no longer clears the minimum margin', () => {
    const suggestion = engine.suggest({
      unitCost: Money.of('4.50'),
      previousRetailPrice: Money.of('4.99'),
    });
    expect(suggestion.source).not.toBe(PricingSource.PREVIOUS_PRICE);
    expect(suggestion.priceReviewRecommended).toBe(true);
  });

  it('uses the markup rule above the top of the ladder', () => {
    const suggestion = engine.suggest({ unitCost: Money.of('20.00') });
    expect(suggestion.source).toBe(PricingSource.MARKUP);
    // 20 x 1.60 = 32.00 -> next .99 ending
    expect(suggestion.suggestedPrice.format()).toBe('$32.99');
  });

  it('never offers an alternative at or below cost', () => {
    const suggestion = engine.suggest({ unitCost: Money.of('2.17'), category: Category.OTHER });
    for (const alternative of suggestion.alternatives) {
      expect(alternative.greaterThan(Money.of('2.17'))).toBe(true);
    }
  });

  it('flags a suggestion that falls under the minimum margin', () => {
    const suggestion = engine.suggest({
      unitCost: Money.of('4.00'),
      productOverridePrice: Money.of('4.50'),
    });
    expect(suggestion.belowMinimumMargin).toBe(true);
  });
});
