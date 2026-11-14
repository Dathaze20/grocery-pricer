import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { Category, ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import type { StoredItem } from '../../data/schema';
import { ask } from '../conversation';

/**
 * Photograph to price - the thing the app is for.
 *
 * The shop has already processed a receipt. Now somebody is unpacking, photographs what is in
 * their hands, and asks what it is worth. Gemini is faked throughout: it says what the picture
 * shows and nothing else. Every figure in the reply comes from the stored receipt.
 *
 * All products and prices here are invented.
 */

let counter = 7000;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  counter += 1;
  return Repository.open(`photo-db-${counter}`);
}

function row(over: Partial<StoredItem> & { displayName: string; orderId: number }): Omit<StoredItem, 'id'> {
  return {
    productId: null,
    rawName: over.displayName,
    size: null,
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
    suggestedPrice: Money.of('4.99').toStorage(),
    pricingSource: PricingSource.COST_TIER,
    pricingRationale: 'Cost tier.',
    approvedPrice: null,
    previousPrice: null,
    confidence: ItemConfidence.HIGH,
    aiConfidence: 0.9,
    issues: [],
    sourcePhotoIds: [],
    sourceText: [],
    ...over,
  };
}

const PHOTO = { id: 1, image: { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/jpeg' } };

function seen(brand: string, productName: string, size: string, position: number) {
  return { brand, productName, size, variant: null, upc: null, position, confidence: 0.9 };
}

describe('photographing merchandise after the receipt is processed', () => {
  let repo: Repository;
  let orderId: number;

  beforeEach(async () => {
    repo = await freshRepo();
    const order = await repo.createOrder();
    orderId = order.id;
  });

  it('answers one product with its cost and selling price, nothing else', async () => {
    await repo.addItems([
      row({
        orderId,
        displayName: 'Example Overnight Pads Size 5',
        size: '20 CT',
        trueUnitCost: Money.of('6.50').toStorage(),
        suggestedPrice: Money.of('11.99').toStorage(),
      }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [seen('Example', 'Overnight Pads Size 5', '20 CT', 0)],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    expect(answer.text).toBe(
      'Example Overnight Pads Size 5 20 CT\n$6.50 each → $11.99 (suggested)',
    );
    // No table, no margin, no explanation of the arithmetic.
    expect(answer.text).not.toMatch(/margin|markup|%|profit/i);
  });

  it('answers three cases in one photo as a numbered list', async () => {
    await repo.addItems([
      row({ orderId, displayName: 'Example Plus Oxi', size: '56 OZ', trueUnitCost: Money.of('2.62').toStorage(), suggestedPrice: Money.of('5.99').toStorage() }),
      row({ orderId, displayName: 'Example Calypso Fresh', size: '57.6 OZ', trueUnitCost: Money.of('2.62').toStorage(), suggestedPrice: Money.of('5.99').toStorage() }),
      row({ orderId, displayName: 'Example Mountain Rain', size: '57.6 OZ', trueUnitCost: Money.of('2.62').toStorage(), suggestedPrice: Money.of('5.99').toStorage() }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [
        seen('Example', 'Plus Oxi', '56 OZ', 0),
        seen('Example', 'Calypso Fresh', '57.6 OZ', 1),
        seen('Example', 'Mountain Rain', '57.6 OZ', 2),
      ],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much are these three cases?', {
      photo: PHOTO,
    });

    expect(answer.text).toBe(
      '1. Example Plus Oxi 56 OZ\n   $2.62 each → $5.99 (suggested)\n' +
        '2. Example Calypso Fresh 57.6 OZ\n   $2.62 each → $5.99 (suggested)\n' +
        '3. Example Mountain Rain 57.6 OZ\n   $2.62 each → $5.99 (suggested)',
    );
    expect(answer.itemIds).toHaveLength(3);
  });

  it('shows an approved price as the price, without calling it a suggestion', async () => {
    const [item] = await repo.addItems([
      row({ orderId, displayName: 'Example Corn Oil', size: '48 OZ', trueUnitCost: Money.of('5.00').toStorage() }),
    ]);
    await repo.approvePrice(item!.id, Money.of('9.49'));

    const provider = new FakeAiProvider().queueIdentification({
      products: [seen('Example', 'Corn Oil', '48 OZ', 0)],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    expect(answer.text).toBe('Example Corn Oil 48 OZ\n$5.00 each → $9.49');
    expect(answer.text).not.toContain('suggested');
  });

  it('never invents a cost for something the receipt does not have', async () => {
    await repo.addItems([row({ orderId, displayName: 'Example Corn Oil', size: '48 OZ' })]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [seen('Unrelated', 'Shampoo', '12 OZ', 0)],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    expect(answer.text).toContain('not in this order');
    expect(answer.text).not.toMatch(/\$\d/);
    expect(answer.itemIds).toHaveLength(0);
  });

  it('prices what it recognises and says what it could not match', async () => {
    await repo.addItems([
      row({ orderId, displayName: 'Example Corn Oil', size: '48 OZ', trueUnitCost: Money.of('5.00').toStorage(), suggestedPrice: Money.of('8.99').toStorage() }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [seen('Example', 'Corn Oil', '48 OZ', 0), seen('Unrelated', 'Shampoo', '12 OZ', 1)],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much are these', { photo: PHOTO });

    expect(answer.text).toContain('$5.00 each → $8.99');
    expect(answer.text).toContain('could not match');
    expect(answer.itemIds).toHaveLength(1);
  });

  it('answers once for three cases of the same product', async () => {
    await repo.addItems([
      row({ orderId, displayName: 'Example Cat Litter', size: '7 LB', trueUnitCost: Money.of('3.25').toStorage(), suggestedPrice: Money.of('6.49').toStorage() }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [
        seen('Example', 'Cat Litter', '7 LB', 0),
        seen('Example', 'Cat Litter', '7 LB', 1),
        seen('Example', 'Cat Litter', '7 LB', 2),
      ],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much are these three cases?', {
      photo: PHOTO,
    });

    expect(answer.text).toBe('Example Cat Litter 7 LB\n$3.25 each → $6.49 (suggested)');
    expect(answer.itemIds).toEqual([1]);
  });

  it('refuses to guess between two sizes it cannot tell apart', async () => {
    await repo.addItems([
      row({ orderId, displayName: 'Example Detergent', size: '25 OZ', trueUnitCost: Money.of('2.00').toStorage() }),
      row({ orderId, displayName: 'Example Detergent', size: '40 OZ', trueUnitCost: Money.of('3.00').toStorage() }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [{ brand: 'Example', productName: 'Detergent', size: null, variant: null, upc: null, position: 0, confidence: 0.8 }],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    // The two cost different amounts. Picking one would be a coin flip on a real shelf price.
    expect(answer.text).not.toContain('$2.00');
    expect(answer.text).not.toContain('$3.00');
    expect(answer.itemIds).toHaveLength(0);
  });

  it('adds the profit only when asked for it', async () => {
    await repo.addItems([
      row({ orderId, displayName: 'Example Corn Oil', size: '48 OZ', trueUnitCost: Money.of('5.00').toStorage(), suggestedPrice: Money.of('8.99').toStorage() }),
    ]);

    const provider = new FakeAiProvider().queueIdentification({
      products: [seen('Example', 'Corn Oil', '48 OZ', 0)],
      warnings: [],
    });

    const answer = await ask(repo, provider, orderId, 'what profit do I make on this', {
      photo: PHOTO,
    });

    expect(answer.text).toContain('$5.00 each → $8.99');
    expect(answer.text).toContain('Gross profit');
  });

  it('says plainly when it cannot tell what the photo shows', async () => {
    await repo.addItems([row({ orderId, displayName: 'Example Corn Oil' })]);
    const provider = new FakeAiProvider().queueIdentification({ products: [], warnings: [] });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    expect(answer.text).toContain('could not tell what that is');
  });

  it('reports a quota failure rather than pricing from nothing', async () => {
    await repo.addItems([row({ orderId, displayName: 'Example Corn Oil' })]);
    const provider = new FakeAiProvider().queueFailure({ kind: 'quotaExhausted' });

    const answer = await ask(repo, provider, orderId, 'how much is this', { photo: PHOTO });

    expect(answer.text).toContain('will not charge you');
    expect(answer.text).not.toMatch(/\$\d/);
  });
});
