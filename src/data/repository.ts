import type { IDBPDatabase } from 'idb';
import { Money } from '../core/money';
import { NameNormalizer } from '../core/matching';
import { Category, guessCategory } from '../core/models';
import { openGroceryDb, type GroceryDb } from './db';
import {
  DB_NAME,
  MessageRole,
  OrderStatus,
  SettingKey,
  type StoredDeliveryCheck,
  type StoredItem,
  type StoredMessage,
  type StoredOrder,
  type StoredPhoto,
  type StoredPriceHistory,
  type StoredProduct,
} from './schema';

/**
 * Every read and write the app makes.
 *
 * The database is the authority. A model may claim a case cost $41.99; what is stored is what the
 * shopkeeper confirmed, and what is read back later is the stored value - never a fresh guess.
 */
export class Repository {
  private constructor(private readonly db: IDBPDatabase<GroceryDb>) {}

  static async open(name: string = DB_NAME): Promise<Repository> {
    return new Repository(await openGroceryDb(name));
  }

  close(): void {
    this.db.close();
  }

  // --- settings -------------------------------------------------------------

  async setting<T>(key: string): Promise<T | null> {
    const row = await this.db.get('settings', key);
    return row === undefined ? null : (row.value as T);
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    await this.db.put('settings', { key, value });
  }

  /**
   * The user's own Gemini key.
   *
   * It is read at the moment of a call and handed straight to the client. It is never copied into
   * a module-level variable, never logged, and never included in an order export.
   */
  async apiKey(): Promise<string | null> {
    const stored = await this.setting<string>(SettingKey.GEMINI_API_KEY);
    const trimmed = stored?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  }

  async setApiKey(key: string | null): Promise<void> {
    const trimmed = key?.trim() ?? '';
    if (trimmed.length === 0) {
      await this.db.delete('settings', SettingKey.GEMINI_API_KEY);
      return;
    }
    await this.putSetting(SettingKey.GEMINI_API_KEY, trimmed);
  }

  async model(): Promise<string | null> {
    return this.setting<string>(SettingKey.GEMINI_MODEL);
  }

  async setModel(model: string | null): Promise<void> {
    await this.putSetting(SettingKey.GEMINI_MODEL, model?.trim() ?? '');
  }

  // --- orders ---------------------------------------------------------------

  async createOrder(): Promise<StoredOrder> {
    const now = Date.now();
    const draft: Omit<StoredOrder, 'id'> = {
      createdAt: now,
      updatedAt: now,
      supplier: null,
      status: OrderStatus.DRAFT,
      failureMessage: null,
      totalWholesaleCost: 0,
      itemCount: 0,
      warnings: [],
      deliveryCheckedAt: null,
    };
    const id = await this.db.add('orders', draft as StoredOrder);
    return { ...draft, id };
  }

  async order(id: number): Promise<StoredOrder | null> {
    return (await this.db.get('orders', id)) ?? null;
  }

  async recentOrders(limit = 20): Promise<StoredOrder[]> {
    const all = await this.db.getAllFromIndex('orders', 'createdAt');
    return all.reverse().slice(0, limit);
  }

  async updateOrder(id: number, patch: Partial<StoredOrder>): Promise<StoredOrder | null> {
    const existing = await this.db.get('orders', id);
    if (existing === undefined) return null;
    const updated = { ...existing, ...patch, id, updatedAt: Date.now() };
    await this.db.put('orders', updated);
    return updated;
  }

  /** Deletes an order and everything hanging off it, photos included. */
  async deleteOrder(id: number): Promise<void> {
    const tx = this.db.transaction(['orders', 'photos', 'items', 'messages', 'deliveryChecks'], 'readwrite');
    await Promise.all([
      tx.objectStore('orders').delete(id),
      deleteByIndex(tx.objectStore('photos').index('orderId'), id),
      deleteByIndex(tx.objectStore('items').index('orderId'), id),
      deleteByIndex(tx.objectStore('messages').index('orderId'), id),
      deleteByIndex(tx.objectStore('deliveryChecks').index('orderId'), id),
      tx.done,
    ]);
  }

  // --- photos ---------------------------------------------------------------

  async addPhoto(photo: Omit<StoredPhoto, 'id'>): Promise<StoredPhoto> {
    const id = await this.db.add('photos', photo as StoredPhoto);
    return { ...photo, id };
  }

  async photosFor(orderId: number, includeDelivery = true): Promise<StoredPhoto[]> {
    const all = await this.db.getAllFromIndex('photos', 'orderId', orderId);
    return includeDelivery ? all : all.filter((p) => !p.isDeliveryPhoto);
  }

  async photo(id: number): Promise<StoredPhoto | null> {
    return (await this.db.get('photos', id)) ?? null;
  }

  async deletePhoto(id: number): Promise<void> {
    await this.db.delete('photos', id);
  }

  // --- items ----------------------------------------------------------------

  async addItems(items: ReadonlyArray<Omit<StoredItem, 'id'>>): Promise<StoredItem[]> {
    const tx = this.db.transaction('items', 'readwrite');
    const saved: StoredItem[] = [];
    for (const item of items) {
      const id = await tx.store.add(item as StoredItem);
      saved.push({ ...item, id });
    }
    await tx.done;
    return saved;
  }

  async itemsFor(orderId: number): Promise<StoredItem[]> {
    return this.db.getAllFromIndex('items', 'orderId', orderId);
  }

  async item(id: number): Promise<StoredItem | null> {
    return (await this.db.get('items', id)) ?? null;
  }

  async updateItem(id: number, patch: Partial<StoredItem>): Promise<StoredItem | null> {
    const existing = await this.db.get('items', id);
    if (existing === undefined) return null;
    const updated = { ...existing, ...patch, id };
    await this.db.put('items', updated);
    return updated;
  }

  /**
   * Records the price the shopkeeper decided on.
   *
   * This is the only way an approved price is ever set, and it writes the product and the price
   * history in the same breath - so the next order can say "you sold this at $4.99 last time"
   * without anyone having to remember.
   */
  async approvePrice(itemId: number, price: Money): Promise<StoredItem | null> {
    const item = await this.item(itemId);
    if (item === null) return null;

    const updated = await this.updateItem(itemId, { approvedPrice: price.toStorage() });
    if (item.productId !== null) {
      await this.recordPrice(item.productId, item.orderId, item.trueUnitCost, price.toStorage());
      const product = await this.db.get('products', item.productId);
      if (product !== undefined) {
        await this.db.put('products', { ...product, lastRetailPrice: price.toStorage() });
      }
    }
    return updated;
  }

  // --- products and history -------------------------------------------------

  /**
   * Finds the product a receipt line refers to, or creates it.
   *
   * A barcode is definitive when there is one. Otherwise a product is the same product when its
   * normalised name and its size both agree - name alone would merge Tide 25 oz into Tide 40 oz,
   * and then quote the wrong cost for both.
   */
  async findOrCreateProduct(input: {
    displayName: string;
    size: string | null;
    upc: string | null;
    category?: Category;
  }): Promise<StoredProduct> {
    const normalized = NameNormalizer.normalize(input.displayName);
    const upc = input.upc?.trim() ?? '';

    if (upc.length > 0) {
      const byUpc = await this.db.getFromIndex('products', 'upc', upc);
      if (byUpc !== undefined) return this.touchProduct(byUpc);
    }

    const candidates = await this.db.getAllFromIndex('products', 'normalizedName', normalized);
    const match = candidates.find((c) => (c.size ?? null) === (input.size ?? null));
    if (match !== undefined) return this.touchProduct(match);

    const now = Date.now();
    const created: Omit<StoredProduct, 'id'> = {
      normalizedName: normalized,
      displayName: input.displayName,
      size: input.size,
      upc: upc.length > 0 ? upc : null,
      category: input.category ?? guessCategory(input.displayName),
      lastCost: null,
      lastRetailPrice: null,
      overridePrice: null,
      timesSeen: 1,
      lastSeenAt: now,
    };
    const id = await this.db.add('products', created as StoredProduct);
    return { ...created, id };
  }

  private async touchProduct(product: StoredProduct): Promise<StoredProduct> {
    const updated = { ...product, timesSeen: product.timesSeen + 1, lastSeenAt: Date.now() };
    await this.db.put('products', updated);
    return updated;
  }

  async product(id: number): Promise<StoredProduct | null> {
    return (await this.db.get('products', id)) ?? null;
  }

  async updateProduct(id: number, patch: Partial<StoredProduct>): Promise<StoredProduct | null> {
    const existing = await this.db.get('products', id);
    if (existing === undefined) return null;
    const updated = { ...existing, ...patch, id };
    await this.db.put('products', updated);
    return updated;
  }

  async recordPrice(
    productId: number,
    orderId: number | null,
    unitCost: number | null,
    retailPrice: number | null,
    note: string | null = null,
  ): Promise<StoredPriceHistory> {
    const row: Omit<StoredPriceHistory, 'id'> = {
      productId,
      orderId,
      unitCost,
      retailPrice,
      recordedAt: Date.now(),
      note,
    };
    const id = await this.db.add('priceHistory', row as StoredPriceHistory);
    return { ...row, id };
  }

  /** Newest first, so "what did this cost last time" is the first row. */
  async historyFor(productId: number): Promise<StoredPriceHistory[]> {
    const rows = await this.db.getAllFromIndex('priceHistory', 'productId', productId);
    return rows.sort((a, b) => b.recordedAt - a.recordedAt);
  }

  // --- conversation ---------------------------------------------------------

  async addMessage(message: Omit<StoredMessage, 'id'>): Promise<StoredMessage> {
    const id = await this.db.add('messages', message as StoredMessage);
    return { ...message, id };
  }

  async say(
    orderId: number,
    role: MessageRole,
    text: string,
    options: { photoId?: number | null; referencedItemIds?: number[] } = {},
  ): Promise<StoredMessage> {
    return this.addMessage({
      orderId,
      role,
      text,
      photoId: options.photoId ?? null,
      referencedItemIds: options.referencedItemIds ?? [],
      createdAt: Date.now(),
    });
  }

  async conversation(orderId: number): Promise<StoredMessage[]> {
    const rows = await this.db.getAllFromIndex('messages', 'orderId', orderId);
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  // --- delivery checks ------------------------------------------------------

  async saveDeliveryCheck(check: Omit<StoredDeliveryCheck, 'id'>): Promise<StoredDeliveryCheck> {
    const id = await this.db.add('deliveryChecks', check as StoredDeliveryCheck);
    await this.updateOrder(check.orderId, { deliveryCheckedAt: check.createdAt });
    return { ...check, id };
  }

  async deliveryChecksFor(orderId: number): Promise<StoredDeliveryCheck[]> {
    const rows = await this.db.getAllFromIndex('deliveryChecks', 'orderId', orderId);
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }
}

async function deleteByIndex(
  index: { getAllKeys(query: number): Promise<number[]>; objectStore: { delete(key: number): Promise<void> } },
  orderId: number,
): Promise<void> {
  const keys = await index.getAllKeys(orderId);
  await Promise.all(keys.map((key) => index.objectStore.delete(key)));
}
