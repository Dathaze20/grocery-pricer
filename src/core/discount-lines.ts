import { NameNormalizer, SizeParser, sizeCanonical } from './matching';
import { DiscountScope, scopeFromReceiptText } from './models';
import { Money } from './money';
import type { AiDiscountLine, AiExtractedItem, AiOrderExtraction } from './ai-types';

/**
 * Decides which product each printed money-off line belongs to.
 *
 * The model is asked only to list the lines it can see; whose line it is gets decided here,
 * because that decision is money. The rule throughout is that an unplaced discount is reported
 * and a misplaced one is never made: a line attached to the wrong product changes what the shop
 * charges for two products at once, and nothing on the screen would show it.
 */

/** How alike a flyer line's name and a product's name must be before they are the same product. */
export const DISCOUNT_NAME_MATCH = 0.72;

/** Two candidates this close together are a tie, and a tie is not evidence. */
const TIE_MARGIN = 0.05;

export interface DiscountAssociation {
  readonly items: readonly AiExtractedItem[];
  readonly warnings: readonly string[];
}

/**
 * Attaches what the evidence supports and reports the rest.
 *
 * Never overwrites a discount a product already carries, never places one line on two products,
 * and never places two lines on one product. A line it cannot place becomes a warning naming the
 * amount, so the owner can enter it on the product card themselves.
 */
export function associateDiscountLines(
  items: readonly AiExtractedItem[],
  lines: readonly AiDiscountLine[] | undefined,
): DiscountAssociation {
  if (lines === undefined || lines.length === 0) return { items, warnings: [] };

  const out = items.map((item) => ({ ...item }));
  const taken = new Set<number>();
  const warnings: string[] = [];

  // A product that already carries a discount is not a candidate, and its amount is left alone.
  // Read loosely, sign and all: whatever the model attached, that product is spoken for.
  for (let i = 0; i < out.length; i += 1) {
    if (carriesDiscount(out[i]!)) taken.add(i);
  }

  for (const line of lines) {
    const amount = discountAmount(line);
    if (amount === null) {
      // No figure, no discount. Inventing one here is the one thing this must never do.
      if (describes(line)) warnings.push(unreadableWarning(line));
      continue;
    }

    const placement = placeLine(line, out, taken);
    if (placement.kind !== 'at') {
      const warning = refusalWarning(placement.kind, line, amount);
      if (warning !== null) warnings.push(warning);
      continue;
    }

    const target = placement.at;
    taken.add(target);
    const item = out[target]!;
    const evidence = [...item.sourceText, ...line.sourceText];
    out[target] = {
      ...item,
      discount: {
        amount: amount.toPlainString(),
        // Only the paper's own words may say "off the whole case"; anything else is asked.
        scope: scopeFromReceiptText(line.sourceText) ?? DiscountScope.UNKNOWN,
        appliesToUnits: null,
      },
      // The discount line becomes part of this product's evidence, which is what the owner reads
      // when they want to know why a cost is what it is.
      sourceText: [...new Set(evidence)],
      sourcePhotoIds: [...new Set([...item.sourcePhotoIds, ...line.sourcePhotoIds])],
    };
  }

  return { items: out, warnings };
}

/**
 * Where a line goes, or why it does not go anywhere.
 *
 * Each refusal is its own answer because each has a different thing to tell the owner, and
 * because a refusal that cannot explain itself is indistinguishable from a line nobody noticed.
 */
type Placement =
  | { readonly kind: 'at'; readonly at: number }
  /** The line names one product and points at another. */
  | { readonly kind: 'conflict' }
  /** A name several products answer to, and nothing printed to tell them apart. */
  | { readonly kind: 'unverified' }
  /** The product it points at already has this discount. */
  | { readonly kind: 'duplicate' }
  /** Nothing to go on at all. */
  | { readonly kind: 'unplaceable' };

/**
 * Which product a line belongs to, or why the paper does not say.
 *
 * The model's index is its reading of the layout, and the layout is real evidence: the amount is
 * printed below its product and above the next one. But it is only ever one piece of evidence,
 * and it is never taken over the top of another. When the line also names a product, the name
 * has to agree with the index, or nothing is applied - a model that writes "size 5" and points
 * at size 6 has told us two different things, and picking the one we happen to read first takes
 * money off the wrong product while looking entirely settled.
 *
 * And an index is not a tie-breaker. "FLYER DISCOUNT - DRYNITE JUMBO" over a receipt holding
 * two sizes of it names both equally; an index pointing at one of them adds no printed evidence
 * about which, so unless something on the paper tells the two apart, the line goes unplaced.
 */
function placeLine(
  line: AiDiscountLine,
  items: readonly AiExtractedItem[],
  taken: ReadonlySet<number>,
): Placement {
  const named = nameOf(line);
  const tied = named === null ? [] : topMatches(named, items, taken);

  const index = line.appliesToIndex;
  const pointed =
    index !== null && index !== undefined && Number.isInteger(index) && index >= 0 && index < items.length
      ? index
      : null;

  /*
   * The same discount listed twice.
   *
   * The prompt asks for every money-off line even when it has already been nested into a
   * product, so the same deduction can arrive twice. Falling back to matching by name sent the
   * second copy to the *next* purchase of the same product - a second case that had no discount
   * printed against it quietly got one. A line that points at a product already holding its
   * discount is that same money, so it stops here.
   */
  if (pointed !== null && taken.has(pointed)) return { kind: 'duplicate' };

  if (pointed !== null) {
    // Nothing is named, so the layout is all there is - and it is what the model could see.
    if (named === null) return { kind: 'at', at: pointed };

    /*
     * A name that was given has to support the product being pointed at.
     *
     * Treating "the name matches no row" as "the name contradicts no row" left the index
     * trusted on its own wherever the name was unrecognisable - and a name nobody can place is
     * exactly the case where the index is least likely to be right. It also covered a quieter
     * one: the product the name really belongs to may already hold its discount, so it is no
     * longer among the candidates, and the line was then applied to whatever the index happened
     * to say instead. Either way the two pieces of evidence on the line do not agree, and a
     * discount is only ever applied where they do.
     */
    if (!supports(named, items[pointed]!)) return { kind: 'conflict' };

    if (!tied.some((candidate) => candidate.at === pointed)) return { kind: 'conflict' };
    // The name agrees, and with this row alone.
    if (tied.length === 1) return { kind: 'at', at: pointed };
    // Two cases of one product: either row takes it and the answer is the same.
    if (allAlike(tied, items)) return { kind: 'at', at: pointed };
    // Several different products answer to the name. Only the paper may break that tie.
    return distinguishes(line, pointed, tied, items)
      ? { kind: 'at', at: pointed }
      : { kind: 'unverified' };
  }

  if (named === null || tied.length === 0) return { kind: 'unplaceable' };
  if (tied.length === 1) return { kind: 'at', at: tied[0]!.at };
  if (allAlike(tied, items)) return { kind: 'at', at: tied[0]!.at };
  return { kind: 'unverified' };
}

/** The name the line gives, or null when it gives nothing usable. */
function nameOf(line: AiDiscountLine): string | null {
  const named = line.productName;
  if (named === null || named === undefined) return null;
  return NameNormalizer.tokens(named).length === 0 ? null : named;
}

/** How well a line's name fits one row, by whichever of its two names fits better. */
function scoreFor(named: string, item: AiExtractedItem): number {
  return Math.max(
    NameNormalizer.similarity(named, item.rawName),
    NameNormalizer.similarity(named, item.canonicalName),
  );
}

/** Whether this row is one the name could be describing at all. */
function supports(named: string, item: AiExtractedItem): boolean {
  return scoreFor(named, item) >= DISCOUNT_NAME_MATCH;
}

/** The best-matching untaken rows, and anything tied with them. */
function topMatches(
  named: string,
  items: readonly AiExtractedItem[],
  taken: ReadonlySet<number>,
): Array<{ at: number; score: number }> {
  const scored: Array<{ at: number; score: number }> = [];
  for (let at = 0; at < items.length; at += 1) {
    if (taken.has(at)) continue;
    const score = scoreFor(named, items[at]!);
    if (score >= DISCOUNT_NAME_MATCH) scored.push({ at, score });
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  return scored.filter((candidate) => candidate.score >= best.score - TIE_MARGIN);
}

/** Whether every tied row is the same purchase as the first: nothing printed tells them apart. */
function allAlike(
  tied: ReadonlyArray<{ at: number }>,
  items: readonly AiExtractedItem[],
): boolean {
  const first = items[tied[0]!.at]!;
  return tied.every((candidate) => indistinguishable(first, items[candidate.at]!));
}

/**
 * Whether the line's own printed text names something only the pointed-at row has.
 *
 * This is what turns a tie into evidence. A flyer line reading "DRYNITE JUMBO #5 24CT" carries
 * "24CT", which belongs to one of the two sizes and not the other; a line reading only "DRYNITE
 * JUMBO" carries nothing that does. Amounts are stripped out first, or the digits in "-24.00"
 * would line themselves up against a 24-count pack and look like proof.
 */
function distinguishes(
  line: AiDiscountLine,
  pointed: number,
  tied: ReadonlyArray<{ at: number }>,
  items: readonly AiExtractedItem[],
): boolean {
  const printed = new Set(identityTokens([line.productName ?? '', ...line.sourceText].join(' ')));
  if (printed.size === 0) return false;

  const mine = identityTokens(identityOf(items[pointed]!));
  const others = tied
    .filter((candidate) => candidate.at !== pointed)
    .map((candidate) => new Set(identityTokens(identityOf(items[candidate.at]!))));

  return mine.some(
    (token) => printed.has(token) && others.every((other) => !other.has(token)),
  );
}

function identityOf(item: AiExtractedItem): string {
  return [item.rawName ?? '', item.canonicalName ?? '', item.size ?? ''].join(' ');
}

/** Words and numbers that identify a product, with money taken out of the way. */
function identityTokens(text: string): string[] {
  return text
    .replace(/-?\$?\d+[.,]\d{2}\b/g, ' ')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Two rows nothing printed can tell apart: same name, same size, same case price. */
function indistinguishable(a: AiExtractedItem, b: AiExtractedItem): boolean {
  return (
    NameNormalizer.normalize(a.rawName ?? a.canonicalName) ===
      NameNormalizer.normalize(b.rawName ?? b.canonicalName) &&
    sizeKey(a) === sizeKey(b) &&
    priceKey(a) === priceKey(b)
  );
}

function sizeKey(item: AiExtractedItem): string {
  const parsed = SizeParser.parse(item.size);
  return parsed === null ? (item.size?.trim().toUpperCase() ?? '') : sizeCanonical(parsed);
}

function priceKey(item: AiExtractedItem): string {
  const parsed = readableAmount(item.casePrice);
  return parsed?.toPlainString() ?? '?';
}

/** A positive, readable figure, or null. Used for prices, where a minus sign is a misread. */
function readableAmount(raw: string | null | undefined): Money | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const parsed = Money.parseOrNull(raw);
  if (parsed === null || parsed.isNegative || parsed.isZero) return null;
  return parsed;
}

/** Words that say a line is money off, so a printed minus is its sign rather than a misread. */
const SAYS_MONEY_OFF =
  /\b(flyer|discount|discounts|deal|deals|allowance|promo|promotion|promotional|saving|savings|rebate|coupon|off)\b/i;

/**
 * How much a discount line takes off, read the way the receipt prints it.
 *
 * The paper prints money off as "-7.00", and the prompt asks for it without the sign - but the
 * model reads what is in front of it and sometimes copies the minus. Throwing that away loses a
 * discount that was printed perfectly plainly. So a negative figure on a line that says, in its
 * own words, that it is money off is taken as its magnitude; the line's text is kept exactly as
 * it arrived, so the evidence on the product card still shows the minus the receipt printed.
 *
 * A negative figure on a line that says nothing of the kind is still refused: it could as
 * easily be a credit, a correction or a misread, and none of those should lower a cost.
 */
function discountAmount(line: AiDiscountLine): Money | null {
  const raw = line.amount;
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const parsed = Money.parseOrNull(raw);
  if (parsed === null || parsed.isZero) return null;
  if (!parsed.isNegative) return parsed;
  return saysMoneyOff(line) ? parsed.abs() : null;
}

function saysMoneyOff(line: AiDiscountLine): boolean {
  return SAYS_MONEY_OFF.test(
    [line.productName ?? '', line.reference ?? '', ...line.sourceText].join(' '),
  );
}

/** Whether the model already attached a discount to this row, whatever sign it wrote it with. */
function carriesDiscount(item: AiExtractedItem): boolean {
  const raw = item.discount?.amount;
  if (raw === null || raw === undefined || raw.trim().length === 0) return false;
  const parsed = Money.parseOrNull(raw);
  return parsed !== null && !parsed.isZero;
}

function describes(line: AiDiscountLine): boolean {
  return (
    (line.productName ?? '').trim().length > 0 ||
    line.sourceText.some((text) => text.trim().length > 0)
  );
}

/** What to tell the owner about a line that was not applied. Null when there is nothing to say. */
function refusalWarning(
  kind: 'conflict' | 'unverified' | 'duplicate' | 'unplaceable',
  line: AiDiscountLine,
  amount: Money,
): string | null {
  const named = (line.productName ?? '').trim();
  const which = named.length > 0 ? ` for ${named}` : '';

  switch (kind) {
    case 'duplicate':
      // The same money, listed twice. Said once, quietly, so nobody goes looking for it.
      return `The ${amount.format()} discount${which} was listed twice on the receipt and has been counted once.`;
    case 'conflict':
      return `A discount of ${amount.format()}${which} was printed, but the line names one product and points at another, so I could not tell which it belongs to. Nothing was taken off - open the product and enter it if you can see which one it is.`;
    default:
      return unplacedWarning(line, amount);
  }
}

function unplacedWarning(line: AiDiscountLine, amount: Money): string {
  const named = (line.productName ?? '').trim();
  const which = named.length > 0 ? ` for ${named}` : '';
  return `A discount of ${amount.format()}${which} was printed, but I could not tell which product it belongs to. Nothing was taken off - open the product and enter it if you can see which one it is.`;
}

function unreadableWarning(line: AiDiscountLine): string {
  const named = (line.productName ?? '').trim();
  const which = named.length > 0 ? ` for ${named}` : '';
  return `A discount line${which} was on the receipt but the amount could not be read. Nothing was taken off.`;
}

/**
 * One batch, with its printed discount lines placed on the products they belong to.
 *
 * Done per batch, before batches are stitched together, because `appliesToIndex` is a position in
 * the array the model returned for those photographs and means nothing once the arrays are
 * concatenated. Anything that could not be placed is added to the batch's own warnings, which is
 * what the owner sees under "what could not be read".
 */
export function attachDiscountLines(extraction: AiOrderExtraction): AiOrderExtraction {
  const placed = associateDiscountLines(extraction.items, extraction.discountLines);
  if (placed.warnings.length === 0 && placed.items === extraction.items) return extraction;
  return {
    ...extraction,
    items: placed.items,
    warnings: [...extraction.warnings, ...placed.warnings],
  };
}
