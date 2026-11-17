import { beforeEach, describe, expect, it } from 'vitest';
import { Money } from '../../core/money';
import { Category, DiscountScope } from '../../core/models';
import { ItemConfidence } from '../../core/models';
import { PricingSource } from '../../core/pricing';
import { resetDbHandle } from '../db';
import { Repository } from '../repository';
import type { StoredItem } from '../schema';

let n = 0;
async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  n += 1;
  return Repository.open(`revise-db-${n}`);
}

/** A row exactly as the receipt was read: discount present, scope never established. */
async function rowAsRead(
  repo: Repository,
  over: { casePrice: string; unitsPerCase: number | null; discount: string | null; name: string },
): Promise<StoredItem> {
  const order = await repo.createOrder();
  const [saved] = await repo.addItems([
    {
      orderId: order.id,
      productId: null,
      rawName: over.name,
      displayName: over.name,
      size: null,
      upc: null,
      supplierSku: null,
      category: Category.OTHER,
      casePrice: Money.of(over.casePrice).toStorage(),
      unitsPerCase: over.unitsPerCase,
      casesPurchased: 1,
      looseUnits: 0,
      discount:
        over.discount === null
          ? null
          : {
              description: 'Flyer',
              amount: Money.of(over.discount).toStorage(),
              scope: DiscountScope.UNKNOWN,
              appliesToUnits: null,
            },
      trueUnitCost: null,
      totalWholesaleCost: null,
      suggestedPrice: null,
      pricingSource: PricingSource.COST_TIER,
      pricingRationale: '',
      approvedPrice: null,
      previousPrice: null,
      confidence: ItemConfidence.NEEDS_REVIEW,
      aiConfidence: 0.8,
      issues: ['UNKNOWN_DISCOUNT_SCOPE'],
      sourcePhotoIds: [],
      sourceText: [],
    },
  ]);
  return saved!;
}

describe('answering what the receipt did not say', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('Pampers: saying the $7.00 is off the case gives $9.75 a package', async () => {
    const row = await rowAsRead(repo, {
      name: 'Pampers Jumbo Size 6',
      casePrice: '45.99',
      unitsPerCase: 4,
      discount: '7.00',
    });

    const revised = await repo.reviseItem(row.id, { scope: DiscountScope.WHOLE_CASE });

    expect(Money.fromStorage(revised!.trueUnitCost!).format()).toBe('$9.75');
    expect(revised!.discount!.scope).toBe(DiscountScope.WHOLE_CASE);
    // The question has been answered, so the row stops asking it.
    expect(revised!.issues).not.toContain('UNKNOWN_DISCOUNT_SCOPE');
  });

  it('Cesar: $29.39 case, 4 units, $1.40 off gives $7.00 each', async () => {
    const row = await rowAsRead(repo, {
      name: 'Cesar Filet Mignon 2.7 lb',
      casePrice: '29.39',
      unitsPerCase: 4,
      discount: '1.40',
    });

    const revised = await repo.reviseItem(row.id, { scope: DiscountScope.WHOLE_CASE });
    expect(Money.fromStorage(revised!.trueUnitCost!).format()).toBe('$7.00');
  });

  it('Febreze: the pack count is the missing piece, not the discount', async () => {
    // The receipt printed a price and a flyer discount but no pieces per pack, so there was
    // no cost at all - dividing by nothing is not a number.
    const row = await rowAsRead(repo, {
      name: 'Febreze Air Spring Clean 8.1 oz',
      casePrice: '9.89',
      unitsPerCase: null,
      discount: '0.50',
    });
    expect(row.trueUnitCost).toBeNull();

    // The owner counted the bottles. Nothing here guessed four.
    const revised = await repo.reviseItem(row.id, {
      unitsPerCase: 4,
      scope: DiscountScope.WHOLE_CASE,
    });

    expect(Money.fromStorage(revised!.trueUnitCost!).format()).toBe('$2.35');
    expect(revised!.unitsPerCase).toBe(4);
  });

  it('a pack count alone still leaves an unapplied discount unapplied', async () => {
    const row = await rowAsRead(repo, {
      name: 'Febreze Air Spring Clean 8.1 oz',
      casePrice: '9.89',
      unitsPerCase: null,
      discount: '0.50',
    });

    const revised = await repo.reviseItem(row.id, { unitsPerCase: 4 });

    // $9.89 / 4, because nobody has said what the 50 cents comes off yet. Still asking.
    expect(Money.fromStorage(revised!.trueUnitCost!).format()).toBe('$2.47');
    expect(revised!.issues).toContain('UNKNOWN_DISCOUNT_SCOPE');
  });

  it('never overwrites a price the owner approved', async () => {
    const row = await rowAsRead(repo, {
      name: 'Pampers Jumbo Size 6',
      casePrice: '45.99',
      unitsPerCase: 4,
      discount: '7.00',
    });
    await repo.approvePrice(row.id, Money.of('14.99'));

    const revised = await repo.reviseItem(row.id, { scope: DiscountScope.WHOLE_CASE });

    // The cost is corrected; what the shop charges stays the shop's decision.
    expect(Money.fromStorage(revised!.trueUnitCost!).format()).toBe('$9.75');
    expect(Money.fromStorage(revised!.approvedPrice!).format()).toBe('$14.99');
  });

  it('leaves every other row of the order alone', async () => {
    const row = await rowAsRead(repo, {
      name: 'Pampers Jumbo Size 6',
      casePrice: '45.99',
      unitsPerCase: 4,
      discount: '7.00',
    });
    const { id: _ignored, ...shape } = row;
    const [other] = await repo.addItems([shape]);

    await repo.reviseItem(row.id, { scope: DiscountScope.WHOLE_CASE });

    const untouched = await repo.item(other!.id);
    expect(untouched!.trueUnitCost).toBeNull();
    expect(untouched!.discount!.scope).toBe(DiscountScope.UNKNOWN);
  });

  it('ignores an item that is not there rather than throwing', async () => {
    expect(await repo.reviseItem(9999, { scope: DiscountScope.WHOLE_CASE })).toBeNull();
  });
});

describe('a count the owner establishes is not asked for twice', () => {
  it('remembers it against the product', async () => {
    const repo = await freshRepo();
    const product = await repo.findOrCreateProduct({
      displayName: 'Febreze Air Spring Clean',
      size: '8.1 OZ',
      upc: null,
    });
    expect(product.unitsPerCase ?? null).toBeNull();

    const order = await repo.createOrder();
    const [row] = await repo.addItems([
      {
        orderId: order.id,
        productId: product.id,
        rawName: 'FEBREZE AIR SPRING',
        displayName: 'Febreze Air Spring Clean',
        size: '8.1 OZ',
        upc: null,
        supplierSku: null,
        category: Category.OTHER,
        casePrice: Money.of('9.89').toStorage(),
        unitsPerCase: null,
        casesPurchased: 1,
        looseUnits: 0,
        discount: null,
        trueUnitCost: null,
        totalWholesaleCost: null,
        suggestedPrice: null,
        pricingSource: PricingSource.COST_TIER,
        pricingRationale: '',
        approvedPrice: null,
        previousPrice: null,
        confidence: ItemConfidence.NEEDS_REVIEW,
        aiConfidence: 0.8,
        issues: ['MISSING_UNITS_PER_CASE'],
        sourcePhotoIds: [],
        sourceText: [],
      },
    ]);

    await repo.reviseItem(row!.id, { unitsPerCase: 4 });

    // Counted once. The next receipt for this product will not ask.
    expect((await repo.product(product.id))!.unitsPerCase).toBe(4);
  });

  it('refuses a count that is not a whole number of pieces', async () => {
    const repo = await freshRepo();
    const product = await repo.findOrCreateProduct({
      displayName: 'Example Product',
      size: null,
      upc: null,
    });

    for (const bad of [0, -3, 2.5, Number.NaN]) {
      await repo.rememberUnitsPerCase(product.id, bad);
      expect((await repo.product(product.id))!.unitsPerCase ?? null, String(bad)).toBeNull();
    }
  });

  it('a product saved before this existed reads as unknown, with no migration', async () => {
    const repo = await freshRepo();
    const product = await repo.findOrCreateProduct({
      displayName: 'Older Product',
      size: null,
      upc: null,
    });

    // The shape of every product saved before the field existed.
    expect((await repo.product(product.id))!.unitsPerCase ?? null).toBeNull();
  });
});
