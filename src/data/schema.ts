import type { Category, DiscountScope, ItemConfidence } from '../core/models';
import type { OrderImageType } from '../core/ai-types';
import type { DeliveryStatus } from '../core/delivery';
import type { PricingSource } from '../core/pricing';

/**
 * What is written to disk.
 *
 * Two rules govern every shape in here.
 *
 * Money is stored as an integer - the `toStorage()` value of a [Money], ten-thousandths of a
 * dollar - and never as a decimal. A float in a database is a rounding error waiting to be
 * discovered at the till.
 *
 * Nothing a model said is stored as though it were fact. `aiConfidence`, `issues` and
 * `sourceText` travel with every row so the app can always answer "why does it say that?".
 */

export const DB_NAME = 'grocery-pricer';
export const DB_VERSION = 1;

export const OrderStatus = {
  /** Photos added, nothing sent anywhere yet. */
  DRAFT: 'DRAFT',
  PROCESSING: 'PROCESSING',
  /** Processed and priced. The shopkeeper can ask questions about it. */
  READY: 'READY',
  /** Processing stopped early - no key, no quota, no connection. */
  FAILED: 'FAILED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export interface StoredOrder {
  id: number;
  createdAt: number;
  updatedAt: number;
  supplier: string | null;
  status: OrderStatus;
  /** What went wrong, when status is FAILED. Never contains a key or a URL. */
  failureMessage: string | null;
  /** Totals in storage units. Recomputed from items, never from a model. */
  totalWholesaleCost: number;
  itemCount: number;
  warnings: string[];
  /** Set once the shopkeeper has checked this order against a delivery. */
  deliveryCheckedAt: number | null;
}

export interface StoredPhoto {
  id: number;
  orderId: number;
  /**
   * The image itself, as raw bytes.
   *
   * Bytes rather than a Blob on purpose: a Blob's support in IndexedDB varies by engine, and
   * bytes round-trip identically everywhere. Nothing leaves this device except the copy sent to
   * Gemini for the one call that needs it.
   */
  bytes: ArrayBuffer;
  mimeType: string;
  type: OrderImageType;
  /** True for photos taken during a delivery check rather than of the paperwork. */
  isDeliveryPhoto: boolean;
  createdAt: number;
}

export interface StoredDiscount {
  description: string;
  amount: number;
  scope: DiscountScope;
  appliesToUnits: number | null;
}

export interface StoredItem {
  id: number;
  orderId: number;
  productId: number | null;
  /** Exactly as printed, OCR damage included. This is what the shopkeeper will recognise. */
  rawName: string;
  displayName: string;
  size: string | null;
  upc: string | null;
  supplierSku: string | null;
  category: Category;

  casePrice: number | null;
  unitsPerCase: number | null;
  casesPurchased: number;
  looseUnits: number;
  discount: StoredDiscount | null;

  /** Computed here, by CostCalculator, from the figures above. */
  trueUnitCost: number | null;
  totalWholesaleCost: number | null;

  suggestedPrice: number | null;
  pricingSource: PricingSource | null;
  pricingRationale: string | null;
  /** What the shopkeeper actually decided to charge, once they say so. */
  approvedPrice: number | null;
  previousPrice: number | null;

  confidence: ItemConfidence;
  aiConfidence: number;
  issues: string[];
  sourcePhotoIds: number[];
  sourceText: string[];
}

export interface StoredProduct {
  id: number;
  /** Uppercased, size-stripped, noise-stripped. The matching key. */
  normalizedName: string;
  displayName: string;
  size: string | null;
  upc: string | null;
  category: Category;
  lastCost: number | null;
  lastRetailPrice: number | null;
  /** A price the shopkeeper pinned to this product; beats every rule. */
  overridePrice: number | null;
  timesSeen: number;
  lastSeenAt: number;
}

export interface StoredPriceHistory {
  id: number;
  productId: number;
  orderId: number | null;
  unitCost: number | null;
  retailPrice: number | null;
  recordedAt: number;
  note: string | null;
}

export const MessageRole = {
  USER: 'USER',
  APP: 'APP',
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

export interface StoredMessage {
  id: number;
  orderId: number;
  role: MessageRole;
  text: string;
  /** A photo the shopkeeper attached to the question. */
  photoId: number | null;
  /** Which items the answer was about, so a follow-up question knows what "it" means. */
  referencedItemIds: number[];
  createdAt: number;
}

export interface StoredDeliveryLine {
  itemId: number | null;
  name: string;
  size: string | null;
  expectedCases: number | null;
  countedCases: number | null;
  status: DeliveryStatus;
  confidence: number | null;
  needsAnotherPhoto: boolean;
  message: string;
  sourcePhotoIds: number[];
}

export interface StoredDeliveryCheck {
  id: number;
  orderId: number;
  createdAt: number;
  lines: StoredDeliveryLine[];
  warnings: string[];
}

/**
 * Settings, one row per key.
 *
 * The Gemini key lives here, in this browser, on this device. It is never synced, never sent
 * anywhere but Google, and never written into the repository. See the README on why that is fine
 * for one shopkeeper's phone and wrong for a public service.
 */
export interface StoredSetting {
  key: string;
  value: unknown;
}

export const SettingKey = {
  GEMINI_API_KEY: 'geminiApiKey',
  GEMINI_MODEL: 'geminiModel',
  PRICING_RULES: 'pricingRules',
  LAST_OPENED_ORDER: 'lastOpenedOrder',
} as const;
export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];
