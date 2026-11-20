import { describe, expect, it } from 'vitest';
import { orderExtractionPrompt } from '../../ai/prompts';
import { parseChatIntent } from '../chat';

describe('the receipt reader is told that discounts have their own line', () => {
  const prompt = orderExtractionPrompt([1, 2]);

  it('asks for every money-off line as a list of its own', () => {
    /*
     * Why this is a list and not a field.
     *
     * Telling the model where the money off is printed was not enough: eighty-one products came
     * back from a real seven-photograph order with not one discount among them. Carrying an
     * amount backwards over four lines and nesting it in the right object is bookkeeping.
     * Listing the lines it can see is reading, which is the thing it is good at - and whose
     * line it is then gets decided by code that can refuse.
     */
    expect(prompt).toContain('"discountLines"');
    expect(prompt).toMatch(/list every line of money off/i);
    expect(prompt).toMatch(/even when you are not sure which product/i);
  });

  it('shows the shape the receipt actually prints, reference line and all', () => {
    // Four lines between the product and its amount, with a reference number in between.
    expect(prompt).toContain('FLYER DISCOUNT');
    expect(prompt).toContain('-7.00');
    expect(prompt).toContain('UNITS 1');
    expect(prompt).toMatch(/four lines below the product/i);
  });

  it('says an index is a position in the answer, not a line on the paper', () => {
    // An index read as a line number silently takes money off the wrong product.
    expect(prompt).toMatch(/position of the product in the "items" array/i);
    expect(prompt).toMatch(/counting\s*\n?from 0 - not a line number/i);
  });

  it('prefers an unplaced line to a guessed one', () => {
    expect(prompt).toMatch(/Null is not a failure here/i);
    expect(prompt).toMatch(/never invent an amount/i);
  });

  it('still tells it to guess no scope', () => {
    expect(prompt).toMatch(/UNKNOWN whenever the receipt does not/i);
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
