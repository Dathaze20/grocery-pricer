/**
 * A money-safe amount.
 *
 * JavaScript has no BigDecimal, and `0.1 + 0.2 !== 0.3` is not an acceptable property for
 * something that sets shelf prices. So an amount is stored as an *integer* count of
 * ten-thousandths of a dollar and every operation is integer arithmetic. No float ever touches a
 * price; the only division that rounds does so explicitly, half-up, exactly as the Kotlin
 * BigDecimal version did.
 *
 * Ten-thousandths (four decimal places) is enough to divide a case cost across its retail units
 * without losing fractions of a cent. `Number.MAX_SAFE_INTEGER` at this scale is about $900
 * billion, which is comfortably more than a deli spends on mayonnaise.
 */
export class Money {
  /** Tenths of a cent. Enough to divide a case across a few hundred units. */
  static readonly INTERNAL_SCALE = 4;
  static readonly DISPLAY_SCALE = 2;
  static readonly RATIO_SCALE = 6;

  private static readonly UNITS_PER_DOLLAR = 10_000;
  private static readonly UNITS_PER_CENT = 100;

  /** Ten-thousandths of a dollar. Always an integer. */
  readonly raw: number;

  private constructor(raw: number) {
    if (!Number.isFinite(raw)) throw new RangeError('Money must be a finite amount');
    if (!Number.isSafeInteger(raw)) {
      throw new RangeError(`Money amount is out of range: ${raw}`);
    }
    this.raw = raw;
  }

  static readonly ZERO: Money = new Money(0);

  /** From a whole or fractional number of dollars. */
  static of(value: number | string): Money {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError('Money must be a finite amount');
      return new Money(roundHalfUp(value * Money.UNITS_PER_DOLLAR));
    }
    const parsed = Money.parseOrNull(value);
    if (parsed === null) throw new RangeError(`Not a money amount: ${value}`);
    return parsed;
  }

  static ofCents(cents: number): Money {
    return new Money(roundHalfUp(cents) * Money.UNITS_PER_CENT);
  }

  /** Exact round-trip for storage. The inverse of {@link toStorage}. */
  static fromStorage(raw: number): Money {
    return new Money(Math.trunc(raw));
  }

  /**
   * Best-effort parse of a value lifted out of OCR text or a model's reply.
   *
   * Tolerates `$`, thousands separators, whitespace and parenthesised negatives. Returns null
   * rather than guessing - a price that cannot be read is not a price.
   */
  static parseOrNull(raw: string | null | undefined): Money | null {
    if (raw === null || raw === undefined) return null;
    let text = raw.trim();
    if (text.length === 0) return null;

    let negative = false;
    if (text.startsWith('(') && text.endsWith(')')) {
      negative = true;
      text = text.slice(1, -1);
    }
    if (text.startsWith('-')) {
      negative = true;
      text = text.slice(1);
    }

    text = text.replaceAll('$', '').replaceAll(',', '').replaceAll(' ', '').trim();
    if (text.length === 0) return null;
    // A trailing dot is allowed - OCR drops the cents off "12.00" often enough - but there has
    // to be at least one digit somewhere, so "." and "-" are still refused.
    if (!/^\d*(\.\d*)?$/.test(text) || !/\d/.test(text)) return null;
    if (text.startsWith('.')) text = `0${text}`;
    if (text.endsWith('.')) text = text.slice(0, -1);
    if (text.length === 0) return null;

    // Parsed digit by digit rather than through parseFloat, so a long fraction is truncated
    // deterministically instead of arriving via a float that already lost precision.
    const [whole = '0', fraction = ''] = text.split('.');
    const padded = (fraction + '0000').slice(0, Money.INTERNAL_SCALE);
    const dropped = fraction.slice(Money.INTERNAL_SCALE);
    const units = Number(whole) * Money.UNITS_PER_DOLLAR + Number(padded || '0');
    if (!Number.isSafeInteger(units)) return null;

    // Anything beyond four decimal places still rounds rather than truncating.
    const rounded = dropped.length > 0 && Number(dropped[0]) >= 5 ? units + 1 : units;
    const value = new Money(rounded);
    return negative ? value.negated() : value;
  }

  static sum(values: Iterable<Money>): Money {
    let total = Money.ZERO;
    for (const value of values) total = total.plus(value);
    return total;
  }

  plus(other: Money): Money {
    return new Money(this.raw + other.raw);
  }

  minus(other: Money): Money {
    return new Money(this.raw - other.raw);
  }

  negated(): Money {
    return new Money(-this.raw);
  }

  times(quantity: number): Money {
    if (!Number.isFinite(quantity)) throw new RangeError('Cannot multiply money by that');
    return new Money(roundHalfUp(this.raw * quantity));
  }

  /** Divides across `parts`, keeping four decimal places (e.g. $45.59 / 10 = $4.5590). */
  divideBy(parts: number): Money {
    if (!Number.isFinite(parts) || parts === 0) {
      throw new RangeError(`Cannot divide money into ${parts} parts`);
    }
    return new Money(roundHalfUp(this.raw / parts));
  }

  /** Ratio of this amount to `other`, as a plain number (not money). Null when `other` is zero. */
  ratioTo(other: Money): number | null {
    if (other.isZero) return null;
    const factor = 10 ** Money.RATIO_SCALE;
    return roundHalfUp((this.raw / other.raw) * factor) / factor;
  }

  /** The amount a customer actually sees: two decimal places, half-up. */
  roundedToCents(): Money {
    return new Money(roundHalfUp(this.raw / Money.UNITS_PER_CENT) * Money.UNITS_PER_CENT);
  }

  get isZero(): boolean {
    return this.raw === 0;
  }
  get isNegative(): boolean {
    return this.raw < 0;
  }
  get isPositive(): boolean {
    return this.raw > 0;
  }

  abs(): Money {
    return this.isNegative ? this.negated() : this;
  }

  coerceAtLeastZero(): Money {
    return this.isNegative ? Money.ZERO : this;
  }

  compareTo(other: Money): number {
    return this.raw - other.raw;
  }
  equals(other: Money): boolean {
    return this.raw === other.raw;
  }
  lessThan(other: Money): boolean {
    return this.raw < other.raw;
  }
  greaterThan(other: Money): boolean {
    return this.raw > other.raw;
  }

  /** Whole cents, rounded half-up. */
  toCents(): number {
    return roundHalfUp(this.raw / Money.UNITS_PER_CENT);
  }

  /** Exact stored value, so nothing is lost across a save/load cycle. */
  toStorage(): number {
    return this.raw;
  }

  /** `4.56` - no currency symbol, always two decimals. Use for CSV export. */
  toPlainString(): string {
    const cents = Math.abs(this.toCents());
    const body = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    return this.isNegative && cents !== 0 ? `-${body}` : body;
  }

  /** `$4.56` - what the user reads on screen. */
  format(): string {
    const plain = this.toPlainString();
    return plain.startsWith('-') ? `-$${plain.slice(1)}` : `$${plain}`;
  }

  /** `$4.5590` - for the few places where the extra precision matters. */
  formatPrecise(): string {
    const units = Math.abs(this.raw);
    const whole = Math.trunc(units / Money.UNITS_PER_DOLLAR);
    const fraction = String(units % Money.UNITS_PER_DOLLAR).padStart(Money.INTERNAL_SCALE, '0');
    return `${this.isNegative ? '-' : ''}$${whole}.${fraction}`;
  }

  toString(): string {
    return this.format();
  }

  toJSON(): number {
    return this.raw;
  }
}

/**
 * Half-up rounding, including for negatives.
 *
 * `Math.round` rounds -0.5 to -0 (half-*up* towards positive infinity), which would quietly make
 * a refund a cent different from the charge that produced it.
 */
function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
