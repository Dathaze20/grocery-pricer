import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  DB_NAME,
  DB_VERSION,
  type StoredDeliveryCheck,
  type StoredItem,
  type StoredMessage,
  type StoredOrder,
  type StoredPhoto,
  type StoredPriceHistory,
  type StoredProduct,
  type StoredSetting,
} from './schema';

export interface GroceryDb extends DBSchema {
  orders: {
    key: number;
    value: StoredOrder;
    indexes: { createdAt: number; status: string };
  };
  photos: {
    key: number;
    value: StoredPhoto;
    indexes: { orderId: number };
  };
  items: {
    key: number;
    value: StoredItem;
    indexes: { orderId: number; productId: number };
  };
  products: {
    key: number;
    value: StoredProduct;
    indexes: { normalizedName: string; upc: string };
  };
  priceHistory: {
    key: number;
    value: StoredPriceHistory;
    indexes: { productId: number; recordedAt: number };
  };
  messages: {
    key: number;
    value: StoredMessage;
    indexes: { orderId: number };
  };
  deliveryChecks: {
    key: number;
    value: StoredDeliveryCheck;
    indexes: { orderId: number };
  };
  settings: {
    key: string;
    value: StoredSetting;
  };
}

let handle: Promise<IDBPDatabase<GroceryDb>> | null = null;

/**
 * Opens the database, creating it on first run.
 *
 * Upgrades are written as a sequence of numbered steps rather than one "create everything" block,
 * so a shop that installed the app in January keeps its orders when it reloads the page in June.
 * A PWA updates itself silently; losing a year of price history to a silent update would be
 * unforgivable.
 */
export function openGroceryDb(name: string = DB_NAME): Promise<IDBPDatabase<GroceryDb>> {
  if (name === DB_NAME && handle !== null) return handle;

  const opened = openDB<GroceryDb>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const orders = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        orders.createIndex('createdAt', 'createdAt');
        orders.createIndex('status', 'status');

        const photos = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        photos.createIndex('orderId', 'orderId');

        const items = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        items.createIndex('orderId', 'orderId');
        items.createIndex('productId', 'productId');

        const products = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        products.createIndex('normalizedName', 'normalizedName');
        products.createIndex('upc', 'upc');

        const history = db.createObjectStore('priceHistory', { keyPath: 'id', autoIncrement: true });
        history.createIndex('productId', 'productId');
        history.createIndex('recordedAt', 'recordedAt');

        const messages = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        messages.createIndex('orderId', 'orderId');

        const deliveries = db.createObjectStore('deliveryChecks', { keyPath: 'id', autoIncrement: true });
        deliveries.createIndex('orderId', 'orderId');

        db.createObjectStore('settings', { keyPath: 'key' });
      }
    },
  });

  if (name === DB_NAME) handle = opened;
  return opened;
}

/** Forgets the cached handle. Tests use this between databases. */
export function resetDbHandle(): void {
  handle = null;
}
