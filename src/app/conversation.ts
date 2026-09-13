import { ChatAnswerFormatter, parseChatIntent, type ChatIntent, type PriceAnswer } from '../core/chat';
import { Money } from '../core/money';
import { ProfitCalculator } from '../core/cost';
import { OrderQueryEngine, type QueryableItem } from '../core/query';
import { aiErrorMessage, type OrderQuestionResolution } from '../core/ai-types';
import { visualSearchText } from '../core/ai-types';
import type { AiProvider } from '../ai/provider';
import type { Repository } from '../data/repository';
import { MessageRole, type StoredItem } from '../data/schema';
import { toImagePart, type RawImage } from './images';

export interface AskOptions {
  /** A photo the shopkeeper attached: "how much is this one?" */
  readonly photo?: { id: number; image: RawImage } | null;
  /** Set false to answer without ever calling Gemini. */
  readonly allowAi?: boolean;
}

export interface Answer {
  readonly text: string;
  readonly itemIds: readonly number[];
  /** True when a Gemini call was actually made to produce this. */
  readonly usedAi: boolean;
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

  await repo.say(orderId, MessageRole.USER, text, { photoId: options.photo?.id ?? null });

  const answer = await resolve(repo, provider, engine, stored, orderId, text, options);
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

  // A photo answers "which product" far better than any sentence can.
  if (options.photo !== null && options.photo !== undefined) {
    return identifyFromPhoto(provider, engine, options.photo, text);
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
    return { text: aiErrorMessage(resolution.error), itemIds: [], usedAi: true };
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

async function identifyFromPhoto(
  provider: AiProvider,
  engine: OrderQueryEngine,
  photo: { id: number; image: RawImage },
  text: string,
): Promise<Answer> {
  const part = await toImagePart(photo.image);
  const result = await provider.identifyProducts({ photoId: photo.id, ...part });
  if (!result.ok) return { text: aiErrorMessage(result.error), itemIds: [], usedAi: true };

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
  for (const product of found) {
    const outcome = engine.resolve({ phrase: visualSearchText(product) });
    const item = outcome.kind === 'exact' ? outcome.item : outcome.kind === 'several' ? outcome.items[0] : null;
    if (item === null || item === undefined) continue;
    answers.push(toAnswer(item));
    ids.push(item.id);
  }

  if (answers.length === 0) {
    const names = found.map((p) => visualSearchText(p)).filter((n) => n.length > 0);
    return {
      text:
        names.length > 0
          ? `That looks like ${names[0]}, but it is not in this order.`
          : 'That is not in this order.',
      itemIds: [],
      usedAi: true,
    };
  }

  const note = text.length > 0 && /profit|margin|make/.test(text.toLowerCase()) ? profitNote(answers[0]!) : null;
  const body = ChatAnswerFormatter.numbered(answers);
  return { text: note === null ? body : `${body}\n${note}`, itemIds: ids, usedAi: true };
}

function profitNote(answer: PriceAnswer): string | null {
  const cost = answer.unitCost;
  const retail = answer.approvedRetail ?? answer.suggestedRetail;
  if (cost === null || retail === null || retail === undefined) return null;
  const summary = ProfitCalculator.summarise(cost, retail);
  return `Gross profit: ${summary.grossProfit.format()} each.`;
}

function notFound(): Answer {
  return {
    text: 'I could not find that in this order. Try naming the brand, or take a photo of it.',
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
