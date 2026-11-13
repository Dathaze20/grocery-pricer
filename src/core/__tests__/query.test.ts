import { describe, expect, it } from 'vitest';
import { Money } from '../money';
import { MAX_CANDIDATES, OrderQueryEngine, type QueryableItem } from '../query';

/**
 * These are the literal examples from the brief. Every one is a sentence the shopkeeper is
 * expected to be able to type, so each is pinned rather than left to whether scoring works out.
 *
 * The fixtures are fixtures. None of these products or prices ships in the app.
 */
function item(partial: Partial<QueryableItem> & { id: number; name: string }): QueryableItem {
  return {
    size: null,
    brand: null,
    category: 'Grocery',
    upc: null,
    supplierSku: null,
    unitsPerCase: 12,
    unitCost: Money.of('2.00'),
    suggestedRetail: Money.of('4.99'),
    approvedRetail: null,
    ...partial,
  };
}

const order: QueryableItem[] = [
  item({ id: 1, name: "Hellmann's Mayonnaise", size: '8 oz', brand: "Hellmann's", category: 'Condiments' }),
  item({ id: 2, name: "Hellmann's Mayonnaise", size: '15 oz', brand: "Hellmann's", category: 'Condiments' }),
  item({ id: 3, name: 'Tide Original', size: '40 fl oz', brand: 'Tide', category: 'Cleaning' }),
  item({ id: 4, name: 'Tide Original', size: '25 fl oz', brand: 'Tide', category: 'Cleaning' }),
  item({ id: 5, name: 'Red & White Corn Oil', size: '48 oz', category: 'Oils' }),
  item({ id: 6, name: 'Red & White Corn Oil', size: '32 oz', category: 'Oils' }),
  item({ id: 7, name: 'Red & White Vegetable Oil', size: '48 oz', category: 'Oils' }),
  item({ id: 8, name: 'Ocean Spray Cranberry Juice', size: '64 oz', category: 'Juice' }),
  item({ id: 9, name: "Mott's Apple Juice", size: '64 oz', category: 'Juice' }),
  item({ id: 10, name: 'Carnation Evaporated Milk', size: '12 oz', brand: 'Carnation', upc: '050000000123' }),
  item({ id: 11, name: 'Downy Soft April Fresh', size: '10 fl oz', brand: 'Downy' }),
];

const engine = new OrderQueryEngine(order);

function exactId(phrase: string): number {
  const outcome = engine.resolve({ phrase });
  expect(outcome.kind, `expected one answer for "${phrase}", got ${outcome.kind}`).toBe('exact');
  return outcome.kind === 'exact' ? outcome.item.id : -1;
}

describe('OrderQueryEngine', () => {
  it('resolves the shorthand a shopkeeper actually types', () => {
    expect(exactId('mayo 8')).toBe(1);
    expect(exactId('Tide 40')).toBe(3);
    expect(exactId('corn oil 48')).toBe(5);
  });

  it('works on a whole sentence as well as a bare phrase', () => {
    expect(exactId('How much is the Carnation milk?')).toBe(10);
    expect(exactId("What did we pay for the Hellmann's mayonnaise 8 oz?")).toBe(1);
  });

  it('asks rather than guessing when two sizes are on the receipt', () => {
    const outcome = engine.resolve({ phrase: 'the mayonnaise' });
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(new Set(outcome.candidates.map((c) => c.id))).toEqual(new Set([1, 2]));
    }
  });

  it('resolves that question when the size is given', () => {
    expect(exactId("Hellmann's Mayonnaise 8 oz")).toBe(1);
  });

  it('returns both when the wording is plural', () => {
    const outcome = engine.resolve({ phrase: 'the two juices', expectMultiple: true, expectedCount: 2 });
    expect(outcome.kind).toBe('several');
    if (outcome.kind === 'several') {
      expect(new Set(outcome.items.map((i) => i.id))).toEqual(new Set([8, 9]));
    }
  });

  it('returns all three oils for a plural group question', () => {
    const outcome = engine.resolve({ phrase: 'the oils', expectMultiple: true });
    expect(outcome.kind).toBe('several');
    if (outcome.kind === 'several') expect(outcome.items).toHaveLength(3);
  });

  it('treats a size the user named as a hard filter, never a preference', () => {
    // There is no 64 oz Tide. Answering with the 40 would be a wrong shelf price.
    expect(engine.resolve({ phrase: 'Tide 64 oz' }).kind).toBe('none');
  });

  it('returns nothing for a product that is simply not on this order', () => {
    expect(engine.resolve({ phrase: 'Heinz ketchup' }).kind).toBe('none');
    expect(engine.resolve({ phrase: '' }).kind).toBe('none');
  });

  it('resolves a barcode exactly or not at all', () => {
    expect(engine.byBarcode('050000000123')?.id).toBe(10);
    expect(engine.byBarcode('999999999999')).toBeNull();
    expect(engine.byBarcode(null)).toBeNull();
    expect(exactId('050000000123')).toBe(10);
  });

  it('filters by cost using Money comparison, never a float', () => {
    const priced = new OrderQueryEngine([
      item({ id: 1, name: 'Cheap', unitCost: Money.of('2.99') }),
      item({ id: 2, name: 'Exactly three', unitCost: Money.of('3.00') }),
      item({ id: 3, name: 'Dear', unitCost: Money.of('10.00') }),
      item({ id: 4, name: 'Unknown cost', unitCost: null }),
    ]);
    // Strictly under: $3.00 is not under $3.00, and an unknown cost is not under it either.
    expect(priced.costingUnder(Money.of('3.00')).map((i) => i.id)).toEqual([1]);
    expect(priced.costingOver(Money.of('3.00')).map((i) => i.id)).toEqual([3]);
  });

  it('keeps the model shortlist short and relevant', () => {
    const candidates = engine.candidatesFor('mayonnaise');
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(new Set(candidates.map((c) => c.id))).toEqual(new Set([1, 2]));
  });

  it('still offers something for the model when nothing matches', () => {
    expect(engine.candidatesFor('zzzz nothing like this').length).toBeGreaterThan(0);
  });

  it('returns ids in the order they were asked for', () => {
    expect(engine.byIds([9, 8]).map((i) => i.id)).toEqual([9, 8]);
    // An id from another order is dropped rather than throwing.
    expect(engine.byIds([8, 4242]).map((i) => i.id)).toEqual([8]);
  });

  it('matches categories case-insensitively', () => {
    expect(engine.inCategory('oils')).toHaveLength(3);
    expect(engine.inCategory('Oils')).toHaveLength(3);
    expect(engine.inCategory('Pet Food')).toHaveLength(0);
    expect(engine.inCategory(null)).toHaveLength(0);
  });
});
