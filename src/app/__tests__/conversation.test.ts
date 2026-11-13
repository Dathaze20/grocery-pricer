import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { Category, ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { MessageRole, type StoredItem } from '../../data/schema';
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
      discount: null,
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
      'Free Gemini quota reached. Grocery Pricer will not charge you. Try again after the quota resets.',
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
