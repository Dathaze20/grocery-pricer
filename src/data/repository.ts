import type { IDBPDatabase } from 'idb';
import { Money } from '../core/money';
import { NameNormalizer, normalizeUpc, upcEquivalent } from '../core/matching';
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

  /**
   * Throws away orders that were started and abandoned before a single photo was taken.
   *
   * Pressing NEW ORDER creates the order up front, so backing out of that screen leaves a row
   * behind. One is untidy; a month of them buries the orders that matter. An order with photos is
   * never touched - that is work in progress, not litter.
   */
  async deleteEmptyDrafts(): Promise<number> {
    const drafts = await this.db.getAllFromIndex('orders', 'status', OrderStatus.DRAFT);
    let removed = 0;
    for (const draft of drafts) {
      const photos = await this.db.getAllKeysFromIndex('photos', 'orderId', draft.id);
      if (photos.length === 0) {
        await this.deleteOrder(draft.id);
        removed += 1;
      }
    }
    return removed;
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

  /**
   * Removes the rows a previous attempt at this order left behind.
   *
   * Processing appends, so without this a retry after a half-finished run shows every product
   * twice and doubles the order total. Only the priced rows go; the photographs, the order and
   * the product catalogue are untouched, which is what makes the retry safe to offer.
   */
  async clearItemsFor(orderId: number): Promise<number> {
    const tx = this.db.transaction('items', 'readwrite');
    const existing = await tx.store.index('orderId').getAllKeys(orderId);
    for (const key of existing) await tx.store.delete(key);
    await tx.done;
    return existing.length;
  }

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
      // Approving a price is the shop confirming this row is this product, which makes the
      // receipt's abbreviation worth remembering.
      await this.rememberAlias(item.productId, item.rawName);
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
   * The order of attempts is the order of how much each thing proves:
   *
   *   1. the barcode - definitive when the receipt prints a legible one
   *   2. the supplier's own item number - definitive within one supplier
   *   3. a receipt abbreviation this shop has already confirmed
   *   4. the normalised name, with the size and variant agreeing exactly
   *
   * There is no fuzzy step here on purpose. Names alone merge Tide 25 oz into Tide 40 oz, and
   * a lemon cleaner into a lavender one, and the shop then gets quoted the wrong cost for both.
   * A close-but-not-certain name is left as its own product until somebody confirms otherwise.
   */
  async findOrCreateProduct(input: {
    displayName: string;
    size: string | null;
    upc: string | null;
    variant?: string | null;
    supplierSku?: string | null;
    receiptName?: string | null;
    category?: Category;
  }): Promise<StoredProduct> {
    const normalized = NameNormalizer.normalize(input.displayName);
    const alias = NameNormalizer.normalize(input.receiptName ?? '');
    const upc = normalizeUpc(input.upc) ?? '';
    const sku = input.supplierSku?.trim() ?? '';
    const variant = input.variant?.trim() ?? null;

    // An abbreviation is only recorded against a product when something else proved the match:
    // a barcode or the supplier's own item number. A name a model expanded is a guess, and a
    // guess written into memory is a guess the app will trust forever afterwards.
    if (upc.length > 0) {
      const byUpc = await this.findByBarcode(upc, input.upc ?? null);
      if (byUpc !== undefined) return this.touchProduct(byUpc, alias);
    }

    if (sku.length > 0) {
      const bySku = await this.db.getFromIndex('products', 'supplierSku', sku);
      if (bySku !== undefined) return this.touchProduct(bySku, alias);
    }

    if (alias.length > 0) {
      const all = await this.db.getAll('products');
      // Products saved before aliases existed have no such field; reading it as a list would
      // throw and take the whole lookup with it.
      const byAlias = all.find((product) => (product.aliases ?? []).includes(alias));
      if (byAlias !== undefined) return this.touchProduct(byAlias, alias);
    }

    const candidates = await this.db.getAllFromIndex('products', 'normalizedName', normalized);
    const match = candidates.find(
      (c) => (c.size ?? null) === (input.size ?? null) && (c.variant ?? null) === variant,
    );
    // Matched on the name alone, which is not proof of identity, so the abbreviation is not
    // learned here. Approving a price is what confirms it.
    if (match !== undefined) return this.touchProduct(match);

    const now = Date.now();
    const created: Omit<StoredProduct, 'id'> = {
      normalizedName: normalized,
      displayName: input.displayName,
      size: input.size,
      variant,
      upc: upc.length > 0 ? upc : null,
      supplierSku: sku.length > 0 ? sku : null,
      // A brand-new product has confirmed nothing yet.
      aliases: [],
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

  /**
   * Finds a product by barcode, whichever way the digits were written down.
   *
   * The same product is printed as 12 digits on one receipt and 13 on another, differing only
   * by leading zeros, and rows saved by older versions kept whatever the receipt showed. The
   * index is tried first because it is fast; the scan behind it is what makes the two spellings
   * one product rather than two.
   */
  private async findByBarcode(
    normalized: string,
    raw: string | null,
  ): Promise<StoredProduct | undefined> {
    const indexed = await this.db.getFromIndex('products', 'upc', normalized);
    if (indexed !== undefined) return indexed;
    if (raw !== null && raw.trim() !== normalized) {
      const asPrinted = await this.db.getFromIndex('products', 'upc', raw.trim());
      if (asPrinted !== undefined) return asPrinted;
    }
    const all = await this.db.getAll('products');
    return all.find((product) => upcEquivalent(product.upc, normalized));
  }

  /** Records a receipt abbreviation against a product the shop has confirmed it belongs to. */
  async rememberAlias(productId: number, receiptName: string | null): Promise<void> {
    const alias = NameNormalizer.normalize(receiptName ?? '');
    if (alias.length === 0) return;
    const product = await this.db.get('products', productId);
    if (product === undefined || product.aliases.includes(alias)) return;
    await this.db.put('products', { ...product, aliases: [...product.aliases, alias] });
  }

  private async touchProduct(product: StoredProduct, alias = ''): Promise<StoredProduct> {
    // Products stored before aliases existed have none; treat that as an empty list rather
    // than letting it read as missing.
    const aliases = product.aliases ?? [];
    const updated = {
      ...product,
      aliases: alias.length > 0 && !aliases.includes(alias) ? [...aliases, alias] : aliases,
      timesSeen: product.timesSeen + 1,
      lastSeenAt: Date.now(),
    };
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

  /**
   * Newest first, so "what did this cost last time" is the first row.
   *
   * Two rows written in the same millisecond tie on time, which is not rare when an order is
   * processed in one go. The id breaks the tie, because it always increases.
   */
  async historyFor(productId: number): Promise<StoredPriceHistory[]> {
    const rows = await this.db.getAllFromIndex('priceHistory', 'productId', productId);
    return rows.sort((a, b) => b.recordedAt - a.recordedAt || b.id - a.id);
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
