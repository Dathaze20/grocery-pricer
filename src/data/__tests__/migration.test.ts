import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '../../core/money';
import { Category } from '../../core/models';
import { resetDbHandle } from '../db';
import { Repository } from '../repository';
import { OrderStatus, SettingKey } from '../schema';

/**
 * Upgrading a shop that has been using the app since version 1.
 *
 * Built the way version 1 really built it - the same stores, the same indexes, the same record
 * shapes, and with no `aliases`, `variant` or `supplierSku` on a product, because those did not
 * exist yet. Then opened at version 2 through the ordinary code path.
 *
 * Everything is invented. The point is the shape, not the prices.
 */

const V1_STORES = [
  { name: 'orders', indexes: ['createdAt', 'status'] },
  { name: 'photos', indexes: ['orderId'] },
  { name: 'items', indexes: ['orderId', 'productId'] },
  { name: 'products', indexes: ['normalizedName', 'upc'] },
  { name: 'priceHistory', indexes: ['productId', 'recordedAt'] },
  { name: 'messages', indexes: ['orderId'] },
  { name: 'deliveryChecks', indexes: ['orderId'] },
];

/** Creates a version-1 database exactly as version 1 did, and fills it with a shop's work. */
async function buildVersionOne(name: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const created = request.result;
      for (const store of V1_STORES) {
        const objectStore = created.createObjectStore(store.name, {
          keyPath: 'id',
          autoIncrement: true,
        });
        for (const index of store.indexes) objectStore.createIndex(index, index);
      }
      created.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const put = async (store: string, value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const request = tx.objectStore(store).add(value as never);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

  await put('settings', { key: SettingKey.GEMINI_API_KEY, value: 'AIzaKeyFromVersionOne' });
  await put('settings', { key: SettingKey.GEMINI_MODEL, value: 'gemini-2.0-flash' });

  await put('orders', {
    id: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    supplier: 'EXAMPLE WHOLESALE',
    status: OrderStatus.READY,
    failureMessage: null,
    totalWholesaleCost: Money.of('54.00').toStorage(),
    itemCount: 1,
    warnings: [],
    deliveryCheckedAt: null,
  });

  // A version-1 product: no aliases, no variant, no supplier number.
  await put('products', {
    id: 1,
    normalizedName: 'EXAMPLE CORN OIL',
    displayName: 'Example Corn Oil',
    size: '48 OZ',
    upc: '012345678905',
    category: Category.OTHER,
    lastCost: Money.of('5.00').toStorage(),
    lastRetailPrice: Money.of('8.99').toStorage(),
    overridePrice: null,
    timesSeen: 3,
    lastSeenAt: 1_700_000_000_000,
  });

  await put('items', {
    id: 1,
    orderId: 1,
    productId: 1,
    rawName: 'EXMPL CORN OIL 48Z',
    displayName: 'Example Corn Oil',
    size: '48 OZ',
    upc: '012345678905',
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
    pricingSource: 'COST_TIER',
    pricingRationale: 'Cost tier.',
    approvedPrice: Money.of('8.99').toStorage(),
    previousPrice: null,
    confidence: 'HIGH',
    aiConfidence: 0.9,
    issues: [],
    sourcePhotoIds: [1],
    sourceText: ['EXMPL CORN OIL 48Z 30.00'],
  });

  await put('priceHistory', {
    id: 1,
    productId: 1,
    orderId: 1,
    unitCost: Money.of('5.00').toStorage(),
    retailPrice: Money.of('8.99').toStorage(),
    recordedAt: 1_700_000_000_000,
    note: null,
  });

  await put('messages', {
    id: 1,
    orderId: 1,
    role: 'APP',
    text: '1 product, $30.00 wholesale.',
    photoId: null,
    referencedItemIds: [],
    createdAt: 1_700_000_000_000,
  });

  db.close();
}

let counter = 5000;

describe('upgrading a version-1 database', () => {
  let name: string;

  beforeEach(async () => {
    resetDbHandle();
    counter += 1;
    name = `migration-db-${counter}`;
    await buildVersionOne(name);
  });

  it('keeps the API key', async () => {
    const repo = await Repository.open(name);
    expect(await repo.apiKey()).toBe('AIzaKeyFromVersionOne');
    expect(await repo.model()).toBe('gemini-2.0-flash');
  });

  it('keeps the orders, their items and their conversation', async () => {
    const repo = await Repository.open(name);

    const order = await repo.order(1);
    expect(order?.supplier).toBe('EXAMPLE WHOLESALE');
    expect(Money.fromStorage(order!.totalWholesaleCost).format()).toBe('$54.00');

    const items = await repo.itemsFor(1);
    expect(items).toHaveLength(1);
    expect(Money.fromStorage(items[0]!.approvedPrice!).format()).toBe('$8.99');

    expect(await repo.conversation(1)).toHaveLength(1);
  });

  it('keeps the products and their price history', async () => {
    const repo = await Repository.open(name);

    const product = await repo.product(1);
    expect(product?.displayName).toBe('Example Corn Oil');
    expect(Money.fromStorage(product!.lastRetailPrice!).format()).toBe('$8.99');
    expect(await repo.historyFor(1)).toHaveLength(1);
  });

  it('matches a version-1 product that has no aliases field at all', async () => {
    const repo = await Repository.open(name);

    // The lookup reads product.aliases. On a row written before that field existed it is
    // undefined, and reading it as a list would throw and take the whole lookup with it.
    const found = await repo.findOrCreateProduct({
      displayName: 'Example Corn Oil',
      size: '48 OZ',
      upc: null,
      receiptName: 'EXMPL CORN OIL 48Z',
    });

    expect(found.id).toBe(1);
    expect(found.timesSeen).toBe(4);
  });

  it('matches a version-1 product by its barcode and can then learn its abbreviation', async () => {
    const repo = await Repository.open(name);

    const found = await repo.findOrCreateProduct({
      displayName: 'EXMPL CORN OIL 48Z',
      size: null,
      upc: '012345678905',
      receiptName: 'EXMPL CORN OIL 48Z',
    });

    expect(found.id).toBe(1);
    expect(found.aliases).toContain('EXMPL CORN OIL');
  });

  it('creates nothing and deletes nothing during the upgrade', async () => {
    const repo = await Repository.open(name);

    expect(await repo.recentOrders()).toHaveLength(1);
    const all = await repo.itemsFor(1);
    expect(all).toHaveLength(1);
    // The upgrade adds an index; it does not rewrite rows, so the old record is untouched.
    expect(all[0]!.rawName).toBe('EXMPL CORN OIL 48Z');
  });

  it('can still save new work after the upgrade', async () => {
    const repo = await Repository.open(name);

    const order = await repo.createOrder();
    expect(order.id).toBe(2);

    const product = await repo.findOrCreateProduct({
      displayName: 'Example Beans',
      size: '15 OZ',
      upc: null,
      supplierSku: 'SKU-900',
    });
    expect(product.id).toBe(2);

    const again = await repo.findOrCreateProduct({
      displayName: 'EXMPL BEANS',
      size: null,
      upc: null,
      supplierSku: 'SKU-900',
    });
    expect(again.id).toBe(product.id);
  });
});
