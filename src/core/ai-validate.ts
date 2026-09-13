import { Money } from './money';
import { DiscountScope } from './models';
import { discountScopeFrom } from './ai-parse';
import type { AiExtractedDiscount, AiExtractedItem, AiOrderExtraction } from './ai-types';
import { NameNormalizer, SizeParser, sizeCanonical } from './matching';

/** Something wrong with an extracted row, recorded rather than silently swallowed. */
export const ExtractionIssue = {
  NO_USABLE_NAME: 'NO_USABLE_NAME',
  UNREADABLE_CASE_PRICE: 'UNREADABLE_CASE_PRICE',
  NEGATIVE_CASE_PRICE: 'NEGATIVE_CASE_PRICE',
  MISSING_CASE_PRICE: 'MISSING_CASE_PRICE',
  UNREADABLE_UNIT_COST: 'UNREADABLE_UNIT_COST',
  INVALID_UNITS_PER_CASE: 'INVALID_UNITS_PER_CASE',
  MISSING_UNITS_PER_CASE: 'MISSING_UNITS_PER_CASE',
  INVALID_CASES_PURCHASED: 'INVALID_CASES_PURCHASED',
  UNREADABLE_DISCOUNT: 'UNREADABLE_DISCOUNT',
  NEGATIVE_DISCOUNT: 'NEGATIVE_DISCOUNT',
  DISCOUNT_EXCEEDS_CASE_PRICE: 'DISCOUNT_EXCEEDS_CASE_PRICE',
  UNKNOWN_DISCOUNT_SCOPE: 'UNKNOWN_DISCOUNT_SCOPE',
  SUBSET_UNITS_EXCEED_CASE: 'SUBSET_UNITS_EXCEED_CASE',
  CONFIDENCE_OUT_OF_RANGE: 'CONFIDENCE_OUT_OF_RANGE',
  UNKNOWN_SOURCE_PHOTO: 'UNKNOWN_SOURCE_PHOTO',
  NO_SOURCE_EVIDENCE: 'NO_SOURCE_EVIDENCE',
} as const;
export type ExtractionIssue = (typeof ExtractionIssue)[keyof typeof ExtractionIssue];

const BLOCKING_ISSUES: ReadonlySet<ExtractionIssue> = new Set([
  ExtractionIssue.MISSING_CASE_PRICE,
  ExtractionIssue.UNREADABLE_CASE_PRICE,
  ExtractionIssue.MISSING_UNITS_PER_CASE,
  ExtractionIssue.INVALID_UNITS_PER_CASE,
]);

export interface ValidatedItem {
  readonly item: AiExtractedItem;
  readonly issues: readonly ExtractionIssue[];
  /** True when this row can be priced without asking the user anything. */
  readonly isComplete: boolean;
}

export interface ValidatedExtraction {
  readonly supplier: string | null;
  readonly accepted: readonly ValidatedItem[];
  readonly rejected: ReadonlyArray<{ item: AiExtractedItem; reason: ExtractionIssue }>;
  readonly warnings: readonly string[];
}

/** Above this, a claimed pack count is a misread of something else on the line. */
export const MAX_PLAUSIBLE_UNITS_PER_CASE = 1000;
/** Above this, a claimed case count is a misread. */
export const MAX_PLAUSIBLE_CASES = 500;

/**
 * The gate between what a model claimed and what gets written down.
 *
 * The policy is repair-then-record, not reject-everything: a row with an unreadable price is
 * still worth keeping, because the user can ask about it and be told honestly that the price
 * could not be read. Only a row with no name at all is thrown away, because there is no way to
 * ever refer to it again.
 *
 * Nothing here computes a cost. It decides which claimed figures are *usable*; the arithmetic
 * happens afterwards in CostCalculator.
 */
export function validateExtraction(
  extraction: AiOrderExtraction,
  knownPhotoIds: ReadonlySet<number> = new Set(),
): ValidatedExtraction {
  const accepted: ValidatedItem[] = [];
  const rejected: Array<{ item: AiExtractedItem; reason: ExtractionIssue }> = [];

  for (const item of extraction.items) {
    const outcome = validateItem(item, knownPhotoIds);
    if (outcome === null) {
      rejected.push({ item, reason: ExtractionIssue.NO_USABLE_NAME });
    } else {
      accepted.push(outcome);
    }
  }

  return {
    supplier: extraction.supplier?.trim() || null,
    accepted,
    rejected,
    warnings: extraction.warnings,
  };
}

export function itemsNeedingAttention(
  validated: ValidatedExtraction,
): readonly ValidatedItem[] {
  return validated.accepted.filter((item) => !item.isComplete);
}

function validateItem(
  item: AiExtractedItem,
  knownPhotoIds: ReadonlySet<number>,
): ValidatedItem | null {
  const name = nonBlank(item.canonicalName) ?? nonBlank(item.rawName);
  if (name === null) return null;

  const issues: ExtractionIssue[] = [];

  const casePrice = readMoney(item.casePrice, issues, {
    missing: ExtractionIssue.MISSING_CASE_PRICE,
    unreadable: ExtractionIssue.UNREADABLE_CASE_PRICE,
    negative: ExtractionIssue.NEGATIVE_CASE_PRICE,
  });

  const printedUnitCost = readMoney(item.printedUnitCost, issues, {
    // The printed per-unit figure is a nicety, never required.
    missing: null,
    unreadable: ExtractionIssue.UNREADABLE_UNIT_COST,
    negative: ExtractionIssue.UNREADABLE_UNIT_COST,
  });

  let unitsPerCase: number | null;
  if (item.unitsPerCase === null || item.unitsPerCase === undefined) {
    issues.push(ExtractionIssue.MISSING_UNITS_PER_CASE);
    unitsPerCase = null;
  } else if (item.unitsPerCase <= 0 || item.unitsPerCase > MAX_PLAUSIBLE_UNITS_PER_CASE) {
    issues.push(ExtractionIssue.INVALID_UNITS_PER_CASE);
    unitsPerCase = null;
  } else {
    unitsPerCase = item.unitsPerCase;
  }

  // A receipt line with no case count means one case, the overwhelmingly common reading.
  let casesPurchased: number;
  if (item.casesPurchased === null || item.casesPurchased === undefined) {
    casesPurchased = 1;
  } else if (item.casesPurchased <= 0 || item.casesPurchased > MAX_PLAUSIBLE_CASES) {
    issues.push(ExtractionIssue.INVALID_CASES_PURCHASED);
    casesPurchased = 1;
  } else {
    casesPurchased = item.casesPurchased;
  }

  const discount = validateDiscount(item.discount ?? null, casePrice, unitsPerCase, issues);

  let confidence: number;
  if (Number.isNaN(item.confidence)) {
    issues.push(ExtractionIssue.CONFIDENCE_OUT_OF_RANGE);
    confidence = 0;
  } else if (item.confidence < 0 || item.confidence > 1) {
    issues.push(ExtractionIssue.CONFIDENCE_OUT_OF_RANGE);
    confidence = Math.min(Math.max(item.confidence, 0), 1);
  } else {
    confidence = item.confidence;
  }

  // A source photo id that was never imported is a fabricated citation. Drop the id, keep the
  // row, and note that its provenance is not trustworthy.
  let sourcePhotoIds = item.sourcePhotoIds;
  if (knownPhotoIds.size > 0) {
    const kept = item.sourcePhotoIds.filter((id) => knownPhotoIds.has(id));
    if (kept.length !== item.sourcePhotoIds.length) {
      issues.push(ExtractionIssue.UNKNOWN_SOURCE_PHOTO);
    }
    sourcePhotoIds = kept;
  }

  if (sourcePhotoIds.length === 0 && item.sourceText.length === 0) {
    issues.push(ExtractionIssue.NO_SOURCE_EVIDENCE);
  }

  const cleaned: AiExtractedItem = {
    ...item,
    canonicalName: nonBlank(item.canonicalName) ?? name,
    rawName: nonBlank(item.rawName),
    casePrice: casePrice?.toPlainString() ?? null,
    printedUnitCost: printedUnitCost?.toPlainString() ?? null,
    unitsPerCase,
    casesPurchased,
    discount,
    sourcePhotoIds,
    confidence,
  };

  const distinct = [...new Set(issues)];
  return {
    item: cleaned,
    issues: distinct,
    isComplete:
      cleaned.casePrice !== null &&
      cleaned.unitsPerCase !== null &&
      !distinct.some((issue) => BLOCKING_ISSUES.has(issue)),
  };
}

function readMoney(
  raw: string | null | undefined,
  issues: ExtractionIssue[],
  labels: { missing: ExtractionIssue | null; unreadable: ExtractionIssue; negative: ExtractionIssue },
): Money | null {
  if (raw === null || raw === undefined) {
    if (labels.missing !== null) issues.push(labels.missing);
    return null;
  }
  const parsed = Money.parseOrNull(raw);
  if (parsed === null) {
    issues.push(labels.unreadable);
    return null;
  }
  if (parsed.isNegative) {
    issues.push(labels.negative);
    return null;
  }
  return parsed;
}

function validateDiscount(
  discount: AiExtractedDiscount | null,
  casePrice: Money | null,
  unitsPerCase: number | null,
  issues: ExtractionIssue[],
): AiExtractedDiscount | null {
  if (discount === null) return null;

  const amount = discount.amount === null || discount.amount === undefined
    ? null
    : Money.parseOrNull(discount.amount);
  if (discount.amount !== null && discount.amount !== undefined && amount === null) {
    issues.push(ExtractionIssue.UNREADABLE_DISCOUNT);
    return null;
  }
  if (amount !== null && amount.isNegative) {
    // A discount printed as "-$8.00" is still eight dollars off. A genuinely negative discount is
    // a misread, and applying it would silently *raise* the cost.
    issues.push(ExtractionIssue.NEGATIVE_DISCOUNT);
    return null;
  }

  const scope = discountScopeFrom(discount.scope);
  if (discount.scope !== null && discount.scope !== undefined && scope === null) {
    issues.push(ExtractionIssue.UNKNOWN_DISCOUNT_SCOPE);
  }

  // A discount bigger than the case is not a free case plus change; it is a misread.
  if (amount !== null && casePrice !== null && amount.greaterThan(casePrice)) {
    issues.push(ExtractionIssue.DISCOUNT_EXCEEDS_CASE_PRICE);
    return null;
  }

  let appliesToUnits: number | null = null;
  if (discount.appliesToUnits !== null && discount.appliesToUnits !== undefined) {
    const claimed = discount.appliesToUnits;
    if (claimed <= 0) appliesToUnits = null;
    else if (unitsPerCase !== null && claimed > unitsPerCase) {
      issues.push(ExtractionIssue.SUBSET_UNITS_EXCEED_CASE);
      appliesToUnits = unitsPerCase;
    } else appliesToUnits = claimed;
  }

  if (amount === null && scope === null) return null;

  return {
    amount: amount?.toPlainString() ?? null,
    // An unreadable scope must never silently become "take it off the whole case".
    scope: scope ?? DiscountScope.UNKNOWN,
    appliesToUnits,
  };
}

function nonBlank(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && value.trim().length > 0 ? value : null;
}

/**
 * Stitches the results of several extraction batches into one order.
 *
 * Photographs of a long receipt overlap - people take them that way, and they are told to. The
 * same product therefore turns up in two batches, and naively concatenating them would bill the
 * shop twice for one case.
 *
 * The rule is conservative in the direction that costs nothing: two rows are the same purchase
 * only when the product, the size AND the case price all agree. Two rows for the same product at
 * different prices are two real purchases and are both kept, because a wholesaler genuinely does
 * print the same item twice at two prices.
 */
export function mergeExtractions(batches: readonly AiOrderExtraction[]): AiOrderExtraction {
  if (batches.length === 0) return { supplier: null, items: [], warnings: [] };
  if (batches.length === 1) return batches[0]!;

  const all = batches.flatMap((batch) => [...batch.items]);

  // A legible barcode is the strongest identity there is, stronger than a size photographed at an
  // angle. Merge on it first, across size readings.
  const byBarcode = new Map<string, AiExtractedItem>();
  const withoutBarcode: AiExtractedItem[] = [];
  for (const item of all) {
    const upc = item.upc?.trim();
    if (upc === undefined || upc.length === 0) {
      withoutBarcode.push(item);
      continue;
    }
    const key = `${upc}|${priceKey(item)}`;
    const existing = byBarcode.get(key);
    byBarcode.set(key, existing === undefined ? item : combine(existing, item));
  }

  // Everything else buckets on the two things that must agree exactly - package size and case
  // price - and is matched on the name inside each bucket.
  const buckets = new Map<string, AiExtractedItem[]>();
  for (const item of [...byBarcode.values(), ...withoutBarcode]) {
    const key = bucketKey(item);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }

  const items: AiExtractedItem[] = [];
  for (const bucket of buckets.values()) {
    const survivors: AiExtractedItem[] = [];
    for (const candidate of bucket) {
      const index = survivors.findIndex((s) => isSamePurchase(s, candidate));
      if (index >= 0) survivors[index] = combine(survivors[index]!, candidate);
      else survivors.push(candidate);
    }
    items.push(...survivors);
  }

  return {
    supplier: batches.map((b) => b.supplier).find((s) => s !== null && s.trim().length > 0) ?? null,
    items,
    warnings: [...new Set(batches.flatMap((b) => [...b.warnings]))],
  };
}

/** How alike two names must look before two rows at the same size and price are one purchase. */
export const SAME_PRODUCT_SIMILARITY = 0.72;

function bucketKey(item: AiExtractedItem): string {
  const parsed = SizeParser.parse(item.size);
  const size = parsed === null ? (item.size?.trim().toUpperCase() ?? '') : sizeCanonical(parsed);
  return `${size}|${priceKey(item)}`;
}

function priceKey(item: AiExtractedItem): string {
  const parsed = item.casePrice === null || item.casePrice === undefined
    ? null
    : Money.parseOrNull(item.casePrice);
  return parsed?.toPlainString() ?? '?';
}

function isSamePurchase(a: AiExtractedItem, b: AiExtractedItem): boolean {
  const upcA = a.upc?.trim();
  const upcB = b.upc?.trim();
  if (upcA !== undefined && upcA.length > 0 && upcB !== undefined && upcB.length > 0) {
    return upcA === upcB;
  }
  const nameA = a.canonicalName ?? a.rawName;
  const nameB = b.canonicalName ?? b.rawName;
  if (!nameA || !nameB) return false;
  if (NameNormalizer.normalize(nameA) === NameNormalizer.normalize(nameB)) return true;
  return NameNormalizer.similarity(nameA, nameB) >= SAME_PRODUCT_SIMILARITY;
}

/**
 * Folds a second sighting into the first.
 *
 * Photo ids and source lines are unioned - the evidence genuinely is both pictures. Case counts
 * are NOT summed: both sightings describe the same printed line, and adding them would turn one
 * case into two, the exact bug this exists to prevent.
 */
function combine(first: AiExtractedItem, second: AiExtractedItem): AiExtractedItem {
  const better = second.confidence > first.confidence ? second : first;
  const other = better === first ? second : first;
  const pick = <K extends keyof AiExtractedItem>(key: K): AiExtractedItem[K] =>
    (better[key] ?? other[key]) as AiExtractedItem[K];

  return {
    ...better,
    rawName: pick('rawName'),
    canonicalName: pick('canonicalName'),
    brand: pick('brand'),
    size: pick('size'),
    upc: pick('upc'),
    supplierSku: pick('supplierSku'),
    casePrice: pick('casePrice'),
    unitsPerCase: pick('unitsPerCase'),
    printedUnitCost: pick('printedUnitCost'),
    casesPurchased: pick('casesPurchased'),
    discount: pick('discount'),
    category: pick('category'),
    sourcePhotoIds: [...new Set([...first.sourcePhotoIds, ...second.sourcePhotoIds])],
    sourceText: [...new Set([...first.sourceText, ...second.sourceText])],
    confidence: Math.max(first.confidence, second.confidence),
  };
}
