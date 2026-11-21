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

/**
 * One money-off line exactly as it sits on the paper, before anything decides whose it is.
 *
 * A wholesale receipt does not print a discount beside its product. It prints the product, the
 * barcode, the case price, a flyer description, a flyer reference number, the amount off and a
 * units line - seven lines, in that order, for one purchase. Asking a model to carry an amount
 * backwards over four lines and nest it in the right object is asking it to do bookkeeping, and
 * on a real seven-photograph order it did not: eighty-one products came back and not one
 * discount. Asking it to list the lines it can see is a far smaller thing to get right.
 *
 * Which product each line belongs to is then decided here, by code, from the printed evidence.
 */
export interface AiDiscountLine {
  /** The money off, as printed. Text until Money has parsed it. */
  readonly amount?: string | null;
  /** The product the line names, if it names one. */
  readonly productName?: string | null;
  /**
   * The product line printed directly above it, copied verbatim.
   *
   * The most useful thing the model can give us about a money-off line, because it is reading
   * rather than judgement: a copied line says which product the money belongs to without
   * anybody counting array positions, and it is printed evidence we can check a name against.
   */
  readonly productLineAbove?: string | null;
  /** The barcode printed with that product, if it was visible. The strongest identity there is. */
  readonly upc?: string | null;
  /** 0-based index into `items`, when the model can tell whose line it is. */
  readonly appliesToIndex?: number | null;
  /** A flyer or promotion number printed with it, kept as evidence rather than used. */
  readonly reference?: string | null;
  readonly sourcePhotoIds: readonly number[];
  readonly sourceText: readonly string[];
}

export interface AiOrderExtraction {
  readonly supplier: string | null;
  readonly items: readonly AiExtractedItem[];
  /** Money-off lines seen on the paper, whether or not they were nested into an item. */
  readonly discountLines?: readonly AiDiscountLine[];
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
  /** HTTP 404: the key reached Google, but this model is not one it may call. */
  | { kind: 'modelUnavailable'; model: string; status: number; detail?: string | null }
  /** Every model the app is willing to choose was refused. One answer, not a list. */
  | { kind: 'noWorkingModel'; tried: number }
  /** HTTP 400 that is not about the key: the request itself was refused. */
  | { kind: 'badRequest'; status: number; detail?: string | null }
  /** HTTP 403 that is not about the key: the project or model is restricted. */
  | { kind: 'accessDenied'; status: number; detail?: string | null }
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
    error.kind === 'quotaExhausted' ||
    // A model the key cannot call, or a project that is refused, is refused for every photo.
    // Trying the remaining batches only spends time and makes the same report arrive late.
    error.kind === 'modelUnavailable' ||
    error.kind === 'noWorkingModel' ||
    error.kind === 'accessDenied'
  );
}

/** What the user reads. Never leaks a key, a URL or a stack trace. */
/**
 * Appends Google's own explanation when there is one.
 *
 * Kept short and never raw: a whole error document in a toast is unreadable, and the body of a
 * failed request is the one place a stray credential could turn up.
 */
function withDetail(detail: string | null | undefined): string {
  const safe = redactSecrets(detail ?? '').trim();
  if (safe.length === 0) return '.';
  return `: ${safe.length > 160 ? `${safe.slice(0, 160)}...` : safe}`;
}

/** Nothing key-shaped is ever shown, logged or stored, wherever it came from. */
export function redactSecrets(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key hidden]')
    .replace(/(key=)[^&\s"']+/gi, '$1[key hidden]');
}

export function aiErrorMessage(error: AiError): string {
  switch (error.kind) {
    case 'missingKey':
      return 'AI setup is required once before Grocery Pricer can read receipt photos.';
    case 'invalidKey':
      return 'That API key was rejected. Check it in Settings under AI setup.';
    case 'quotaExhausted':
      // The exact sentence the brief asks for: nobody gets billed by surprise.
      // Carefully worded. What this app does is knowable and is stated; what Google bills is
      // a property of the owner's own project, and promising "you will not be charged" would
      // be a guarantee about somebody else's account that nothing here can actually make.
      return 'Gemini quota reached for now. Grocery Pricer never turns on billing and never picks a paid model - what your Google project charges, if anything, is set in that project. Try again after the allowance resets.';
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
    case 'modelUnavailable':
      // The single most useful sentence this app can print: it names the model, says the key
      // itself was accepted, and points at the one setting that fixes it.
      return `Gemini does not offer "${error.model}" to this API key (HTTP 404). The key reached Google, so the key itself is fine. Open Settings and choose a different model - "List the models Google advertises for my key" shows what to try.`;
    case 'noWorkingModel':
      // Deliberately names no model. Reaching here means the owner cannot fix this by picking
      // from a list - every model this app would pick has already been refused - so the one
      // useful thing to say is where the problem actually lives.
      return 'Gemini would not read the receipt with any of the models Grocery Pricer can use. This is usually the Google project the key belongs to rather than the app. Try a new key from Google AI Studio, or try again later.';
    case 'accessDenied':
      return `Google refused this request (HTTP 403)${withDetail(error.detail)} The key was recognised, so this is the Google project's access to the model rather than the key itself.`;
    case 'badRequest':
      return `Gemini rejected the request (HTTP 400)${withDetail(error.detail)} This is the request itself, not your key or your photos.`;
    case 'serverError':
      return `Gemini returned an error (HTTP ${error.status})${withDetail(error.detail)} Try again.`;
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
