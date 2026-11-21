import { ChatAnswerFormatter, parseChatIntent, type ChatIntent, type PriceAnswer } from '../core/chat';
import { Money } from '../core/money';
import { ProfitCalculator } from '../core/cost';
import { OrderQueryEngine, type QueryableItem } from '../core/query';
import { aiErrorMessage, type OrderQuestionResolution } from '../core/ai-types';
import { visualSearchText } from '../core/ai-types';
import type { AiProvider } from '../ai/provider';
import type { Repository } from '../data/repository';
import { MessageRole, type StoredItem, isIncomplete } from '../data/schema';
import { affectsCost, discountScopeInWords } from '../core/models';
import { toImagePart, type RawImage } from './images';

export interface AskOptions {
  /** A photo the shopkeeper attached: "how much is this one?" */
  readonly photo?: { id: number; image: RawImage } | null;
  /** Set false to answer without ever calling Gemini. */
  readonly allowAi?: boolean;
  /**
   * The question is already in the conversation, so do not write it again.
   *
   * True for a question asked while the receipt was still being read: it was shown at the time
   * so the owner could see it had been heard, and answering it later must not make it appear
   * in the thread a second time.
   */
  readonly alreadyAsked?: boolean;
}

export interface Answer {
  readonly text: string;
  readonly itemIds: readonly number[];
  /** True when a Gemini call was actually made to produce this. */
  readonly usedAi: boolean;
  /**
   * True when this text is Gemini's failure rather than an answer.
   *
   * The two read alike in the chat - both are a sentence from the app - but they are not the
   * same thing at all. A question answered has been dealt with; a question that produced an
   * error has not, and treating the second as the first quietly throws the question away.
   */
  readonly failed?: boolean;
}

/**
 * Answers a question about an order.
 *
 * The order of attempts is deliberate and is about the shopkeeper's money twice over. Local
 * matching runs first because most questions are ordinary and an API call for "how much is the
 * mayo" spends free quota for nothing. And whatever resolves the *reference*, every figure in the
 * reply is read back out of the database - the model is never the source of a price.
 */
export async function ask(
  repo: Repository,
  provider: AiProvider,
  orderId: number,
  question: string,
  options: AskOptions = {},
): Promise<Answer> {
  const text = question.trim();
  const stored = await repo.itemsFor(orderId);
  const engine = new OrderQueryEngine(stored.map(toQueryable));

  if (options.alreadyAsked !== true) {
    await repo.say(orderId, MessageRole.USER, text, { photoId: options.photo?.id ?? null });
  }

  const resolved = await resolve(repo, provider, engine, stored, orderId, text, options);

  /*
   * An answer that names no product is the only kind that can mislead about the purchase.
   *
   * Applied here rather than at each place that gives up, because there are several and one
   * of them will be added later. "I could not find that" is true whatever happened; "it is
   * not in this order" is a claim about the delivery, and a receipt that was only half read
   * does not support it.
   */
  const order = await repo.order(orderId);
  const answer =
    resolved.itemIds.length === 0 &&
    order !== null &&
    isIncomplete(order) &&
    !resolved.text.includes('never read')
      ? { ...resolved, text: `${resolved.text}${absenceCaveat(true)}` }
      : resolved;

  await repo.say(orderId, MessageRole.APP, answer.text, { referencedItemIds: [...answer.itemIds] });
  return answer;
}

async function resolve(
  repo: Repository,
  provider: AiProvider,
  engine: OrderQueryEngine,
  stored: readonly StoredItem[],
  orderId: number,
  text: string,
  options: AskOptions,
): Promise<Answer> {
  if (stored.length === 0) {
    return { text: 'There is nothing in this order yet.', itemIds: [], usedAi: false };
  }

  // Whether this order is missing part of its receipt decides what may be said about a
  // product that cannot be found: "not in this order" is a claim about the purchase, and only
  // a fully read receipt supports it.
  const order = await repo.order(orderId);
  const incomplete = order !== null && isIncomplete(order);

  // A photo answers "which product" far better than any sentence can.
  if (options.photo !== null && options.photo !== undefined) {
    return identifyFromPhoto(provider, engine, options.photo, text, incomplete);
  }

  const intent = parseChatIntent(text);
  const local = answerLocally(engine, intent, stored);
  if (local !== null) return local;

  if (options.allowAi === false) {
    return { text: 'I am not sure which product you mean. Try naming the brand.', itemIds: [], usedAi: false };
  }

  const history = (await repo.conversation(orderId))
    .slice(-6)
    .map((m) => `${m.role === MessageRole.USER ? 'Shopkeeper' : 'App'}: ${m.text}`);

  const resolution = await provider.resolveQuestion(
    text,
    stored.map((item) => ({
      itemId: item.id,
      name: item.displayName,
      size: item.size,
      category: item.category,
    })),
    history,
  );

  if (!resolution.ok) {
    return { text: aiErrorMessage(resolution.error), itemIds: [], usedAi: true, failed: true };
  }
  return applyResolution(repo, engine, stored, resolution.value);
}

/** Everything that can be answered from the order alone, without spending a call. */
function answerLocally(
  engine: OrderQueryEngine,
  intent: ChatIntent,
  stored: readonly StoredItem[],
): Answer | null {
  switch (intent.kind) {
    case 'priceLookup':
    case 'lastCharged': {
      const outcome = engine.resolve(intent.request);
      return fromOutcome(outcome, (items) => ChatAnswerFormatter.numbered(items.map(toAnswer)));
    }

    case 'discountQuery': {
      const outcome = engine.resolve(intent.request);
      return fromOutcome(outcome, (items) =>
        items
          .map((queryable) => {
            const row = stored.find((candidate) => candidate.id === queryable.id);
            const discount = row?.discount ?? null;

            if (discount === null) {
              /*
               * The answer that was missing, and the one that matters.
               *
               * Asked whether a discount had been recorded, the app used to reply with a cost
               * and a suggested price - which reads as a yes. It is not. Nothing was read off
               * the receipt for this product, so the cost shown is the undiscounted one, and a
               * figure the shopkeeper types into this chat is their recollection rather than
               * anything the app has seen on the paper.
               */
              return [
                `${queryable.name}: no discount was recorded from the receipt.`,
                queryable.unitCost === null
                  ? 'There is no cost each for it either.'
                  : `The ${queryable.unitCost.format()} each is the case price divided by the pack, with nothing taken off - so if a discount was printed, this cost is too high.`,
                'I cannot confirm an amount I did not read.',
              ].join('\n');
            }

            const amount = Money.fromStorage(discount.amount);
            return [
              // What it comes off is half the answer. "A $7.00 discount was recorded" does not
              // tell the owner whether that is $7.00 off the case or $7.00 off each of four,
              // and those are different costs - so the scope is said in words, not as a code.
              `${queryable.name}: ${amount.format()} ${discountScopeInWords(discount.scope)} was read from the receipt.`,
              affectsCost(discount.scope)
                ? `It is in the ${queryable.unitCost?.format() ?? 'cost'} each.`
                : 'It is not in the cost - the receipt does not say what it comes off, so it is waiting for you to say.',
            ].join('\n');
          })
          .join('\n\n'),
      );
    }

    case 'caseQuantity': {
      const outcome = engine.resolve(intent.request);
      return fromOutcome(outcome, (items) =>
        items.map((item) => ChatAnswerFormatter.caseQuantity(toAnswer(item))).join('\n\n'),
      );
    }

    case 'profitAt': {
      if (intent.request === null) return null;
      const outcome = engine.resolve(intent.request);
      return fromOutcome(outcome, (items) =>
        items.map((item) => ChatAnswerFormatter.profitAt(toAnswer(item), intent.retailPrice)).join('\n\n'),
      );
    }

    case 'costUnder': {
      const items = engine.costingUnder(intent.limit);
      if (items.length === 0) return { text: `Nothing in this order costs under ${intent.limit.format()}.`, itemIds: [], usedAi: false };
      return { text: ChatAnswerFormatter.numbered(items.map(toAnswer)), itemIds: items.map((i) => i.id), usedAi: false };
    }

    case 'costOver': {
      const items = engine.costingOver(intent.limit);
      if (items.length === 0) return { text: `Nothing in this order costs over ${intent.limit.format()}.`, itemIds: [], usedAi: false };
      return { text: ChatAnswerFormatter.numbered(items.map(toAnswer)), itemIds: items.map((i) => i.id), usedAi: false };
    }

    case 'orderSummary': {
      const total = Money.sum(
        stored
          .map((i) => (i.totalWholesaleCost === null ? null : Money.fromStorage(i.totalWholesaleCost)))
          .filter((m): m is Money => m !== null),
      );
      return {
        text: `${stored.length} ${stored.length === 1 ? 'product' : 'products'} in this order, ${total.format()} wholesale.`,
        itemIds: stored.map((i) => i.id),
        usedAi: false,
      };
    }

    // Corrections and delivery checks change stored data, so they are handled by their own
    // functions where the write can be made explicitly rather than as a side effect of chatting.
    case 'correction':
    case 'deliveryCheck':
    case 'unknown':
      return null;
  }
}

function fromOutcome(
  outcome: ReturnType<OrderQueryEngine['resolve']>,
  format: (items: QueryableItem[]) => string,
): Answer | null {
  switch (outcome.kind) {
    case 'exact':
      return { text: format([outcome.item]), itemIds: [outcome.item.id], usedAi: false };
    case 'several':
      return { text: format(outcome.items), itemIds: outcome.items.map((i) => i.id), usedAi: false };
    case 'ambiguous':
      return {
        text:
          'Which one do you mean?\n' +
          outcome.candidates
            .map((item, index) => `${index + 1}. ${item.name}${item.size !== null ? ` ${item.size}` : ''}`)
            .join('\n'),
        itemIds: outcome.candidates.map((i) => i.id),
        usedAi: false,
      };
    case 'none':
      // Not an answer. Let the model have a go at the reference before giving up.
      return null;
  }
}

/** Turns what the model decided the sentence *meant* into an answer built from stored figures. */
async function applyResolution(
  repo: Repository,
  engine: OrderQueryEngine,
  stored: readonly StoredItem[],
  resolution: OrderQuestionResolution,
): Promise<Answer> {
  switch (resolution.kind) {
    case 'productMatches':
    case 'categoryMatches': {
      const items = engine.byIds(resolution.itemIds);
      if (items.length === 0) return notFound();
      return {
        text: ChatAnswerFormatter.numbered(items.map(toAnswer)),
        itemIds: items.map((i) => i.id),
        usedAi: true,
      };
    }

    case 'caseQuantityQuery': {
      const items = engine.byIds(resolution.itemIds);
      if (items.length === 0) return notFound();
      return {
        text: items.map((item) => ChatAnswerFormatter.caseQuantity(toAnswer(item))).join('\n\n'),
        itemIds: items.map((i) => i.id),
        usedAi: true,
      };
    }

    case 'profitQuery': {
      const items = engine.byIds(resolution.itemIds);
      const price = Money.parseOrNull(resolution.retailPrice);
      if (items.length === 0 || price === null) return notFound();
      return {
        text: items.map((item) => ChatAnswerFormatter.profitAt(toAnswer(item), price)).join('\n\n'),
        itemIds: items.map((i) => i.id),
        usedAi: true,
      };
    }

    case 'priceCorrection': {
      const updates: Array<readonly [PriceAnswer, Money]> = [];
      for (const update of resolution.updates) {
        const price = Money.parseOrNull(update.retailPrice);
        const item = stored.find((i) => i.id === update.itemId);
        if (price === null || item === undefined) continue;
        // The shopkeeper said the number; the app writes it down and re-reads it. The model's
        // only contribution is which row it belongs to.
        await repo.approvePrice(item.id, price);
        updates.push([toAnswer(toQueryable(item)), price]);
      }
      if (updates.length === 0) return notFound();
      return {
        text: ChatAnswerFormatter.savedPrices(updates),
        itemIds: resolution.updates.map((u) => u.itemId),
        usedAi: true,
      };
    }

    case 'clarification':
      return { text: ChatAnswerFormatter.clarification(resolution.question), itemIds: [], usedAi: true };

    case 'general':
      return { text: resolution.reply, itemIds: [], usedAi: true };

    case 'unresolved':
      return notFound();
  }
}

/**
 * Photograph to price.
 *
 * The shopkeeper photographs what they are unpacking and asks what it is worth. Gemini says
 * what the picture shows; every figure in the reply comes from the receipt this shop already
 * processed. A product the camera sees but the receipt does not know is reported as not found -
 * there is no cost to quote, and inventing one would be worse than saying so.
 */
async function identifyFromPhoto(
  provider: AiProvider,
  engine: OrderQueryEngine,
  photo: { id: number; image: RawImage },
  text: string,
  incomplete: boolean,
): Promise<Answer> {
  const part = await toImagePart(photo.image);
  const result = await provider.identifyProducts({ photoId: photo.id, ...part });
  if (!result.ok) {
    return { text: aiErrorMessage(result.error), itemIds: [], usedAi: true, failed: true };
  }

  const found = result.value.products;
  if (found.length === 0) {
    return {
      text: 'I could not tell what that is. Try a photo of the front of the pack.',
      itemIds: [],
      usedAi: true,
    };
  }

  const answers: PriceAnswer[] = [];
  const ids: number[] = [];
  const missing: string[] = [];

  for (const product of found) {
    const phrase = visualSearchText(product);
    const outcome = engine.resolve({ phrase });
    // Only a confident match quotes a price. "Several" or "ambiguous" means the picture could
    // be any of them, and the costs differ, so it is reported as unmatched rather than guessed.
    const item = outcome.kind === 'exact' ? outcome.item : null;
    if (item === null) {
      if (phrase.length > 0) missing.push(phrase);
      continue;
    }
    // Three cases of one product in one picture is one answer, not three identical ones.
    if (ids.includes(item.id)) continue;
    answers.push(toAnswer(item));
    ids.push(item.id);
  }

  if (answers.length === 0) {
    return {
      text:
        missing.length > 0
          ? `That looks like ${missing[0]}, but ${incomplete ? 'it is not among the lines I read.' : 'it is not in this order.'}${absenceCaveat(incomplete)}`
          : `${incomplete ? 'That is not among the lines I read.' : 'That is not in this order.'}${absenceCaveat(incomplete)}`,
      itemIds: [],
      usedAi: true,
    };
  }

  const lines = [ChatAnswerFormatter.numbered(answers)];

  if (missing.length > 0) {
    lines.push(
      missing.length === 1
        ? `I could not match ${missing[0]} to this order.`
        : `I could not match ${missing.length} of the products in that photo to this order.`,
    );
  }

  // Profit stays out of the way unless it was asked for: the everyday question is two numbers.
  if (/profit|margin|make|earn/.test(text.toLowerCase())) {
    const note = profitNote(answers[0]!);
    if (note !== null) lines.push(note);
  }

  return { text: lines.join('\n'), itemIds: ids, usedAi: true };
}

function profitNote(answer: PriceAnswer): string | null {
  const cost = answer.unitCost;
  const retail = answer.approvedRetail ?? answer.suggestedRetail;
  if (cost === null || retail === null || retail === undefined) return null;
  const summary = ProfitCalculator.summarise(cost, retail);
  return `Gross profit: ${summary.grossProfit.format()} each.`;
}

/**
 * "Not in this order" is a claim about a purchase, and it needs the receipt to have been read.
 *
 * When some photographs were never read, the app does not know whether a product was bought -
 * only that it is not among the lines it managed to see. Saying it was not in the order would
 * be telling the shop something false about their own delivery.
 */
function absenceCaveat(incomplete: boolean): string {
  return incomplete
    ? ' Part of this receipt was never read, so it may still have been on it - try reading the receipt again.'
    : '';
}

function notFound(incomplete = false): Answer {
  return {
    text: incomplete
      ? `I could not find that among the lines I read.${absenceCaveat(true)}`
      : 'I could not find that in this order. Try naming the brand, or take a photo of it.',
    itemIds: [],
    usedAi: true,
  };
}

export function toQueryable(item: StoredItem): QueryableItem {
  return {
    id: item.id,
    name: item.displayName,
    size: item.size,
    brand: null,
    category: item.category,
    upc: item.upc,
    supplierSku: item.supplierSku,
    unitsPerCase: item.unitsPerCase,
    unitCost: item.trueUnitCost === null ? null : Money.fromStorage(item.trueUnitCost),
    suggestedRetail: item.suggestedPrice === null ? null : Money.fromStorage(item.suggestedPrice),
    approvedRetail: item.approvedPrice === null ? null : Money.fromStorage(item.approvedPrice),
  };
}

export function toAnswer(item: QueryableItem): PriceAnswer {
  return {
    itemId: item.id,
    displayName: item.name,
    size: item.size,
    unitCost: item.unitCost,
    suggestedRetail: item.suggestedRetail,
    approvedRetail: item.approvedRetail,
    unitsPerCase: item.unitsPerCase,
  };
}
