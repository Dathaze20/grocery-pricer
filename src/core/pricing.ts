import { Money } from './money';
import { Category, CATEGORY_LABELS } from './models';
import { ProfitCalculator } from './cost';

/** The cents a suggested price should end in. `.99` is only the default. */
export interface PriceEnding {
  readonly cents: number;
  readonly label: string;
}

export const PriceEndings = {
  NINETY_NINE: { cents: 99, label: '.99' } as PriceEnding,
  FORTY_NINE: { cents: 49, label: '.49' } as PriceEnding,
  WHOLE: { cents: 0, label: '.00' } as PriceEnding,

  custom(cents: number): PriceEnding {
    if (!Number.isInteger(cents) || cents < 0 || cents > 99) {
      throw new RangeError('A price ending must be between 0 and 99 cents');
    }
    return { cents, label: `.${String(cents).padStart(2, '0')}` };
  },

  fromCents(cents: number): PriceEnding {
    return (
      [PriceEndings.NINETY_NINE, PriceEndings.FORTY_NINE, PriceEndings.WHOLE].find(
        (e) => e.cents === cents,
      ) ?? PriceEndings.custom(cents)
    );
  },
};

/** One row of the cost ladder: "anything costing between X and Y starts at this shelf price". */
export interface CostTier {
  readonly minCost: Money;
  readonly maxCost: Money;
  readonly suggestedPrice: Money;
  readonly alternatePrice?: Money | null;
}

export function tierLabel(tier: CostTier): string {
  return `${tier.minCost.format()} - ${tier.maxCost.format()}`;
}

/** Optional per-category override: its own markup, its own ending, and/or a whole-dollar nudge. */
export interface CategoryPricingRule {
  readonly category: Category;
  readonly markupPercent?: number | null;
  readonly priceEnding?: PriceEnding | null;
  readonly tierSteps: number;
  readonly enabled: boolean;
}

export interface PricingRules {
  readonly tiers: readonly CostTier[];
  /** Applied to any cost above the highest tier. */
  readonly highCostMarkupPercent: number;
  readonly defaultEnding: PriceEnding;
  readonly categoryRules: Partial<Record<Category, CategoryPricingRule>>;
  /** A suggested price below this gross margin raises a warning. */
  readonly minimumGrossMarginPercent: number;
  /** A wholesale cost move of at least this much is worth telling the user about. */
  readonly costChangeAlertPercent: number;
}

/**
 * Starting ladder for a small neighbourhood deli - convenience-store margins, not supermarket
 * margins. Every row is editable in Settings.
 */
export function defaultTiers(): CostTier[] {
  const tier = (min: string, max: string, price: string, alt?: string): CostTier => ({
    minCost: Money.of(min),
    maxCost: Money.of(max),
    suggestedPrice: Money.of(price),
    alternatePrice: alt === undefined ? null : Money.of(alt),
  });
  return [
    tier('0.00', '1.24', '2.99'),
    tier('1.25', '1.99', '3.99'),
    tier('2.00', '2.99', '4.99', '5.99'),
    tier('3.00', '3.99', '5.99', '6.99'),
    tier('4.00', '4.99', '7.99', '8.99'),
    tier('5.00', '5.99', '8.99', '9.99'),
    tier('6.00', '7.99', '10.99', '12.99'),
    tier('8.00', '9.99', '13.99', '15.99'),
  ];
}

export function defaultPricingRules(): PricingRules {
  return {
    tiers: defaultTiers(),
    highCostMarkupPercent: 60,
    defaultEnding: PriceEndings.NINETY_NINE,
    categoryRules: {},
    minimumGrossMarginPercent: 30,
    costChangeAlertPercent: 10,
  };
}

/**
 * The tier a cost belongs to.
 *
 * A true unit cost is a case price divided by a pack count, so it rarely lands on a whole cent -
 * $1.2450 is an ordinary result. The ladder is therefore read as contiguous bands: a cost belongs
 * to the last tier that starts at or below it. Matching each tier's printed range literally would
 * leave a gap between $1.24 and $1.25 that costs fell through. Anything above the top of the
 * ladder has no tier and uses the markup rule instead.
 */
export function tierFor(rules: PricingRules, cost: Money): CostTier | null {
  if (rules.tiers.length === 0) return null;
  const ordered = [...rules.tiers].sort((a, b) => a.minCost.compareTo(b.minCost));
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  if (cost.lessThan(first.minCost)) return null;
  if (cost.greaterThan(last.maxCost)) return null;
  let match: CostTier | null = null;
  for (const candidate of ordered) {
    if (candidate.minCost.compareTo(cost) <= 0) match = candidate;
  }
  return match;
}

export function categoryRuleFor(
  rules: PricingRules,
  category: Category,
): CategoryPricingRule | null {
  const rule = rules.categoryRules[category];
  return rule !== undefined && rule.enabled ? rule : null;
}

/**
 * Applies a configured price ending to a target price.
 *
 * Not "round to the nearest .99". The rules decide the target first; this moves it up to the next
 * price that ends the way the store wants. $5.16 becomes $5.99, and a price that already ends
 * correctly is left alone.
 */
export const PriceRounding = {
  applyEnding(target: Money, ending: PriceEnding): Money {
    if (!target.isPositive) return Money.ZERO;
    const dollars = Math.floor(target.toStorage() / 10_000);
    const endingPart = Money.ofCents(ending.cents);
    let candidate = Money.of(dollars).plus(endingPart);
    if (candidate.lessThan(target)) {
      candidate = Money.of(dollars + 1).plus(endingPart);
    }
    return candidate.roundedToCents();
  },

  /** Moves a price up or down by whole dollars, keeping its ending. Used by category rules. */
  step(price: Money, steps: number, ending: PriceEnding): Money {
    if (steps === 0) return price;
    const moved = price.plus(Money.of(steps));
    return moved.isPositive ? PriceRounding.applyEnding(moved, ending) : Money.ZERO;
  },
};

export const PricingSource = {
  PRODUCT_OVERRIDE: 'PRODUCT_OVERRIDE',
  PREVIOUS_PRICE: 'PREVIOUS_PRICE',
  CATEGORY_RULE: 'CATEGORY_RULE',
  COST_TIER: 'COST_TIER',
  MARKUP: 'MARKUP',
  NO_COST: 'NO_COST',
} as const;
export type PricingSource = (typeof PricingSource)[keyof typeof PricingSource];

export const PRICING_SOURCE_LABELS: Record<PricingSource, string> = {
  PRODUCT_OVERRIDE: 'Product-specific price',
  PREVIOUS_PRICE: 'Your previous store price',
  CATEGORY_RULE: 'Category rule',
  COST_TIER: 'Cost tier',
  MARKUP: 'Markup rule',
  NO_COST: 'No cost available',
};

/** A price proposal. Nothing here is final until the user approves it. */
export interface PricingSuggestion {
  readonly suggestedPrice: Money;
  readonly source: PricingSource;
  readonly rationale: string;
  readonly alternatives: readonly Money[];
  readonly previousPrice?: Money | null;
  /** True when the old shelf price no longer clears the minimum margin at the new cost. */
  readonly priceReviewRecommended: boolean;
  readonly belowMinimumMargin: boolean;
}

interface Baseline {
  price: Money;
  source: PricingSource;
  rationale: string;
}

/**
 * Turns a true unit cost into a suggested shelf price.
 *
 * Resolution order, exactly as the store owner described it:
 *   1. a price pinned to this specific product
 *   2. the price it was last sold at, if it still clears the minimum margin
 *   3. the category rule, if one is switched on
 *   4. the global cost ladder
 *   5. a markup for anything above the top of the ladder
 *
 * Nothing here is automatic: the result is a *suggestion* the user still approves.
 */
export class PricingEngine {
  constructor(private readonly rules: PricingRules = defaultPricingRules()) {}

  suggest(params: {
    unitCost: Money | null;
    category?: Category;
    previousRetailPrice?: Money | null;
    productOverridePrice?: Money | null;
  }): PricingSuggestion {
    const { unitCost } = params;
    const category = params.category ?? Category.OTHER;
    const previousRetailPrice = params.previousRetailPrice ?? null;
    const productOverridePrice = params.productOverridePrice ?? null;

    const ending = this.endingFor(category);

    // A cost of exactly zero is a known cost (a fully discounted case), not a missing one.
    // Only null - nothing was read - means the price cannot be worked out.
    if (unitCost === null || unitCost.isNegative) {
      const fallback = productOverridePrice ?? previousRetailPrice ?? Money.ZERO;
      return {
        suggestedPrice: fallback,
        source: PricingSource.NO_COST,
        rationale: 'No wholesale cost is known for this product yet.',
        previousPrice: previousRetailPrice,
        alternatives: this.alternativesAround(fallback, unitCost, ending),
        priceReviewRecommended: false,
        belowMinimumMargin: false,
      };
    }

    const baseline = this.baselinePrice(unitCost, category, ending);

    if (productOverridePrice !== null && productOverridePrice.isPositive) {
      return this.finish({
        price: productOverridePrice,
        source: PricingSource.PRODUCT_OVERRIDE,
        rationale: 'This product has its own fixed price.',
        unitCost,
        previousPrice: previousRetailPrice,
        ending,
      });
    }

    if (previousRetailPrice !== null && previousRetailPrice.isPositive) {
      const marginAtPrevious = ProfitCalculator.grossMarginPercent(unitCost, previousRetailPrice);
      const stillHealthy =
        marginAtPrevious !== null && marginAtPrevious >= this.rules.minimumGrossMarginPercent;
      if (stillHealthy) {
        return this.finish({
          price: previousRetailPrice,
          source: PricingSource.PREVIOUS_PRICE,
          rationale: 'Keeps the price you used last time; the margin still holds at the new cost.',
          unitCost,
          previousPrice: previousRetailPrice,
          ending,
        });
      }
      return this.finish({
        price: baseline.price,
        source: baseline.source,
        rationale: `Cost has risen far enough that ${previousRetailPrice.format()} no longer holds your minimum margin. ${baseline.rationale}`,
        unitCost,
        previousPrice: previousRetailPrice,
        ending,
        priceReviewRecommended: true,
      });
    }

    return this.finish({
      price: baseline.price,
      source: baseline.source,
      rationale: baseline.rationale,
      unitCost,
      previousPrice: null,
      ending,
    });
  }

  /** The ladder/category/markup answer, before previous-price and override handling. */
  private baselinePrice(unitCost: Money, category: Category, ending: PriceEnding): Baseline {
    const categoryRule = categoryRuleFor(this.rules, category);

    const markupPercent = categoryRule?.markupPercent;
    if (markupPercent !== null && markupPercent !== undefined) {
      const target = unitCost.times(1 + markupPercent / 100);
      return {
        price: PriceRounding.applyEnding(target, ending),
        source: PricingSource.CATEGORY_RULE,
        rationale: `${CATEGORY_LABELS[category]} rule: ${trimNumber(markupPercent)}% markup on cost.`,
      };
    }

    const tier = tierFor(this.rules, unitCost);
    if (tier !== null) {
      const steps = categoryRule?.tierSteps ?? 0;
      const stepped = PriceRounding.step(tier.suggestedPrice, steps, ending);
      const priced = PriceRounding.applyEnding(stepped, ending);
      const usesCategory = steps !== 0 || (categoryRule?.priceEnding ?? null) !== null;
      return {
        price: priced,
        source: usesCategory ? PricingSource.CATEGORY_RULE : PricingSource.COST_TIER,
        rationale: usesCategory
          ? `${CATEGORY_LABELS[category]} rule applied on top of the ${tierLabel(tier)} cost tier.`
          : `Cost tier ${tierLabel(tier)}.`,
      };
    }

    const markup = this.rules.highCostMarkupPercent;
    return {
      price: PriceRounding.applyEnding(unitCost.times(1 + markup / 100), ending),
      source: PricingSource.MARKUP,
      rationale: `Above the top cost tier, so a ${trimNumber(markup)}% markup was used.`,
    };
  }

  private finish(params: {
    price: Money;
    source: PricingSource;
    rationale: string;
    unitCost: Money;
    previousPrice: Money | null;
    ending: PriceEnding;
    priceReviewRecommended?: boolean;
  }): PricingSuggestion {
    const margin = ProfitCalculator.grossMarginPercent(params.unitCost, params.price);
    return {
      suggestedPrice: params.price.roundedToCents(),
      source: params.source,
      rationale: params.rationale,
      alternatives: this.alternativesAround(params.price, params.unitCost, params.ending),
      previousPrice: params.previousPrice,
      priceReviewRecommended: params.priceReviewRecommended ?? false,
      belowMinimumMargin: margin !== null && margin < this.rules.minimumGrossMarginPercent,
    };
  }

  /**
   * One-tap alternatives shown next to the suggestion: the tier's second price when there is one,
   * plus a dollar either side. Anything at or below cost is dropped - offering a price that loses
   * money on every sale is worse than offering nothing.
   */
  private alternativesAround(
    price: Money,
    unitCost: Money | null,
    ending: PriceEnding,
  ): readonly Money[] {
    if (!price.isPositive) return [];
    const tierAlternate = unitCost === null ? null : (tierFor(this.rules, unitCost)?.alternatePrice ?? null);
    const candidates = [
      PriceRounding.step(price, -1, ending),
      price,
      tierAlternate,
      PriceRounding.step(price, 1, ending),
      PriceRounding.step(price, 2, ending),
    ].filter((value): value is Money => value !== null);

    const seen = new Set<number>();
    const kept: Money[] = [];
    for (const candidate of candidates.map((c) => c.roundedToCents())) {
      if (!candidate.isPositive) continue;
      if (unitCost !== null && !candidate.greaterThan(unitCost)) continue;
      if (seen.has(candidate.toStorage())) continue;
      seen.add(candidate.toStorage());
      kept.push(candidate);
    }
    return kept.sort((a, b) => a.compareTo(b));
  }

  private endingFor(category: Category): PriceEnding {
    return categoryRuleFor(this.rules, category)?.priceEnding ?? this.rules.defaultEnding;
  }
}

/** `60` rather than `60.0`, matching how the rule reads in Settings. */
function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
