import { Money } from './money';
import { affectsCost, DiscountScope, type CostBreakdown, type ReceiptDiscount } from './models';

/**
 * Works out what one sellable unit actually cost.
 *
 * This is the arithmetic the whole app exists to get right, and the reason a language model is
 * never allowed near it. The printed "unit" price on a wholesale receipt is the price *before*
 * the discount; what the shop actually paid per unit is this.
 */
export const CostCalculator = {
  calculate(params: {
    casePrice: Money;
    unitsPerCase: number;
    casesPurchased?: number;
    looseUnits?: number;
    discount?: ReceiptDiscount | null;
  }): CostBreakdown {
    const { casePrice, unitsPerCase } = params;
    const casesPurchased = params.casesPurchased ?? 1;
    const looseUnits = params.looseUnits ?? 0;
    const discount = params.discount ?? null;

    if (!Number.isInteger(unitsPerCase) || unitsPerCase <= 0) {
      throw new RangeError('A case must contain at least one retail unit');
    }
    if (!Number.isInteger(casesPurchased) || casesPurchased < 0) {
      throw new RangeError('Cases purchased cannot be negative');
    }
    if (!Number.isInteger(looseUnits) || looseUnits < 0) {
      throw new RangeError('Loose units cannot be negative');
    }

    const grossUnitCost = casePrice.divideBy(unitsPerCase);
    const grossTotal = casePrice.times(casesPurchased).plus(grossUnitCost.times(looseUnits));

    const discountPerCase = discountForOneCase(discount, casePrice, unitsPerCase, casesPurchased);
    const netCaseCost = casePrice.minus(discountPerCase).coerceAtLeastZero();
    const trueUnitCost = netCaseCost.divideBy(unitsPerCase);

    const totalWholesaleCost = netCaseCost
      .times(casesPurchased)
      .plus(trueUnitCost.times(looseUnits));
    const totalDiscount = grossTotal.minus(totalWholesaleCost).coerceAtLeastZero();

    return {
      casePrice,
      unitsPerCase,
      casesPurchased,
      looseUnits,
      discountPerCase,
      totalDiscount,
      netCaseCost,
      trueUnitCost,
      totalUnits: unitsPerCase * casesPurchased + looseUnits,
      totalWholesaleCost,
    };
  },
};

/**
 * How much a discount takes off ONE case, given its scope.
 *
 * Capped at the case price, so a misread discount can never produce a negative cost - the caller
 * flags that situation separately rather than the arithmetic inventing money.
 */
function discountForOneCase(
  discount: ReceiptDiscount | null,
  casePrice: Money,
  unitsPerCase: number,
  casesPurchased: number,
): Money {
  if (discount === null || !affectsCost(discount.scope)) return Money.ZERO;

  let raw: Money;
  switch (discount.scope) {
    case DiscountScope.WHOLE_CASE:
      raw = discount.amount;
      break;
    case DiscountScope.PER_UNIT:
      raw = discount.amount.times(unitsPerCase);
      break;
    case DiscountScope.UNITS_SUBSET: {
      const claimed = discount.appliesToUnits ?? 0;
      const units = Math.min(Math.max(claimed, 0), unitsPerCase);
      raw = discount.amount.times(units);
      break;
    }
    case DiscountScope.CUSTOM:
      raw = discount.amount.divideBy(Math.max(casesPurchased, 1));
      break;
    default:
      return Money.ZERO;
  }

  return raw.greaterThan(casePrice) ? casePrice : raw;
}

/**
 * Gross profit, gross margin and markup.
 *
 * Margin and markup are different numbers and are never used interchangeably:
 *   gross profit  = retail - cost
 *   gross margin% = gross profit / retail x 100
 *   markup%       = gross profit / cost   x 100
 */
export interface ProfitSummary {
  readonly unitCost: Money;
  readonly retailPrice: Money;
  readonly grossProfit: Money;
  readonly grossMarginPercent: number | null;
  readonly markupPercent: number | null;
}

export const ProfitCalculator = {
  summarise(unitCost: Money, retailPrice: Money): ProfitSummary {
    const grossProfit = retailPrice.minus(unitCost);
    return {
      unitCost,
      retailPrice,
      grossProfit,
      grossMarginPercent: percentOrNull(grossProfit, retailPrice),
      markupPercent: percentOrNull(grossProfit, unitCost),
    };
  },

  grossMarginPercent(unitCost: Money, retailPrice: Money): number | null {
    return percentOrNull(retailPrice.minus(unitCost), retailPrice);
  },

  markupPercent(unitCost: Money, retailPrice: Money): number | null {
    return percentOrNull(retailPrice.minus(unitCost), unitCost);
  },

  formatPercent(value: number | null): string {
    return value === null ? '-' : `${value.toFixed(1)}%`;
  },
};

function percentOrNull(numerator: Money, denominator: Money): number | null {
  const ratio = numerator.ratioTo(denominator);
  return ratio === null ? null : ratio * 100;
}
