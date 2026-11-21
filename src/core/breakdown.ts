import { caseEconomics } from './profit';
import { DiscountScope, affectsCost, discountScopeInWords } from './models';
import { Money } from './money';
import { nameWithSize } from './matching';
import type {
  StoredBreakdown,
  StoredBreakdownRow,
  StoredDiscount,
  StoredItem,
} from '../data/schema';

/**
 * Everything a shopkeeper needs to understand one purchase, worked out once.
 *
 * The chat and the product card were each assembling their own version of this and saying
 * different amounts of it: the card showed the subtraction while the chat answered a question
 * about a flyer discount, a case price, a pack count and a selling price with "$9.75 each →
 * $13.99". One set of figures, derived here, so the two cannot drift apart.
 *
 * Nothing in here invents anything. Every figure is either read from the row or worked out from
 * figures that are, and a figure that cannot be worked out stays null and is said out loud.
 */
export interface PricingBreakdown {
  readonly itemId: number;
  readonly name: string;
  readonly casePrice: Money | null;
  readonly discount: BreakdownDiscount | null;
  /** The case price with verified money off it. Known even when the pack count is not. */
  readonly netCase: Money | null;
  readonly unitsPerCase: number | null;
  readonly unitCost: Money | null;
  readonly suggested: Money | null;
  readonly approved: Money | null;
  /** The price a shelf tag would carry: what they approved, else what was worked out. */
  readonly retail: Money | null;
  readonly profitPerUnit: Money | null;
  readonly caseRevenue: Money | null;
  readonly profitPerCase: Money | null;
  readonly casesPurchased: number;
  /** Plain sentences about what is not known, in the order worth saying them. */
  readonly missing: readonly string[];
}

export interface BreakdownDiscount {
  readonly amount: Money;
  readonly scope: DiscountScope;
  /** In the cost, as opposed to read but waiting on what it applies to. */
  readonly applied: boolean;
  /** Typed in by the shopkeeper rather than read off the receipt. */
  readonly enteredByHand: boolean;
}

/** How a discount the owner typed in is described in storage. */
export const ENTERED_BY_HAND = 'Entered from the receipt';

/**
 * The case price with its verified money off, even when nobody knows the pack count.
 *
 * A flyer line takes a fixed amount off the case, and that subtraction does not depend on how
 * many bottles are inside: $9.89 less $0.50 is $9.39 whether the case holds four or forty. The
 * card was showing a dash there, which reads as "not known" about a figure the receipt states
 * plainly. A per-unit discount is different - that one genuinely needs the count - so it
 * returns null rather than guessing.
 */
export function netCaseCost(
  casePrice: Money | null,
  discount: StoredDiscount | null,
  unitsPerCase: number | null,
  casesPurchased = 1,
): Money | null {
  if (casePrice === null) return null;
  if (discount === null || !affectsCost(discount.scope)) return casePrice;

  const amount = Money.fromStorage(discount.amount);
  switch (discount.scope) {
    case DiscountScope.WHOLE_CASE:
      return casePrice.minus(amount).coerceAtLeastZero();
    case DiscountScope.CUSTOM:
      return casePrice.minus(amount.divideBy(Math.max(casesPurchased, 1))).coerceAtLeastZero();
    case DiscountScope.PER_UNIT:
      if (unitsPerCase === null || unitsPerCase <= 0) return null;
      return casePrice.minus(amount.times(unitsPerCase)).coerceAtLeastZero();
    case DiscountScope.UNITS_SUBSET: {
      if (unitsPerCase === null || unitsPerCase <= 0) return null;
      const units = Math.min(Math.max(discount.appliesToUnits ?? 0, 0), unitsPerCase);
      return casePrice.minus(amount.times(units)).coerceAtLeastZero();
    }
    default:
      return casePrice;
  }
}

/** Everything known about one purchase, from the row the receipt was read into. */
export function breakdownOf(item: StoredItem): PricingBreakdown {
  const casePrice = item.casePrice === null ? null : Money.fromStorage(item.casePrice);
  const unitsPerCase = item.unitsPerCase !== null && item.unitsPerCase > 0 ? item.unitsPerCase : null;
  const discount = item.discount === null ? null : toBreakdownDiscount(item.discount);

  const net = netCaseCost(casePrice, item.discount, unitsPerCase, item.casesPurchased);
  // The stored cost, not a fresh division: the card prices from that figure, and a chat that
  // worked out its own would eventually disagree with the card by a cent.
  const unitCost = item.trueUnitCost === null ? null : Money.fromStorage(item.trueUnitCost);
  const suggested = item.suggestedPrice === null ? null : Money.fromStorage(item.suggestedPrice);
  const approved = item.approvedPrice === null ? null : Money.fromStorage(item.approvedPrice);
  const retail = approved ?? suggested;

  let caseRevenue: Money | null = null;
  let profitPerCase: Money | null = null;
  if (net !== null && unitsPerCase !== null) {
    const economics = caseEconomics({
      netCaseCost: net,
      sellableUnits: unitsPerCase,
      retailPrice: retail,
      casesPurchased: item.casesPurchased,
    });
    caseRevenue = economics.caseRevenue;
    profitPerCase = economics.profitPerCase;
  }

  const profitPerUnit = unitCost !== null && retail !== null ? retail.minus(unitCost) : null;

  const missing: string[] = [];
  if (casePrice === null) missing.push('The case price could not be read from the receipt.');
  if (unitsPerCase === null) {
    missing.push(
      'The receipt does not say how many sellable units are in the case, so there is no cost each yet. Open the product and put the number in.',
    );
  }
  if (discount !== null && !discount.applied) {
    missing.push(
      `The ${discount.amount.format()} discount is not in the cost yet, because the receipt does not say what it comes off.`,
    );
  }
  if (retail === null && unitCost !== null) missing.push('No selling price has been set yet.');

  return {
    itemId: item.id,
    name: nameWithSize(item.displayName, item.size),
    casePrice,
    discount,
    netCase: net,
    unitsPerCase,
    unitCost,
    suggested,
    approved,
    retail,
    profitPerUnit,
    caseRevenue,
    profitPerCase,
    casesPurchased: item.casesPurchased,
    missing,
  };
}

function toBreakdownDiscount(discount: StoredDiscount): BreakdownDiscount {
  return {
    amount: Money.fromStorage(discount.amount),
    scope: discount.scope,
    applied: affectsCost(discount.scope),
    enteredByHand: discount.description === ENTERED_BY_HAND,
  };
}

/**
 * The breakdown as a shopkeeper would explain it out loud.
 *
 * Sentences, not fields. "unitsPerCase: 4" is a database row read aloud; "There are 4 packages
 * in the case, so each package costs you $9.75" is an answer. Every sentence carries its own
 * figures, so the text alone is a complete answer wherever the coloured block is not shown.
 */
export function breakdownSentences(breakdown: PricingBreakdown): string {
  const lines: string[] = [];
  const unit = unitNoun(breakdown);

  if (breakdown.casePrice !== null && breakdown.discount !== null && breakdown.discount.applied) {
    const read = breakdown.discount.enteredByHand ? 'You entered' : 'The receipt shows';
    lines.push(
      `${breakdown.name} costs ${breakdown.casePrice.format()} a case. ${read} ${breakdown.discount.amount.format()} ${discountScopeInWords(breakdown.discount.scope)}, bringing the case to ${breakdown.netCase?.format() ?? '—'}.`,
    );
  } else if (breakdown.casePrice !== null) {
    const noDiscount =
      breakdown.discount === null ? ' No discount was recorded against it.' : '';
    lines.push(`${breakdown.name} costs ${breakdown.casePrice.format()} a case.${noDiscount}`);
  } else {
    lines.push(`${breakdown.name}: the case price could not be read from the receipt.`);
  }

  if (breakdown.unitsPerCase !== null && breakdown.unitCost !== null) {
    lines.push(
      `There are ${breakdown.unitsPerCase} ${unit} in the case, so each one costs you ${breakdown.unitCost.format()}.`,
    );
  }

  if (breakdown.retail !== null) {
    const whose = breakdown.approved !== null ? 'Your price is' : 'The suggested price is';
    if (breakdown.caseRevenue !== null && breakdown.profitPerCase !== null) {
      lines.push(
        `${whose} ${breakdown.retail.format()} each. Selling all ${breakdown.unitsPerCase} brings in ${breakdown.caseRevenue.format()}, leaving ${breakdown.profitPerCase.format()} gross profit on the case.`,
      );
    } else {
      lines.push(`${whose} ${breakdown.retail.format()} each.`);
    }
  }

  for (const note of breakdown.missing) lines.push(note);
  return lines.join('\n');
}

/** What one sellable thing is called, when the size makes it obvious. */
function unitNoun(breakdown: PricingBreakdown): string {
  const count = breakdown.unitsPerCase ?? 0;
  return count === 1 ? 'unit' : 'units';
}

/**
 * The breakdown laid out as labelled figures.
 *
 * The same numbers as the sentences, arranged so a shopkeeper can find one of them at a glance
 * without reading a paragraph. Every row carries its own label, so the tone - and the colour
 * the screen gives it - only ever repeats what the words already say.
 */
export function breakdownRows(breakdown: PricingBreakdown): StoredBreakdown {
  const rows: StoredBreakdownRow[] = [];

  if (breakdown.casePrice !== null) {
    rows.push({ label: 'Case', value: breakdown.casePrice.format() });
  }
  if (breakdown.discount !== null && breakdown.discount.applied) {
    rows.push({
      label: breakdown.discount.enteredByHand ? 'Discount you entered' : 'Flyer discount',
      value: `−${breakdown.discount.amount.format()}`,
      tone: 'off',
    });
  }
  if (breakdown.netCase !== null && breakdown.discount !== null && breakdown.discount.applied) {
    rows.push({ label: 'Net case', value: breakdown.netCase.format(), tone: 'strong' });
  }

  rows.push(
    breakdown.unitCost === null
      ? { label: 'Cost each', value: 'not worked out yet', tone: 'warn' }
      : { label: 'Cost each', value: breakdown.unitCost.format(), tone: 'strong' },
  );

  rows.push(
    breakdown.unitsPerCase === null
      ? { label: 'In the case', value: 'not established', tone: 'warn' }
      : { label: 'In the case', value: `${breakdown.unitsPerCase} to sell` },
  );

  if (breakdown.retail !== null) {
    rows.push({
      label: breakdown.approved !== null ? 'Your price' : 'Suggested price',
      value: breakdown.retail.format(),
      tone: 'strong',
    });
  }
  if (breakdown.profitPerCase !== null) {
    rows.push({
      label: 'Profit per case',
      value: breakdown.profitPerCase.format(),
      tone: 'keep',
    });
  }

  return {
    title: breakdown.name,
    rows,
    ...(breakdown.missing.length > 0 ? { notes: [...breakdown.missing] } : {}),
  };
}
