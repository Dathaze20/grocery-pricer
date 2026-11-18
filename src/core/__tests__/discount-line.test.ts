import { describe, expect, it } from 'vitest';
import { orderExtractionPrompt } from '../../ai/prompts';
import { parseChatIntent } from '../chat';

describe('the receipt reader is told that discounts have their own line', () => {
  const prompt = orderExtractionPrompt([1, 2]);

  it('says a discount line belongs to the product it follows', () => {
    // The root cause of the missing Pampers and Cesar discounts: the prompt described
    // "discount" as a field of a product line and never said that the money off is printed
    // underneath, on a line of its own, which the model therefore skipped.
    expect(prompt).toMatch(/own line/i);
    expect(prompt).toMatch(/belongs to the product line/i);
    expect(prompt).toMatch(/never drop it/i);
  });

  it('shows the two-line shape with the real figures', () => {
    expect(prompt).toContain('PAMPERS JUMBO #6 21CT');
    expect(prompt).toContain('45.99');
    expect(prompt).toContain('7.00');
  });

  it('still tells it to guess no scope', () => {
    expect(prompt).toMatch(/UNKNOWN is the safe answer/);
  });
});

describe('asking about a discount is not asking about a price', () => {
  it('recognises the question the shop actually asked', () => {
    const intent = parseChatIntent(
      'What is my actual cost for Cesar Filet Mignon 2.7 lb? Did you record a $1.40 flyer discount? Check my saved receipt information. If the discount is missing, tell me.',
    );
    expect(intent.kind).toBe('discountQuery');
  });

  it('recognises the shorter ways of asking', () => {
    for (const text of [
      'did you record the flyer discount on the pampers',
      'was there a discount on the cesar filet mignon',
      'what discount did you read for the pampers jumbo',
    ]) {
      expect(parseChatIntent(text).kind, text).toBe('discountQuery');
    }
  });

  it('does not treat a number inside the question as a price to save', () => {
    // "$1.40" is the shopkeeper's recollection, not an instruction to set a price.
    const intent = parseChatIntent('Did you record a $1.40 flyer discount on the cesar?');
    expect(intent.kind).not.toBe('correction');
  });

  it('leaves ordinary price questions alone', () => {
    expect(parseChatIntent('how much is the mayonnaise').kind).toBe('priceLookup');
    expect(parseChatIntent('what should I sell the pampers for').kind).toBe('priceLookup');
  });
});
