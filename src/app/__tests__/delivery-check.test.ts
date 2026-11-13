import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { OrderImageType } from '../../core/ai-types';
import { DeliveryStatus } from '../../core/delivery';
import { Money } from '../../core/money';
import { Category, ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { MessageRole } from '../../data/schema';
import { checkDelivery } from '../delivery-check';

let dbCounter = 2000;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`delivery-db-${dbCounter}`);
}

async function seedOrder(
  repo: Repository,
  rows: Array<{ name: string; size: string | null; cases: number }>,
): Promise<number> {
  const order = await repo.createOrder();
  await repo.addItems(
    rows.map((row) => ({
      orderId: order.id,
      productId: null,
      rawName: row.name,
      displayName: row.name,
      size: row.size,
      upc: null,
      supplierSku: null,
      category: Category.BEER,
      casePrice: Money.of('30.00').toStorage(),
      unitsPerCase: 24,
      casesPurchased: row.cases,
      looseUnits: 0,
      discount: null,
      trueUnitCost: Money.of('1.25').toStorage(),
      totalWholesaleCost: Money.of('30.00').times(row.cases).toStorage(),
      suggestedPrice: Money.of('2.99').toStorage(),
      pricingSource: PricingSource.COST_TIER,
      pricingRationale: 'Cost tier.',
      approvedPrice: null,
      previousPrice: null,
      confidence: ItemConfidence.HIGH,
      aiConfidence: 0.9,
      issues: [],
      sourcePhotoIds: [],
      sourceText: [],
    })),
  );
  return order.id;
}

async function deliveryPhoto(repo: Repository, orderId: number): Promise<number> {
  const photo = await repo.addPhoto({
    orderId,
    bytes: new Uint8Array([9, 9, 9]).buffer,
    mimeType: 'image/jpeg',
    type: OrderImageType.PRODUCT_PHOTO,
    isDeliveryPhoto: true,
    createdAt: Date.now(),
  });
  return photo.id;
}

describe('checkDelivery', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('confirms a delivery that is all there', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 8 }]);
    const photoId = await deliveryPhoto(repo, orderId);
    const provider = new FakeAiProvider().queueCaseCount({
      sightings: [
        {
          brand: 'BUDWEISER',
          productName: null,
          size: '24 CT',
          packDescription: null,
          countedCases: 8,
          mayBeHidden: false,
          confidence: 0.9,
          sourcePhotoIds: [photoId],
        },
      ],
      warnings: [],
    });

    const result = await checkDelivery(repo, provider, orderId, [photoId]);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('1 confirmed.');
    expect(result.reconciliation!.lines[0]!.status).toBe(DeliveryStatus.CONFIRMED);
  });

  it('asks for another photo instead of accusing the supplier', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 8 }]);
    const photoId = await deliveryPhoto(repo, orderId);
    const provider = new FakeAiProvider().queueCaseCount({
      sightings: [
        {
          brand: 'BUDWEISER',
          productName: null,
          size: '24 CT',
          packDescription: '24-pack',
          countedCases: 7,
          mayBeHidden: true,
          confidence: 0.9,
          sourcePhotoIds: [photoId],
        },
      ],
      warnings: [],
    });

    const result = await checkDelivery(repo, provider, orderId, [photoId]);

    const line = result.reconciliation!.lines[0]!;
    expect(line.status).toBe(DeliveryStatus.POSSIBLY_MISSING);
    expect(line.needsAnotherPhoto).toBe(true);
    const message = (await repo.conversation(orderId)).at(-1)!;
    expect(message.role).toBe(MessageRole.APP);
    expect(message.text).toContain('possibly short');
    expect(message.text).toContain('take another photo');
  });

  it('saves the check against the order so it can be looked at later', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 4 }]);
    const photoId = await deliveryPhoto(repo, orderId);
    const provider = new FakeAiProvider().queueCaseCount({
      sightings: [
        {
          brand: 'BUDWEISER',
          productName: null,
          size: '24 CT',
          packDescription: null,
          countedCases: 4,
          mayBeHidden: false,
          confidence: 0.88,
          sourcePhotoIds: [photoId],
        },
      ],
      warnings: [],
    });

    await checkDelivery(repo, provider, orderId, [photoId]);

    const saved = await repo.deliveryChecksFor(orderId);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.lines[0]!.countedCases).toBe(4);
    expect((await repo.order(orderId))!.deliveryCheckedAt).not.toBeNull();
  });

  it('names what still has to be photographed instead of calling it missing', async () => {
    const orderId = await seedOrder(repo, [
      { name: 'BUDWEISER', size: '24 CT', cases: 4 },
      { name: 'CORONA', size: '12 CT', cases: 2 },
    ]);
    const photoId = await deliveryPhoto(repo, orderId);
    const provider = new FakeAiProvider().queueCaseCount({
      sightings: [
        {
          brand: 'BUDWEISER',
          productName: null,
          size: '24 CT',
          packDescription: null,
          countedCases: 4,
          mayBeHidden: false,
          confidence: 0.9,
          sourcePhotoIds: [photoId],
        },
      ],
      warnings: [],
    });

    const result = await checkDelivery(repo, provider, orderId, [photoId]);

    const message = (await repo.conversation(orderId)).at(-1)!;
    expect(message.text).toContain('Still to photograph: CORONA');
    expect(result.reconciliation!.notPhotographed).toBe(1);
  });

  it('does not treat a failed count as an empty delivery', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 8 }]);
    const photoId = await deliveryPhoto(repo, orderId);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    const result = await checkDelivery(repo, provider, orderId, [photoId]);

    expect(result.ok).toBe(false);
    expect(result.reconciliation).toBeNull();
    expect(result.summary).toContain('will not charge you');
    expect(await repo.deliveryChecksFor(orderId)).toHaveLength(0);
  });

  it('will not check a delivery before the receipt has been read', async () => {
    const order = await repo.createOrder();
    const photoId = await deliveryPhoto(repo, order.id);
    const provider = new FakeAiProvider();

    const result = await checkDelivery(repo, provider, order.id, [photoId]);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Process the receipt first');
    expect(provider.calls).toHaveLength(0);
  });

  it('asks for a photo when none was taken', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 8 }]);
    const provider = new FakeAiProvider();

    const result = await checkDelivery(repo, provider, orderId, []);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Take a photo');
    expect(provider.calls).toHaveLength(0);
  });

  it('counts photos in small batches', async () => {
    const orderId = await seedOrder(repo, [{ name: 'BUDWEISER', size: '24 CT', cases: 8 }]);
    const ids = [
      await deliveryPhoto(repo, orderId),
      await deliveryPhoto(repo, orderId),
      await deliveryPhoto(repo, orderId),
    ];
    const provider = new FakeAiProvider();

    await checkDelivery(repo, provider, orderId, ids);

    const calls = provider.calls.filter((c) => c.startsWith('countCases'));
    expect(calls).toHaveLength(2);
  });
});
