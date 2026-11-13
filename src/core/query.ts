import { Money } from './money';
import { NameNormalizer, SizeParser, normalizeUpc, sizesMatch, upcEquivalent } from './matching';

/** One row of an imported order, as far as searching is concerned. */
export interface QueryableItem {
  readonly id: number;
  readonly name: string;
  readonly size: string | null;
  readonly brand: string | null;
  readonly category: string | null;
  readonly upc: string | null;
  readonly supplierSku: string | null;
  readonly unitsPerCase: number | null;
  readonly unitCost: Money | null;
  readonly suggestedRetail: Money | null;
  readonly approvedRetail: Money | null;
}

/** What the user's words appeared to be asking for. */
export interface QueryRequest {
  readonly phrase: string;
  /** True when the wording was plural - "the juices", "all six" - so several answers are wanted. */
  readonly expectMultiple?: boolean;
  /** A count the user stated, e.g. 2 in "how much are these two". */
  readonly expectedCount?: number | null;
}

export type QueryOutcome =
  | { kind: 'exact'; item: QueryableItem }
  | { kind: 'several'; items: QueryableItem[] }
  | { kind: 'ambiguous'; candidates: QueryableItem[] }
  | { kind: 'none' };

/** How far ahead the top match must be before it answers without asking. */
export const DECISIVE_MARGIN = 0.9;
/** How close to the top a row must be to count as a real alternative. */
export const SIBLING_MARGIN = 1.0;
export const MAX_CANDIDATES = 8;

/** Words that carry no product meaning, so they never decide a match. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'buy', 'can', 'charge', 'cost', 'costs', 'did',
  'do', 'does', 'each', 'for', 'get', 'give', 'how', 'i', 'in', 'is', 'it', 'its', 'many',
  'me', 'much', 'my', 'of', 'on', 'one', 'ones', 'or', 'our', 'pay', 'paid', 'per',
  'price', 'prices', 'sell', 'selling', 'should', 'show', 'that', 'the', 'them', 'these',
  'they', 'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what', 'whats', 'which',
  'with', 'you', 'your',
  // Counting words say how many answers are wanted, not what the product is called.
  'both', 'couple', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'all', 'every',
]);

/**
 * Local product lookup over one imported order.
 *
 * This exists so the common question never leaves the phone. "How much is the Hellmann's 8 oz" has
 * exactly one answer already in the database, and paying a cloud model to find it would be slower,
 * cost the shopkeeper money, and work no better. The AI is for what this cannot settle: real
 * ambiguity, photographs, and sentences that refer back to the conversation.
 *
 * Nothing here computes a price. It returns rows; the caller reads the money off them.
 */
export class OrderQueryEngine {
  constructor(private readonly items: readonly QueryableItem[]) {}

  all(): readonly QueryableItem[] {
    return this.items;
  }

  byId(id: number): QueryableItem | null {
    return this.items.find((item) => item.id === id) ?? null;
  }

  byIds(ids: readonly number[]): QueryableItem[] {
    // Preserve the caller's order: "number two" depends on it.
    const byId = new Map(this.items.map((item) => [item.id, item]));
    return ids.map((id) => byId.get(id)).filter((item): item is QueryableItem => item !== undefined);
  }

  /** A scanned barcode is an exact answer or no answer. It never guesses. */
  byBarcode(barcode: string | null | undefined): QueryableItem | null {
    if (normalizeUpc(barcode) === null) return null;
    return this.items.find((item) => upcEquivalent(item.upc, barcode)) ?? null;
  }

  inCategory(category: string | null | undefined): QueryableItem[] {
    const wanted = (category ?? '').trim().toLowerCase();
    if (wanted.length === 0) return [];
    return this.items.filter((item) => (item.category ?? '').trim().toLowerCase() === wanted);
  }

  costingUnder(limit: Money): QueryableItem[] {
    return this.items
      .filter((item) => item.unitCost !== null && item.unitCost.lessThan(limit))
      .sort((a, b) => (a.unitCost?.toStorage() ?? 0) - (b.unitCost?.toStorage() ?? 0));
  }

  costingOver(limit: Money): QueryableItem[] {
    return this.items
      .filter((item) => item.unitCost !== null && item.unitCost.greaterThan(limit))
      .sort((a, b) => (b.unitCost?.toStorage() ?? 0) - (a.unitCost?.toStorage() ?? 0));
  }

  /**
   * Resolve a product phrase against this order.
   *
   * The plural rule matters more than it looks. "How much is the mayonnaise" with an 8 oz and a
   * 15 oz on the receipt must ask which one, because answering with either is a coin flip on a
   * real shelf price. "How much are the two juices" with the same shaped result must answer both.
   * The difference is entirely in how the person spoke.
   */
  resolve(request: QueryRequest): QueryOutcome {
    const phrase = request.phrase.trim();
    if (phrase.length === 0) return { kind: 'none' };

    const barcoded = this.barcodeIn(phrase);
    if (barcoded !== null) return { kind: 'exact', item: barcoded };

    const scored = this.rank(phrase);
    if (scored.length === 0) return { kind: 'none' };

    const best = scored[0]!;
    const runnerUp = scored[1];
    const decisive = runnerUp === undefined || best.score >= runnerUp.score + DECISIVE_MARGIN;

    if (request.expectMultiple === true) {
      const wanted = request.expectedCount ?? null;
      const strong = scored.filter((s) => s.score >= best.score - SIBLING_MARGIN);
      const chosen = wanted !== null && wanted <= scored.length ? scored.slice(0, wanted) : strong;
      if (chosen.length <= 1) return { kind: 'exact', item: best.item };
      return { kind: 'several', items: chosen.map((s) => s.item) };
    }

    if (decisive) return { kind: 'exact', item: best.item };

    const tied = scored.filter((s) => s.score >= best.score - SIBLING_MARGIN);
    if (tied.length <= 1) return { kind: 'exact', item: best.item };
    return { kind: 'ambiguous', candidates: tied.slice(0, MAX_CANDIDATES).map((s) => s.item) };
  }

  /**
   * The shortlist handed to the model when local matching cannot settle it.
   *
   * Deliberately short. Sending the whole order would cost the user money on every question and
   * make the model's job harder, not easier.
   */
  candidatesFor(phrase: string, limit: number = MAX_CANDIDATES): QueryableItem[] {
    const ranked = this.rank(phrase);
    if (ranked.length > 0) return ranked.slice(0, limit).map((s) => s.item);
    // Nothing matched at all - offer a small slice so the model can still say "did you mean".
    return this.items.slice(0, limit);
  }

  private barcodeIn(phrase: string): QueryableItem | null {
    const match = /\b\d{8,14}\b/.exec(phrase);
    return match === null ? null : this.byBarcode(match[0]);
  }

  /**
   * Score every row against the phrase.
   *
   * Size is a hard filter rather than a soft signal: if the person said a size and a row
   * contradicts it, that row is out. Merging an 8 oz and a 15 oz would produce a confident answer
   * at the wrong price.
   */
  private rank(phrase: string): Array<{ item: QueryableItem; score: number }> {
    const askedSize = SizeParser.parse(phrase);
    const bareNumbers = looseNumbers(phrase);
    const words = meaningfulWords(phrase);
    if (words.length === 0 && askedSize === null && bareNumbers.length === 0) return [];

    const scored: Array<{ item: QueryableItem; score: number }> = [];

    for (const item of this.items) {
      const itemSize = SizeParser.parse(item.size);

      if (askedSize !== null) {
        if (itemSize === null || !sizesMatch(itemSize, askedSize)) continue;
      }

      const haystack = [item.brand, item.name, item.size].filter((p) => p !== null).join(' ');
      const normalizedHaystack = NameNormalizer.normalize(haystack).toLowerCase();
      const haystackWords = new Set(NameNormalizer.tokens(haystack).map((w) => w.toLowerCase()));
      const haystackStems = new Set([...haystackWords].map(stem));

      let score = 0;
      let matchedWords = 0;

      for (const word of words) {
        let hit = 0;
        if (haystackWords.has(word)) hit = 1;
        // "the oils" must reach "Corn Oil"; edit distance never gets there on a short word.
        else if (haystackStems.has(stem(word))) hit = 0.95;
        else if (normalizedHaystack.includes(word)) hit = 0.85;
        else if ([...haystackWords].some((hw) => NameNormalizer.levenshteinRatio(hw, word) >= 0.82)) hit = 0.7;

        if (hit > 0) {
          matchedWords++;
          score += hit;
        }
      }

      // Every meaningful word has to land somewhere. "corn oil 48" must not match plain
      // "vegetable oil" just because "oil" is in both.
      if (words.length > 0 && matchedWords < words.length) continue;

      if (askedSize !== null) {
        score += 2;
      } else if (bareNumbers.length > 0 && itemSize !== null) {
        // "mayo 8" - a naked number that lines up with a package size is a strong hint.
        if (bareNumbers.some((n) => n === itemSize.value)) score += 2;
      }

      if (score > 0) scored.push({ item, score });
    }

    return scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  }
}

/**
 * Crude, deliberately. "oils" -> "oil", "juices" -> "juice", "boxes" -> "box". It exists to let a
 * plural question reach a singular product name, not to conjugate English.
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function meaningfulWords(phrase: string): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of NameNormalizer.tokens(phrase)) {
    const word = raw.toLowerCase();
    if (word.length === 0 || STOP_WORDS.has(word)) continue;
    // A bare number is handled as a size hint, not as a name word.
    if (/^\d+$/.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

function looseNumbers(phrase: string): number[] {
  return [...phrase.matchAll(/\b\d+(?:\.\d+)?\b/g)]
    .map((m) => Number(m[0]))
    .filter((n) => Number.isFinite(n));
}
