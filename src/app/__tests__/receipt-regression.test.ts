import { describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { DiscountScope } from '../../core/models';
import { OrderImageType, type AiDiscountLine, type AiExtractedItem } from '../../core/ai-types';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { processOrder } from '../processing';

/**
 * The arithmetic a real wholesale receipt has to come out at.
 *
 * The figures are the ones checked against the paper by hand; the names are invented, because
 * no real receipt text belongs in this repository and nothing here may become a rule in the
 * app. What is being pinned is the shape - a product, a barcode, a case price with its pack
 * count, then the flyer words, a reference and the amount, several lines below - and the cost
 * each that has to fall out of it.
 */

let dbCounter = 8000;
async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`receipt-db-${dbCounter}`);
}

async function orderWithPhoto(repo: Repository): Promise<number> {
  const order = await repo.createOrder();
  await repo.addPhoto({
    orderId: order.id,
    bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    mimeType: 'image/jpeg',
    type: OrderImageType.RECEIPT,
    isDeliveryPhoto: false,
    createdAt: Date.now(),
  });
  return order.id;
}

interface Printed {
  readonly name: string;
  readonly upc: string;
  readonly size: string;
  readonly casePrice: string;
  /** Retail packages in the case - the number printed beside the case price. */
  readonly packs: number;
  readonly discount: string;
  readonly reference: string;
}

function productFrom(printed: Printed): AiExtractedItem {
  return {
    rawName: printed.name,
    canonicalName: printed.name,
    brand: null,
    size: printed.size,
    upc: printed.upc,
    supplierSku: null,
    casePrice: printed.casePrice,
    unitsPerCase: printed.packs,
    printedUnitCost: null,
    casesPurchased: 1,
    discount: null,
    category: null,
    sourcePhotoIds: [1],
    sourceText: [printed.name, printed.upc, `${printed.casePrice}   ${printed.packs}`],
    confidence: 0.9,
  };
}

/** The money-off block as the paper prints it: words, reference, amount, then UNITS. */
function discountFrom(printed: Printed, at: number): AiDiscountLine {
  return {
    amount: printed.discount,
    productName: null,
    productLineAbove: printed.name,
    upc: printed.upc,
    appliesToIndex: at,
    reference: printed.reference,
    sourcePhotoIds: [1],
    sourceText: ['FLYER DISCOUNT', printed.reference, printed.discount, 'UNITS 1'],
  };
}

const RECEIPT: readonly Printed[] = [
  {
    name: 'DRYNITE JUMBO #6 21CT',
    upc: '0000000000016',
    size: '21 CT',
    casePrice: '45.99',
    packs: 4,
    discount: '-7.00',
    reference: 'F12',
  },
  {
    // The same product line in a different size: a different product at the same case price.
    name: 'DRYNITE JUMBO #5 24CT',
    upc: '0000000000023',
    size: '24 CT',
    casePrice: '45.99',
    packs: 4,
    discount: '-7.00',
    reference: 'F12',
  },
  {
    name: 'HOUND DINNER FILET 2.7 LB',
    upc: '0000000000030',
    size: '2.7 LB',
    casePrice: '29.39',
    packs: 4,
    discount: '-1.40',
    reference: 'F31',
  },
  {
    name: 'AIRFRESH SPRING CLEAN',
    upc: '0000000000047',
    size: '4 CT',
    casePrice: '9.89',
    packs: 4,
    discount: '-0.50',
    reference: 'F44',
  },
];

async function readReceipt(repo: Repository, printed: readonly Printed[]): Promise<number> {
  const orderId = await orderWithPhoto(repo);
  const provider = new FakeAiProvider();
  provider.queueExtraction({
    supplier: 'SUPPLIER',
    items: printed.map(productFrom),
    discountLines: printed.map((row, at) => discountFrom(row, at)),
    warnings: [],
  });
  const result = await processOrder(repo, provider, orderId, { retryDelayMs: 0 });
  expect(result.ok).toBe(true);
  return orderId;
}

describe('the whole receipt, read in one go', () => {
  it('gets every cost each right, with the flyer money already off', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, RECEIPT);

    const rows = await repo.itemsFor(orderId);
    const costs = new Map(
      rows.map((row) => [
        row.rawName,
        Money.fromStorage(row.trueUnitCost!).roundedToCents().format(),
      ]),
    );

    // $45.99 less $7.00 over four packages.
    expect(costs.get('DRYNITE JUMBO #6 21CT')).toBe('$9.75');
    expect(costs.get('DRYNITE JUMBO #5 24CT')).toBe('$9.75');
    // $29.39 less $1.40 over four.
    expect(costs.get('HOUND DINNER FILET 2.7 LB')).toBe('$7.00');
    // $9.89 less $0.50 over four bottles.
    expect(costs.get('AIRFRESH SPRING CLEAN')).toBe('$2.35');
  });

  it('records the net case cost, not the printed one', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, RECEIPT);

    const rows = await repo.itemsFor(orderId);
    const net = new Map(
      rows.map((row) => [row.rawName, Money.fromStorage(row.totalWholesaleCost!).format()]),
    );

    expect(net.get('DRYNITE JUMBO #6 21CT')).toBe('$38.99');
    expect(net.get('HOUND DINNER FILET 2.7 LB')).toBe('$27.99');
    expect(net.get('AIRFRESH SPRING CLEAN')).toBe('$9.39');
  });

  it('keeps the two sizes apart, as two products', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, RECEIPT);

    const rows = await repo.itemsFor(orderId);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.productId)).size).toBe(4);
  });

  it('applies every discount without being asked anything', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, RECEIPT);

    const rows = await repo.itemsFor(orderId);
    expect(rows.every((r) => r.discount !== null)).toBe(true);
    expect(rows.every((r) => r.discount!.scope === DiscountScope.WHOLE_CASE)).toBe(true);
    // Nothing left open: no scope question, no missing pack count.
    expect(rows.flatMap((r) => r.issues)).toEqual([]);
    const order = await repo.order(orderId);
    expect(order!.warnings).toEqual([]);
  });

  it('adds the order up from the discounted figures', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, RECEIPT);

    const order = await repo.order(orderId);
    // 38.99 + 38.99 + 27.99 + 9.39
    expect(Money.fromStorage(order!.totalWholesaleCost).format()).toBe('$115.36');
  });
});

describe('the same receipt photographed twice over', () => {
  it('counts each purchase and each discount once', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    // Two overlapping photographs that both caught the same two products.
    for (let pass = 0; pass < 2; pass += 1) {
      provider.queueExtraction({
        supplier: 'SUPPLIER',
        items: RECEIPT.slice(0, 2).map(productFrom),
        discountLines: RECEIPT.slice(0, 2).map((row, at) => discountFrom(row, at)),
        warnings: [],
      });
    }

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const rows = await repo.itemsFor(orderId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.discount !== null)).toBe(true);
    // Two cases at $38.99 - not four, and not two at $31.99 with the money off twice.
    const order = await repo.order(orderId);
    expect(Money.fromStorage(order!.totalWholesaleCost).format()).toBe('$77.98');
  });
});

describe('a discount cut off from its product by the camera', () => {
  it('still lands once the photographs are put together', async () => {
    const repo = await freshRepo();
    const order = await repo.createOrder();
    for (let i = 0; i < 4; i += 1) {
      await repo.addPhoto({
        orderId: order.id,
        bytes: new Uint8Array([1, 2, 3, 4]).buffer,
        mimeType: 'image/jpeg',
        type: OrderImageType.RECEIPT,
        isDeliveryPhoto: false,
        createdAt: 2000 + i,
      });
    }
    const provider = new FakeAiProvider();
    const stranded = RECEIPT[0]!;
    // First pair of photographs: the product, and no discount line with it.
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [productFrom(stranded)],
      discountLines: [],
      warnings: [],
    });
    // Second pair: the flyer block that was printed below the fold, naming the line above it.
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [productFrom(RECEIPT[2]!)],
      discountLines: [{ ...discountFrom(stranded, 0), appliesToIndex: null }],
      warnings: [],
    });

    await processOrder(repo, provider, order.id, { retryDelayMs: 0 });

    const rows = await repo.itemsFor(order.id);
    const nappies = rows.find((r) => r.rawName === stranded.name);
    expect(Money.fromStorage(nappies!.trueUnitCost!).roundedToCents().format()).toBe('$9.75');
    // And it did not land on the product that happened to share its batch.
    const other = rows.find((r) => r.rawName === RECEIPT[2]!.name);
    expect(other!.discount).toBeNull();
  });
});

describe('pieces in a packet are not packets in a case', () => {
  it('asks when the printed unit price disproves the pack count', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [
        {
          // 21 nappies in a packet, misread as 21 packets in the case - and the receipt's own
          // per-unit figure says each packet is $11.50, which twenty-one of cannot be.
          ...productFrom({ ...RECEIPT[0]!, packs: 21 }),
          printedUnitCost: '11.50',
        },
      ],
      discountLines: [discountFrom(RECEIPT[0]!, 0)],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const [row] = await repo.itemsFor(orderId);
    // $45.99 over 21 reads $2.19 a packet against a printed $11.50. Better to ask.
    expect(row!.unitsPerCase).toBeNull();
    expect(row!.trueUnitCost).toBeNull();
    expect(row!.issues).toContain('MISSING_UNITS_PER_CASE');
  });

  it('accepts a pack count the printed unit price agrees with', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({
      supplier: 'SUPPLIER',
      items: [{ ...productFrom(RECEIPT[0]!), printedUnitCost: '11.50' }],
      discountLines: [discountFrom(RECEIPT[0]!, 0)],
      warnings: [],
    });

    await processOrder(repo, provider, orderId, { retryDelayMs: 0 });

    const [row] = await repo.itemsFor(orderId);
    // $45.99 over four is $11.50 before the flyer money, which is what is printed.
    expect(row!.unitsPerCase).toBe(4);
    expect(Money.fromStorage(row!.trueUnitCost!).roundedToCents().format()).toBe('$9.75');
  });

  it('leaves a club pack whose count matches its size alone', async () => {
    const repo = await freshRepo();
    // Four bottles in the pack and four to sell: the two numbers are honestly the same, and
    // nothing may read that coincidence as a mistake.
    const orderId = await readReceipt(repo, [RECEIPT[3]!]);

    const [row] = await repo.itemsFor(orderId);
    expect(row!.unitsPerCase).toBe(4);
    expect(Money.fromStorage(row!.trueUnitCost!).roundedToCents().format()).toBe('$2.35');
    expect(row!.issues).toEqual([]);
  });

  it('leaves an honest pack count alone', async () => {
    const repo = await freshRepo();
    const orderId = await readReceipt(repo, [RECEIPT[0]!]);

    const [row] = await repo.itemsFor(orderId);
    expect(row!.unitsPerCase).toBe(4);
  });

  it('does not interfere with a size that is not a count', async () => {
    const repo = await freshRepo();
    // A case holding four 2.7 lb trays: the numbers cannot collide, and nothing is asked.
    const orderId = await readReceipt(repo, [RECEIPT[2]!]);

    const [row] = await repo.itemsFor(orderId);
    expect(row!.unitsPerCase).toBe(4);
    expect(row!.issues).toEqual([]);
  });
});
