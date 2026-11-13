import { Money } from './money';
import { DiscountScope } from './models';
import {
  aiFail,
  aiOk,
  imageTypeFrom,
  type AiCaseCount,
  type AiCaseSighting,
  type AiExtractedDiscount,
  type AiExtractedItem,
  type AiOrderExtraction,
  type AiResult,
  type OrderImageType,
  type OrderQuestionResolution,
  type ProductIdentification,
} from './ai-types';

type Json = Record<string, unknown>;

/**
 * Pull the first complete JSON object out of a reply.
 *
 * Models wrap JSON in prose, in ```json fences, or in an apology. Rather than trusting any of
 * that, scan for the first `{` and walk forward counting depth - while respecting string literals
 * and escapes, so a `}` inside a product name cannot end the object early.
 *
 * Returns null when there is no balanced object, which is what a truncated reply looks like.
 */
export function extractFirstJsonObject(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonObject(raw: string | null | undefined): Json | null {
  const text = extractFirstJsonObject(raw);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

// --- defensive readers. A field can be absent, null, the wrong type, a number sent as a string
//     or a string sent as a number, and none of those may throw. ---

function str(source: Json, key: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text.length > 0 && text.toLowerCase() !== 'null' ? text : null;
}

function int(source: Json, key: string): number | null {
  const value = source[key];
  if (value === null || value === undefined || typeof value === 'object') return null;
  const num = Number(String(value).trim());
  if (!Number.isFinite(num)) return null;
  return Number.isInteger(num) ? num : Math.trunc(num);
}

function dbl(source: Json, key: string): number | null {
  const value = source[key];
  if (value === null || value === undefined || typeof value === 'object') return null;
  const num = Number(String(value).trim());
  return Number.isFinite(num) ? num : null;
}

function bool(source: Json, key: string): boolean | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  return null;
}

function arr(source: Json, key: string): unknown[] | null {
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

function objList(source: Json, key: string): Json[] {
  return (arr(source, key) ?? []).filter(
    (v): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

function strList(source: Json, key: string): string[] {
  return (arr(source, key) ?? [])
    .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function numList(source: Json, key: string): number[] {
  return (arr(source, key) ?? [])
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.trunc(n));
}

/**
 * Turns whatever the model actually sent into the typed shapes the rest of the app expects.
 *
 * A parse never throws. Anything unreadable becomes a malformedResponse carrying a short reason,
 * and anything readable-but-wrong is left for the validator to throw out.
 */
export const AiResponseParser = {
  orderExtraction(raw: string | null | undefined): AiResult<AiOrderExtraction> {
    const root = parseJsonObject(raw);
    if (root === null) {
      return aiFail({
        kind: 'malformedResponse',
        detail:
          raw === null || raw === undefined || raw.trim().length === 0
            ? 'the reply was empty'
            : 'the reply contained no complete JSON object',
      });
    }
    if (arr(root, 'items') === null) {
      return aiFail({ kind: 'malformedResponse', detail: 'the reply had no "items" array' });
    }
    return aiOk({
      supplier: str(root, 'supplier'),
      items: objList(root, 'items').map(toExtractedItem),
      warnings: strList(root, 'warnings'),
    });
  },

  imageClassification(
    raw: string | null | undefined,
  ): AiResult<Array<{ photoId: number; type: OrderImageType; confidence: number }>> {
    const root = parseJsonObject(raw);
    if (root === null) return aiFail({ kind: 'malformedResponse', detail: 'no JSON object in the reply' });
    if (arr(root, 'images') === null) {
      return aiFail({ kind: 'malformedResponse', detail: 'the reply had no "images" array' });
    }
    const classified = objList(root, 'images')
      .map((el) => {
        const photoId = int(el, 'photoId');
        if (photoId === null) return null;
        return { photoId, type: imageTypeFrom(str(el, 'type')), confidence: dbl(el, 'confidence') ?? 0 };
      })
      .filter((v): v is { photoId: number; type: OrderImageType; confidence: number } => v !== null);
    return aiOk(classified);
  },

  productIdentification(raw: string | null | undefined): AiResult<ProductIdentification> {
    const root = parseJsonObject(raw);
    if (root === null) return aiFail({ kind: 'malformedResponse', detail: 'no JSON object in the reply' });
    if (arr(root, 'products') === null) {
      return aiFail({ kind: 'malformedResponse', detail: 'the reply had no "products" array' });
    }
    const products = objList(root, 'products')
      .map((el, index) => ({
        brand: str(el, 'brand'),
        productName: str(el, 'productName'),
        size: str(el, 'size'),
        variant: str(el, 'variant'),
        upc: str(el, 'upc'),
        // Fall back to reading order so "the second one" still means something.
        position: int(el, 'position') ?? index,
        confidence: dbl(el, 'confidence') ?? 0,
      }))
      .filter((p) => p.brand !== null || p.productName !== null || p.upc !== null);
    return aiOk({ products, warnings: strList(root, 'warnings') });
  },

  /**
   * Cases counted in a delivery photograph.
   *
   * A sighting claiming a negative or absurd number of cases is dropped rather than corrected -
   * it is evidence the photograph was not understood, and a wrong count here turns into a false
   * accusation that a supplier short-shipped.
   */
  caseCount(raw: string | null | undefined): AiResult<AiCaseCount> {
    const root = parseJsonObject(raw);
    if (root === null) return aiFail({ kind: 'malformedResponse', detail: 'no JSON object in the reply' });
    if (arr(root, 'sightings') === null) {
      return aiFail({ kind: 'malformedResponse', detail: 'the reply had no "sightings" array' });
    }
    const sightings: AiCaseSighting[] = objList(root, 'sightings')
      .map((el) => ({
        brand: str(el, 'brand'),
        productName: str(el, 'productName'),
        size: str(el, 'size'),
        packDescription: str(el, 'packDescription'),
        countedCases: int(el, 'countedCases') ?? 0,
        mayBeHidden: bool(el, 'mayBeHidden') ?? false,
        confidence: clamp01(dbl(el, 'confidence') ?? 0),
        sourcePhotoIds: numList(el, 'sourcePhotoIds'),
      }))
      .filter(
        (s) =>
          s.countedCases >= 0 &&
          s.countedCases <= MAX_PLAUSIBLE_CASES &&
          (s.brand !== null || s.productName !== null),
      );
    return aiOk({ sightings, warnings: strList(root, 'warnings') });
  },

  /**
   * Reads the model's decision about what the user meant.
   *
   * Any item id is filtered against `allowedItemIds`. A model that invents an id, or reaches for
   * a row that was never offered to it, gets that id dropped rather than obeyed - which is what
   * stops a hallucinated reference turning into a real price change.
   */
  questionResolution(
    raw: string | null | undefined,
    allowedItemIds: ReadonlySet<number>,
  ): AiResult<OrderQuestionResolution> {
    const root = parseJsonObject(raw);
    if (root === null) return aiFail({ kind: 'malformedResponse', detail: 'no JSON object in the reply' });

    const ids = numList(root, 'itemIds').filter((id) => allowedItemIds.has(id));

    switch (kindKey(str(root, 'kind'))) {
      case 'PRODUCTMATCHES':
        return aiOk(
          ids.length === 0
            ? { kind: 'unresolved', reason: 'no known item matched' }
            : { kind: 'productMatches', itemIds: ids, followUp: str(root, 'followUp') },
        );

      case 'CATEGORYMATCHES':
        return aiOk(
          ids.length === 0
            ? { kind: 'unresolved', reason: 'no item in that group' }
            : { kind: 'categoryMatches', itemIds: ids, label: str(root, 'label') },
        );

      case 'CLARIFICATION': {
        const question = str(root, 'question');
        if (question === null) {
          return aiFail({ kind: 'malformedResponse', detail: 'a clarification with no question in it' });
        }
        return aiOk({ kind: 'clarification', question });
      }

      case 'PRICECORRECTION': {
        const updates = objList(root, 'updates')
          .map((el) => {
            const itemId = int(el, 'itemId');
            const retailPrice = str(el, 'retailPrice');
            if (itemId === null || retailPrice === null || !allowedItemIds.has(itemId)) return null;
            return { itemId, retailPrice };
          })
          .filter((v): v is { itemId: number; retailPrice: string } => v !== null);
        return aiOk(
          updates.length === 0
            ? { kind: 'unresolved', reason: 'a correction naming no known product' }
            : { kind: 'priceCorrection', updates },
        );
      }

      case 'PROFITQUERY': {
        const retailPrice = str(root, 'retailPrice');
        if (retailPrice === null || ids.length === 0) {
          return aiOk({ kind: 'unresolved', reason: 'an incomplete profit question' });
        }
        return aiOk({ kind: 'profitQuery', itemIds: ids, retailPrice });
      }

      case 'CASEQUANTITYQUERY':
        return aiOk(
          ids.length === 0
            ? { kind: 'unresolved', reason: 'no known item matched' }
            : { kind: 'caseQuantityQuery', itemIds: ids },
        );

      case 'GENERAL': {
        const reply = str(root, 'reply');
        if (reply === null) {
          return aiFail({ kind: 'malformedResponse', detail: 'a general answer with no text' });
        }
        return aiOk({ kind: 'general', reply });
      }

      case '':
        return aiFail({ kind: 'malformedResponse', detail: 'the reply had no "kind"' });

      default:
        return aiOk({ kind: 'unresolved', reason: 'an unrecognised answer type' });
    }
  },
};

const MAX_PLAUSIBLE_CASES = 5000;

/**
 * The answer type, spelling-insensitive.
 *
 * A model asked for `productMatches` sometimes returns `product_matches`, and either spelling
 * means the same thing. Underscores and case are removed so a formatting whim cannot turn a
 * perfectly good answer into "I did not understand that".
 */
function kindKey(raw: string | null): string {
  return (raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function toExtractedItem(source: Json): AiExtractedItem {
  return {
    rawName: str(source, 'rawName'),
    canonicalName: str(source, 'canonicalName'),
    brand: str(source, 'brand'),
    size: str(source, 'size'),
    upc: str(source, 'upc'),
    supplierSku: str(source, 'supplierSku'),
    casePrice: str(source, 'casePrice'),
    unitsPerCase: int(source, 'unitsPerCase'),
    printedUnitCost: str(source, 'printedUnitCost'),
    casesPurchased: int(source, 'casesPurchased'),
    discount: toDiscount(source),
    category: str(source, 'category'),
    sourcePhotoIds: numList(source, 'sourcePhotoIds'),
    sourceText: strList(source, 'sourceText'),
    // A model that forgets to score itself is treated as unsure, never as certain.
    confidence: dbl(source, 'confidence') ?? 0,
  };
}

function toDiscount(source: Json): AiExtractedDiscount | null {
  const raw = source['discount'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const discount = raw as Json;
  const amount = str(discount, 'amount');
  const scope = str(discount, 'scope');
  // `"discount": {}` means no discount, not a zero-dollar one.
  if (amount === null && scope === null) return null;
  return { amount, scope, appliesToUnits: int(discount, 'appliesToUnits') };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/** Scope names the model is allowed to use. Anything else becomes UNKNOWN. */
export function discountScopeFrom(raw: string | null | undefined): DiscountScope | null {
  const key = (raw ?? '').trim().toUpperCase();
  return (Object.values(DiscountScope) as string[]).includes(key) ? (key as DiscountScope) : null;
}

export { Money };
