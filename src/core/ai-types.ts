/**
 * What a multimodal model claims it read.
 *
 * Nothing in this file is authoritative money. Every figure arrives as the text the model says it
 * saw printed, and it stays text until the deterministic engine has parsed and recomputed it. The
 * model is allowed to decide *which characters are on the page*; it is never allowed to decide
 * what a case costs.
 */

export interface AiExtractedDiscount {
  readonly amount?: string | null;
  /** Matches DiscountScope; anything else becomes UNKNOWN. */
  readonly scope?: string | null;
  readonly appliesToUnits?: number | null;
}

export interface AiExtractedItem {
  /** The product name exactly as printed, OCR mangling included. */
  readonly rawName?: string | null;
  readonly canonicalName?: string | null;
  readonly brand?: string | null;
  readonly size?: string | null;
  readonly upc?: string | null;
  readonly supplierSku?: string | null;
  /** Money as a String on purpose: only Money may parse one. */
  readonly casePrice?: string | null;
  readonly unitsPerCase?: number | null;
  readonly printedUnitCost?: string | null;
  readonly casesPurchased?: number | null;
  readonly discount?: AiExtractedDiscount | null;
  readonly category?: string | null;
  readonly sourcePhotoIds: readonly number[];
  readonly sourceText: readonly string[];
  /** The model's own confidence, 0.0 to 1.0. */
  readonly confidence: number;
}

export interface AiOrderExtraction {
  readonly supplier: string | null;
  readonly items: readonly AiExtractedItem[];
  readonly warnings: readonly string[];
}

/** How an imported photograph was classified before extraction ran. */
export const OrderImageType = {
  RECEIPT: 'RECEIPT',
  CASE_LABEL: 'CASE_LABEL',
  PRODUCT_PHOTO: 'PRODUCT_PHOTO',
  UNKNOWN: 'UNKNOWN',
} as const;
export type OrderImageType = (typeof OrderImageType)[keyof typeof OrderImageType];

export function imageTypeFrom(raw: string | null | undefined): OrderImageType {
  const key = (raw ?? '').trim().toUpperCase();
  return (Object.values(OrderImageType) as string[]).includes(key)
    ? (key as OrderImageType)
    : OrderImageType.UNKNOWN;
}

/** One product the model says it can see in a photograph. */
export interface AiVisualProduct {
  readonly brand?: string | null;
  readonly productName?: string | null;
  readonly size?: string | null;
  readonly variant?: string | null;
  readonly upc?: string | null;
  /** Left to right in the picture, so "the second one" can be resolved. */
  readonly position: number;
  readonly confidence: number;
}

export function visualSearchText(product: AiVisualProduct): string {
  return [product.brand, product.productName, product.variant, product.size]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ');
}

export interface ProductIdentification {
  readonly products: readonly AiVisualProduct[];
  readonly warnings: readonly string[];
}

/**
 * A stack of cases the model says it can see in a delivery photograph.
 *
 * `countedCases` is what it could actually count, which is not the same as what is there - a
 * pallet hides its own back row. `mayBeHidden` is the model saying so.
 */
export interface AiCaseSighting {
  readonly brand?: string | null;
  readonly productName?: string | null;
  readonly size?: string | null;
  readonly packDescription?: string | null;
  readonly countedCases: number;
  readonly mayBeHidden: boolean;
  readonly confidence: number;
  readonly sourcePhotoIds: readonly number[];
}

export interface AiCaseCount {
  readonly sightings: readonly AiCaseSighting[];
  readonly warnings: readonly string[];
}

/**
 * What the model decided the user's sentence *means*. Reference and intent only.
 *
 * Note what is absent: there is no variant carrying a price. The model can say "they mean item 4"
 * and "that was a correction to $7.99", but the cost and the shelf price are read back out of the
 * database afterwards.
 */
export type OrderQuestionResolution =
  | { kind: 'productMatches'; itemIds: number[]; followUp?: string | null }
  | { kind: 'categoryMatches'; itemIds: number[]; label?: string | null }
  | { kind: 'clarification'; question: string }
  | { kind: 'priceCorrection'; updates: Array<{ itemId: number; retailPrice: string }> }
  | { kind: 'profitQuery'; itemIds: number[]; retailPrice: string }
  | { kind: 'caseQuantityQuery'; itemIds: number[] }
  | { kind: 'general'; reply: string }
  | { kind: 'unresolved'; reason?: string | null };

/** Why an AI call did not produce an answer. Each maps to something worth saying out loud. */
export type AiError =
  | { kind: 'missingKey' }
  | { kind: 'invalidKey' }
  | { kind: 'quotaExhausted'; retryAfterSeconds?: number | null }
  | { kind: 'rateLimited'; retryAfterSeconds?: number | null }
  | { kind: 'overloaded' }
  | { kind: 'timeout' }
  | { kind: 'network'; detail?: string | null }
  | { kind: 'requestTooLarge' }
  | { kind: 'blocked'; reason?: string | null }
  | { kind: 'truncated' }
  | { kind: 'serverError'; status: number; detail?: string | null }
  | { kind: 'malformedResponse'; detail: string }
  | { kind: 'unknown'; detail?: string | null };

/** True when trying the same call again could plausibly succeed. */
export function isTransient(error: AiError): boolean {
  switch (error.kind) {
    case 'rateLimited':
    case 'overloaded':
    case 'timeout':
    case 'network':
      return true;
    case 'serverError':
      return error.status >= 500;
    default:
      return false;
  }
}

/** Errors where trying the next batch is throwing good money after bad. */
export function isFatalForRun(error: AiError): boolean {
  return (
    error.kind === 'missingKey' ||
    error.kind === 'invalidKey' ||
    error.kind === 'quotaExhausted'
  );
}

/** What the user reads. Never leaks a key, a URL or a stack trace. */
export function aiErrorMessage(error: AiError): string {
  switch (error.kind) {
    case 'missingKey':
      return 'AI setup is required once before Grocery Pricer can read receipt photos.';
    case 'invalidKey':
      return 'That API key was rejected. Check it in Settings under AI setup.';
    case 'quotaExhausted':
      // The exact sentence the brief asks for: nobody gets billed by surprise.
      return 'Free Gemini quota reached. Grocery Pricer will not charge you. Try again after the quota resets.';
    case 'rateLimited':
      return 'Gemini is rate limiting requests right now. Try again in a moment.';
    case 'overloaded':
      return 'Gemini is busy right now. Try again in a moment.';
    case 'timeout':
      return 'That took too long to come back. Try again.';
    case 'network':
      return 'No internet connection. Saved orders still work offline.';
    case 'requestTooLarge':
      return 'Too many photos went out at once. Try again with fewer.';
    case 'blocked':
      return 'Gemini declined to process that image. Try a different photo.';
    case 'truncated':
      return 'The reply was cut off before it finished. Try processing fewer photos at once.';
    case 'serverError':
      return 'Gemini returned an error. Try again.';
    case 'malformedResponse':
      return 'I got a reply I could not read. Try again.';
    case 'unknown':
      return 'Something went wrong talking to Gemini.';
  }
}

export type AiResult<T> = { ok: true; value: T } | { ok: false; error: AiError };

export function aiOk<T>(value: T): AiResult<T> {
  return { ok: true, value };
}

export function aiFail<T = never>(error: AiError): AiResult<T> {
  return { ok: false, error };
}
