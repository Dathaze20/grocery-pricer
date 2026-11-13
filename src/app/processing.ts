import { aiErrorMessage, isFatalForRun, isTransient, OrderImageType, type AiError, type AiOrderExtraction } from '../core/ai-types';
import { mergeExtractions, validateExtraction, ExtractionIssue, type ValidatedItem } from '../core/ai-validate';
import { CostCalculator } from '../core/cost';
import { Money } from '../core/money';
import { ItemConfidence, categoryFromName, guessCategory, makeDiscount, type ReceiptDiscount } from '../core/models';
import { DiscountScope } from '../core/models';
import { PricingEngine, defaultPricingRules, type PricingRules } from '../core/pricing';
import type { AiProvider, IdentifiedImage } from '../ai/provider';
import type { Repository } from '../data/repository';
import { MessageRole, OrderStatus, type StoredItem, type StoredPhoto } from '../data/schema';
import { toImagePart } from './images';

/** Photos per Gemini call. Enough context to read a whole receipt, few enough to stay inside a reply. */
export const PHOTOS_PER_BATCH = 3;

export interface ProcessOptions {
  readonly rules?: PricingRules;
  /** Injected so tests do not sit through a retry delay. */
  readonly retryDelayMs?: number;
  readonly onProgress?: (step: string) => void;
}

export interface ProcessResult {
  readonly ok: boolean;
  readonly itemCount: number;
  readonly warnings: readonly string[];
  readonly error: AiError | null;
  readonly summary: string;
}

/**
 * The one button.
 *
 * Photographs in, priced order out, with a sentence at the end the shopkeeper can read at a
 * glance. The division of labour is absolute: Gemini says what characters are on the receipt,
 * this function does every piece of arithmetic, and anything the model was unsure about is
 * recorded as an issue rather than smoothed over.
 */
export async function processOrder(
  repo: Repository,
  provider: AiProvider,
  orderId: number,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const rules = options.rules ?? defaultPricingRules();
  const progress = options.onProgress ?? (() => {});

  const photos = (await repo.photosFor(orderId, false)).sort((a, b) => a.id - b.id);
  if (photos.length === 0) {
    return fail(repo, orderId, null, 'Add a photo of the receipt first.');
  }

  await repo.updateOrder(orderId, { status: OrderStatus.PROCESSING, failureMessage: null });
  progress('Reading the photos');

  const parts: IdentifiedImage[] = [];
  for (const photo of photos) {
    const part = await toImagePart({ bytes: photo.bytes, mimeType: photo.mimeType });
    parts.push({ photoId: photo.id, ...part });
  }

  // Sorting the photos first means a product snapshot in the middle of a receipt roll does not
  // get read as though it were a line of printed figures.
  const classified = await classify(provider, parts, photos);
  const paperwork = parts.filter((part) => classified.get(part.photoId) !== OrderImageType.PRODUCT_PHOTO);
  if (paperwork.length === 0) {
    return fail(repo, orderId, null, 'None of those photos look like a receipt or a case label.');
  }

  const batches: AiOrderExtraction[] = [];
  for (let i = 0; i < paperwork.length; i += PHOTOS_PER_BATCH) {
    const batch = paperwork.slice(i, i + PHOTOS_PER_BATCH);
    progress(`Reading photo ${i + 1} of ${paperwork.length}`);
    const result = await withOneRetry(() => provider.extractOrder(batch), options.retryDelayMs);
    if (!result.ok) {
      // A spent quota or a rejected key will not fix itself on the next batch. Stopping here
      // keeps a half-read order from being presented as a whole one.
      if (isFatalForRun(result.error) || batches.length === 0) {
        return fail(repo, orderId, result.error, aiErrorMessage(result.error));
      }
      batches.push({ supplier: null, items: [], warnings: [aiErrorMessage(result.error)] });
      continue;
    }
    batches.push(result.value);
  }

  const merged = mergeExtractions(batches);
  const validated = validateExtraction(merged, new Set(photos.map((p) => p.id)));
  progress('Working out costs');

  const engine = new PricingEngine(rules);
  const rows: Array<Omit<StoredItem, 'id'>> = [];
  let orderTotal = Money.ZERO;

  for (const accepted of validated.accepted) {
    const row = await priceOne(repo, engine, orderId, accepted);
    rows.push(row);
    if (row.totalWholesaleCost !== null) {
      orderTotal = orderTotal.plus(Money.fromStorage(row.totalWholesaleCost));
    }
  }

  const saved = await repo.addItems(rows);
  for (const item of saved) {
    if (item.productId !== null && item.trueUnitCost !== null) {
      await repo.updateProduct(item.productId, { lastCost: item.trueUnitCost });
      await repo.recordPrice(item.productId, orderId, item.trueUnitCost, item.suggestedPrice);
    }
  }

  const warnings = [
    ...validated.warnings,
    ...validated.rejected.map((r) => `A line was dropped: ${describeIssue(r.reason)}`),
  ];

  await repo.updateOrder(orderId, {
    status: OrderStatus.READY,
    supplier: validated.supplier,
    itemCount: saved.length,
    totalWholesaleCost: orderTotal.toStorage(),
    warnings,
    failureMessage: null,
  });

  const summary = summarise(saved, orderTotal, warnings);
  await repo.say(orderId, MessageRole.APP, summary);

  return { ok: true, itemCount: saved.length, warnings, error: null, summary };
}

/**
 * Sorts the photos so a shelf snapshot is not read as a receipt.
 *
 * A failed classification is not a failed order: everything is treated as paperwork, which is
 * what it almost always is. Spending a user's quota on a second attempt at sorting would be
 * worse than being slightly wrong about one photo.
 */
async function classify(
  provider: AiProvider,
  parts: readonly IdentifiedImage[],
  photos: readonly StoredPhoto[],
): Promise<Map<number, OrderImageType>> {
  const known = new Map<number, OrderImageType>();
  const unknown = parts.filter((part) => {
    const photo = photos.find((p) => p.id === part.photoId);
    if (photo !== undefined && photo.type !== OrderImageType.UNKNOWN) {
      known.set(part.photoId, photo.type);
      return false;
    }
    return true;
  });
  if (unknown.length === 0) return known;

  const result = await provider.classifyImages(unknown);
  if (!result.ok) {
    for (const part of unknown) known.set(part.photoId, OrderImageType.RECEIPT);
    return known;
  }
  for (const part of unknown) known.set(part.photoId, OrderImageType.RECEIPT);
  for (const row of result.value) known.set(row.photoId, row.type);
  return known;
}

/** Turns one validated row into a stored, costed, priced item. */
async function priceOne(
  repo: Repository,
  engine: PricingEngine,
  orderId: number,
  accepted: ValidatedItem,
): Promise<Omit<StoredItem, 'id'>> {
  const item = accepted.item;
  const displayName = (item.canonicalName ?? item.rawName ?? '').trim();
  const category =
    item.category !== null && item.category !== undefined
      ? categoryFromName(item.category)
      : guessCategory(displayName);

  const casePrice = Money.parseOrNull(item.casePrice);
  const unitsPerCase = item.unitsPerCase ?? null;
  const casesPurchased = item.casesPurchased ?? 1;
  const discount = toDiscount(item.discount);

  let trueUnitCost: Money | null = null;
  let totalWholesaleCost: Money | null = null;
  if (casePrice !== null && unitsPerCase !== null && unitsPerCase > 0) {
    const breakdown = CostCalculator.calculate({
      casePrice,
      unitsPerCase,
      casesPurchased,
      discount,
    });
    trueUnitCost = breakdown.trueUnitCost;
    totalWholesaleCost = breakdown.totalWholesaleCost;
  }

  const product = await repo.findOrCreateProduct({
    displayName: displayName.length > 0 ? displayName : (item.rawName ?? 'Unnamed item'),
    size: item.size ?? null,
    upc: item.upc ?? null,
    category,
  });

  const suggestion = engine.suggest({
    unitCost: trueUnitCost,
    category,
    previousRetailPrice: product.lastRetailPrice !== null ? Money.fromStorage(product.lastRetailPrice) : null,
    productOverridePrice: product.overridePrice !== null ? Money.fromStorage(product.overridePrice) : null,
  });

  return {
    orderId,
    productId: product.id,
    rawName: item.rawName ?? displayName,
    displayName: displayName.length > 0 ? displayName : (item.rawName ?? 'Unnamed item'),
    size: item.size ?? null,
    upc: item.upc ?? null,
    supplierSku: item.supplierSku ?? null,
    category,
    casePrice: casePrice?.toStorage() ?? null,
    unitsPerCase,
    casesPurchased,
    looseUnits: 0,
    discount:
      discount === null
        ? null
        : {
            description: discount.description,
            amount: discount.amount.toStorage(),
            scope: discount.scope,
            appliesToUnits: discount.appliesToUnits ?? null,
          },
    trueUnitCost: trueUnitCost?.toStorage() ?? null,
    totalWholesaleCost: totalWholesaleCost?.toStorage() ?? null,
    // A suggestion with no cost behind it is not a price. Storing zero here would be a lie the
    // rest of the app would happily repeat.
    suggestedPrice: trueUnitCost === null ? null : suggestion.suggestedPrice.toStorage(),
    pricingSource: suggestion.source,
    pricingRationale: suggestion.rationale,
    approvedPrice: null,
    previousPrice: product.lastRetailPrice,
    confidence: confidenceOf(accepted),
    aiConfidence: item.confidence,
    issues: [...accepted.issues],
    sourcePhotoIds: [...item.sourcePhotoIds],
    sourceText: [...item.sourceText],
  };
}

function confidenceOf(accepted: ValidatedItem): ItemConfidence {
  if (!accepted.isComplete) return ItemConfidence.PROBLEM;
  if (accepted.issues.length > 0 || accepted.item.confidence < 0.7) return ItemConfidence.NEEDS_REVIEW;
  return ItemConfidence.HIGH;
}

function toDiscount(raw: { amount?: string | null; scope?: string | null; appliesToUnits?: number | null } | null | undefined): ReceiptDiscount | null {
  if (raw === null || raw === undefined) return null;
  const amount = Money.parseOrNull(raw.amount);
  if (amount === null || amount.isNegative) return null;
  return makeDiscount('Receipt discount', amount, scopeOf(raw.scope), raw.appliesToUnits ?? null);
}

function scopeOf(raw: string | null | undefined): DiscountScope {
  const key = (raw ?? '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  return (Object.values(DiscountScope) as string[]).includes(key)
    ? (key as DiscountScope)
    // Not knowing what a discount applies to is the honest answer, and it deliberately leaves
    // the cost untouched until the shopkeeper says.
    : DiscountScope.UNKNOWN;
}

async function withOneRetry<T>(
  call: () => Promise<T & { ok: boolean; error?: AiError }>,
  delayMs = 1500,
): Promise<T & { ok: boolean; error?: AiError }> {
  const first = await call();
  if (first.ok || first.error === undefined || !isTransient(first.error)) return first;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return call();
}

async function fail(
  repo: Repository,
  orderId: number,
  error: AiError | null,
  message: string,
): Promise<ProcessResult> {
  await repo.updateOrder(orderId, { status: OrderStatus.FAILED, failureMessage: message });
  await repo.say(orderId, MessageRole.APP, message);
  return { ok: false, itemCount: 0, warnings: [], error, summary: message };
}

function summarise(items: readonly StoredItem[], total: Money, warnings: readonly string[]): string {
  if (items.length === 0) {
    return 'I could not read any products from those photos. Try again with a clearer picture.';
  }
  const needsReview = items.filter((i) => i.confidence !== ItemConfidence.HIGH).length;
  const lines = [
    `${items.length} ${items.length === 1 ? 'product' : 'products'}, ${total.format()} wholesale.`,
  ];
  if (needsReview > 0) {
    lines.push(`${needsReview} ${needsReview === 1 ? 'needs' : 'need'} a second look.`);
  }
  if (warnings.length > 0) lines.push(warnings[0]!);
  lines.push('Ask me anything about this order.');
  return lines.join('\n');
}

function describeIssue(issue: ExtractionIssue): string {
  switch (issue) {
    case ExtractionIssue.NO_USABLE_NAME:
      return 'a line with no readable product name';
    default:
      return issue.toLowerCase().replace(/_/g, ' ');
  }
}
