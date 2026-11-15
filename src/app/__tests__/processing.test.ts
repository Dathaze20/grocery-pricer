import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { GeminiProvider } from '../../ai/provider';
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

  it('stops the run when the free quota is gone, without promising what Google bills', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('quotaExhausted');
    expect(result.summary).toBe(
      'Gemini quota reached for now. Grocery Pricer never turns on billing and never picks a paid model - what your Google project charges, if anything, is set in that project. Try again after the allowance resets.',
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
    // Two photographs per request, so seven go out as four. Smaller requests come back sooner
    // and a slow one costs a pair rather than a third of the receipt.
    expect(calls).toHaveLength(4);
    expect(calls[0]!.split(',')).toHaveLength(2);

    // And no classification round-trip: nothing is sent before the reading begins.
    expect(provider.calls.filter((c) => c.startsWith('classifyImages'))).toHaveLength(0);
  });

  it('skips photos already known to be of products, without asking first', async () => {
    const order = await repo.createOrder();
    const receipt = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.UNKNOWN,
      isDeliveryPhoto: false,
      createdAt: 1,
    });
    // A snapshot taken through the chat is stored as a product photo when it is added, which
    // is where that knowledge comes from now that nothing is sent away to ask.
    const shelf = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.PRODUCT_PHOTO,
      isDeliveryPhoto: false,
      createdAt: 2,
    });
    const provider = new FakeAiProvider();

    await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    expect(provider.calls).toContain(`extractOrder(${receipt.id})`);
    expect(provider.calls.join(' ')).not.toContain(String(shelf.id));
    expect(provider.calls.filter((c) => c.startsWith('classifyImages'))).toHaveLength(0);
  });

  it('does not re-send a request that already ran out of time', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'timeout' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    // One attempt, not two. The same photographs going out again would spend another ninety
    // seconds without being any more likely to finish.
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(1);
  });

  it('times each phase, and records nothing but durations', async () => {
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });

    const result = await processOrder(repo, provider, orderId);

    expect(result.timings.length).toBeGreaterThan(0);
    expect(result.timings.map((t) => t.phase)).toContain('prepare-photos');
    for (const timing of result.timings) {
      expect(typeof timing.ms).toBe('number');
      // Phase names are fixed labels. No file name, no product, no price, no key.
      expect(timing.phase).toMatch(/^[a-z-]+(-\d+)?$/);
    }
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

describe('an unavailable model does not reach the shopkeeper', () => {
  /** A receipt as Gemini would return it, for the whole pipeline to run on. */
  function geminiReply(): Response {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    supplier: 'JETRO',
                    items: [
                      {
                        rawName: 'HELLM MAYONNAISE 8Z',
                        canonicalName: "Hellmann's Mayonnaise",
                        casePrice: '24.00',
                        unitsPerCase: 6,
                        casesPurchased: 1,
                        sourcePhotoIds: [1],
                        sourceText: ['HELLM MAYONNAISE 8Z 24.00'],
                        confidence: 0.9,
                      },
                    ],
                    warnings: [],
                  }),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
      { status: 200 },
    );
  }

  function refused(model: string): Response {
    return new Response(
      JSON.stringify({
        error: { code: 404, status: 'NOT_FOUND', message: `models/${model} is not found` },
      }),
      { status: 404 },
    );
  }

  it('falls back to a working model and prices the order, once', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const model = decodeURIComponent(/models\/([^:]+):/.exec(String(url))?.[1] ?? '');
      asked.push(model);
      // The real failure: the first choice is refused outright by Google.
      return model === 'retired-primary' ? refused(model) : geminiReply();
    });

    const worked: string[] = [];
    const provider = new GeminiProvider({
      apiKey: 'AIza-test-key',
      models: ['retired-primary', 'working-model'],
      onModelWorked: (m) => worked.push(m),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await processOrder(repo, provider, orderId);

    // The shopkeeper gets their products. They are never told a model name.
    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain('retired-primary');
    expect(result.summary).not.toContain('404');

    const items = await repo.itemsFor(orderId);
    expect(items).toHaveLength(1);
    expect(items[0]!.displayName).toBeTruthy();

    expect(asked).toContain('retired-primary');
    expect(worked).toEqual(['working-model']);
    expect((await repo.order(orderId))!.status).toBe(OrderStatus.READY);
    // Nothing was lost on the way through, either.
    expect(await repo.photosFor(orderId, false)).toHaveLength(1);
  });

  it('does not duplicate rows when the fallback happens on a re-read', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const model = decodeURIComponent(/models\/([^:]+):/.exec(String(url))?.[1] ?? '');
      return model === 'retired-primary' ? refused(model) : geminiReply();
    });
    const provider = new GeminiProvider({
      apiKey: 'AIza-test-key',
      models: ['retired-primary', 'working-model'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await processOrder(repo, provider, orderId);
    const first = await repo.itemsFor(orderId);
    expect(first).toHaveLength(1);

    await processOrder(repo, provider, orderId, { reprocess: true });
    const second = await repo.itemsFor(orderId);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });

  it('keeps the order intact when every model is refused', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);

    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      refused(decodeURIComponent(/models\/([^:]+):/.exec(String(url))?.[1] ?? '')),
    );
    const provider = new GeminiProvider({
      apiKey: 'AIza-test-key',
      models: ['one', 'two', 'three'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await processOrder(repo, provider, orderId);

    expect(result.ok).toBe(false);
    // One explanation, with no model names and nothing to choose between.
    expect(result.summary).toContain('Google project');
    expect(result.summary).not.toContain('one');
    expect(result.summary).not.toContain('HTTP');
    expect(await repo.photosFor(orderId, false)).toHaveLength(1);
    expect(await repo.itemsFor(orderId)).toHaveLength(0);
  });
});

describe('telling a complete reading from an incomplete one', () => {
  it('does not call an empty receipt a success', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    // The model answered, and found nothing on the page.
    provider.queueExtraction({ supplier: 'JETRO', items: [], warnings: [] });

    const result = await processOrder(repo, provider, orderId);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('empty');
    // A tick and a total of zero beside a receipt nobody read is worse than an error.
    expect((await repo.order(orderId))!.status).not.toBe(OrderStatus.READY);
    expect(await repo.itemsFor(orderId)).toHaveLength(0);
    // And the photographs are still here to try again with.
    expect(await repo.photosFor(orderId, false)).toHaveLength(1);
    expect(result.summary.toLowerCase()).toContain('could not');
  });

  it('keeps the phase timings when extraction fails, which is when they matter most', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'timeout' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    // The six-minute timeout is exactly the case we need durations for.
    expect(result.timings.length).toBeGreaterThan(0);
    expect(result.timings.map((t) => t.phase)).toContain('prepare-photos');
    expect(result.timings.some((t) => t.phase.startsWith('extract-'))).toBe(true);
  });

  it('marks a half-read receipt as incomplete rather than ready', async () => {
    const repo = await freshRepo();
    const order = await repo.createOrder();
    for (let i = 0; i < 4; i += 1) {
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
    // Four photographs is two groups: the first reads, the second does not come back.
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    provider.queueFailure({ kind: 'timeout' });

    const result = await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    expect(result.outcome).toBe('partial');
    expect(result.itemCount).toBe(1);
    // The products that were read are kept - they are real - but the total is not the order.
    expect(await repo.itemsFor(order.id)).toHaveLength(1);
    expect(result.summary).toContain('not fully read');
    expect(result.warnings.join(' ')).toContain('incomplete');
  });

  it('calls a fully read receipt complete', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });

    const result = await processOrder(repo, provider, orderId);

    expect(result.outcome).toBe('complete');
    expect(result.summary).not.toContain('not fully read');
  });

  it('retrying a partial read replaces rather than duplicates, and keeps approved prices', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    await processOrder(repo, provider, orderId);

    const first = (await repo.itemsFor(orderId))[0]!;
    await repo.approvePrice(first.id, Money.of('6.25'));

    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    const again = await processOrder(repo, provider, orderId, { reprocess: true });

    expect(again.ok).toBe(true);
    const rows = await repo.itemsFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());
  });
});
