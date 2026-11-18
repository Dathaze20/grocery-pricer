import type { IDBPDatabase } from 'idb';
import { Money } from '../core/money';
import { NameNormalizer, normalizeUpc, upcEquivalent } from '../core/matching';
import { Category, DiscountScope, guessCategory, makeDiscount, APPROVED_PRICE_BELOW_COST, approvedPriceIsBelowCost } from '../core/models';
import { CostCalculator } from '../core/cost';
import { PricingEngine, defaultPricingRules, type PricingRules } from '../core/pricing';
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

  /**
   * The model that last worked, but only if it worked for the key in use now.
   *
   * Tied to the key because model access is granted per Google project: a key swapped for a
   * different project's can be offered an entirely different set, and starting from the old
   * project's answer would just cost a wasted call. The key is never stored here - only a
   * short non-reversible fingerprint of it, which is enough to notice it changed.
   */
  async workingModel(apiKey: string | null): Promise<string | null> {
    const stored = await this.setting<{ model: string; keyPrint: string }>(
      SettingKey.GEMINI_WORKING_MODEL,
    );
    if (stored === undefined || stored === null) return null;
    if (stored.keyPrint !== fingerprint(apiKey)) return null;
    const trimmed = stored.model?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  }

  async rememberWorkingModel(apiKey: string | null, model: string): Promise<void> {
    await this.putSetting(SettingKey.GEMINI_WORKING_MODEL, {
      model,
      keyPrint: fingerprint(apiKey),
    });
    // Gemini has just answered, so whatever went wrong before is no longer the current state.
    await this.db.delete('settings', SettingKey.GEMINI_LAST_FAULT);
  }

  /**
   * Records, in a few words, why the last attempt to read a receipt did not work.
   *
   * Short on purpose: this is for a status line, not a diagnosis. The failing screen already
   * shows the full explanation, and a model name or an HTTP status has no business in Settings.
   */
  async recordAiFault(apiKey: string | null, summary: string): Promise<void> {
    await this.putSetting(SettingKey.GEMINI_LAST_FAULT, {
      summary,
      keyPrint: fingerprint(apiKey),
      at: Date.now(),
    });
  }

  async lastAiFault(apiKey: string | null): Promise<string | null> {
    const stored = await this.setting<{ summary: string; keyPrint: string }>(
      SettingKey.GEMINI_LAST_FAULT,
    );
    if (stored === undefined || stored === null) return null;
    // A fault recorded against a different key says nothing about the key in use now.
    if (stored.keyPrint !== fingerprint(apiKey)) return null;
    const trimmed = stored.summary?.trim();
    return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
  }

  async forgetWorkingModel(): Promise<void> {
    await this.db.delete('settings', SettingKey.GEMINI_WORKING_MODEL);
  }

  /** Back to "not tested yet" - used when the key changes, so a stale verdict is not shown. */
  async forgetAiHealth(): Promise<void> {
    await this.db.delete('settings', SettingKey.GEMINI_WORKING_MODEL);
    await this.db.delete('settings', SettingKey.GEMINI_LAST_FAULT);
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
   * Swaps this order's rows for a new set, in one transaction.
   *
   * Replacing rather than clearing is the whole point. A clear followed later by an insert has
   * a window in between where the order has nothing in it, and if the work that was meant to
   * fill it fails - the model refuses, the connection drops, the tab is closed - the shopkeeper
   * is left with an order whose products are simply gone. Here the old rows go only once the
   * new ones are ready, and IndexedDB aborts the whole transaction if any part of it fails, so
   * the order holds either the old set or the new one and never neither.
   *
   * Photographs, products, price history, conversations and the stored key live in other
   * stores and are not touched.
   */
  async replaceItems(
    orderId: number,
    items: ReadonlyArray<Omit<StoredItem, 'id'>>,
  ): Promise<StoredItem[]> {
    const tx = this.db.transaction('items', 'readwrite');
    const previous = await tx.store.index('orderId').getAllKeys(orderId);
    for (const key of previous) await tx.store.delete(key);

    const saved: StoredItem[] = [];
    for (const item of items) {
      const id = await tx.store.add(item as StoredItem);
      saved.push({ ...item, id });
    }
    await tx.done;
    return saved;
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
  /**
   * Applies a correction the shopkeeper makes to one row, and re-does the arithmetic.
   *
   * Two things a receipt often does not say: what a flyer discount applies to, and how many
   * pieces are in a pack. Both are knowable - by the person holding the case - and neither is
   * anything this app should guess. This is where their answer goes.
   *
   * What it recomputes is cost and the suggested price. What it never touches is the price the
   * owner approved: that is their decision about what to charge, and a correction to the cost
   * is not permission to overwrite it.
   */
  async reviseItem(
    itemId: number,
    change: { scope?: DiscountScope; unitsPerCase?: number },
    rules: PricingRules = defaultPricingRules(),
  ): Promise<StoredItem | null> {
    const item = await this.item(itemId);
    if (item === null) return null;

    const unitsPerCase = change.unitsPerCase ?? item.unitsPerCase;
    const casePrice = item.casePrice === null ? null : Money.fromStorage(item.casePrice);

    const discount =
      item.discount === null
        ? null
        : makeDiscount(
            item.discount.description,
            Money.fromStorage(item.discount.amount),
            change.scope ?? item.discount.scope,
            item.discount.appliesToUnits ?? null,
          );

    let trueUnitCost: number | null = null;
    let totalWholesaleCost: number | null = null;
    if (casePrice !== null && unitsPerCase !== null && unitsPerCase > 0) {
      const breakdown = CostCalculator.calculate({
        casePrice,
        unitsPerCase,
        casesPurchased: item.casesPurchased,
        discount,
      });
      trueUnitCost = breakdown.trueUnitCost.toStorage();
      totalWholesaleCost = breakdown.totalWholesaleCost.toStorage();
    }

    const product = item.productId === null ? null : await this.product(item.productId);
    const suggestion = new PricingEngine(rules).suggest({
      unitCost: trueUnitCost === null ? null : Money.fromStorage(trueUnitCost),
      category: item.category,
      previousRetailPrice:
        product?.lastRetailPrice != null ? Money.fromStorage(product.lastRetailPrice) : null,
      productOverridePrice:
        product?.overridePrice != null ? Money.fromStorage(product.overridePrice) : null,
    });

    // The questions this row was flagged for have been answered, so the flags go.
    const settled = item.issues.filter(
      (issue) =>
        !(change.scope !== undefined && issue === 'UNKNOWN_DISCOUNT_SCOPE') &&
        !(change.unitsPerCase !== undefined && issue === 'MISSING_UNITS_PER_CASE') &&
        // Decided again below against the corrected cost, so the stale verdict goes first.
        issue !== APPROVED_PRICE_BELOW_COST,
    );

    /*
     * Whether the owner's price still covers the cost, asked again.
     *
     * A correction moves the cost, and the cost is half of that comparison. Correcting a pack
     * count upward raises the cost each and can leave an approved price underwater without
     * anything saying so; correcting a discount downward can clear a warning that is no longer
     * true. Both directions, or the flag means nothing.
     *
     * The row's own approved price first - it is the decision about this product - falling back
     * to what the product was last sold for, which is what the receipt reading compares against.
     */
    const approvedPrice =
      item.approvedPrice ?? product?.lastRetailPrice ?? null;
    if (
      approvedPriceIsBelowCost(
        approvedPrice === null ? null : Money.fromStorage(approvedPrice),
        trueUnitCost === null ? null : Money.fromStorage(trueUnitCost),
      )
    ) {
      settled.push(APPROVED_PRICE_BELOW_COST);
    }

    // A count the owner established is worth keeping: it is the same pack next month.
    if (change.unitsPerCase !== undefined && item.productId !== null) {
      await this.rememberUnitsPerCase(item.productId, change.unitsPerCase);
    }

    const revised = await this.updateItem(itemId, {
      unitsPerCase,
      discount:
        discount === null
          ? null
          : {
              description: discount.description,
              amount: discount.amount.toStorage(),
              scope: discount.scope,
              appliesToUnits: discount.appliesToUnits ?? null,
            },
      trueUnitCost,
      totalWholesaleCost,
      suggestedPrice: suggestion.suggestedPrice.toStorage(),
      pricingSource: suggestion.source,
      pricingRationale: suggestion.rationale,
      issues: settled,
    });

    // The row is not the only place that figure appears. An order summary still showing the
    // uncorrected total, or a product still remembering the uncorrected cost, is the same
    // wrong number surviving in a quieter place.
    await this.recomputeOrderTotal(item.orderId);
    if (item.productId !== null && trueUnitCost !== null) {
      await this.refreshLastCost(item.productId, item.orderId, trueUnitCost);
    }

    return revised;
  }

  /**
   * Re-adds the order's wholesale total from its rows.
   *
   * Summed rather than adjusted by a difference: an adjustment has to be right about what the
   * old figure was, and a total that drifts is worse than one that is simply recomputed. Only
   * the total moves - the status, the warnings and every approved price are left alone.
   */
  private async recomputeOrderTotal(orderId: number): Promise<void> {
    const items = await this.itemsFor(orderId);
    const total = items.reduce(
      (sum, row) => (row.totalWholesaleCost === null ? sum : sum.plus(Money.fromStorage(row.totalWholesaleCost))),
      Money.ZERO,
    );
    await this.updateOrder(orderId, { totalWholesaleCost: total.toStorage() });
  }

  /**
   * Updates what this product last cost, but only when the correction is to its latest order.
   *
   * Correcting a receipt from three months ago must not overwrite what the product costs now.
   * lastCost means the most recent purchase, so an older order's correction leaves it alone -
   * and the price history, which is the record of what was actually paid and when, is never
   * rewritten by a correction either.
   */
  private async refreshLastCost(
    productId: number,
    orderId: number,
    trueUnitCost: number,
  ): Promise<void> {
    const rows = await this.db.getAllFromIndex('items', 'productId', productId);
    const latestOrder = rows.reduce((newest, row) => Math.max(newest, row.orderId), 0);
    if (orderId < latestOrder) return;

    const product = await this.db.get('products', productId);
    if (product === undefined) return;
    await this.db.put('products', { ...product, lastCost: trueUnitCost });
  }

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
    unitsPerCase?: number | null;
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
      //
      // A size or variant that disagrees rules the match out. A receipt abbreviation is the
      // shop's shorthand, not an identity: "HELLM MAYO" is printed over the 8oz and the 40oz
      // alike, and matching on it alone would hand the big jar the small jar's product - and
      // with it the small jar's approved selling price. The name lookup below has always
      // compared size and variant; this one quietly did not.
      const byAlias = all.find(
        (product) =>
          (product.aliases ?? []).includes(alias) && !conflicts(product, input.size, variant),
      );
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
      unitsPerCase: input.unitsPerCase ?? null,
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

  /** Writes down a pack count once, so the same case is never counted twice. */
  async rememberUnitsPerCase(productId: number, unitsPerCase: number): Promise<void> {
    if (!Number.isInteger(unitsPerCase) || unitsPerCase <= 0) return;
    const product = await this.db.get('products', productId);
    if (product === undefined) return;
    await this.db.put('products', { ...product, unitsPerCase });
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

/**
 * A short, non-reversible mark of a key, used only to tell one key from another.
 *
 * Not a security measure and not trying to be: it never leaves the device, and the key itself
 * is already stored beside it. The point is simply that nothing which looks like a credential
 * ends up in a second place where it could be logged or exported by mistake.
 */
function fingerprint(apiKey: string | null): string {
  const text = apiKey?.trim() ?? '';
  if (text.length === 0) return 'none';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}-${hash.toString(16)}`;
}

/**
 * Whether a stored product is definitely NOT what this receipt line describes.
 *
 * Used by the alias lookup, and deliberately weaker than the exact comparison the name lookup
 * makes. The two have different evidence behind them, so they get different rules:
 *
 *   - An alias was written down because a barcode or the supplier's item number once proved
 *     this abbreviation belongs to this product. That is real evidence. A line that prints the
 *     abbreviation and no readable size is not a reason to throw the evidence away and make a
 *     second product - the receipt simply did not say.
 *   - A size that disagrees is different. 8 OZ against 40 OZ is not a gap in what the receipt
 *     said; it is the receipt saying something else. The alias does not survive it.
 *
 * So: unknown on either side is not a conflict, two known and different values are.
 */
function conflicts(
  product: Pick<StoredProduct, 'size' | 'variant'>,
  size: string | null,
  variant: string | null,
): boolean {
  return differs(product.size ?? null, size ?? null) || differs(product.variant ?? null, variant);
}

function differs(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a.trim().toUpperCase() !== b.trim().toUpperCase();
}
