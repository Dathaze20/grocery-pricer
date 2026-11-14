import { Money } from './money';

/**
 * Profit per case.
 *
 * PC is the gross dollar profit from selling every retail item in one wholesale case:
 *
 *   net case cost = case price - the discounts that actually apply to the case
 *   unit cost     = net case cost / sellable units per case
 *   case revenue  = retail price per item x sellable units per case
 *   PC            = case revenue - net case cost
 *
 * It is not a unit price, not a margin percentage and not a markup percentage. It is gross
 * profit before any cost of running the shop - rent, labour, breakage, theft, card fees - so it
 * is not money in anyone's pocket.
 *
 * There is no universal profit target here. What a case should earn is a decision per product
 * and per shop, which is why the owner sets it and this file only does the arithmetic.
 */

/** One tap of + or - moves the target profit by a dollar. Any exact amount can still be typed. */
export const PROFIT_STEP = Money.of('1.00');

/** A cent, in Money's internal ten-thousandths. Retail prices land on whole cents. */
const UNITS_PER_CENT = 100;

export interface CaseInput {
  /** What one case cost after the discounts that apply to it. */
  readonly netCaseCost: Money;
  /** Retail items that come out of one case. A 4-pack sold as four bottles is four. */
  readonly sellableUnits: number;
  /** What the shop charges for one retail item, or null when nothing is set yet. */
  readonly retailPrice: Money | null;
  /** How many of these cases were bought on this receipt. */
  readonly casesPurchased?: number;
}

export interface CaseEconomics {
  readonly netCaseCost: Money;
  readonly unitCost: Money;
  readonly sellableUnits: number;
  readonly retailPrice: Money | null;
  readonly caseRevenue: Money | null;
  /** Gross profit on one case. Null when no retail price is set. */
  readonly profitPerCase: Money | null;
  readonly casesPurchased: number;
  /** Profit per case multiplied by the cases bought. Not the same number, and not interchangeable. */
  readonly totalProfit: Money | null;
  /** The shelf price is below what the item cost: every sale loses money. */
  readonly belowCost: boolean;
}

export function caseEconomics(input: CaseInput): CaseEconomics {
  const sellableUnits = input.sellableUnits;
  if (!Number.isInteger(sellableUnits) || sellableUnits <= 0) {
    throw new RangeError('A case must contain at least one sellable item');
  }
  const casesPurchased = input.casesPurchased ?? 1;
  if (!Number.isInteger(casesPurchased) || casesPurchased < 0) {
    throw new RangeError('Cases purchased cannot be negative');
  }

  const unitCost = input.netCaseCost.divideBy(sellableUnits);
  const retailPrice = input.retailPrice;

  if (retailPrice === null) {
    return {
      netCaseCost: input.netCaseCost,
      unitCost,
      sellableUnits,
      retailPrice: null,
      caseRevenue: null,
      profitPerCase: null,
      casesPurchased,
      totalProfit: null,
      belowCost: false,
    };
  }

  const caseRevenue = retailPrice.times(sellableUnits);
  const profitPerCase = caseRevenue.minus(input.netCaseCost);

  return {
    netCaseCost: input.netCaseCost,
    unitCost,
    sellableUnits,
    retailPrice,
    caseRevenue,
    profitPerCase,
    casesPurchased,
    totalProfit: profitPerCase.times(casesPurchased),
    // Compared against the true unit cost rather than the rounded display figure: a price a
    // hundredth under cost still loses money on every sale.
    belowCost: retailPrice.lessThan(unitCost),
  };
}

export interface TargetedPrice {
  /** What the owner asked the case to earn. */
  readonly target: Money;
  /** The shelf price that gets closest without falling short. Never negative. */
  readonly retailPrice: Money;
  /** What that price actually earns on a case, which is rarely the target exactly. */
  readonly achieved: Money;
  /** True when the achieved profit is the target to the cent. */
  readonly exact: boolean;
  readonly belowCost: boolean;
}

/**
 * The shelf price that earns a target profit on one case.
 *
 * Shelf prices are whole cents, so most targets cannot be hit exactly: a case of 12 moves in
 * 12-cent steps of profit, a case of 24 in 24-cent steps. The price is rounded *up* to the next
 * cent, so the case earns at least what was asked rather than a penny less, and the caller is
 * told what it actually earns. Claiming the target when the price cannot produce it would be a
 * lie about money.
 */
export function priceForTargetProfit(
  netCaseCost: Money,
  sellableUnits: number,
  target: Money,
): TargetedPrice {
  if (!Number.isInteger(sellableUnits) || sellableUnits <= 0) {
    throw new RangeError('A case must contain at least one sellable item');
  }

  const neededRaw = netCaseCost.toStorage() + target.toStorage();
  // Ceiling division into whole cents, correct for negative numerators too.
  const perUnitRaw = neededRaw / sellableUnits;
  const cents = Math.ceil(perUnitRaw / UNITS_PER_CENT);
  // A shelf price cannot be negative. A target that would demand one is met by giving the item
  // away, and the caller sees the real profit that results.
  const price = Money.fromStorage(Math.max(cents, 0) * UNITS_PER_CENT);

  const economics = caseEconomics({ netCaseCost, sellableUnits, retailPrice: price });
  const achieved = economics.profitPerCase ?? Money.ZERO;

  return {
    target,
    retailPrice: price,
    achieved,
    exact: achieved.equals(target),
    belowCost: economics.belowCost,
  };
}

/** Moves a profit target by one step. Targets may go negative; the price never does. */
export function stepProfitTarget(current: Money, direction: 1 | -1): Money {
  return direction === 1 ? current.plus(PROFIT_STEP) : current.minus(PROFIT_STEP);
}
