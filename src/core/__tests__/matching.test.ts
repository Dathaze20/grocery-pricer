import { describe, expect, it } from 'vitest';
import { NameNormalizer, SizeParser, normalizeUpc, sizesMatch, upcEquivalent } from '../matching';

describe('SizeParser', () => {
  it('reads the size shapes a wholesale receipt prints', () => {
    expect(SizeParser.canonicalOrNull('HELLM MAYONNAISE 8Z')).toBe('8 OZ');
    expect(SizeParser.canonicalOrNull('DOWNY 10 FL OZ')).toBe('10 OZ');
    expect(SizeParser.canonicalOrNull('KELL FROOT LOOP FM 13.2Z')).toBe('13.2 OZ');
    expect(SizeParser.canonicalOrNull('WATER 750ML')).toBe('750 ML');
    expect(SizeParser.canonicalOrNull('RICE 2.5 LB')).toBe('2.5 LB');
    expect(SizeParser.canonicalOrNull('NAPKINS 12 CT')).toBe('12 CT');
    expect(SizeParser.canonicalOrNull('MILK 1 GAL')).toBe('1 GAL');
  });

  it('prefers the right-most size, where receipts put it', () => {
    // "24/12 OZ" is a case of 24 twelve-ounce units. The retail unit is 12 oz.
    expect(SizeParser.canonicalOrNull('SODA 24/12 OZ')).toBe('12 OZ');
  });

  it('does not mistake a number in a brand name for a size', () => {
    expect(SizeParser.parse('7UP')).toBeNull();
    expect(SizeParser.parse('V8 JUICE')).toBeNull();
    expect(SizeParser.parse('HELLMANNS MAYONNAISE')).toBeNull();
    expect(SizeParser.parse('')).toBeNull();
    expect(SizeParser.parse(null)).toBeNull();
  });

  it('keeps different sizes apart', () => {
    const eight = SizeParser.parse('8 oz')!;
    const fifteen = SizeParser.parse('15 oz')!;
    const eightCt = SizeParser.parse('8 ct')!;
    expect(sizesMatch(eight, eight)).toBe(true);
    expect(sizesMatch(eight, fifteen)).toBe(false);
    // Same number, different unit. Eight ounces is not eight cans.
    expect(sizesMatch(eight, eightCt)).toBe(false);
  });

  it('strips the size so the name can be matched on its own', () => {
    expect(SizeParser.stripSize('HELLM MAYONNAISE 8Z')).toBe('HELLM MAYONNAISE');
  });
});

describe('NameNormalizer', () => {
  it('normalises away punctuation, possessives, sizes and noise words', () => {
    expect(NameNormalizer.normalize("Hellmann's Mayonnaise 8 oz")).toBe('HELLMANN MAYONNAISE');
    expect(NameNormalizer.normalize('RED & WHITE CORN OIL')).toBe('RED WHITE CORN OIL');
  });

  it('scores an OCR-mangled name against a clean one', () => {
    // The case this exists for: the same product read two different ways.
    expect(NameNormalizer.similarity('HELLM MAYONNAISE', "Hellmann's Mayonnaise")).toBeGreaterThan(0.7);
  });

  it('does not confuse two different products that look alike', () => {
    expect(NameNormalizer.similarity('TIDE', 'TIDY')).toBeLessThan(0.7);
    expect(NameNormalizer.similarity('Corn Oil', 'Vegetable Oil')).toBeLessThan(0.7);
  });

  it('leaves product names containing O, S and B alone', () => {
    // A character-correction pass that "fixed" these would rename real products.
    for (const name of ['OSBORNE', 'BOSCO', 'SOBE']) {
      expect(NameNormalizer.normalize(name)).toBe(name);
    }
  });

  it('handles empty input without dividing by zero', () => {
    expect(NameNormalizer.similarity('', 'anything')).toBe(0);
    expect(NameNormalizer.similarity(null, null)).toBe(0);
    expect(NameNormalizer.levenshteinRatio('', '')).toBe(1);
  });
});

describe('barcodes', () => {
  it('treats UPC-A and EAN-13 for the same product as the same', () => {
    expect(upcEquivalent('050000000123', '0050000000123')).toBe(true);
    expect(upcEquivalent('050000000123', '050000000124')).toBe(false);
  });

  it('refuses things that are not barcodes', () => {
    expect(normalizeUpc('12')).toBeNull();
    expect(normalizeUpc('not a barcode')).toBeNull();
    expect(normalizeUpc(null)).toBeNull();
    expect(upcEquivalent(null, '050000000123')).toBe(false);
  });
});
