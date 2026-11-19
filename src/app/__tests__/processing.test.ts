import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { GeminiProvider } from '../../ai/provider';
import { Money } from '../../core/money';
import { ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { Repository } from '../../data/repository';
import { resetDbHandle } from '../../data/db';
import { OrderStatus, MessageRole, type StoredPhoto, isIncomplete } from '../../data/schema';
import { OrderImageType, type AiExtractedItem } from '../../core/ai-types';
import { APPROVED_PRICE_BELOW_COST, GROUP_REQUEST_BUDGET, processOrder } from '../processing';

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

describe('an incomplete order stays incomplete after the app is closed', () => {
  async function halfReadOrder(repo: Repository): Promise<number> {
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
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    provider.queueFailure({ kind: 'timeout' });
    await processOrder(repo, provider, order.id, { retryDelayMs: 0 });
    return order.id;
  }

  it('records the unread groups on the order itself', async () => {
    const repo = await freshRepo();
    const orderId = await halfReadOrder(repo);

    // Read back the way the home screen reads it, not from the result object that only
    // existed in the session that did the work.
    const stored = (await repo.order(orderId))!;
    expect(isIncomplete(stored)).toBe(true);
    expect(stored.unreadPhotoGroups).toBe(1);
    expect(stored.warnings.join(' ')).toContain('incomplete');
  });

  it('a fully read order is not marked incomplete', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    await processOrder(repo, provider, orderId);

    expect(isIncomplete((await repo.order(orderId))!)).toBe(false);
  });

  it('an order saved before this existed reads as complete, with no migration', async () => {
    const repo = await freshRepo();
    const order = await repo.createOrder();

    // Exactly the shape of a version-2 record: no such field at all.
    const stored = (await repo.order(order.id))!;
    expect(stored.unreadPhotoGroups).toBeUndefined();
    expect(isIncomplete(stored)).toBe(false);
  });

  it('a successful re-read clears the incomplete mark without duplicating or losing anything', async () => {
    const repo = await freshRepo();
    const orderId = await halfReadOrder(repo);
    const first = (await repo.itemsFor(orderId))[0]!;
    await repo.approvePrice(first.id, Money.of('6.25'));

    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [extractedItem()], warnings: [] });
    provider.queueExtraction({ supplier: 'JETRO', items: [], warnings: [] });
    const again = await processOrder(repo, provider, orderId, { reprocess: true });

    expect(again.outcome).toBe('complete');
    expect(isIncomplete((await repo.order(orderId))!)).toBe(false);

    const rows = await repo.itemsFor(orderId);
    expect(rows).toHaveLength(1);
    // The owner's own decision survived the re-read.
    expect(rows[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());
  });

  it('never reports a partial total as the whole purchase', async () => {
    const repo = await freshRepo();
    const orderId = await halfReadOrder(repo);
    const stored = (await repo.order(orderId))!;

    // The figure is real and worth showing - it is the claim around it that must be hedged.
    expect(stored.totalWholesaleCost).toBeGreaterThan(0);
    expect(isIncomplete(stored)).toBe(true);
  });
});

describe('three ways a receipt can be miscounted', () => {
  it('keeps sizes apart, keeps repeated cases, and folds an overlap into one', async () => {
    const repo = await freshRepo();
    const order = await repo.createOrder();
    const photoA = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: 1,
    });
    const photoB = await repo.addPhoto({
      orderId: order.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: 2,
    });

    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        // Two sizes under the one shorthand the receipt prints for both.
        extractedItem({
          rawName: 'HELLM MAYO',
          canonicalName: "Hellmann's Mayonnaise",
          size: '8 OZ',
          casePrice: '24.00',
          sourcePhotoIds: [photoA.id],
        }),
        extractedItem({
          rawName: 'HELLM MAYO',
          canonicalName: "Hellmann's Mayonnaise",
          size: '40 OZ',
          casePrice: '60.00',
          sourcePhotoIds: [photoA.id],
        }),
        // The same product printed twice on the one photograph: two cases bought, not one
        // line seen twice.
        extractedItem({
          rawName: 'EXMP CORN OIL',
          canonicalName: 'Example Corn Oil',
          size: '1 GAL',
          casePrice: '30.00',
          sourcePhotoIds: [photoA.id],
        }),
        extractedItem({
          rawName: 'EXMP CORN OIL',
          canonicalName: 'Example Corn Oil',
          size: '1 GAL',
          casePrice: '30.00',
          sourcePhotoIds: [photoA.id],
        }),
      ],
      warnings: [],
    });
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        // The overlap: the same printed line caught again in the next photograph.
        extractedItem({
          rawName: 'HELLM MAYO',
          canonicalName: "Hellmann's Mayonnaise",
          size: '8 OZ',
          casePrice: '24.00',
          sourcePhotoIds: [photoB.id],
        }),
      ],
      warnings: [],
    });

    const result = await processOrder(repo, provider, order.id, { retryDelayMs: 0 });
    expect(result.ok).toBe(true);

    const rows = await repo.itemsFor(order.id);

    // 1. The two mayonnaise sizes are separate products with separate prices.
    const mayo = rows.filter((r) => r.displayName.toLowerCase().includes('mayonnaise'));
    expect(mayo).toHaveLength(2);
    const productIds = new Set(mayo.map((r) => r.productId));
    expect(productIds.size).toBe(2);
    expect(new Set(mayo.map((r) => r.size))).toEqual(new Set(['8 OZ', '40 OZ']));

    // 2. Both cases of corn oil survive - that is money the shop actually paid.
    const oil = rows.filter((r) => r.displayName.toLowerCase().includes('corn oil'));
    expect(oil).toHaveLength(2);

    // 3. The overlapping photograph did not add a third jar of 8oz mayonnaise.
    expect(mayo.filter((r) => r.size === '8 OZ')).toHaveLength(1);
  });
});

describe('working without asking, where the receipt says enough', () => {
  it('applies a Jetro flyer discount on its own: Pampers at $9.75', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        extractedItem({
          rawName: 'PAMPERS JUMBO SZ6',
          canonicalName: 'Pampers Jumbo Size 6',
          casePrice: '45.99',
          unitsPerCase: 4,
          casesPurchased: 1,
          discount: { amount: '7.00', scope: 'UNKNOWN', appliesToUnits: null },
          sourceText: ['PAMPERS JUMBO SZ6  45.99', 'Flyer 12 - PAMPERS JUMBO   -7.00'],
        }),
      ],
      warnings: [],
    });

    await processOrder(repo, provider, orderId);
    const row = (await repo.itemsFor(orderId))[0]!;

    expect(Money.fromStorage(row.trueUnitCost!).format()).toBe('$9.75');
    expect(row.discount!.scope).toBe('WHOLE_CASE');
    // Nothing to ask, so nothing is asked.
    expect(row.issues).not.toContain('UNKNOWN_DISCOUNT_SCOPE');
  });

  it('still asks when the line is genuinely ambiguous', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        extractedItem({
          rawName: 'CESAR FILET',
          casePrice: '29.39',
          unitsPerCase: 4,
          discount: { amount: '1.40', scope: 'UNKNOWN', appliesToUnits: null },
          sourceText: ['CESAR FILET 2.7LB  29.39  1.40 each'],
        }),
      ],
      warnings: [],
    });

    await processOrder(repo, provider, orderId);
    const row = (await repo.itemsFor(orderId))[0]!;

    // "each" could mean per unit, and guessing would change what the shop charges.
    expect(row.discount!.scope).toBe('UNKNOWN');
    expect(row.issues).toContain('UNKNOWN_DISCOUNT_SCOPE');
    expect(Money.fromStorage(row.trueUnitCost!).format()).toBe('$7.35');
  });

  it('remembers a pack count, so the next receipt does not need one', async () => {
    const repo = await freshRepo();

    // First delivery: the receipt printed the count.
    const first = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        extractedItem({
          rawName: 'FEBREZE AIR SPRING',
          canonicalName: 'Febreze Air Spring Clean',
          size: '8.1 OZ',
          casePrice: '9.89',
          unitsPerCase: 4,
          discount: null,
        }),
      ],
      warnings: [],
    });
    await processOrder(repo, provider, first.orderId);

    // Second delivery: the same product, and this time the line does not print the count.
    const second = await repo.createOrder();
    await repo.addPhoto({
      orderId: second.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [
        extractedItem({
          rawName: 'FEBREZE AIR SPRING',
          canonicalName: 'Febreze Air Spring Clean',
          size: '8.1 OZ',
          casePrice: '9.89',
          unitsPerCase: null,
          discount: { amount: '0.50', scope: 'UNKNOWN', appliesToUnits: null },
          sourceText: ['FEBREZE AIR SPRING 8.1Z  9.89', 'Flyer 7 - FEBREZE AIR  -0.50'],
        }),
      ],
      warnings: [],
    });
    await processOrder(repo, provider, second.id);

    const row = (await repo.itemsFor(second.id))[0]!;
    // Counted once, months ago. The cost is there without anybody being asked again.
    expect(row.unitsPerCase).toBe(4);
    expect(Money.fromStorage(row.trueUnitCost!).format()).toBe('$2.35');
  });

  it('prices from the new cost when a later receipt costs more', async () => {
    const repo = await freshRepo();
    const first = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12 })],
      warnings: [],
    });
    await processOrder(repo, provider, first.orderId);
    const before = (await repo.itemsFor(first.orderId))[0]!;

    const second = await repo.createOrder();
    await repo.addPhoto({
      orderId: second.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ casePrice: '48.00', unitsPerCase: 12 })],
      warnings: [],
    });
    await processOrder(repo, provider, second.id);
    const after = (await repo.itemsFor(second.id))[0]!;

    expect(Money.fromStorage(after.trueUnitCost!).greaterThan(Money.fromStorage(before.trueUnitCost!))).toBe(true);
    // A new cost produces a new suggestion rather than carrying the old one forward.
    expect(after.suggestedPrice).not.toBe(before.suggestedPrice);
  });

  it('keeps an approved price but says when the cost has overtaken it', async () => {
    const repo = await freshRepo();
    const first = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ casePrice: '24.00', unitsPerCase: 12 })],
      warnings: [],
    });
    await processOrder(repo, provider, first.orderId);
    const row = (await repo.itemsFor(first.orderId))[0]!;
    await repo.approvePrice(row.id, Money.of('3.00'));

    // The supplier doubles the price.
    const second = await repo.createOrder();
    await repo.addPhoto({
      orderId: second.id,
      bytes: photoBytes(),
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });
    provider.queueExtraction({
      supplier: 'JETRO',
      items: [extractedItem({ casePrice: '96.00', unitsPerCase: 12 })],
      warnings: [],
    });
    await processOrder(repo, provider, second.id);

    // The owner's $3.00 stands - it is their price - but it now loses money on every sale.
    expect(Money.fromStorage((await repo.item(row.id))!.approvedPrice!).format()).toBe('$3.00');
    expect((await repo.itemsFor(second.id))[0]!.issues).toContain(APPROVED_PRICE_BELOW_COST);
  });
});

describe('saying which photographs went unread', () => {
  async function orderWith(repo: Repository, count: number): Promise<number> {
    const order = await repo.createOrder();
    for (let i = 0; i < count; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: photoBytes(),
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: 1000 + i,
      });
    }
    return order.id;
  }

  it('names the photographs by the order they were taken in', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 4);
    const provider = new FakeAiProvider();
    // Photos 1 and 2 read; photos 3 and 4 do not come back.
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    provider.queueFailure({ kind: 'timeout' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.outcome).toBe('partial');
    const saved = (await repo.order(orderId))!;
    const failure = saved.warnings.find((w) => /^Photos? \d/.test(w));
    expect(failure).toBeDefined();
    expect(failure).toContain('Photos 3 and 4');
    // The app's own sentence for the failure, so the cause is identifiable later.
    expect(failure).toContain('too long');
  });

  it('keeps one warning per failed group even when the reason is identical', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 4);
    const provider = new FakeAiProvider();
    // Both groups fail the same way. These used to collapse into a single warning, because
    // mergeExtractions puts them through a Set - so a receipt that lost four photographs
    // reported losing two. A timeout is used because it is not retried, so one queued
    // failure is one failed group.
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    provider.queueFailure({ kind: 'timeout' });
    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const bigger = await orderWith(repo, 6);
    const second = new FakeAiProvider();
    second.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    second.queueFailure({ kind: 'timeout' });
    second.queueFailure({ kind: 'timeout' });
    await processOrder(repo, second, bigger, { retryDelayMs: 0 });

    const saved = (await repo.order(bigger))!;
    const failures = saved.warnings.filter((w) => /^Photos? \d/.test(w));
    expect(failures).toHaveLength(2);
    expect(failures.some((w) => w.includes('Photos 3 and 4'))).toBe(true);
    expect(failures.some((w) => w.includes('Photos 5 and 6'))).toBe(true);
  });

  it('says "Photo 7" rather than "Photos" for a group of one', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 7);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });
    provider.queueFailure({ kind: 'timeout' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const saved = (await repo.order(orderId))!;
    const failure = saved.warnings.find((w) => /^Photos? \d/.test(w))!;
    expect(failure).toContain('Photo 7');
    expect(failure).not.toContain('Photos 7');
  });

  it('puts nothing from the receipt or the reply into the warning', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    provider.queueFailure({
      kind: 'serverError',
      status: 500,
      detail: 'INTERNAL: something about the request',
    });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // A first-group failure stops the run, so the reason arrives as the summary instead.
    const text = `${result.summary} ${(await repo.order(orderId))!.warnings.join(' ')}`;
    expect(text).not.toMatch(/AIza/);
    expect(text).not.toMatch(/<html|candidates|inlineData/);
  });

  it('a fully read receipt records no failure warning at all', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });

    await processOrder(repo, provider, orderId);

    const saved = (await repo.order(orderId))!;
    expect(saved.warnings.filter((w) => /^Photos? \d/.test(w))).toHaveLength(0);
  });
});

describe('recovering a reply that was cut off', () => {
  async function orderWith(repo: Repository, count: number): Promise<number> {
    const order = await repo.createOrder();
    for (let i = 0; i < count; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: photoBytes(),
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: 2000 + i,
      });
    }
    return order.id;
  }

  it('reads the photographs one at a time instead of losing the pair', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    // The failure both real receipts hit: the answer ran past one reply.
    provider.queueFailure({ kind: 'truncated' });
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [extractedItem({ rawName: 'FIRST PRODUCT', canonicalName: 'First Product', casePrice: '10.00' })],
      warnings: [],
    });
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [extractedItem({ rawName: 'SECOND PRODUCT', canonicalName: 'Second Product', casePrice: '20.00' })],
      warnings: [],
    });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // Nothing lost, and nothing to apologise for.
    expect(result.outcome).toBe('complete');
    const names = (await repo.itemsFor(orderId)).map((r) => r.rawName).sort();
    expect(names).toEqual(['FIRST PRODUCT', 'SECOND PRODUCT']);
    expect((await repo.order(orderId))!.warnings.filter((w) => /^Photos? \d/.test(w))).toHaveLength(0);
    // One try at the pair, then one at each photograph - the split really happened.
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(3);
  });

  it('keeps the photograph that reads and names the one that does not', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'truncated' });
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [extractedItem({ rawName: 'FIRST PRODUCT', canonicalName: 'First Product', casePrice: '10.00' })],
      warnings: [],
    });
    provider.queueFailure({ kind: 'truncated' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.outcome).toBe('partial');
    expect((await repo.itemsFor(orderId)).map((r) => r.rawName)).toEqual(['FIRST PRODUCT']);
    const failure = (await repo.order(orderId))!.warnings.find((w) => /^Photo 2/.test(w));
    expect(failure).toBeDefined();
    expect(failure).toContain('on its own');
  });

  it('splits once and never again, so a run cannot spin', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    // Everything truncates, always.
    for (let i = 0; i < 10; i += 1) provider.queueFailure({ kind: 'truncated' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // One attempt at the pair, then one at each photograph. Three calls, not a loop.
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(3);
  });

  it('does not store a product twice when the split recovers it', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 2);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'truncated' });
    // The same product read off both photographs, as an overlap would give.
    const shared = extractedItem({ rawName: 'OVERLAPPING PRODUCT', upc: '012345678905' });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [shared], warnings: [] });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [shared], warnings: [] });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const rows = await repo.itemsFor(orderId);
    expect(rows.filter((r) => r.rawName === 'OVERLAPPING PRODUCT')).toHaveLength(1);
  });

  it('stops on a spent quota found during the split instead of blaming the photograph', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 4);
    const provider = new FakeAiProvider();
    // The first pair reads, the second is cut off, and the quota runs out on the split.
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [extractedItem({ rawName: 'FIRST PRODUCT', canonicalName: 'First Product', casePrice: '10.00' })],
      warnings: [],
    });
    provider.queueFailure({ kind: 'truncated' });
    provider.queueFailure({ kind: 'quotaExhausted' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    // The run stopped there - it did not go on to the fourth photograph.
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(3);
    // And the order is exactly as it was found, products and prices untouched.
    expect(await repo.itemsFor(orderId)).toHaveLength(0);
  });

  it('does not split a group of one - there is nothing to split', async () => {
    const repo = await freshRepo();
    const orderId = await orderWith(repo, 1);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'truncated' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(1);
  });
});

describe('the two kinds of failure together', () => {
  async function pairOrder(repo: Repository): Promise<number> {
    const order = await repo.createOrder();
    for (let i = 0; i < 2; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: photoBytes(),
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: 2000 + i,
      });
    }
    return order.id;
  }

  it('costs one group no more than its budget when busy and cut off combine', async () => {
    const repo = await freshRepo();
    const orderId = await pairOrder(repo);
    const provider = new FakeAiProvider();
    // Busy, busy, then cut off - so the retries are spent and the split still happens.
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'truncated' });
    // And the same again for each photograph on its own, if it were allowed.
    for (let i = 0; i < 2; i += 1) {
      provider.queueFailure({ kind: 'overloaded' });
      provider.queueFailure({ kind: 'overloaded' });
      provider.queueFailure({ kind: 'truncated' });
    }

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // Nine requests without a budget. Five with one.
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(
      GROUP_REQUEST_BUDGET,
    );
  });

  it('still reads each photograph once when the pair has used the retries', async () => {
    const repo = await freshRepo();
    const orderId = await pairOrder(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'truncated' });
    // Both photographs read on the one attempt each has left.
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [
        extractedItem({ rawName: 'FIRST PRODUCT', canonicalName: 'First Product', casePrice: '10.00' }),
      ],
      warnings: [],
    });
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [
        extractedItem({ rawName: 'SECOND PRODUCT', canonicalName: 'Second Product', casePrice: '20.00' }),
      ],
      warnings: [],
    });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(result.outcome).toBe('complete');
    const names = (await repo.itemsFor(orderId)).map((r) => r.rawName).sort();
    expect(names).toEqual(['FIRST PRODUCT', 'SECOND PRODUCT']);
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(5);
  });

  it('tells a photograph that stayed busy apart from one that was cut off', async () => {
    const repo = await freshRepo();
    const orderId = await pairOrder(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'truncated' });
    // The first photograph is busy on its one attempt, the second is cut off on its own.
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'truncated' });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // Neither read, and the order is left exactly as it was - not a half-read one.
    expect(result.ok).toBe(false);
    expect(await repo.itemsFor(orderId)).toHaveLength(0);
    expect(provider.calls.filter((c) => c.startsWith('extractOrder')).length).toBeLessThanOrEqual(
      GROUP_REQUEST_BUDGET,
    );
  });

  it('names the busy photograph as busy, not as a reply that was too long', async () => {
    const repo = await freshRepo();
    const order = await repo.createOrder();
    for (let i = 0; i < 4; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: photoBytes(),
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: 2000 + i,
      });
    }
    const provider = new FakeAiProvider();
    // The first pair reads, so there is something to keep.
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [
        extractedItem({ rawName: 'FIRST PRODUCT', canonicalName: 'First Product', casePrice: '10.00' }),
      ],
      warnings: [],
    });
    // The second pair is cut off; photo 3 stays busy, photo 4 reads.
    provider.queueFailure({ kind: 'truncated' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [
        extractedItem({ rawName: 'FOURTH PRODUCT', canonicalName: 'Fourth Product', casePrice: '40.00' }),
      ],
      warnings: [],
    });

    const result = await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    // What read is kept, and the order does not claim to be whole.
    expect(result.outcome).toBe('partial');
    const names = (await repo.itemsFor(order.id)).map((r) => r.rawName).sort();
    expect(names).toEqual(['FIRST PRODUCT', 'FOURTH PRODUCT']);

    // Photo 3 is named, and named as busy - the real reason, not the group's reason.
    const failure = (await repo.order(order.id))!.warnings.find((w) => /^Photo 3/.test(w));
    expect(failure).toBeDefined();
    expect(failure).not.toContain('too long');
    expect(failure!.toLowerCase()).toContain('busy');
  });
});

describe('a model that says it is busy', () => {
  it('is given two more tries before the group is written off', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueFailure({ kind: 'overloaded' });
    provider.queueExtraction({ supplier: 'SUPPLIER', items: [extractedItem()], warnings: [] });

    const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    // The real receipt lost a group to one retry a second and a half later.
    expect(result.ok).toBe(true);
    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(3);
  });

  it('stops after those tries rather than going on for ever', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    for (let i = 0; i < 10; i += 1) provider.queueFailure({ kind: 'overloaded' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(3);
  });

  it('still does not re-send a request that ran out of time', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'timeout' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(1);
  });

  it('gives a rejected key no retries at all', async () => {
    const repo = await freshRepo();
    const { orderId } = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueFailure({ kind: 'invalidKey' });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    expect(provider.calls.filter((c) => c.startsWith('extractOrder'))).toHaveLength(1);
  });
});
