import { beforeEach, describe, expect, it } from 'vitest';
import { OrderImageType } from '../../core/ai-types';
import { resetDbHandle } from '../db';
import { Repository } from '../repository';
import { Money } from '../../core/money';
import { Category, ItemConfidence } from '../../core/models';
import { OrderStatus } from '../schema';

let dbCounter = 3000;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`repo-db-${dbCounter}`);
}

describe('deleteEmptyDrafts', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('removes a draft nobody put a photo in', async () => {
    const abandoned = await repo.createOrder();

    expect(await repo.deleteEmptyDrafts()).toBe(1);
    expect(await repo.order(abandoned.id)).toBeNull();
  });

  it('keeps a draft that has photos in it', async () => {
    const started = await repo.createOrder();
    await repo.addPhoto({
      orderId: started.id,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'image/jpeg',
      type: OrderImageType.UNKNOWN,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });

    // Work in progress, not litter: the shopkeeper photographed a receipt and walked away.
    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect(await repo.order(started.id)).not.toBeNull();
  });

  it('never touches an order that was processed', async () => {
    const done = await repo.createOrder();
    await repo.updateOrder(done.id, { status: OrderStatus.READY, itemCount: 3 });

    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect((await repo.order(done.id))?.status).toBe(OrderStatus.READY);
  });

  it('leaves a failed order alone so its reason can still be read', async () => {
    const failed = await repo.createOrder();
    await repo.updateOrder(failed.id, {
      status: OrderStatus.FAILED,
      failureMessage: 'Free Gemini quota reached.',
    });

    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect((await repo.order(failed.id))?.failureMessage).toContain('quota');
  });

  it('clears several at once and leaves the rest of the list intact', async () => {
    await repo.createOrder();
    await repo.createOrder();
    const kept = await repo.createOrder();
    await repo.updateOrder(kept.id, { status: OrderStatus.READY });

    expect(await repo.deleteEmptyDrafts()).toBe(2);
    expect((await repo.recentOrders()).map((o) => o.id)).toEqual([kept.id]);
  });
});

/**
 * Local product memory.
 *
 * Everything here is invented. The shapes are receipt-shaped because that is what has to work;
 * no real supplier prices or pricing decisions live in this repository.
 */
describe('finding a product again', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('starts with nothing: a new shop has no catalogue at all', async () => {
    expect(await repo.product(1)).toBeNull();
  });

  it('recognises a barcode whatever the name was read as', async () => {
    const first = await repo.findOrCreateProduct({
      displayName: 'Example Mayonnaise',
      size: '8 OZ',
      upc: '012345678905',
    });

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMPL MAYO',
      size: '8 0Z',
      upc: '012345678905',
    });

    expect(again.id).toBe(first.id);
    expect(again.timesSeen).toBe(2);
  });

  it("recognises the supplier's own item number", async () => {
    const first = await repo.findOrCreateProduct({
      displayName: 'Example Cleaner',
      size: '32 OZ',
      upc: null,
      supplierSku: 'SKU-55120',
    });

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMPL CLNR 32Z',
      size: null,
      upc: null,
      supplierSku: 'SKU-55120',
    });

    expect(again.id).toBe(first.id);
  });

  it('does not take an unconfirmed abbreviation as proof of identity', async () => {
    const created = await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: null,
      receiptName: 'EXMP EVAP MILK 12Z',
    });

    // Nothing confirmed that this expansion was right, so the abbreviation is not learned and
    // cannot later vouch for a different product on its own.
    expect(created.aliases).toEqual([]);
  });

  it('learns an abbreviation when a barcode proves the match', async () => {
    const created = await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: '012345678905',
    });

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMP EVAP MILK 12Z',
      size: null,
      upc: '012345678905',
      receiptName: 'EXMP EVAP MILK 12Z',
    });

    expect(again.id).toBe(created.id);
    expect(again.aliases).toContain('EXMP EVAP MILK');

    // And from then on the abbreviation alone finds it, with no barcode printed.
    const third = await repo.findOrCreateProduct({
      displayName: 'EXMP EVAP MILK 12Z',
      size: null,
      upc: null,
      receiptName: 'EXMP EVAP MILK 12Z',
    });
    expect(third.id).toBe(created.id);
  });

  it('remembers the abbreviation when a price is approved', async () => {
    const product = await repo.findOrCreateProduct({
      displayName: 'Example Oil',
      size: '48 OZ',
      upc: null,
    });
    const order = await repo.createOrder();
    const [item] = await repo.addItems([
      {
        orderId: order.id,
        productId: product.id,
        rawName: 'EXMPL OIL 48Z',
        displayName: 'Example Oil',
        size: '48 OZ',
        upc: null,
        supplierSku: null,
        category: Category.OTHER,
        casePrice: Money.of('30.00').toStorage(),
        unitsPerCase: 6,
        casesPurchased: 1,
        looseUnits: 0,
        discount: null,
        trueUnitCost: Money.of('5.00').toStorage(),
        totalWholesaleCost: Money.of('30.00').toStorage(),
        suggestedPrice: Money.of('8.99').toStorage(),
        pricingSource: null,
        pricingRationale: null,
        approvedPrice: null,
        previousPrice: null,
        confidence: ItemConfidence.HIGH,
        aiConfidence: 0.9,
        issues: [],
        sourcePhotoIds: [],
        sourceText: [],
      },
    ]);

    await repo.approvePrice(item!.id, Money.of('9.49'));

    const found = await repo.findOrCreateProduct({
      displayName: 'EXMPL OIL 48Z',
      size: null,
      upc: null,
      receiptName: 'EXMPL OIL 48Z',
    });
    expect(found.id).toBe(product.id);
    expect(Money.fromStorage(found.lastRetailPrice!).format()).toBe('$9.49');
  });

  it('never merges two sizes of the same product', async () => {
    const small = await repo.findOrCreateProduct({ displayName: 'Example Detergent', size: '25 OZ', upc: null });
    const large = await repo.findOrCreateProduct({ displayName: 'Example Detergent', size: '40 OZ', upc: null });

    expect(large.id).not.toBe(small.id);
  });

  it('never merges two variants of the same product', async () => {
    const lemon = await repo.findOrCreateProduct({
      displayName: 'Example Cleaner',
      size: '16 OZ',
      upc: null,
      variant: 'Lemon',
    });
    const lavender = await repo.findOrCreateProduct({
      displayName: 'Example Cleaner',
      size: '16 OZ',
      upc: null,
      variant: 'Lavender',
    });

    expect(lavender.id).not.toBe(lemon.id);
  });

  it('does not merge two products whose names merely look alike', async () => {
    const first = await repo.findOrCreateProduct({ displayName: 'Example Tide', size: '25 OZ', upc: null });
    const second = await repo.findOrCreateProduct({ displayName: 'Example Tidy', size: '25 OZ', upc: null });

    expect(second.id).not.toBe(first.id);
  });

  it('keeps the price history of a product across orders', async () => {
    const product = await repo.findOrCreateProduct({ displayName: 'Example Beans', size: '15 OZ', upc: null });

    await repo.recordPrice(product.id, null, Money.of('1.10').toStorage(), Money.of('2.49').toStorage());
    await repo.recordPrice(product.id, null, Money.of('1.25').toStorage(), Money.of('2.49').toStorage());

    const history = await repo.historyFor(product.id);
    expect(history).toHaveLength(2);
    // Newest first: a new receipt sets the new cost, it does not erase the old one.
    expect(Money.fromStorage(history[0]!.unitCost!).format()).toBe('$1.25');
    expect(Money.fromStorage(history[1]!.unitCost!).format()).toBe('$1.10');
  });
});
