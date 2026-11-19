import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { Category, ItemConfidence, DiscountScope } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { MessageRole, type StoredItem, OrderStatus } from '../../data/schema';
import { pending } from '../pending';
import { OrderImageType } from '../../core/ai-types';
import { ask } from '../conversation';

let dbCounter = 1000;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`chat-db-${dbCounter}`);
}

async function seed(
  repo: Repository,
  rows: Array<Partial<StoredItem> & { displayName: string }>,
): Promise<{ orderId: number; items: StoredItem[] }> {
  const order = await repo.createOrder();
  const items = await repo.addItems(
    rows.map((row) => ({
      orderId: order.id,
      productId: null,
      rawName: row.displayName,
      displayName: row.displayName,
      size: row.size ?? null,
      upc: row.upc ?? null,
      supplierSku: null,
      category: row.category ?? Category.OTHER,
      casePrice: row.casePrice ?? Money.of('24.00').toStorage(),
      unitsPerCase: row.unitsPerCase ?? 12,
      casesPurchased: row.casesPurchased ?? 1,
      looseUnits: 0,
      discount: row.discount ?? null,
      trueUnitCost: row.trueUnitCost ?? Money.of('2.00').toStorage(),
      totalWholesaleCost: row.totalWholesaleCost ?? Money.of('24.00').toStorage(),
      suggestedPrice: row.suggestedPrice ?? Money.of('4.99').toStorage(),
      pricingSource: PricingSource.COST_TIER,
      pricingRationale: 'Cost tier $2.00 - $2.99.',
      approvedPrice: row.approvedPrice ?? null,
      previousPrice: null,
      confidence: ItemConfidence.HIGH,
      aiConfidence: 0.9,
      issues: [],
      sourcePhotoIds: [],
      sourceText: [],
    })),
  );
  return { orderId: order.id, items };
}

describe('ask', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('answers an ordinary price question without calling Gemini at all', async () => {
    const { orderId } = await seed(repo, [
      { displayName: "Hellmann's Mayonnaise", size: '8 OZ' },
      { displayName: 'Corn Oil', size: '48 OZ' },
    ]);
    const provider = new FakeAiProvider();

    const answer = await ask(repo, provider, orderId, 'how much is the corn oil');

    expect(answer.usedAi).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(answer.text).toContain('Corn Oil');
    expect(answer.text).toContain('$4.99');
  });

  it('asks which one rather than guessing between two sizes', async () => {
    const { orderId } = await seed(repo, [
      { displayName: "Hellmann's Mayonnaise", size: '8 OZ' },
      { displayName: "Hellmann's Mayonnaise", size: '15 OZ' },
    ]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the mayonnaise');

    expect(answer.text).toContain('Which one');
    expect(answer.itemIds).toHaveLength(2);
  });

  it('escalates a sentence it does not recognise, and answers from stored figures', async () => {
    const { orderId, items } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider().queueResolution({
      kind: 'productMatches',
      itemIds: [items[0]!.id],
      followUp: null,
    });

    const answer = await ask(repo, provider, orderId, 'the yellow bottle thing from before');

    expect(answer.usedAi).toBe(true);
    expect(provider.calls.some((c) => c.startsWith('resolveQuestion'))).toBe(true);
    expect(answer.text).toContain('$4.99');
  });

  it('ignores an item id the model invented', async () => {
    const { orderId } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider().queueResolution({
      kind: 'productMatches',
      itemIds: [98765],
      followUp: null,
    });

    const answer = await ask(repo, provider, orderId, 'the thing');

    expect(answer.text).toContain('could not find');
    expect(answer.itemIds).toHaveLength(0);
  });

  it('writes a correction the shopkeeper dictated and reads it back', async () => {
    const { orderId, items } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider().queueResolution({
      kind: 'priceCorrection',
      updates: [{ itemId: items[0]!.id, retailPrice: '7.99' }],
    });

    const answer = await ask(repo, provider, orderId, 'actually the oil goes out at seven ninety nine');

    expect(answer.text).toContain('Saved');
    const stored = await repo.item(items[0]!.id);
    expect(Money.fromStorage(stored!.approvedPrice!).format()).toBe('$7.99');
  });

  it('keeps the corrected price for the next question', async () => {
    const { orderId, items } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    await repo.approvePrice(items[0]!.id, Money.of('7.99'));

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the corn oil');

    expect(answer.text).toContain('$7.99');
  });

  it('works out profit at a price the shopkeeper named, from the stored cost', async () => {
    const { orderId } = await seed(repo, [
      { displayName: 'Corn Oil', size: '48 OZ', trueUnitCost: Money.of('2.00').toStorage() },
    ]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'what do I make on the corn oil at $5.99');

    expect(answer.usedAi).toBe(false);
    expect(answer.text).toContain('Gross profit: $3.99');
  });

  it('says how many are in the case', async () => {
    const { orderId } = await seed(repo, [
      { displayName: 'Carnation Evaporated Milk', size: '12 OZ', unitsPerCase: 8 },
    ]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how many in the case of evaporated milk');

    expect(answer.text).toContain('8');
    expect(answer.text.toLowerCase()).toContain('per case');
  });

  it('records both sides of the conversation so a follow-up has context', async () => {
    const { orderId } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);

    await ask(repo, new FakeAiProvider(), orderId, 'how much is the corn oil');

    const conversation = await repo.conversation(orderId);
    expect(conversation.map((m) => m.role)).toEqual([MessageRole.USER, MessageRole.APP]);
    expect(conversation[0]!.text).toBe('how much is the corn oil');
  });

  it('passes the recent conversation to the model when it escalates', async () => {
    const { orderId, items } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    await ask(repo, new FakeAiProvider(), orderId, 'how much is the corn oil');

    const provider = new FakeAiProvider().queueResolution({
      kind: 'profitQuery',
      itemIds: [items[0]!.id],
      retailPrice: '5.99',
    });
    const answer = await ask(repo, provider, orderId, 'and what do I make on that one');

    expect(answer.text).toContain('Gross profit: $3.99');
  });

  it('identifies a product from an attached photo and prices it from the order', async () => {
    const { orderId } = await seed(repo, [
      { displayName: "Hellmann's Mayonnaise", size: '8 OZ' },
      { displayName: 'Corn Oil', size: '48 OZ' },
    ]);
    const provider = new FakeAiProvider().queueIdentification({
      products: [
        { brand: 'HELLMANNS', productName: 'Mayonnaise', size: '8 OZ', variant: null, upc: null, position: 0, confidence: 0.9 },
      ],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', {
      photo: { id: 1, image: { bytes: new Uint8Array([1, 2]).buffer, mimeType: 'image/jpeg' } },
    });

    expect(answer.usedAi).toBe(true);
    expect(answer.text).toContain('Mayonnaise');
    expect(answer.text).toContain('$4.99');
  });

  it('says so plainly when a photographed product is not in this order', async () => {
    const { orderId } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider().queueIdentification({
      products: [
        { brand: 'TIDE', productName: 'Detergent', size: '100 OZ', variant: null, upc: null, position: 0, confidence: 0.9 },
      ],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', {
      photo: { id: 1, image: { bytes: new Uint8Array([1, 2]).buffer, mimeType: 'image/jpeg' } },
    });

    expect(answer.text).toContain('not in this order');
    expect(answer.itemIds).toHaveLength(0);
  });

  it('reports a quota failure as itself instead of as "not found"', async () => {
    const { orderId } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    const answer = await ask(repo, provider, orderId, 'the unrecognisable thing over there');

    expect(answer.text).toBe(
      'Gemini quota reached for now. Grocery Pricer never turns on billing and never picks a paid model - what your Google project charges, if anything, is set in that project. Try again after the allowance resets.',
    );
  });

  it('can be told to answer offline, without ever reaching for the model', async () => {
    const { orderId } = await seed(repo, [{ displayName: 'Corn Oil', size: '48 OZ' }]);
    const provider = new FakeAiProvider();

    const answer = await ask(repo, provider, orderId, 'the unrecognisable thing over there', {
      allowAi: false,
    });

    expect(provider.calls).toHaveLength(0);
    expect(answer.usedAi).toBe(false);
    expect(answer.text).toContain('not sure which product');
  });

  it('says the order is empty rather than inventing an answer', async () => {
    const order = await repo.createOrder();

    const answer = await ask(repo, new FakeAiProvider(), order.id, 'how much is the mayo');

    expect(answer.text).toBe('There is nothing in this order yet.');
  });

  it('lists what cost under a figure', async () => {
    const { orderId } = await seed(repo, [
      { displayName: 'Corn Oil', trueUnitCost: Money.of('2.00').toStorage() },
      { displayName: 'Olive Oil', trueUnitCost: Money.of('6.00').toStorage() },
    ]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'what cost under $3');

    expect(answer.text).toContain('Corn Oil');
    expect(answer.text).not.toContain('Olive Oil');
  });
});

describe('what may be said about a product on a half-read receipt', () => {
  it('does not claim a product was absent when part of the receipt was never read', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    // The order holds products, and is known to be missing part of its receipt.
    await repo.updateOrder(orderId, { status: OrderStatus.READY, unreadPhotoGroups: 1 });

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the ketchup');

    // It may say it did not find it. It may not say the shop did not buy it.
    expect(answer.text).not.toContain('not in this order');
    expect(answer.text.toLowerCase()).toContain('never read');
  });

  it('answers plainly about a product that is there, incomplete or not', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    await repo.updateOrder(orderId, { status: OrderStatus.READY, unreadPhotoGroups: 1 });

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the mayonnaise');

    expect(answer.text.toLowerCase()).toContain('mayonnaise');
    // The caveat belongs on absence, not on every answer.
    expect(answer.text.toLowerCase()).not.toContain('never read');
  });

  it('still says "not in this order" when the receipt was fully read', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    await repo.updateOrder(orderId, { status: OrderStatus.READY });

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the ketchup');

    expect(answer.text.toLowerCase()).not.toContain('never read');
  });
});

describe('telling an answer apart from a failure', () => {
  it('marks a Gemini failure as not an answer', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);

    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });

    // A question only Gemini could answer, so the failure is reached.
    const answer = await ask(repo, provider, orderId, 'which of these is best value for a deli');

    expect(answer.failed).toBe(true);
    expect(answer.itemIds).toHaveLength(0);
    // The text is still worth showing - it just is not an answer to the question.
    expect(answer.text.length).toBeGreaterThan(0);
  });

  it('does not mark a real answer as failed', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the mayonnaise');

    expect(answer.failed).toBeFalsy();
    expect(answer.itemIds.length).toBeGreaterThan(0);
  });

  it('does not mark a local "could not find" as a failure', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'how much is the ketchup');

    // Answered truthfully from what is stored. Nothing went wrong, so nothing is retried.
    expect(answer.failed).toBeFalsy();
  });

  it('keeps the failure flag through the incomplete-receipt caveat', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    await repo.updateOrder(orderId, { status: OrderStatus.READY, unreadPhotoGroups: 1 });

    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });
    const answer = await ask(repo, provider, orderId, 'which of these is best value for a deli');

    expect(answer.failed).toBe(true);
  });
});

describe('a queued question that fails, then is retried by hand', () => {
  /** Exactly what the chat does: claim, answer, then complete or block. */
  async function attempt(
    repo: Repository,
    provider: FakeAiProvider,
    orderId: number,
  ): Promise<'answered' | 'failed' | 'nothing-to-do'> {
    const item = pending.claimNext(orderId);
    if (item === null) return 'nothing-to-do';

    const answer = await ask(repo, provider, orderId, item.question, { alreadyAsked: true });
    if (answer.failed === true) {
      pending.fail(orderId, item.id);
      return 'failed';
    }
    pending.complete(orderId, item.id);
    return 'answered';
  }

  it('does not retry itself, and succeeds when the owner asks again', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    pending.clear(orderId);

    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });
    const question = 'which of these is best value for a deli';
    await repo.say(orderId, MessageRole.USER, question);
    pending.add(orderId, question, null);

    expect(await attempt(repo, provider, orderId)).toBe('failed');
    const callsAfterFailure = provider.calls.length;

    // The queue is stalled, so every further pass does nothing at all. This is the loop that
    // would otherwise keep a failing model busy with photographs.
    expect(await attempt(repo, provider, orderId)).toBe('nothing-to-do');
    expect(await attempt(repo, provider, orderId)).toBe('nothing-to-do');
    expect(provider.calls).toHaveLength(callsAfterFailure);

    // The question is still there, and still the owner's.
    expect(pending.queue(orderId)).toHaveLength(1);
    expect(pending.queue(orderId)[0]?.question).toBe(question);

    // Pressing the button is what tries again.
    pending.retry(orderId);
    expect(await attempt(repo, provider, orderId)).toBe('answered');
    expect(pending.queue(orderId)).toHaveLength(0);

    // Asked once, and in the end answered once.
    const said = await repo.conversation(orderId);
    expect(said.filter((m) => m.text === question)).toHaveLength(1);
    expect(await attempt(repo, provider, orderId)).toBe('nothing-to-do');
  });

  it('keeps several questions in the order they were asked across a failure', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    pending.clear(orderId);

    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });

    pending.add(orderId, 'which of these is best value for a deli', null);
    pending.add(orderId, 'how much is the mayonnaise', null);

    expect(await attempt(repo, provider, orderId)).toBe('failed');
    // The second question is not answered ahead of the first.
    expect(await attempt(repo, provider, orderId)).toBe('nothing-to-do');
    expect(pending.queue(orderId).map((q) => q.question)).toEqual([
      'which of these is best value for a deli',
      'how much is the mayonnaise',
    ]);

    pending.retry(orderId);
    expect(await attempt(repo, provider, orderId)).toBe('answered');
    expect(await attempt(repo, provider, orderId)).toBe('answered');
    expect(pending.queue(orderId)).toHaveLength(0);
  });

  it('keeps the attached photograph through a failure and a retry', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [{ displayName: "Hellmann's Mayonnaise" }]);
    pending.clear(orderId);

    const photo = await repo.addPhoto({
      orderId,
      bytes: new Uint8Array([9, 9, 9]).buffer,
      mimeType: 'image/jpeg',
      type: OrderImageType.PRODUCT_PHOTO,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });
    const entry = pending.add(orderId, 'how much is this', photo.id);

    pending.claimNext(orderId);
    pending.fail(orderId, entry.id);

    // The row is in the database, not a File the page was holding, so it is still readable.
    expect(pending.queue(orderId)[0]?.photoId).toBe(photo.id);
    expect(await repo.photo(photo.id)).not.toBeNull();
  });
});

describe('answering what the receipt actually recorded', () => {
  it('says plainly that no discount was read, and does not pass a price off as a yes', async () => {
    const repo = await freshRepo();
    // The Cesar exactly as it is saved today: no discount on the row at all.
    const { orderId } = await seed(repo, [
      {
        displayName: 'CESAR FILET MIGNON 2.7 LB',
        casePrice: Money.of('29.39').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('7.35').toStorage(),
        suggestedPrice: Money.of('10.99').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'Did you record a $1.40 flyer discount on the Cesar Filet Mignon?',
    );

    expect(answer.text).toContain('no discount was recorded');
    // The old reply was the price line, which reads as confirmation that it was recorded.
    expect(answer.text).toContain('too high');
    expect(answer.text).toContain('cannot confirm an amount I did not read');
  });

  it('does not accept a figure typed in chat as something it read', async () => {
    const repo = await freshRepo();
    const { orderId } = await seed(repo, [
      {
        displayName: 'CESAR FILET MIGNON 2.7 LB',
        casePrice: Money.of('29.39').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('7.35').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'Did you record a $1.40 flyer discount on the Cesar Filet Mignon?',
    );

    // It must not repeat the shopkeeper's number back as though it were evidence.
    expect(answer.text).not.toContain('$1.40');
    expect(answer.text).not.toContain('7.00');
    // And the stored cost is untouched by the question.
    expect(Money.fromStorage((await repo.itemsFor(orderId))[0]!.trueUnitCost!).format()).toBe('$7.35');
  });

  it('reports a discount it did read, and whether it is in the cost', async () => {
    const repo = await freshRepo();
    const { orderId, items } = await seed(repo, [
      {
        displayName: 'PAMPERS JUMBO DIAPERS SIZE 6',
        casePrice: Money.of('45.99').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('9.75').toStorage(),
      },
    ]);
    await repo.updateItem(items[0]!.id, {
      discount: {
        description: 'Flyer',
        amount: Money.of('7.00').toStorage(),
        scope: DiscountScope.WHOLE_CASE,
        appliesToUnits: null,
      },
    });

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'what flyer discount did you read for the pampers',
    );

    // The amount, and what it comes off: a $7.00 off the case and a $7.00 off each are
    // different costs, so the answer says which.
    expect(answer.text).toContain('$7.00 off the whole case was read from the receipt');
    expect(answer.text).toContain('$9.75');
  });

  it('says a read discount is not applied when the scope is still open', async () => {
    const repo = await freshRepo();
    const { orderId, items } = await seed(repo, [
      {
        displayName: 'PAMPERS JUMBO DIAPERS SIZE 6',
        casePrice: Money.of('45.99').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('11.50').toStorage(),
      },
    ]);
    await repo.updateItem(items[0]!.id, {
      discount: {
        description: 'Flyer',
        amount: Money.of('7.00').toStorage(),
        scope: DiscountScope.UNKNOWN,
        appliesToUnits: null,
      },
    });

    const answer = await ask(repo, new FakeAiProvider(), orderId, 'was there a discount on the pampers');

    expect(answer.text).toContain('$7.00');
    expect(answer.text).toContain('was read from the receipt');
    expect(answer.text).toContain('not in the cost');
  });
});

describe('asked about a discount, it answers about the discount', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('says what was read off the receipt, and that it comes off the case', async () => {
    const { orderId } = await seed(repo, [
      {
        displayName: 'DryNite Jumbo #6 21CT',
        size: '21 CT',
        casePrice: Money.of('45.99').toStorage(),
        unitsPerCase: 4,
        discount: {
          description: 'Flyer',
          amount: Money.of('7.00').toStorage(),
          scope: DiscountScope.WHOLE_CASE,
          appliesToUnits: null,
        },
        trueUnitCost: Money.of('9.7475').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'Did you record a flyer discount for DryNite Jumbo Diapers 21CT?',
    );

    expect(answer.text).toContain('$7.00');
    expect(answer.text.toLowerCase()).toContain('case');
    // Answered from what is saved: no call, no cost to the shop.
    expect(answer.usedAi).toBe(false);
  });

  it('says plainly that none was recorded, instead of quoting a price', async () => {
    const { orderId } = await seed(repo, [
      {
        displayName: 'DryNite Jumbo #6 21CT',
        size: '21 CT',
        casePrice: Money.of('45.99').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('11.4975').toStorage(),
        suggestedPrice: Money.of('15.99').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'Did you record a flyer discount for DryNite Jumbo Diapers 21CT?',
    );

    expect(answer.text.toLowerCase()).toContain('no discount was recorded');
    // The old answer was the selling price, which reads as a yes.
    expect(answer.text).not.toContain('$15.99');
    // And it says why that matters: the cost on the card is the undiscounted one.
    expect(answer.text.toLowerCase()).toContain('too high');
  });

  it('will not confirm an amount the owner supplies in the chat', async () => {
    const { orderId } = await seed(repo, [
      {
        displayName: 'Dog Dinner Filet 2.7 LB',
        size: '2.7 LB',
        casePrice: Money.of('29.39').toStorage(),
        unitsPerCase: 4,
        trueUnitCost: Money.of('7.3475').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'What is my actual cost for Dog Dinner Filet 2.7 lb? Did you record a $1.40 flyer discount? If the discount is missing, tell me.',
    );

    expect(answer.text.toLowerCase()).toContain('no discount was recorded');
    expect(answer.text.toLowerCase()).toContain('cannot confirm an amount i did not read');
    // Their figure is their recollection, and must not come back as evidence.
    expect(answer.text).not.toContain('$1.40');
  });

  it('asks which one when two sizes answer to the same name', async () => {
    const { orderId } = await seed(repo, [
      { displayName: 'DryNite Jumbo #6 21CT', size: '21 CT' },
      { displayName: 'DryNite Jumbo #5 24CT', size: '24 CT' },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'did you record a flyer discount for DryNite Jumbo?',
    );

    // Answering about either one is a coin flip on two different products.
    expect(answer.text).toContain('Which one');
    expect(answer.itemIds).toHaveLength(2);
  });

  it('answers for the size that was asked about', async () => {
    const { orderId } = await seed(repo, [
      {
        displayName: 'DryNite Jumbo #6 21CT',
        size: '21 CT',
        discount: {
          description: 'Flyer',
          amount: Money.of('7.00').toStorage(),
          scope: DiscountScope.WHOLE_CASE,
          appliesToUnits: null,
        },
      },
      { displayName: 'DryNite Jumbo #5 24CT', size: '24 CT' },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'did you record a flyer discount for DryNite Jumbo 24CT?',
    );

    expect(answer.text).toContain('24');
    expect(answer.text.toLowerCase()).toContain('no discount was recorded');
  });

  it('says a recorded discount is not in the cost when nobody has said what it comes off', async () => {
    const { orderId } = await seed(repo, [
      {
        displayName: 'Air Fresh Spring 4CT',
        size: '4 CT',
        casePrice: Money.of('9.89').toStorage(),
        unitsPerCase: 4,
        discount: {
          description: 'Flyer',
          amount: Money.of('0.50').toStorage(),
          scope: DiscountScope.UNKNOWN,
          appliesToUnits: null,
        },
        trueUnitCost: Money.of('2.4725').toStorage(),
      },
    ]);

    const answer = await ask(
      repo,
      new FakeAiProvider(),
      orderId,
      'was there a discount on the Air Fresh Spring?',
    );

    expect(answer.text).toContain('$0.50');
    // Read, but not applied - and the difference has to be said out loud.
    expect(answer.text.toLowerCase()).toMatch(/not in the cost|not been applied|does not say/);
  });
});
