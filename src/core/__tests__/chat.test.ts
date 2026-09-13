import { describe, expect, it } from 'vitest';
import { Money } from '../money';
import { ChatAnswerFormatter, parseChatIntent, type PriceAnswer } from '../chat';

describe('parseChatIntent', () => {
  function lookup(text: string) {
    const intent = parseChatIntent(text);
    expect(intent.kind, `expected a price lookup for "${text}"`).toBe('priceLookup');
    return intent.kind === 'priceLookup' ? intent.request : { phrase: '' };
  }

  it('recognises the everyday price questions locally', () => {
    expect(lookup('How much is the Carnation milk?').phrase).toBe('carnation milk');
    expect(lookup('What did we pay for the cereal?').phrase).toBe('cereal');
    expect(lookup('How much should I charge for the cereal?').phrase).toBe('cereal');
  });

  it('carries plurality and any stated count', () => {
    expect(lookup('How much are the two juices?').expectMultiple).toBe(true);
    expect(lookup('How much are the two juices?').expectedCount).toBe(2);
    expect(lookup('How much are these three oils?').expectedCount).toBe(3);
    expect(lookup('How much is the mayonnaise?').expectMultiple).toBe(false);
  });

  it('tells a case-count question from a price question', () => {
    expect(parseChatIntent('How many bottles are in the case?').kind).toBe('caseQuantity');
    expect(parseChatIntent('how many come in the box').kind).toBe('caseQuantity');
  });

  it('routes delivery questions to the reconciliation, not to pricing', () => {
    for (const question of [
      "What's missing?",
      'Did everything arrive?',
      'What still needs verifying?',
      'Did anything arrive that is not on the invoice?',
    ]) {
      expect(parseChatIntent(question).kind, question).toBe('deliveryCheck');
    }
  });

  it('does not mistake "how many were supposed to arrive" for a case count', () => {
    // That is a delivery question about quantities, not a question about pack size.
    expect(parseChatIntent('How many of these were supposed to arrive?').kind).not.toBe('caseQuantity');
  });

  it('carries the price out of a profit question', () => {
    const intent = parseChatIntent("What's my profit if I sell it for 7.99?");
    expect(intent.kind).toBe('profitAt');
    if (intent.kind === 'profitAt') expect(intent.retailPrice.equals(Money.of('7.99'))).toBe(true);
  });

  it('recognises cost filters', () => {
    const intent = parseChatIntent('Show me all the products under $3 cost');
    expect(intent.kind).toBe('costUnder');
    if (intent.kind === 'costUnder') expect(intent.limit.equals(Money.of('3'))).toBe(true);
  });

  describe('price corrections', () => {
    function correction(text: string) {
      const intent = parseChatIntent(text);
      expect(intent.kind, `expected a correction for "${text}"`).toBe('correction');
      return intent.kind === 'correction' ? intent.targets : [];
    }

    it('"I put 7.99" corrects whatever was being discussed', () => {
      const [target] = correction('I put 7.99');
      expect(target?.kind).toBe('current');
      expect(target?.price.equals(Money.of('7.99'))).toBe(true);
    });

    it('"make that" corrects the current product too', () => {
      expect(correction('Make that 8.99')[0]?.kind).toBe('current');
    });

    it('resolves an ordinal against the last list', () => {
      const [target] = correction('Number two should be 7.99');
      expect(target?.kind).toBe('ordinal');
      if (target?.kind === 'ordinal') expect(target.position).toBe(2);
    });

    it('takes two numbered corrections from one sentence', () => {
      const targets = correction('Number one 2.99 and number two 11.99');
      expect(targets).toHaveLength(2);
      expect(targets[0]?.price.format()).toBe('$2.99');
      expect(targets[1]?.price.format()).toBe('$11.99');
    });

    it('applies "all the cereals are 7.99" to everything just listed', () => {
      expect(correction('All the cereals are 7.99')[0]?.kind).toBe('allListed');
    });

    it('never treats a question that merely mentions a price as a correction', () => {
      // The one that would quietly rewrite a shelf price if it went wrong.
      expect(parseChatIntent("What's my profit if I sell it for 7.99?").kind).not.toBe('correction');
      expect(parseChatIntent('How much is the 7.99 cereal?').kind).not.toBe('correction');
      expect(parseChatIntent('Is 7.99 too much?').kind).not.toBe('correction');
    });
  });

  it('bails out to the model rather than guessing', () => {
    expect(parseChatIntent('hmm').kind).toBe('unknown');
    expect(parseChatIntent('').kind).toBe('unknown');
  });
});

describe('ChatAnswerFormatter', () => {
  const mayo: PriceAnswer = {
    itemId: 1,
    displayName: "Hellmann's Mayonnaise",
    size: '8 oz',
    unitCost: Money.of('2.17'),
    suggestedRetail: Money.of('4.99'),
  };

  const milk: PriceAnswer = {
    itemId: 2,
    displayName: 'Carnation Evaporated Milk',
    size: '12 oz',
    unitCost: Money.of('4.20'),
    suggestedRetail: Money.of('7.99'),
    unitsPerCase: 8,
    unitNoun: 'can',
  };

  it('renders one product exactly as the brief specifies', () => {
    expect(ChatAnswerFormatter.single(mayo)).toBe("Hellmann's Mayonnaise 8 oz\n$2.17 → $4.99");
  });

  it('numbers several products', () => {
    const oils: PriceAnswer[] = [
      { itemId: 1, displayName: 'Red & White Vegetable Oil', size: '48 oz', unitCost: Money.of('4.36'), suggestedRetail: Money.of('7.99') },
      { itemId: 2, displayName: 'Red & White Corn Oil', size: '48 oz', unitCost: Money.of('4.64'), suggestedRetail: Money.of('8.99') },
      { itemId: 3, displayName: 'Red & White Corn Oil', size: '32 oz', unitCost: Money.of('3.35'), suggestedRetail: Money.of('6.99') },
    ];
    expect(ChatAnswerFormatter.numbered(oils)).toBe(
      '1. Red & White Vegetable Oil 48 oz\n$4.36 → $7.99\n\n' +
        '2. Red & White Corn Oil 48 oz\n$4.64 → $8.99\n\n' +
        '3. Red & White Corn Oil 32 oz\n$3.35 → $6.99',
    );
  });

  it('does not number a single-item list', () => {
    expect(ChatAnswerFormatter.numbered([mayo])).toBe(ChatAnswerFormatter.single(mayo));
  });

  it('renders a case count with the right noun and plural', () => {
    expect(ChatAnswerFormatter.caseQuantity(milk)).toBe('Carnation Evaporated Milk 12 oz\n8 cans per case.');
    expect(ChatAnswerFormatter.caseQuantity({ ...milk, unitsPerCase: 1 })).toContain('1 can per case.');
    expect(ChatAnswerFormatter.caseQuantity({ ...milk, unitNoun: null })).toContain('8 units per case.');
  });

  it('renders profit as cost, sell and gross profit', () => {
    expect(ChatAnswerFormatter.profitAt(milk, Money.of('7.99'))).toBe(
      'Carnation Evaporated Milk 12 oz\nCost: $4.20\nSell: $7.99\nGross profit: $3.79 each',
    );
  });

  it('says what was saved', () => {
    expect(ChatAnswerFormatter.savedPrice(mayo, Money.of('6.99'))).toBe(
      "Saved. Hellmann's Mayonnaise 8 oz → $6.99",
    );
  });

  it('lets what the user set outrank what was suggested', () => {
    expect(ChatAnswerFormatter.single({ ...mayo, approvedRetail: Money.of('6.99') })).toContain('$6.99');
  });

  it('says so rather than inventing a number when the cost is unreadable', () => {
    const unknown = { ...mayo, unitCost: null, suggestedRetail: null };
    expect(ChatAnswerFormatter.single(unknown)).toContain('could not read the cost');
    expect(ChatAnswerFormatter.profitAt(unknown, Money.of('7.99'))).toContain('cannot work out');
  });

  it('reports a cost change in both directions from Money arithmetic', () => {
    expect(
      ChatAnswerFormatter.costChange({ ...mayo, unitCost: Money.of('2.39'), previousUnitCost: Money.of('2.17') }),
    ).toBe('The cost went up $0.22 from $2.17.');
    expect(
      ChatAnswerFormatter.costChange({ ...mayo, unitCost: Money.of('2.00'), previousUnitCost: Money.of('2.17') }),
    ).toBe('The cost went down $0.17 from $2.17.');
    expect(ChatAnswerFormatter.costChange({ ...mayo, previousUnitCost: Money.of('2.17') })).toBeNull();
  });
});
