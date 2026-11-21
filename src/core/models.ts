import { Money } from './money';

/**
 * How a receipt discount line applies to the product above it.
 *
 * The parser never picks anything other than WHOLE_CASE or UNKNOWN on its own; every other scope
 * is an explicit choice somebody made.
 */
export const DiscountScope = {
  /** The printed amount comes off one case. Net case cost = case price - amount. */
  WHOLE_CASE: 'WHOLE_CASE',
  /** The printed amount comes off every retail unit in the case. */
  PER_UNIT: 'PER_UNIT',
  /** The printed amount comes off a set number of units inside one case. */
  UNITS_SUBSET: 'UNITS_SUBSET',
  /** A single flat amount off the whole purchase, however many cases were bought. */
  CUSTOM: 'CUSTOM',
  /** The user decided this discount does not belong to this product. */
  IGNORED: 'IGNORED',
  /** A discount was found but how it applies could not be determined. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type DiscountScope = (typeof DiscountScope)[keyof typeof DiscountScope];

export const DISCOUNT_SCOPE_LABELS: Record<DiscountScope, string> = {
  WHOLE_CASE: 'Whole case',
  PER_UNIT: 'Per unit',
  UNITS_SUBSET: 'Applies to N units',
  CUSTOM: 'Flat amount off the order line',
  IGNORED: 'Ignore discount',
  UNKNOWN: 'Needs review',
};

/** UNKNOWN and IGNORED deliberately do not move the cost. */
export function affectsCost(scope: DiscountScope): boolean {
  return scope !== DiscountScope.IGNORED && scope !== DiscountScope.UNKNOWN;
}

/**
 * A discount lifted off a receipt, e.g. `Flyer 43 - HELLM MAYONNAISE   -$8.00`.
 *
 * The amount is always positive; the scope decides what it is subtracted from.
 */
export interface ReceiptDiscount {
  readonly description: string;
  readonly amount: Money;
  readonly scope: DiscountScope;
  /** Only meaningful for UNITS_SUBSET. */
  readonly appliesToUnits?: number | null;
}

export function makeDiscount(
  description: string,
  amount: Money,
  scope: DiscountScope = DiscountScope.UNKNOWN,
  appliesToUnits: number | null = null,
): ReceiptDiscount {
  if (amount.isNegative) {
    throw new RangeError('Discount amounts are stored positive; scope decides the sign');
  }
  return {
    description,
    amount,
    scope,
    appliesToUnits: scope === DiscountScope.UNITS_SUBSET ? appliesToUnits : null,
  };
}

/** Every figure behind one product's cost, so the arithmetic can be shown rather than asserted. */
export interface CostBreakdown {
  readonly casePrice: Money;
  readonly unitsPerCase: number;
  readonly casesPurchased: number;
  readonly looseUnits: number;
  readonly discountPerCase: Money;
  readonly totalDiscount: Money;
  readonly netCaseCost: Money;
  /** What one sellable unit actually cost, after discounts. The number everything else uses. */
  readonly trueUnitCost: Money;
  readonly totalUnits: number;
  readonly totalWholesaleCost: Money;
}

/** How sure the app is about a row it read. */
export const ItemConfidence = {
  HIGH: 'HIGH',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  PROBLEM: 'PROBLEM',
} as const;
export type ItemConfidence = (typeof ItemConfidence)[keyof typeof ItemConfidence];

export const Category = {
  BEVERAGES: 'BEVERAGES',
  SNACKS: 'SNACKS',
  DAIRY: 'DAIRY',
  FROZEN: 'FROZEN',
  CANNED: 'CANNED',
  DRY_GOODS: 'DRY_GOODS',
  CONDIMENTS: 'CONDIMENTS',
  CLEANING: 'CLEANING',
  PAPER: 'PAPER',
  HEALTH: 'HEALTH',
  PET: 'PET',
  BEER: 'BEER',
  OTHER: 'OTHER',
} as const;
export type Category = (typeof Category)[keyof typeof Category];

export const CATEGORY_LABELS: Record<Category, string> = {
  BEVERAGES: 'Beverages',
  SNACKS: 'Snacks',
  DAIRY: 'Dairy',
  FROZEN: 'Frozen',
  CANNED: 'Canned',
  DRY_GOODS: 'Dry goods',
  CONDIMENTS: 'Condiments',
  CLEANING: 'Cleaning',
  PAPER: 'Paper',
  HEALTH: 'Health',
  PET: 'Pet',
  BEER: 'Beer',
  OTHER: 'Other',
};

const CATEGORY_KEYWORDS: Record<Category, readonly string[]> = {
  BEVERAGES: ['juice', 'soda', 'cola', 'water', 'drink', 'tea', 'coffee', 'lemonade', 'nectar'],
  SNACKS: ['chip', 'crisp', 'cookie', 'candy', 'cracker', 'pretzel', 'nut', 'popcorn', 'bar'],
  DAIRY: ['milk', 'cheese', 'yogurt', 'butter', 'cream', 'egg'],
  FROZEN: ['frozen', 'ice cream', 'pizza'],
  CANNED: ['can', 'canned', 'soup', 'bean', 'tuna', 'evaporated'],
  DRY_GOODS: ['rice', 'pasta', 'flour', 'sugar', 'cereal', 'oil', 'salt'],
  CONDIMENTS: ['mayo', 'mayonnaise', 'ketchup', 'mustard', 'sauce', 'dressing', 'vinegar'],
  CLEANING: ['detergent', 'bleach', 'cleaner', 'soap', 'downy', 'tide', 'fabric', 'mr. clean'],
  PAPER: ['towel', 'tissue', 'napkin', 'toilet', 'plate', 'cup', 'foil'],
  HEALTH: ['shampoo', 'toothpaste', 'lotion', 'medicine', 'vitamin', 'bandage'],
  PET: ['dog', 'cat', 'pet food', 'kibble'],
  BEER: ['beer', 'budweiser', 'corona', 'heineken', 'modelo', 'coors', 'miller', 'lager', 'ale'],
  OTHER: [],
};

export function categoryFromName(name: string | null | undefined): Category {
  const key = (name ?? '').trim().toUpperCase();
  const match = (Object.keys(Category) as Category[]).find((c) => c === key);
  return match ?? Category.OTHER;
}

/** Best guess from a product description. Only ever a starting point the user can change. */
export function guessCategory(description: string | null | undefined): Category {
  const text = (description ?? '').toLowerCase();
  if (text.trim().length === 0) return Category.OTHER;
  for (const category of Object.keys(CATEGORY_KEYWORDS) as Category[]) {
    if (CATEGORY_KEYWORDS[category].some((word) => text.includes(word))) return category;
  }
  return Category.OTHER;
}

/**
 * Words that say a discount comes off each piece rather than off the case.
 *
 * Deliberately a list of things a receipt actually prints. If any of these appear, the amount
 * is not safe to treat as a case-level deduction and the shop is asked instead.
 */
const PER_UNIT_MARKERS = /\b(each|ea\b|per\s*unit|per\s*piece|\/\s*unit|\/\s*ea|per\s*lb|per\s*pound)\b/i;

/**
 * Jetro's own word for a case-level promotion, printed on its own line under the product.
 *
 * `Flyer 43 - PEDIGREE ADULT CR PUPPY DRY` is a line off that case. It is the marker the shop
 * already recognises, which is why they call these flyer discounts.
 */
const WHOLE_CASE_MARKERS = /\b(flyer|case\s*discount|case\s*deal|off\s*case|promo\s*case)\b/i;

/**
 * Reads a discount's scope off the receipt text, or admits it cannot.
 *
 * This is the difference between working automatically and guessing. A line that says "Flyer"
 * and nothing about units is a case-level deduction, and making the shopkeeper confirm that
 * forty-five times is not caution, it is a chore. A line that mentions each, per unit or a
 * weight is genuinely ambiguous, and so is a line with no text at all - those still get asked,
 * because applying the wrong one changes what the shop charges.
 *
 * Returns null when the receipt does not settle it.
 */
export function scopeFromReceiptText(lines: readonly string[]): DiscountScope | null {
  const text = lines.join(' \n ');
  if (text.trim().length === 0) return null;
  // Ambiguity wins. A line carrying both markers is not evidence of either.
  if (PER_UNIT_MARKERS.test(text)) return null;
  return WHOLE_CASE_MARKERS.test(text) ? DiscountScope.WHOLE_CASE : null;
}

/**
 * A price the shopkeeper approved that no longer covers what the product costs.
 *
 * Their price is theirs and is never revised on their behalf, but a price under the cost loses
 * money on every sale and nothing about a shelf tag shows it. Lives here, in the core, because
 * both the receipt reading and a later correction have to reach the same verdict about the
 * same row, and a rule written twice is a rule that will disagree with itself.
 */
export const APPROVED_PRICE_BELOW_COST = 'APPROVED_PRICE_BELOW_COST';

/**
 * Whether an approved price is now under the cost.
 *
 * Unknown either way is not a warning: no approved price means nothing to lose money on, and
 * no cost means nothing to compare it with.
 */
export function approvedPriceIsBelowCost(
  approvedPrice: Money | null,
  trueUnitCost: Money | null,
): boolean {
  if (approvedPrice === null || trueUnitCost === null) return false;
  return approvedPrice.lessThan(trueUnitCost);
}


/**
 * A discount's scope as the shopkeeper would say it.
 *
 * Never the stored name. "WHOLE_CASE" on a product card is the app talking to itself, and a
 * shopkeeper reading it has to work out whether that means seven dollars off the case or seven
 * off each of four - which are different costs. Lives here so the card, the chat and anything
 * else that has to say it all say the same thing.
 */
export function discountScopeInWords(scope: DiscountScope): string {
  switch (scope) {
    case DiscountScope.WHOLE_CASE:
      return 'off the whole case';
    case DiscountScope.PER_UNIT:
      return 'off each one';
    case DiscountScope.UNITS_SUBSET:
      return 'off some of the case';
    case DiscountScope.CUSTOM:
      return 'spread over the cases bought';
    case DiscountScope.IGNORED:
      return 'not for this product';
    default:
      return 'not yet applied - it does not say what it comes off';
  }
}
