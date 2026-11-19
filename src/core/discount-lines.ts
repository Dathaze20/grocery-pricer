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
  for (let i = 0; i < out.length; i += 1) {
    if (readableAmount(out[i]!.discount?.amount) !== null) taken.add(i);
  }

  for (const line of lines) {
    const amount = readableAmount(line.amount);
    if (amount === null) {
      // No figure, no discount. Inventing one here is the one thing this must never do.
      if (describes(line)) warnings.push(unreadableWarning(line));
      continue;
    }

    const target = placeLine(line, out, taken);
    if (target === null) {
      warnings.push(unplacedWarning(line, amount));
      continue;
    }

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
 * Which product a line belongs to, or null when the paper does not say.
 *
 * The model's own index is trusted first, because the layout is what it could actually see. A
 * name is trusted second, and only when one product answers to it. Everything else is refused.
 */
function placeLine(
  line: AiDiscountLine,
  items: readonly AiExtractedItem[],
  taken: ReadonlySet<number>,
): number | null {
  const index = line.appliesToIndex;
  if (index !== null && index !== undefined && Number.isInteger(index)) {
    if (index >= 0 && index < items.length && !taken.has(index)) return index;
  }

  const named = line.productName;
  if (named === null || named === undefined || NameNormalizer.tokens(named).length === 0) {
    return null;
  }

  const scored: Array<{ at: number; score: number }> = [];
  for (let at = 0; at < items.length; at += 1) {
    if (taken.has(at)) continue;
    const item = items[at]!;
    const score = Math.max(
      NameNormalizer.similarity(named, item.rawName),
      NameNormalizer.similarity(named, item.canonicalName),
    );
    if (score >= DISCOUNT_NAME_MATCH) scored.push({ at, score });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const tied = scored.filter((s) => s.score >= best.score - TIE_MARGIN);
  if (tied.length === 1) return best.at;

  /*
   * A tie is only safe when the tied rows are the same purchase twice.
   *
   * "FLYER DISCOUNT - PAMPERS JUMBO" names both the size 6 and the size 5 on the same receipt
   * equally well, and they are different products at different costs: guessing picks one at
   * random and is wrong half the time. Two cases of one product bought twice are a different
   * matter - either row takes the line and the answer is the same - so those are placed in the
   * order they were printed.
   */
  const first = items[tied[0]!.at]!;
  const allAlike = tied.every((s) => indistinguishable(first, items[s.at]!));
  return allAlike ? tied[0]!.at : null;
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

/** A positive, readable figure, or null. A negative or unparseable one is not a discount. */
function readableAmount(raw: string | null | undefined): Money | null {
  if (raw === null || raw === undefined || raw.trim().length === 0) return null;
  const parsed = Money.parseOrNull(raw);
  if (parsed === null || parsed.isNegative || parsed.isZero) return null;
  return parsed;
}

function describes(line: AiDiscountLine): boolean {
  return (
    (line.productName ?? '').trim().length > 0 ||
    line.sourceText.some((text) => text.trim().length > 0)
  );
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
