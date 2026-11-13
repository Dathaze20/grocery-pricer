import { describe, expect, it } from 'vitest';
import { Money } from '../money';

describe('Money', () => {
  it('is immune to the float arithmetic that makes 0.1 + 0.2 wrong', () => {
    // The whole reason this class exists rather than using numbers directly.
    expect(Money.of('0.1').plus(Money.of('0.2')).format()).toBe('$0.30');
    expect(Money.of('0.1').plus(Money.of('0.2')).equals(Money.of('0.3'))).toBe(true);

    // A hundred thirty-cent items is exactly thirty dollars, not $29.999999999999996.
    let total = Money.ZERO;
    for (let i = 0; i < 100; i++) total = total.plus(Money.of('0.30'));
    expect(total.format()).toBe('$30.00');
  });

  it('treats equal amounts written differently as equal', () => {
    expect(Money.of('2.50').equals(Money.of('2.5'))).toBe(true);
    expect(Money.of(2.5).equals(Money.of('2.50'))).toBe(true);
    expect(Money.of('0').equals(Money.ZERO)).toBe(true);
  });

  it('keeps four decimal places when dividing a case across its units', () => {
    // $45.59 over 10 units. Rounding to cents here would lose money on every unit.
    const unit = Money.of('45.59').divideBy(10);
    expect(unit.formatPrecise()).toBe('$4.5590');
    expect(unit.format()).toBe('$4.56');
  });

  it('does not let a lost fraction accumulate into a wrong total', () => {
    // $10.00 over 3 is $3.3333 a unit. Three of those is not ten dollars, and the app must not
    // claim it is - but it must also not drift further than a rounding of the real figure.
    const unit = Money.of('10.00').divideBy(3);
    expect(unit.formatPrecise()).toBe('$3.3333');
    expect(unit.times(3).format()).toBe('$10.00');
  });

  it('rounds half-up in both directions', () => {
    expect(Money.of('0.005').format()).toBe('$0.01');
    expect(Money.of('-0.005').format()).toBe('-$0.01');
    expect(Money.of('2.345').roundedToCents().format()).toBe('$2.35');
  });

  it('formats negatives with the sign outside the symbol', () => {
    expect(Money.of('-4.56').format()).toBe('-$4.56');
    expect(Money.of('-4.56').toPlainString()).toBe('-4.56');
    expect(Money.ZERO.format()).toBe('$0.00');
  });

  it('round-trips through storage without losing precision', () => {
    const unit = Money.of('45.59').divideBy(10);
    expect(Money.fromStorage(unit.toStorage()).equals(unit)).toBe(true);
    expect(Money.fromStorage(unit.toStorage()).formatPrecise()).toBe('$4.5590');
  });

  describe('parsing values lifted out of OCR or a model reply', () => {
    it('reads the shapes a receipt actually prints', () => {
      expect(Money.parseOrNull('33.99')?.format()).toBe('$33.99');
      expect(Money.parseOrNull('$33.99')?.format()).toBe('$33.99');
      expect(Money.parseOrNull(' $1,234.56 ')?.format()).toBe('$1234.56');
      expect(Money.parseOrNull('.99')?.format()).toBe('$0.99');
      expect(Money.parseOrNull('12.')?.format()).toBe('$12.00');
      expect(Money.parseOrNull('(8.00)')?.format()).toBe('-$8.00');
      expect(Money.parseOrNull('-8.00')?.format()).toBe('-$8.00');
    });

    it('refuses anything it cannot read rather than guessing', () => {
      // A guess here becomes a wrong shelf price in a real shop.
      expect(Money.parseOrNull('thirty three ninety nine')).toBeNull();
      expect(Money.parseOrNull('12.34.56')).toBeNull();
      expect(Money.parseOrNull('1e5')).toBeNull();
      expect(Money.parseOrNull('NaN')).toBeNull();
      expect(Money.parseOrNull('')).toBeNull();
      expect(Money.parseOrNull('   ')).toBeNull();
      expect(Money.parseOrNull(null)).toBeNull();
      expect(Money.parseOrNull(undefined)).toBeNull();
    });

    it('keeps more precision than a float would', () => {
      // 0.1 in binary floating point is not 0.1. Parsing digit by digit avoids ever creating one.
      expect(Money.parseOrNull('0.1')?.toStorage()).toBe(1000);
      expect(Money.parseOrNull('4.5590')?.toStorage()).toBe(45590);
      // Beyond four places it rounds rather than truncating.
      expect(Money.parseOrNull('4.55905')?.toStorage()).toBe(45591);
      expect(Money.parseOrNull('4.55904')?.toStorage()).toBe(45590);
    });
  });

  it('compares and sums', () => {
    expect(Money.of('3.00').greaterThan(Money.of('2.99'))).toBe(true);
    expect(Money.of('3.00').lessThan(Money.of('3.00'))).toBe(false);
    expect(Money.sum([Money.of('1.01'), Money.of('2.02'), Money.of('3.03')]).format()).toBe('$6.06');
    expect(Money.sum([]).equals(Money.ZERO)).toBe(true);
  });

  it('reports sign without floating point ambiguity', () => {
    expect(Money.ZERO.isZero).toBe(true);
    expect(Money.of('-1').isNegative).toBe(true);
    expect(Money.of('-1').abs().format()).toBe('$1.00');
    expect(Money.of('-1').coerceAtLeastZero().equals(Money.ZERO)).toBe(true);
  });

  it('refuses to divide by zero instead of producing Infinity', () => {
    expect(() => Money.of('10').divideBy(0)).toThrow();
    expect(Money.of('10').ratioTo(Money.ZERO)).toBeNull();
    expect(Money.of('5').ratioTo(Money.of('10'))).toBeCloseTo(0.5, 6);
  });
});
