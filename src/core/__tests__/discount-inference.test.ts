import { describe, expect, it } from 'vitest';
import { DiscountScope, scopeFromReceiptText } from '../models';

describe('reading a discount off the receipt instead of asking', () => {
  it('takes a Jetro flyer line as a case-level deduction', () => {
    // The line as Jetro prints it, under the product it belongs to.
    expect(scopeFromReceiptText(['Flyer 43 - PEDIGREE ADULT CR PUPPY DRY'])).toBe(
      DiscountScope.WHOLE_CASE,
    );
    expect(scopeFromReceiptText(['PAMPERS JUMBO SZ6', 'Flyer 12 - PAMPERS JUMBO'])).toBe(
      DiscountScope.WHOLE_CASE,
    );
  });

  it('refuses to decide when the line talks about units', () => {
    // Genuinely ambiguous. Applying the wrong reading changes what the shop charges, so these
    // are still asked about.
    for (const line of [
      'FEBREZE AIR 8.1Z  $0.50 each',
      'CESAR FILET  $1.40 per unit',
      'GROUND BEEF  $0.20 per lb',
      'Flyer 43 - SOMETHING  $1.00 ea',
    ]) {
      expect(scopeFromReceiptText([line]), line).toBeNull();
    }
  });

  it('refuses to decide when there is no text to read', () => {
    expect(scopeFromReceiptText([])).toBeNull();
    expect(scopeFromReceiptText([''])).toBeNull();
    expect(scopeFromReceiptText(['   '])).toBeNull();
  });

  it('refuses when the line says nothing about a flyer or a case', () => {
    expect(scopeFromReceiptText(['HELLM MAYONNAISE 8Z  24.00'])).toBeNull();
    expect(scopeFromReceiptText(['DISCOUNT 2.00'])).toBeNull();
  });

  it('never returns anything but whole case or nothing at all', () => {
    const lines = ['Flyer 1', 'case discount', 'promo case', 'off case', 'nothing here', ''];
    for (const line of lines) {
      const scope = scopeFromReceiptText([line]);
      expect(scope === null || scope === DiscountScope.WHOLE_CASE, line).toBe(true);
    }
  });
});
