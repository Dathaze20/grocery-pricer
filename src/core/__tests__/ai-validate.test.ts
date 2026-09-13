import { describe, expect, it } from 'vitest';
import type { AiExtractedItem, AiOrderExtraction } from '../ai-types';
import {
  ExtractionIssue,
  MAX_PLAUSIBLE_CASES,
  MAX_PLAUSIBLE_UNITS_PER_CASE,
  itemsNeedingAttention,
  mergeExtractions,
  validateExtraction,
} from '../ai-validate';

function item(over: Partial<AiExtractedItem> = {}): AiExtractedItem {
  return {
    rawName: 'HELLM MAYONNAISE 8Z',
    canonicalName: "Hellmann's Mayonnaise",
    brand: 'HELLMANNS',
    size: '8 OZ',
    upc: null,
    supplierSku: null,
    casePrice: '41.99',
    unitsPerCase: 12,
    printedUnitCost: null,
    casesPurchased: 1,
    discount: null,
    category: null,
    sourcePhotoIds: [1],
    sourceText: ['HELLM MAYONNAISE 8Z 41.99'],
    confidence: 0.9,
    ...over,
  };
}

function extraction(items: AiExtractedItem[], warnings: string[] = []): AiOrderExtraction {
  return { supplier: 'JETRO', items, warnings };
}

describe('validateExtraction', () => {
  it('accepts a complete row untouched', () => {
    const result = validateExtraction(extraction([item()]), new Set([1]));

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.issues).toHaveLength(0);
    expect(result.accepted[0]!.isComplete).toBe(true);
    expect(result.rejected).toHaveLength(0);
    expect(result.supplier).toBe('JETRO');
  });

  it('throws away only a row with no name at all', () => {
    const result = validateExtraction(
      extraction([item({ rawName: null, canonicalName: null, brand: 'HELLMANNS' })]),
      new Set([1]),
    );

    // A brand is not a name you can ever refer to on a shelf.
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]!.reason).toBe(ExtractionIssue.NO_USABLE_NAME);
  });

  it('keeps a row whose price could not be read, and marks it incomplete', () => {
    const result = validateExtraction(extraction([item({ casePrice: null })]), new Set([1]));

    // Kept on purpose: the shopkeeper can ask about it and be told the price was not readable.
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.isComplete).toBe(false);
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.MISSING_CASE_PRICE);
    expect(itemsNeedingAttention(result)).toHaveLength(1);
  });

  it('refuses a price that is not a number', () => {
    const result = validateExtraction(extraction([item({ casePrice: 'about forty' })]), new Set([1]));

    expect(result.accepted[0]!.item.casePrice).toBeNull();
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.UNREADABLE_CASE_PRICE);
    expect(result.accepted[0]!.isComplete).toBe(false);
  });

  it('refuses a negative case price', () => {
    const result = validateExtraction(extraction([item({ casePrice: '-41.99' })]), new Set([1]));

    expect(result.accepted[0]!.item.casePrice).toBeNull();
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.NEGATIVE_CASE_PRICE);
  });

  it('refuses an absurd pack count rather than dividing by it', () => {
    for (const units of [0, -12, MAX_PLAUSIBLE_UNITS_PER_CASE + 1]) {
      const result = validateExtraction(extraction([item({ unitsPerCase: units })]), new Set([1]));
      expect(result.accepted[0]!.item.unitsPerCase).toBeNull();
      expect(result.accepted[0]!.issues).toContain(ExtractionIssue.INVALID_UNITS_PER_CASE);
      expect(result.accepted[0]!.isComplete).toBe(false);
    }
  });

  it('reads a missing case count as one case', () => {
    const result = validateExtraction(extraction([item({ casesPurchased: null })]), new Set([1]));

    expect(result.accepted[0]!.item.casesPurchased).toBe(1);
    expect(result.accepted[0]!.isComplete).toBe(true);
  });

  it('falls back to one case when the count is impossible, and says so', () => {
    const result = validateExtraction(
      extraction([item({ casesPurchased: MAX_PLAUSIBLE_CASES + 1 })]),
      new Set([1]),
    );

    expect(result.accepted[0]!.item.casesPurchased).toBe(1);
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.INVALID_CASES_PURCHASED);
  });

  it('clamps a confidence outside 0-1 and records that it was wrong', () => {
    const result = validateExtraction(extraction([item({ confidence: 1.4 })]), new Set([1]));

    expect(result.accepted[0]!.item.confidence).toBe(1);
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.CONFIDENCE_OUT_OF_RANGE);
  });

  it('drops a citation to a photo that was never imported', () => {
    const result = validateExtraction(
      extraction([item({ sourcePhotoIds: [1, 42] })]),
      new Set([1]),
    );

    // A fabricated citation is evidence about the row, so the row is kept and flagged.
    expect(result.accepted[0]!.item.sourcePhotoIds).toEqual([1]);
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.UNKNOWN_SOURCE_PHOTO);
  });

  it('notices a row with no evidence behind it at all', () => {
    const result = validateExtraction(
      extraction([item({ sourcePhotoIds: [], sourceText: [] })]),
      new Set([1]),
    );

    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.NO_SOURCE_EVIDENCE);
  });

  it('will not let a discount exceed the case price', () => {
    const result = validateExtraction(
      extraction([
        item({ casePrice: '24.00', discount: { amount: '90.00', scope: 'WHOLE_CASE', appliesToUnits: null } }),
      ]),
      new Set([1]),
    );

    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.DISCOUNT_EXCEEDS_CASE_PRICE);
  });

  it('marks a discount whose scope the model did not know', () => {
    const result = validateExtraction(
      extraction([
        item({ discount: { amount: '3.00', scope: 'probably per unit?', appliesToUnits: null } }),
      ]),
      new Set([1]),
    );

    expect(result.accepted[0]!.item.discount?.scope).toBe('UNKNOWN');
    expect(result.accepted[0]!.issues).toContain(ExtractionIssue.UNKNOWN_DISCOUNT_SCOPE);
  });

  it("carries the model's own warnings through", () => {
    const result = validateExtraction(extraction([item()], ['Photo 2 was too dark to read']), new Set([1]));
    expect(result.warnings).toEqual(['Photo 2 was too dark to read']);
  });
});

describe('mergeExtractions - the same receipt photographed twice', () => {
  it('does not bill the same line twice when two photos overlap', () => {
    const merged = mergeExtractions([
      extraction([item({ sourcePhotoIds: [1], confidence: 0.8 })]),
      extraction([item({ sourcePhotoIds: [2], confidence: 0.95 })]),
    ]);

    expect(merged.items).toHaveLength(1);
    // Both photos are kept as evidence, but there is one purchase.
    expect(merged.items[0]!.sourcePhotoIds).toEqual([1, 2]);
    expect(merged.items[0]!.confidence).toBe(0.95);
  });

  it('never adds the case counts of two photos of one line together', () => {
    const merged = mergeExtractions([
      extraction([item({ casesPurchased: 3, sourcePhotoIds: [1] })]),
      extraction([item({ casesPurchased: 3, sourcePhotoIds: [2] })]),
    ]);

    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]!.casesPurchased).toBe(3);
  });

  it('merges on a barcode even when the two size readings disagree', () => {
    const merged = mergeExtractions([
      extraction([item({ upc: '012345678905', size: '8 OZ', sourcePhotoIds: [1] })]),
      extraction([item({ upc: '012345678905', size: '8 0Z', sourcePhotoIds: [2], confidence: 0.99 })]),
    ]);

    expect(merged.items).toHaveLength(1);
  });

  it('keeps two genuinely different sizes apart', () => {
    const merged = mergeExtractions([
      extraction([item({ size: '8 OZ', casePrice: '41.99', sourcePhotoIds: [1] })]),
      extraction([item({ size: '15 OZ', casePrice: '58.99', sourcePhotoIds: [2] })]),
    ]);

    expect(merged.items).toHaveLength(2);
  });

  it('keeps the same product bought at two different prices apart', () => {
    // Two lines on one receipt at different prices are two purchases, not a misread.
    const merged = mergeExtractions([
      extraction([item({ casePrice: '41.99', sourcePhotoIds: [1] })]),
      extraction([item({ casePrice: '39.99', sourcePhotoIds: [1] })]),
    ]);

    expect(merged.items).toHaveLength(2);
  });

  it('matches an abbreviated name against its expansion at the same size and price', () => {
    const merged = mergeExtractions([
      extraction([item({ rawName: 'HELLM MAYO 8Z', canonicalName: null, sourcePhotoIds: [1] })]),
      extraction([item({ rawName: "HELLMANN'S MAYONNAISE 8Z", canonicalName: null, sourcePhotoIds: [2] })]),
    ]);

    expect(merged.items).toHaveLength(1);
  });

  it('keeps the first supplier anything actually named', () => {
    const merged = mergeExtractions([
      { supplier: null, items: [item({ sourcePhotoIds: [1] })], warnings: [] },
      { supplier: 'JETRO', items: [], warnings: [] },
    ]);

    expect(merged.supplier).toBe('JETRO');
  });

  it('does not repeat the same warning from every batch', () => {
    const merged = mergeExtractions([
      extraction([], ['The photo is blurry']),
      extraction([], ['The photo is blurry']),
    ]);

    expect(merged.warnings).toEqual(['The photo is blurry']);
  });

  it('returns an empty extraction rather than throwing on no batches', () => {
    const merged = mergeExtractions([]);
    expect(merged.items).toHaveLength(0);
    expect(merged.supplier).toBeNull();
  });
});
