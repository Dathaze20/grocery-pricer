import { Money } from './money';
import { ProfitCalculator } from './cost';
import type { QueryRequest } from './query';

/** Which product a correction is aimed at. Resolved against the conversation, never guessed. */
export type CorrectionTarget =
  | { kind: 'ordinal'; position: number; price: Money }
  | { kind: 'named'; phrase: string; price: Money }
  | { kind: 'current'; price: Money }
  | { kind: 'allListed'; price: Money };

/** What the shopkeeper appears to want, worked out on the device before any API call. */
export type ChatIntent =
  | { kind: 'priceLookup'; request: QueryRequest }
  | { kind: 'caseQuantity'; request: QueryRequest }
  | { kind: 'profitAt'; request: QueryRequest | null; retailPrice: Money }
  | { kind: 'lastCharged'; request: QueryRequest }
  | { kind: 'costUnder'; limit: Money }
  | { kind: 'costOver'; limit: Money }
  | { kind: 'correction'; targets: CorrectionTarget[] }
  | { kind: 'orderSummary' }
  | { kind: 'deliveryCheck'; phrase: string }
  | { kind: 'unknown' };

const MONEY_PATTERN = /\$?\s?(\d{1,6}(?:[.,]\d{1,2})?)/g;

const ORDINAL_WORDS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4,
  five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8,
  nine: 9, ninth: 9, ten: 10, tenth: 10,
};

const COUNT_WORDS: Record<string, number> = {
  both: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const QUESTION_OPENERS = new Set([
  'how', 'what', 'whats', 'which', 'where', 'why', 'who', 'when', 'can', 'could', 'do',
  'does', 'did', 'is', 'are', 'was', 'were', 'show', 'give', 'tell', 'list', 'find',
]);

const CORRECTION_LEADS = [
  'i put', 'i charge', 'i sell', "i'm charging", 'im charging', 'i am charging',
  'we put', 'we charge', 'we sell', 'make that', 'make it', 'change it to',
  'change that to', 'set it to', 'put it at', "it's", 'its', "that's", 'thats',
];

const BODY_FILLERS = [
  'should i be charging for', 'should i be charging', 'should i charge for',
  'should i sell it for', 'should i sell for', 'should i charge', 'should i sell',
  'should we charge for', 'should we charge', 'do i charge for', 'did we pay for',
  'did i pay for', 'do we pay for', 'can i charge for', 'i charge for', 'we charge for',
  'to charge for', 'charge for', 'pay for', 'for', 'is', 'are', 'was', 'were', 'it',
].sort((a, b) => b.length - a.length);

const PRICE_QUESTION_LEADS = [
  'how much is', 'how much are', 'how much was', 'how much were', 'how much for',
  'how much do', 'how much did', 'what did we pay for', 'what did you pay for',
  'what do we pay for', 'what did we pay', 'what should i charge for',
  'what should i charge', 'what should i sell', 'cost of', 'price of', 'price for',
  'show me the', 'show me', 'give me the', 'give me', 'what about the', 'what about',
  'how much',
];

const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

/**
 * Reads the easy sentences without spending the shopkeeper's money.
 *
 * Deliberately not a natural-language system. It recognises the handful of shapes that make up
 * most of what gets typed at a counter and bails out to `unknown` the moment it is unsure -
 * because a wrong guess here silently rewrites a shelf price, while an unrecognised sentence just
 * costs one API call. Every rule errs towards not recognising.
 */
export function parseChatIntent(raw: string): ChatIntent {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'unknown' };
  const lower = text.toLowerCase();

  // Corrections are checked first, but only for sentences that are not questions: "what should I
  // charge, 7.99?" is a question about a price, not an instruction to save one.
  if (!looksLikeQuestion(lower)) {
    const correction = parseCorrection(lower);
    if (correction !== null) return correction;
  }

  return (
    parseDeliveryCheck(lower) ??
    parseCostFilter(lower) ??
    parseProfit(lower) ??
    parseCaseQuantity(lower) ??
    parseLastCharged(lower) ??
    parseOrderSummary(lower) ??
    parsePriceLookup(lower) ?? { kind: 'unknown' }
  );
}

function looksLikeQuestion(lower: string): boolean {
  const first = (lower.split(' ')[0] ?? '').replace(/[?.,!]+$/g, '');
  return QUESTION_OPENERS.has(first) || lower.endsWith('?');
}

function parseCorrection(lower: string): ChatIntent | null {
  const ordinals = parseOrdinalCorrections(lower);
  if (ordinals.length > 0) return { kind: 'correction', targets: ordinals };

  const price = singleMoneyIn(lower);
  if (price === null) return null;

  // "all five cereals are 7.99" / "all of them are 7.99"
  if (/\ball\b/.test(lower)) {
    return { kind: 'correction', targets: [{ kind: 'allListed', price }] };
  }

  const lead = CORRECTION_LEADS.find((l) => lower.startsWith(l) || lower.includes(` ${l} `));
  if (lead === undefined) return null;

  const moneyMatch = new RegExp(MONEY_PATTERN).exec(lower);
  const afterLead = lower.slice(lower.indexOf(lead) + lead.length);
  const beforePrice =
    moneyMatch === null ? afterLead : afterLead.split(moneyMatch[0])[0] ?? afterLead;
  const phrase = beforePrice.replace(/\b(at|to|for|is|as)\b/g, ' ').trim().replace(/^[,\s-]+|[,\s-]+$/g, '');

  return phrase.length === 0
    ? { kind: 'correction', targets: [{ kind: 'current', price }] }
    : { kind: 'correction', targets: [{ kind: 'named', phrase, price }] };
}

/** "number one 2.99 and number two 11.99" - each clause is its own target. */
function parseOrdinalCorrections(lower: string): CorrectionTarget[] {
  const pattern = new RegExp(
    `(?:number|no\\.?|#|item)\\s*([0-9]{1,2}|${Object.keys(ORDINAL_WORDS).join('|')})` +
      `\\s*(?:is|are|should be|=|at|to|->)?\\s*\\$?\\s?(\\d{1,6}(?:[.,]\\d{1,2})?)`,
    'g',
  );
  const targets: CorrectionTarget[] = [];
  for (const match of lower.matchAll(pattern)) {
    const positionText = match[1] ?? '';
    const position = Number(positionText) || ORDINAL_WORDS[positionText] || 0;
    const price = Money.parseOrNull(match[2] ?? '');
    if (position > 0 && price !== null) targets.push({ kind: 'ordinal', position, price });
  }
  return targets;
}

function parseProfit(lower: string): ChatIntent | null {
  if (!lower.includes('profit') && !lower.includes('make') && !lower.includes('margin')) return null;
  const price = lastMoneyIn(lower);
  if (price === null) return null;
  const phrase = productPhrase(
    lower.replace(/\b(profit|margin|gross)\b/g, ' ').split(' if ')[0]!.split(' at ')[0]!,
  );
  return { kind: 'profitAt', request: phrase === null ? null : { phrase }, retailPrice: price };
}

function parseCaseQuantity(lower: string): ChatIntent | null {
  const asksCount =
    lower.includes('how many') ||
    lower.includes('per case') ||
    lower.includes('in the case') ||
    lower.includes('in a case') ||
    lower.includes('in the box') ||
    lower.includes('case count');
  if (!asksCount) return null;
  // A delivery question ("how many should have arrived") is a different thing entirely.
  if (/\b(arrive|arrived|deliver|delivered|supposed|missing)\b/.test(lower)) return null;
  const phrase = productPhrase(
    lower.replace(/\b(how many|are|is|in|the|a|an|case|box|per|come|comes|there)\b/g, ' '),
  );
  return { kind: 'caseQuantity', request: { phrase: phrase ?? '' } };
}

function parseLastCharged(lower: string): ChatIntent | null {
  const asks =
    (lower.includes('last time') || lower.includes('previously') || lower.includes('before')) &&
    (lower.includes('charge') || lower.includes('price') || lower.includes('sell'));
  if (!asks) return null;
  const phrase = productPhrase(
    lower.replace(/\b(last time|previously|before|charge|charged|price|sell)\b/g, ' '),
  );
  return { kind: 'lastCharged', request: { phrase: phrase ?? '' } };
}

function parseCostFilter(lower: string): ChatIntent | null {
  const under = /\b(under|below|less than|cheaper than)\b/.test(lower);
  const over = /\b(over|above|more than|dearer than)\b/.test(lower);
  if (!under && !over) return null;
  if (!lower.includes('cost') && !lower.includes('price') && !lower.includes('$')) return null;
  const limit = singleMoneyIn(lower);
  if (limit === null) return null;
  return under ? { kind: 'costUnder', limit } : { kind: 'costOver', limit };
}

function parseOrderSummary(lower: string): ChatIntent | null {
  const words = [
    'order summary', 'summary of the order', 'how many products', 'how many items',
    "what's in this order", 'whats in this order',
  ];
  return words.some((w) => lower.includes(w)) ? { kind: 'orderSummary' } : null;
}

/**
 * Questions about the delivery rather than the price.
 *
 * Recognised locally so "what is missing" reaches the reconciliation the app already computed,
 * rather than being sent to a model that would have to be told the answer anyway.
 */
function parseDeliveryCheck(lower: string): ChatIntent | null {
  const patterns = [
    'what is missing', "what's missing", 'whats missing', 'anything missing',
    'did everything arrive', 'did it all arrive', 'is everything here',
    'what still needs', 'what needs verifying', 'what needs checking',
    'extra', 'not on the invoice', 'not on the receipt', 'delivery check', 'verify the delivery',
  ];
  return patterns.some((p) => lower.includes(p)) ? { kind: 'deliveryCheck', phrase: lower } : null;
}

/**
 * Only fires when the sentence actually opened like a price question.
 *
 * A bare phrase - "8 oz", "Hellmann's Mayonnaise 8 oz" - deliberately falls through to `unknown`.
 * The router tries those against the local query engine anyway, so they still answer without an
 * API call; what this avoids is treating every unrecognised sentence as a product lookup.
 */
function parsePriceLookup(lower: string): ChatIntent | null {
  const lead = PRICE_QUESTION_LEADS.find((l) => lower.startsWith(l));
  if (lead === undefined) return null;
  const phrase = productPhrase(stripFillers(lower.slice(lead.length)));
  if (phrase === null) return null;

  const plural =
    /\b(are|were|these|those|them|all|both|each)\b/.test(lower) ||
    Object.keys(COUNT_WORDS).some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const counted = Object.entries(COUNT_WORDS).find(([w]) => new RegExp(`\\b${w}\\b`).test(lower));
  const explicit = /\ball (\d{1,2})\b/.exec(lower);
  const expectedCount = counted?.[1] ?? (explicit === null ? null : Number(explicit[1]));

  return { kind: 'priceLookup', request: { phrase, expectMultiple: plural, expectedCount } };
}

function stripFillers(raw: string): string {
  let text = raw.replace(/^[\s?.,!:;-]+|[\s?.,!:;-]+$/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of BODY_FILLERS) {
      if (text === filler) return '';
      if (text.startsWith(`${filler} `)) {
        text = text.slice(filler.length + 1).trimStart();
        changed = true;
        break;
      }
    }
    const withoutArticle = text.replace(LEADING_ARTICLE, '');
    if (withoutArticle !== text) {
      text = withoutArticle;
      changed = true;
    }
  }
  return text;
}

function productPhrase(raw: string): string | null {
  const trimmed = raw
    .replace(LEADING_ARTICLE, '')
    .replace(/^[\s?.,!:;-]+|[\s?.,!:;-]+$/g, '');
  return trimmed.length === 0 ? null : trimmed;
}

function singleMoneyIn(text: string): Money | null {
  const matches = [...text.matchAll(new RegExp(MONEY_PATTERN))];
  if (matches.length !== 1) return null;
  return Money.parseOrNull(matches[0]![1] ?? '');
}

function lastMoneyIn(text: string): Money | null {
  const matches = [...text.matchAll(new RegExp(MONEY_PATTERN))];
  const last = matches[matches.length - 1];
  return last === undefined ? null : Money.parseOrNull(last[1] ?? '');
}

// ---------------------------------------------------------------- answers

export type MatchConfidence = 'EXACT' | 'HIGH' | 'LIKELY';

/**
 * One authoritative answer about one product.
 *
 * Every figure here was read out of the local database or produced by the deterministic pricing
 * engine. Nothing comes from a model's prose - that is the whole point of the type existing. The
 * model may decide *which* product the user meant; from that moment it has no further say.
 */
export interface PriceAnswer {
  readonly itemId: number;
  readonly displayName: string;
  readonly size?: string | null;
  readonly unitCost: Money | null;
  readonly suggestedRetail: Money | null;
  readonly approvedRetail?: Money | null;
  readonly unitsPerCase?: number | null;
  readonly unitNoun?: string | null;
  readonly previousUnitCost?: Money | null;
  readonly previousRetail?: Money | null;
  readonly confidence?: MatchConfidence;
  readonly note?: string | null;
}

const ARROW = ' → ';

export function answerTitle(answer: PriceAnswer): string {
  return [answer.displayName.trim(), answer.size?.trim()].filter((p) => p !== undefined && p.length > 0).join(' ');
}

/** What the shelf price is: what they set, else what was worked out. */
export function effectiveRetail(answer: PriceAnswer): Money | null {
  return answer.approvedRetail ?? answer.suggestedRetail;
}

function priceLine(answer: PriceAnswer): string {
  const cost = answer.unitCost;
  const retail = effectiveRetail(answer);
  if (cost !== null && retail !== null) return cost.format() + ARROW + retail.format();
  if (cost !== null) return `${cost.format()}${ARROW}no price set yet`;
  if (retail !== null) return `cost unknown${ARROW}${retail.format()}`;
  return 'I could not read the cost for this one.';
}

/**
 * Renders answers in the house style the shopkeeper already worked in.
 *
 * Deliberately terse: a name, then cost and shelf price on one line. Someone behind a counter
 * with a box in one hand reads two numbers, not a paragraph.
 */
export const ChatAnswerFormatter = {
  /** `Hellmann's Mayonnaise 8 oz` / `$2.17 -> $4.99` */
  single(answer: PriceAnswer): string {
    let text = `${answerTitle(answer)}\n${priceLine(answer)}`;
    if (answer.note !== null && answer.note !== undefined && answer.note.trim().length > 0) {
      text += `\n${answer.note}`;
    }
    return text;
  },

  /** Numbered, blank line between, same two-line shape for each. */
  numbered(answers: readonly PriceAnswer[]): string {
    if (answers.length === 0) return 'I could not find those in this order.';
    if (answers.length === 1) return ChatAnswerFormatter.single(answers[0]!);
    return answers
      .map((answer, index) => {
        let text = `${index + 1}. ${answerTitle(answer)}\n${priceLine(answer)}`;
        if (answer.note !== null && answer.note !== undefined && answer.note.trim().length > 0) {
          text += `\n${answer.note}`;
        }
        return text;
      })
      .join('\n\n');
  },

  /** `Carnation Evaporated Milk 12 oz` / `8 cans per case.` */
  caseQuantity(answer: PriceAnswer): string {
    const units = answer.unitsPerCase;
    if (units === null || units === undefined) {
      return `${answerTitle(answer)}\nI could not read how many are in the case.`;
    }
    return `${answerTitle(answer)}\n${units} ${pluralNoun(answer.unitNoun ?? null, units)} per case.`;
  },

  /** The one place a margin is spelled out, because it was asked for. */
  profitAt(answer: PriceAnswer, retailPrice: Money): string {
    const cost = answer.unitCost;
    if (cost === null) {
      return `${answerTitle(answer)}\nI could not read the cost for this one, so I cannot work out the profit.`;
    }
    const summary = ProfitCalculator.summarise(cost, retailPrice);
    return [
      answerTitle(answer),
      `Cost: ${cost.format()}`,
      `Sell: ${retailPrice.format()}`,
      `Gross profit: ${summary.grossProfit.format()} each`,
    ].join('\n');
  },

  /** `Saved. Hellmann's Mayonnaise 15 oz -> $6.99` */
  savedPrice(answer: PriceAnswer, newPrice: Money): string {
    return `Saved. ${answerTitle(answer)}${ARROW}${newPrice.format()}`;
  },

  savedPrices(updates: ReadonlyArray<readonly [PriceAnswer, Money]>): string {
    if (updates.length === 0) return 'I could not tell which product you meant.';
    if (updates.length === 1) return ChatAnswerFormatter.savedPrice(updates[0]![0], updates[0]![1]);
    return (
      'Saved.\n' +
      updates.map(([answer, price]) => `  ${answerTitle(answer)}${ARROW}${price.format()}`).join('\n')
    );
  },

  /** Reports a cost that moved since last time. Null when it did not move. */
  costChange(answer: PriceAnswer): string | null {
    const previous = answer.previousUnitCost;
    const current = answer.unitCost;
    if (previous === null || previous === undefined || current === null) return null;
    const delta = current.minus(previous);
    if (delta.isZero) return null;
    const direction = delta.isNegative ? 'down' : 'up';
    return `The cost went ${direction} ${delta.abs().format()} from ${previous.format()}.`;
  },

  clarification(question: string): string {
    return question.trim();
  },
};

function pluralNoun(noun: string | null, count: number): string {
  const base = noun?.trim() && noun.trim().length > 0 ? noun.trim() : 'unit';
  if (count === 1) return base;
  if (base.endsWith('s') || base.endsWith('x') || base.endsWith('ch')) return `${base}es`;
  return `${base}s`;
}
