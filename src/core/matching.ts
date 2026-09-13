/**
 * Product name and package-size matching.
 *
 * Size is load-bearing here. Tide 25 oz and Tide 40 oz are different products at different costs,
 * and a matcher that treats them as one produces a confident answer at the wrong price - which is
 * worse than no answer at all.
 */

const NOISE_WORDS = new Set([
  'the', 'and', 'of', 'with', 'for', 'size', 'case', 'unit', 'units', 'pack', 'pk',
  'ea', 'each', 'ct', 'count', 'fm', 'asst', 'assorted', 'reg', 'regular', 'new',
]);

const POSSESSIVE = /['’]s\b/gi;
const PUNCTUATION = /[^A-Za-z0-9 ]/g;

export interface PackageSize {
  /** Kept as a number rounded to three places; sizes are measurements, not money. */
  readonly value: number;
  readonly unit: SizeUnit;
}

export const SizeUnit = {
  OZ: 'OZ',
  LB: 'LB',
  GRAM: 'G',
  KILOGRAM: 'KG',
  ML: 'ML',
  LITER: 'L',
  COUNT: 'CT',
  GALLON: 'GAL',
  QUART: 'QT',
  PINT: 'PT',
} as const;
export type SizeUnit = (typeof SizeUnit)[keyof typeof SizeUnit];

const UNIT_ALIASES: Record<SizeUnit, readonly string[]> = {
  OZ: ['oz', 'ozs', 'ounce', 'ounces', 'z', 'floz', 'floz', 'fluidounce'],
  LB: ['lb', 'lbs', 'pound', 'pounds', '#'],
  G: ['g', 'gr', 'gram', 'grams'],
  KG: ['kg', 'kgs', 'kilogram', 'kilograms'],
  ML: ['ml', 'mls', 'milliliter', 'millilitre'],
  L: ['l', 'lt', 'ltr', 'liter', 'litre', 'liters'],
  CT: ['ct', 'cnt', 'count', 'pk', 'pack', 'ea', 'each', 'roll', 'rolls', 'sheets'],
  GAL: ['gal', 'gallon', 'gallons'],
  QT: ['qt', 'quart', 'quarts'],
  PT: ['pt', 'pint', 'pints'],
};

export function unitFromToken(token: string): SizeUnit | null {
  const cleaned = token.toLowerCase().trim().replace(/^[.,()]+|[.,()]+$/g, '');
  if (cleaned.length === 0) return null;
  for (const unit of Object.keys(UNIT_ALIASES) as SizeUnit[]) {
    if (UNIT_ALIASES[unit].includes(cleaned)) return unit;
  }
  return null;
}

export function sizeCanonical(size: PackageSize): string {
  return `${trimTrailingZeros(size.value)} ${size.unit}`;
}

/** Sizes only match when both the number and the unit agree. 8 oz is not 15 oz. */
export function sizesMatch(a: PackageSize, b: PackageSize): boolean {
  return a.unit === b.unit && a.value === b.value;
}

// "10 FL OZ", "13.2 OZ", "8Z", "750ML", "2 LB", "12 CT"
const SIZE_PATTERN =
  /(?<![0-9.])([0-9]+(?:\.[0-9]+)?)\s*(fl\.?\s*oz|floz|oz|ozs|lbs|lb|kgs|kg|gal|qt|pt|ml|ltr|ct|cnt|pk|pack|count|rolls|roll|g|l|z)\b/gi;

export const SizeParser = {
  /**
   * Pulls a package size out of free text such as `HELLM MAYONNAISE 8Z` or `DOWNY 10 FL OZ`.
   * Returns null rather than guessing when nothing clear is present.
   */
  parse(text: string | null | undefined): PackageSize | null {
    if (text === null || text === undefined || text.trim().length === 0) return null;
    const matches = [...text.matchAll(new RegExp(SIZE_PATTERN))];
    if (matches.length === 0) return null;

    // Receipt descriptions put the size last ("KELL FROOT LOOP FM 13.2Z"), so prefer the
    // right-most match when a product name happens to contain another number.
    const match = matches[matches.length - 1]!;
    const rawValue = match[1] ?? '';
    const rawUnit = (match[2] ?? '').toLowerCase().replaceAll('.', '').replaceAll(' ', '');
    const unit = unitFromToken(rawUnit);
    if (unit === null) return null;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
    return { value: Math.round(value * 1000) / 1000, unit };
  },

  /** The size portion of a description, as text, for display and storage. */
  canonicalOrNull(text: string | null | undefined): string | null {
    const parsed = SizeParser.parse(text);
    return parsed === null ? null : sizeCanonical(parsed);
  },

  /** Removes the size from a description so the remaining words can be name-matched. */
  stripSize(text: string): string {
    return text.replace(new RegExp(SIZE_PATTERN), ' ').replace(/ {2,}/g, ' ').trim();
  },
};

export const NameNormalizer = {
  /** Upper case, punctuation-free, size-free, noise-free. Empty when nothing meaningful is left. */
  normalize(raw: string | null | undefined): string {
    if (raw === null || raw === undefined || raw.trim().length === 0) return '';
    const withoutSize = SizeParser.stripSize(raw);
    const cleaned = withoutSize
      .replace(POSSESSIVE, '')
      .replace(PUNCTUATION, ' ')
      .toUpperCase()
      .replace(/ {2,}/g, ' ')
      .trim();
    return cleaned
      .split(' ')
      .filter((word) => word.length > 0 && !NOISE_WORDS.has(word.toLowerCase()))
      .join(' ');
  },

  tokens(raw: string | null | undefined): string[] {
    return NameNormalizer.normalize(raw)
      .split(' ')
      .filter((token) => token.length > 0);
  },

  /**
   * 0.0 - 1.0 similarity built from shared tokens plus a character-level comparison, so
   * `HELLM MAYONNAISE` and `HELLMANNS MAYONNAISE` score highly while `TIDE` and `TIDY` do not.
   */
  similarity(a: string | null | undefined, b: string | null | undefined): number {
    const tokensA = NameNormalizer.tokens(a);
    const tokensB = NameNormalizer.tokens(b);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const matchedA = tokensA.filter((ta) => tokensB.some((tb) => NameNormalizer.tokensAlike(ta, tb))).length;
    const matchedB = tokensB.filter((tb) => tokensA.some((ta) => NameNormalizer.tokensAlike(tb, ta))).length;
    const tokenScore = (matchedA + matchedB) / (tokensA.length + tokensB.length);

    const charScore = NameNormalizer.levenshteinRatio(
      NameNormalizer.normalize(a),
      NameNormalizer.normalize(b),
    );
    return tokenScore * 0.7 + charScore * 0.3;
  },

  /** Two tokens are the same word when one is a prefix of the other (`HELLM` / `HELLMANNS`). */
  tokensAlike(a: string, b: string): boolean {
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length < 3) return false;
    if (longer.startsWith(shorter)) return true;
    return NameNormalizer.levenshteinRatio(a, b) >= 0.85;
  },

  levenshteinRatio(a: string, b: string): number {
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const distance = NameNormalizer.levenshtein(a, b);
    return 1 - distance / Math.max(a.length, b.length);
  },

  levenshtein(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    let current = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
        current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
      }
      const swap = previous;
      previous = current;
      current = swap;
    }
    return previous[b.length]!;
  },
};

/** A barcode reduced to a comparable form. Returns null when it is not a plausible barcode. */
export function normalizeUpc(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  // UPC-A and EAN-13 for the same product differ only by leading zeros.
  return digits.replace(/^0+/, '') || '0';
}

export function upcEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeUpc(a);
  const right = normalizeUpc(b);
  return left !== null && right !== null && left === right;
}

function trimTrailingZeros(value: number): string {
  return String(Number(value.toFixed(3)));
}
