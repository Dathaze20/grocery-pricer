import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { Repository } from '../../data/repository';
import { resetDbHandle } from '../../data/db';
import { OrderStatus, MessageRole, type StoredPhoto } from '../../data/schema';
import { OrderImageType, type AiExtractedItem } from '../../core/ai-types';
import { processOrder } from '../processing';

let dbCounter = 0;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`test-db-${dbCounter}`);
}

function photoBytes(): ArrayBuffer {
  return new Uint8Array([1, 2, 3, 4]).buffer;
}

async function orderWithPhoto(repo: Repository): Promise<{ orderId: number; photo: StoredPhoto }> {
  const order = await repo.createOrder();
  const photo = await repo.addPhoto({
    orderId: order.id,
    bytes: photoBytes(),
    mimeType: 'image/jpeg',
    type: OrderImageType.RECEIPT,
    isDeliveryPhoto: false,
    createdAt: Date.now(),
  });
  return { orderId: order.id, photo };
}

function extractedItem(over: Partial<AiExtractedItem> = {}): AiExtractedItem {
  return {
    rawName: 'HELLM MAYONNAISE 8Z',
    canonicalName: "Hellmann's Mayonnaise",
    brand: 'HELLMANNS',
    size: '8 OZ',
    upc: null,
    supplierSku: null,
    casePrice: '41.99',
    unitsPerCase: 12,
    printedUnitCost: null,
    casesPurchased: 1,
    discount: null,
    category: null,
    sourcePhotoIds: [],
    sourceText: ['HELLM MAYONNAISE 8Z 41.99'],
    confidence: 0.9,
    ...over,
  };
}

describe('processOrder', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('computes the unit cost itself rather than taking one from the model', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: 'JETRO',
      items: [
        extractedItem({
          sourcePhotoIds: [photo.id],
          // A printed unit cost that disagrees with the arithmetic. The receipt is wrong; the
          // division is not.
          printedUnitCost: '9.99',
        }),
      ],
      warnings: [],
    });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(true);
    const items = await repo.itemsFor(orderId);
    expect(items).toHaveLength(1);
    // 41.99 / 12 = 3.499166..., held to four places.
    expect(Money.fromStorage(items[0]!.trueUnitCost!).formatPrecise()).toBe('$3.4992');
    expect(items[0]!.trueUnitCost).not.toBe(Money.of('9.99').toStorage());
  });

  it('applies a discount to the cost before pricing', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [
        extractedItem({
          casePrice: '24.00',
          unitsPerCase: 12,
          sourcePhotoIds: [photo.id],
          discount: { amount: '6.00', scope: 'WHOLE_CASE', appliesToUnits: null },
        }),
      ],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    expect(Money.fromStorage(items[0]!.trueUnitCost!).format()).toBe('$1.50');
  });

  it('leaves the cost alone when the discount scope is not clear', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [
        extractedItem({
          casePrice: '24.00',
          unitsPerCase: 12,
          sourcePhotoIds: [photo.id],
          discount: { amount: '6.00', scope: 'something the model made up', appliesToUnits: null },
        }),
      ],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    expect(Money.fromStorage(items[0]!.trueUnitCost!).format()).toBe('$2.00');
    expect(items[0]!.discount?.scope).toBe('UNKNOWN');
  });

  it('stores no price at all when the cost could not be read', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: null, sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    expect(items[0]!.trueUnitCost).toBeNull();
    // Not zero. A zero price here would be repeated to the shopkeeper as though it were real.
    expect(items[0]!.suggestedPrice).toBeNull();
    expect(items[0]!.pricingSource).toBe(PricingSource.NO_COST);
    expect(items[0]!.confidence).toBe(ItemConfidence.PROBLEM);
  });

  it('prices from the cost ladder and records why', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12, sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    // $24.00 for 12 is $2.00 a unit, which is the $2.00 - $2.99 rung of the ladder.
    expect(Money.fromStorage(items[0]!.suggestedPrice!).format()).toBe('$4.99');
    expect(items[0]!.pricingSource).toBe(PricingSource.COST_TIER);
    expect(items[0]!.pricingRationale).toContain('Cost tier');
  });

  it('totals the order from its own arithmetic', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [
        extractedItem({ casePrice: '24.00', unitsPerCase: 12, casesPurchased: 2, sourcePhotoIds: [photo.id] }),
        extractedItem({
          rawName: 'CORN OIL 48Z',
          canonicalName: 'Corn Oil',
          size: '48 OZ',
          casePrice: '30.00',
          unitsPerCase: 6,
          casesPurchased: 1,
          sourcePhotoIds: [photo.id],
        }),
      ],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const order = await repo.order(orderId);
    expect(Money.fromStorage(order!.totalWholesaleCost).format()).toBe('$78.00');
    expect(order!.itemCount).toBe(2);
    expect(order!.status).toBe(OrderStatus.READY);
    expect(order!.supplier).toBeNull();
  });

  it('remembers the supplier the receipt named', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect((await repo.order(orderId))!.supplier).toBe('JETRO');
  });

  it('stops the run when the free quota is gone, and says nothing will be charged', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('quotaExhausted');
    expect(result.summary).toBe(
      'Free Gemini quota reached. Grocery Pricer will not charge you. Try again after the quota resets.',
    );
    const order = await repo.order(orderId);
    expect(order!.status).toBe(OrderStatus.FAILED);
    expect(order!.failureMessage).toBe(result.summary);
    expect(await repo.itemsFor(orderId)).toHaveLength(0);
  });

  it('says what to do when there is no key yet', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueFailure({ kind: 'missingKey' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.summary).toContain('AI setup is required');
    expect((await repo.order(orderId))!.status).toBe(OrderStatus.FAILED);
  });

  it('retries once after a transient failure', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueExtraction({
      supplier: null,
      items: [extractedItem({ sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(1);
  });

  it('does not retry a spent quota, because the retry only spends the next one', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(provider.calls.filter((c) => c.startsWith('extractOrder')).length).toBe(1);
  });

  it('refuses to process an order with no photos', async () => {
    const order = await repo.createOrder();
    const provider = new FakeAiProvider();

    const result = await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Add a photo');
    expect(provider.calls).toHaveLength(0);
  });

  it('sends photos in batches instead of all at once', async () => {
    const order = await repo.createOrder();
    for (let i = 0; i < 7; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: photoBytes(),
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: Date.now() + i,
      });
    }
    const provider = new FakeAiProvider();

    await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    const calls = provider.calls.filter((c) => c.startsWith('extractOrder'));
    expect(calls).toHaveLength(3);
    expect(calls[0]!.split(',')).toHaveLength(3);
  });

  it('skips photos of products when reading the paperwork', async () => {
    const order = await repo.createOrder();
    const receipt = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.UNKNOWN,
      isDeliveryPhoto: false,
      createdAt: 1,
    });
    const shelf = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.UNKNOWN,
      isDeliveryPhoto: false,
      createdAt: 2,
    });
    const provider = new FakeAiProvider().queueClassification([
      { photoId: receipt.id, type: OrderImageType.RECEIPT, confidence: 0.9 },
      { photoId: shelf.id, type: OrderImageType.PRODUCT_PHOTO, confidence: 0.9 },
    ]);

    await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    expect(provider.calls).toContain(`extractOrder(${receipt.id})`);
  });

  it('keeps a nameless row out of the order and says a line was dropped', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [
        extractedItem({ sourcePhotoIds: [photo.id] }),
        extractedItem({ rawName: null, canonicalName: null, brand: null, sourcePhotoIds: [photo.id] }),
      ],
      warnings: [],
    });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.itemCount).toBe(1);
    expect(result.warnings.some((w) => w.includes('dropped'))).toBe(true);
  });

  it('opens the conversation with a summary the shopkeeper can act on', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12, sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const conversation = await repo.conversation(orderId);
    expect(conversation).toHaveLength(1);
    expect(conversation[0]!.role).toBe(MessageRole.APP);
    expect(conversation[0]!.text).toContain('1 product');
    expect(conversation[0]!.text).toContain('$24.00 wholesale');
    expect(conversation[0]!.text).toContain('Ask me anything');
  });

  it('remembers the product between orders and prices from the previous shelf price', async () => {
    const first = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12, sourcePhotoIds: [first.photo.id] })],
      warnings: [],
    });
    await processOrder(repo, provider, first.orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(first.orderId);
    await repo.approvePrice(items[0]!.id, Money.of('4.49'));

    const second = await orderWithPhoto(repo);
    provider.queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12, sourcePhotoIds: [second.photo.id] })],
      warnings: [],
    });
    await processOrder(repo, provider, second.orderId, { retryDelayMs: 0 });

    const laterItems = await repo.itemsFor(second.orderId);
    expect(Money.fromStorage(laterItems[0]!.suggestedPrice!).format()).toBe('$4.49');
    expect(laterItems[0]!.pricingSource).toBe(PricingSource.PREVIOUS_PRICE);
    expect(laterItems[0]!.productId).toBe(items[0]!.productId);
  });

  it('writes a price history row for every costed item', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12, sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    const history = await repo.historyFor(items[0]!.productId!);
    expect(history).toHaveLength(1);
    expect(Money.fromStorage(history[0]!.unitCost!).format()).toBe('$2.00');
  });

  it('keeps the evidence for every row it stored', async () => {
    const { orderId, photo } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueExtraction({
      supplier: null,
      items: [extractedItem({ sourcePhotoIds: [photo.id] })],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const items = await repo.itemsFor(orderId);
    expect(items[0]!.sourcePhotoIds).toEqual([photo.id]);
    expect(items[0]!.sourceText[0]).toContain('HELLM MAYONNAISE');
    expect(items[0]!.aiConfidence).toBe(0.9);
    expect(items[0]!.rawName).toBe('HELLM MAYONNAISE 8Z');
  });
});

describe('retrying an order', () => {
  it('will not read a finished order again by accident', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    expect((await processOrder(repo, provider, orderId)).ok).toBe(true);
    const after = await repo.itemsFor(orderId);
    expect(after).toHaveLength(1);

    // A stray press on an order that is already done. Nothing is sent and nothing is touched.
    const again = await processOrder(repo, provider, orderId);
    expect(again.ok).toBe(false);
    expect(again.summary).toContain('already been read');
    expect(await repo.itemsFor(orderId)).toHaveLength(1);
    expect((await repo.order(orderId))!.status).toBe(OrderStatus.READY);
  });

  it('replaces rather than appends when a re-read is actually asked for', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    await processOrder(repo, provider, orderId);
    const first = await repo.itemsFor(orderId);

    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    const second = await processOrder(repo, provider, orderId, { reprocess: true });
    expect(second.ok).toBe(true);

    const rows = await repo.itemsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(first[0]!.id);
  });

  it('A FAILED RETRY CANNOT ERASE AN APPROVED PRICE', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    await processOrder(repo, provider, orderId);

    // The owner decides what to charge. That decision is theirs, not the model's.
    const item = (await repo.itemsFor(orderId))[0]!;
    await repo.approvePrice(item.id, Money.of('6.25'));
    expect((await repo.itemsFor(orderId))[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());

    // Now a re-read that Gemini refuses outright.
    provider.queueFailure({
      kind: 'modelUnavailable',
      model: 'gemini-2.5-flash',
      status: 404,
      detail: 'not found for API version v1beta',
    });
    const failed = await processOrder(repo, provider, orderId, { reprocess: true });
    expect(failed.ok).toBe(false);

    // Everything the owner had is still there.
    const after = await repo.itemsFor(orderId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(item.id);
    expect(after[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());
    expect(after[0]!.displayName).toBe(item.displayName);

    // And the order is not left looking broken when its products are intact.
    const order = await repo.order(orderId);
    expect(order!.status).toBe(OrderStatus.READY);
    expect(order!.failureMessage).toContain('HTTP 404');
  });

  it('carries an approved price across a re-read that succeeds', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    await processOrder(repo, provider, orderId);
    const item = (await repo.itemsFor(orderId))[0]!;
    await repo.approvePrice(item.id, Money.of('6.25'));

    // Same product, a new wholesale cost. The owner's price is still the owner's price.
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ casePrice: '36.00' })],
      warnings: [],
    });
    expect((await processOrder(repo, provider, orderId, { reprocess: true })).ok).toBe(true);

    const after = await repo.itemsFor(orderId);
    expect(after).toHaveLength(1);
    expect(after[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());
  });

  it('keeps every photograph and the stored key when the model refuses', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    const { orderId } = await orderWithPhoto(repo);

    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'modelUnavailable', model: 'gemini-2.5-flash', status: 404 });

    const failed = await processOrder(repo, provider, orderId);
    expect(failed.ok).toBe(false);
    expect(await repo.photosFor(orderId, false)).toHaveLength(1);
    expect(await repo.apiKey()).toBe('AIza-the-owners-own-key');

    const order = await repo.order(orderId);
    // This one had nothing to lose, so it is the retryable kind.
    expect(order!.status).toBe(OrderStatus.FAILED);
    expect(order!.failureMessage).toContain('HTTP 404');

    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    expect((await processOrder(repo, provider, orderId)).ok).toBe(true);
    expect(await repo.itemsFor(orderId)).toHaveLength(1);
  });
});
