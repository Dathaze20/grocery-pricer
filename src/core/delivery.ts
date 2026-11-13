import { NameNormalizer, SizeParser, sizesMatch } from './matching';
import type { AiCaseSighting } from './ai-types';

/**
 * What the reconciliation concluded about one line of a delivery invoice.
 *
 * The names are deliberately hedged where the evidence is hedged. A photograph of a pallet cannot
 * prove what is behind the front row, so nothing here ever says "missing" on the strength of a
 * count alone - it says what was counted, and what that does and does not establish.
 */
export const DeliveryStatus = {
  /** Counted at least as many cases as the invoice says. */
  CONFIRMED: 'CONFIRMED',
  /** Counted fewer, but the stack may be hiding some. Worth another photo before complaining. */
  POSSIBLY_MISSING: 'POSSIBLY_MISSING',
  /** Counted fewer, with a clear enough view that the shortfall looks real. */
  LIKELY_MISSING: 'LIKELY_MISSING',
  /** Counted more than the invoice lists. */
  MORE_THAN_INVOICED: 'MORE_THAN_INVOICED',
  /** On the invoice, but nothing in the photographs matched it at all. */
  NOT_PHOTOGRAPHED: 'NOT_PHOTOGRAPHED',
  /** Photographed, but not on the invoice. */
  NOT_ON_INVOICE: 'NOT_ON_INVOICE',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

/** One line of what the paperwork says should have arrived. */
export interface InvoiceLine {
  readonly itemId: number;
  readonly name: string;
  readonly size: string | null;
  readonly expectedCases: number;
}

export interface DeliveryLineResult {
  readonly itemId: number | null;
  readonly name: string;
  readonly size: string | null;
  readonly expectedCases: number | null;
  readonly countedCases: number | null;
  readonly difference: number | null;
  readonly status: DeliveryStatus;
  /** How confident the count itself was, 0-1. Null when nothing was counted. */
  readonly confidence: number | null;
  /** True when another photograph would genuinely help. */
  readonly needsAnotherPhoto: boolean;
  readonly message: string;
  readonly sourcePhotoIds: readonly number[];
}

export interface DeliveryReconciliation {
  readonly lines: readonly DeliveryLineResult[];
  readonly confirmed: number;
  readonly possiblyMissing: number;
  readonly likelyMissing: number;
  readonly extra: number;
  readonly notPhotographed: number;
  readonly warnings: readonly string[];
}

/**
 * Below this, a count is treated as too unsure to accuse anyone of short-shipping.
 *
 * Set deliberately high. The cost of a false "confirmed" is a shortfall nobody notices; the cost
 * of a false "missing" is an argument with a supplier over cases that were there all along.
 */
export const CONFIDENT_COUNT = 0.75;

/** How alike two product names must look before a sighting is matched to an invoice line. */
export const MATCH_SIMILARITY = 0.62;

/**
 * Compares what the invoice says arrived against what could actually be seen in the photographs.
 *
 * The governing rule is that a photograph is evidence, not an inventory. Every shortfall is
 * reported with what it rests on - how many were counted, how sure that count was, and whether
 * part of the stack may be hidden - so the shopkeeper decides whether to go and look again or
 * pick up the phone to the supplier.
 */
export function reconcileDelivery(
  invoice: readonly InvoiceLine[],
  sightings: readonly AiCaseSighting[],
  warnings: readonly string[] = [],
): DeliveryReconciliation {
  const unmatched = new Set(sightings.map((_, index) => index));
  const lines: DeliveryLineResult[] = [];

  for (const line of invoice) {
    const matches = [...unmatched]
      .map((index) => ({ index, sighting: sightings[index]!, score: matchScore(line, sightings[index]!) }))
      .filter((m) => m.score >= MATCH_SIMILARITY)
      .sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      lines.push(notPhotographed(line));
      continue;
    }

    // Several photographs of one stack are one stack. The highest count wins rather than the sum:
    // adding them would invent cases that were photographed twice from different angles.
    let counted = 0;
    let confidence = 0;
    let mayBeHidden = false;
    const photoIds = new Set<number>();
    for (const match of matches) {
      unmatched.delete(match.index);
      counted = Math.max(counted, match.sighting.countedCases);
      confidence = Math.max(confidence, match.sighting.confidence);
      mayBeHidden = mayBeHidden || match.sighting.mayBeHidden;
      for (const id of match.sighting.sourcePhotoIds) photoIds.add(id);
    }

    lines.push(compare(line, counted, confidence, mayBeHidden, [...photoIds]));
  }

  // Anything photographed that no invoice line claimed.
  for (const index of unmatched) {
    const sighting = sightings[index]!;
    const name = sightingName(sighting);
    lines.push({
      itemId: null,
      name,
      size: sighting.size ?? null,
      expectedCases: null,
      countedCases: sighting.countedCases,
      difference: null,
      status: DeliveryStatus.NOT_ON_INVOICE,
      confidence: sighting.confidence,
      needsAnotherPhoto: false,
      message:
        `${sighting.countedCases} ${caseWord(sighting.countedCases)} of ${name} ` +
        `${sighting.countedCases === 1 ? 'is' : 'are'} in the photos but not on the invoice.`,
      sourcePhotoIds: sighting.sourcePhotoIds,
    });
  }

  return {
    lines,
    confirmed: lines.filter((l) => l.status === DeliveryStatus.CONFIRMED).length,
    possiblyMissing: lines.filter((l) => l.status === DeliveryStatus.POSSIBLY_MISSING).length,
    likelyMissing: lines.filter((l) => l.status === DeliveryStatus.LIKELY_MISSING).length,
    extra: lines.filter((l) => l.status === DeliveryStatus.NOT_ON_INVOICE).length,
    notPhotographed: lines.filter((l) => l.status === DeliveryStatus.NOT_PHOTOGRAPHED).length,
    warnings,
  };
}

function compare(
  line: InvoiceLine,
  counted: number,
  confidence: number,
  mayBeHidden: boolean,
  photoIds: readonly number[],
): DeliveryLineResult {
  const difference = counted - line.expectedCases;
  const title = describe(line);

  if (difference >= 0) {
    if (difference === 0) {
      return {
        itemId: line.itemId,
        name: line.name,
        size: line.size,
        expectedCases: line.expectedCases,
        countedCases: counted,
        difference,
        status: DeliveryStatus.CONFIRMED,
        confidence,
        needsAnotherPhoto: false,
        message: `${title}: all ${line.expectedCases} ${caseWord(line.expectedCases)} accounted for.`,
        sourcePhotoIds: photoIds,
      };
    }
    return {
      itemId: line.itemId,
      name: line.name,
      size: line.size,
      expectedCases: line.expectedCases,
      countedCases: counted,
      difference,
      status: DeliveryStatus.MORE_THAN_INVOICED,
      confidence,
      needsAnotherPhoto: false,
      message:
        `${title}: invoice says ${line.expectedCases}, but ${counted} ` +
        `${caseWord(counted)} ${counted === 1 ? 'is' : 'are'} visible. Check whether ` +
        `${difference} ${caseWord(difference)} ${difference === 1 ? 'belongs' : 'belong'} to another delivery.`,
      sourcePhotoIds: photoIds,
    };
  }

  const short = Math.abs(difference);
  // A stack that may be hiding cases, or a count the model was unsure of, is not proof of a
  // shortfall. Say what was counted and ask for a better look instead of accusing anyone.
  const uncertain = mayBeHidden || confidence < CONFIDENT_COUNT;

  return {
    itemId: line.itemId,
    name: line.name,
    size: line.size,
    expectedCases: line.expectedCases,
    countedCases: counted,
    difference,
    status: uncertain ? DeliveryStatus.POSSIBLY_MISSING : DeliveryStatus.LIKELY_MISSING,
    confidence,
    needsAnotherPhoto: uncertain,
    message: uncertain
      ? `${title}: invoice says ${line.expectedCases} ${caseWord(line.expectedCases)}, ` +
        `I can count ${counted}. That is ${short} short, but ${
          mayBeHidden ? 'part of the stack may be hidden' : 'I am not confident in the count'
        } - take another photo from a different angle before calling it missing.`
      : `${title}: invoice says ${line.expectedCases} ${caseWord(line.expectedCases)}, ` +
        `I can count ${counted}. ${short} ${caseWord(short)} ${short === 1 ? 'appears' : 'appear'} to be missing.`,
    sourcePhotoIds: photoIds,
  };
}

function notPhotographed(line: InvoiceLine): DeliveryLineResult {
  return {
    itemId: line.itemId,
    name: line.name,
    size: line.size,
    expectedCases: line.expectedCases,
    countedCases: null,
    difference: null,
    status: DeliveryStatus.NOT_PHOTOGRAPHED,
    confidence: null,
    needsAnotherPhoto: true,
    // Not "missing". Nobody photographed it, which says nothing about whether it arrived.
    message:
      `${describe(line)}: on the invoice but not in any photo yet. ` +
      `Photograph it to check the ${line.expectedCases} ${caseWord(line.expectedCases)}.`,
    sourcePhotoIds: [],
  };
}

/** How well a photographed stack matches an invoice line. Size disagreement rules it out. */
function matchScore(line: InvoiceLine, sighting: AiCaseSighting): number {
  const sightingName_ = sightingName(sighting);
  if (sightingName_.length === 0) return 0;

  const lineSize = SizeParser.parse(line.size ?? line.name);
  const seenSize = SizeParser.parse(sighting.size ?? sighting.packDescription ?? '');
  if (lineSize !== null && seenSize !== null && !sizesMatch(lineSize, seenSize)) return 0;

  const similarity = NameNormalizer.similarity(line.name, sightingName_);
  // Agreeing on the size is real evidence, so it lifts a borderline name match.
  return lineSize !== null && seenSize !== null ? Math.min(similarity + 0.1, 1) : similarity;
}

function sightingName(sighting: AiCaseSighting): string {
  return [sighting.brand, sighting.productName]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ')
    .trim();
}

function describe(line: InvoiceLine): string {
  return [line.name.trim(), line.size?.trim()].filter((p) => p !== undefined && p.length > 0).join(' ');
}

function caseWord(count: number): string {
  return count === 1 ? 'case' : 'cases';
}

/** The short summary the conversation opens with after a delivery is processed. */
export function summariseDelivery(result: DeliveryReconciliation): string {
  const parts: string[] = [`${result.confirmed} confirmed`];
  if (result.likelyMissing > 0) parts.push(`${result.likelyMissing} likely missing`);
  if (result.possiblyMissing > 0) parts.push(`${result.possiblyMissing} possibly short`);
  if (result.extra > 0) parts.push(`${result.extra} not on the invoice`);
  if (result.notPhotographed > 0) parts.push(`${result.notPhotographed} not photographed yet`);
  return parts.join(', ') + '.';
}
