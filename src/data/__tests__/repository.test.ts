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

describe('an abbreviation must not merge two different packs', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('keeps two sizes apart even when the receipt prints the same shorthand', async () => {
    const small = await repo.findOrCreateProduct({
      displayName: "Hellmann's Mayonnaise",
      size: '8 OZ',
      upc: '012345678905',
    });
    // Seen again with its barcode printed, which is what proves the abbreviation is its.
    const learned = await repo.findOrCreateProduct({
      displayName: "Hellmann's Mayonnaise",
      size: '8 OZ',
      upc: '012345678905',
      receiptName: 'HELLM MAYO',
    });
    expect(learned.id).toBe(small.id);
    expect(learned.aliases).toContain('HELLM MAYO');

    // A later delivery of the big jar, printed with the very same shorthand.
    const large = await repo.findOrCreateProduct({
      displayName: "Hellmann's Mayonnaise",
      size: '40 OZ',
      upc: null,
      receiptName: 'HELLM MAYO',
    });

    // Two products. Sharing one would give the 40oz the 8oz's approved selling price.
    expect(large.id).not.toBe(small.id);
    expect(large.size).toBe('40 OZ');
    expect((await repo.findOrCreateProduct({
      displayName: "Hellmann's Mayonnaise",
      size: '8 OZ',
      upc: null,
      receiptName: 'HELLM MAYO',
    })).id).toBe(small.id);
  });

  it('keeps two variants apart under a shared abbreviation', async () => {
    const lemon = await repo.findOrCreateProduct({
      displayName: 'Example Dish Soap',
      size: '25 OZ',
      variant: 'Lemon',
      upc: '012345678905',
    });
    await repo.findOrCreateProduct({
      displayName: 'Example Dish Soap',
      size: '25 OZ',
      variant: 'Lemon',
      upc: '012345678905',
      receiptName: 'EXMP DISH SOAP',
    });
    const lavender = await repo.findOrCreateProduct({
      displayName: 'Example Dish Soap',
      size: '25 OZ',
      variant: 'Lavender',
      upc: null,
      receiptName: 'EXMP DISH SOAP',
    });

    expect(lavender.id).not.toBe(lemon.id);
  });

  it('still finds the product when the receipt prints no size at all', async () => {
    // The abbreviation was proved by a barcode. A line that simply does not say the size is
    // not a reason to throw that away and start a second product.
    const created = await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: '012345678905',
    });
    await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: '012345678905',
      receiptName: 'EXMP EVAP MILK',
    });

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMP EVAP MILK',
      size: null,
      upc: null,
      receiptName: 'EXMP EVAP MILK',
    });

    expect(again.id).toBe(created.id);
  });

  it('ignores spacing and case when deciding whether sizes disagree', async () => {
    const created = await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: '012345678905',
    });
    await repo.findOrCreateProduct({
      displayName: 'Example Evaporated Milk',
      size: '12 OZ',
      upc: '012345678905',
      receiptName: 'EXMP EVAP MILK',
    });

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMP EVAP MILK',
      size: ' 12 oz ',
      upc: null,
      receiptName: 'EXMP EVAP MILK',
    });

    // The same pack written two ways is one product, not two.
    expect(again.id).toBe(created.id);
  });
});

describe('deleting one order', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  /** An order with a photograph, a product row and a message - the whole shape of a real one. */
  async function orderWithContents(name: string): Promise<number> {
    const order = await repo.createOrder();
    await repo.addPhoto({
      orderId: order.id,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'image/jpeg',
      type: OrderImageType.RECEIPT,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });
    const product = await repo.findOrCreateProduct({
      displayName: name,
      receiptName: name,
      size: '12 CT',
      upc: null,
      category: Category.OTHER,
    });
    await repo.addItems([
      {
        orderId: order.id,
        productId: product.id,
        rawName: name,
        displayName: name,
        size: '12 CT',
        upc: null,
        supplierSku: null,
        category: Category.OTHER,
        casePrice: Money.of('24.00').toStorage(),
        unitsPerCase: 12,
        casesPurchased: 1,
        looseUnits: 0,
        discount: null,
        trueUnitCost: Money.of('2.00').toStorage(),
        totalWholesaleCost: Money.of('24.00').toStorage(),
        suggestedPrice: Money.of('3.99').toStorage(),
        pricingSource: null,
        pricingRationale: null,
        approvedPrice: Money.of('3.79').toStorage(),
        previousPrice: null,
        confidence: ItemConfidence.HIGH,
        aiConfidence: 0.9,
        issues: [],
        sourcePhotoIds: [],
        sourceText: [],
      },
    ]);
    await repo.recordPrice(product.id, order.id, Money.of('2.00').toStorage(), Money.of('3.79').toStorage());
    return order.id;
  }

  it('removes the one that was chosen and nothing else', async () => {
    const keep = await orderWithContents('KEEP ME');
    const remove = await orderWithContents('REMOVE ME');

    await repo.deleteOrder(remove);

    expect(await repo.order(remove)).toBeNull();
    expect(await repo.order(keep)).not.toBeNull();
    expect(await repo.itemsFor(keep)).toHaveLength(1);
    expect(await repo.photosFor(keep)).toHaveLength(1);
  });

  it('takes that order\'s photographs and rows with it, and no others', async () => {
    const keep = await orderWithContents('KEEP ME');
    const remove = await orderWithContents('REMOVE ME');

    await repo.deleteOrder(remove);

    expect(await repo.itemsFor(remove)).toHaveLength(0);
    expect(await repo.photosFor(remove)).toHaveLength(0);
    expect(await repo.photosFor(keep)).toHaveLength(1);
  });

  it('leaves what the shop knows about its products alone', async () => {
    const remove = await orderWithContents('REMOVE ME');
    const productId = (await repo.itemsFor(remove))[0]!.productId;
    expect(productId).not.toBeNull();
    const historyBefore = await repo.historyFor(productId!);

    await repo.deleteOrder(remove);

    // The product and what it last cost are the shop's memory, not the order's. A receipt
    // thrown away does not unlearn the product that was on it.
    expect(await repo.product(productId!)).not.toBeNull();
    expect(await repo.historyFor(productId!)).toEqual(historyBefore);
  });

  it('leaves the settings and the saved key untouched', async () => {
    const remove = await orderWithContents('REMOVE ME');
    await repo.putSetting('geminiApiKey', 'not-a-real-key');

    await repo.deleteOrder(remove);

    expect(await repo.setting('geminiApiKey')).toBe('not-a-real-key');
  });

  it('drops out of the recent list at once', async () => {
    const keep = await orderWithContents('KEEP ME');
    const remove = await orderWithContents('REMOVE ME');
    expect((await repo.recentOrders(10)).map((o) => o.id)).toContain(remove);

    await repo.deleteOrder(remove);

    const listed = (await repo.recentOrders(10)).map((o) => o.id);
    expect(listed).not.toContain(remove);
    expect(listed).toContain(keep);
  });

  it('deleting one of three leaves the other two whole', async () => {
    const first = await orderWithContents('FIRST');
    const second = await orderWithContents('SECOND');
    const third = await orderWithContents('THIRD');

    await repo.deleteOrder(second);

    expect(await repo.order(first)).not.toBeNull();
    expect(await repo.order(third)).not.toBeNull();
    expect(await repo.itemsFor(first)).toHaveLength(1);
    expect(await repo.itemsFor(third)).toHaveLength(1);
    expect(await repo.order(second)).toBeNull();
  });
});
