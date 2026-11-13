import { describe, expect, it } from 'vitest';
import type { AiCaseSighting } from '../ai-types';
import {
  CONFIDENT_COUNT,
  DeliveryStatus,
  reconcileDelivery,
  summariseDelivery,
  type InvoiceLine,
} from '../delivery';

function line(over: Partial<InvoiceLine> = {}): InvoiceLine {
  return { itemId: 1, name: 'BUDWEISER', size: '24 CT', expectedCases: 8, ...over };
}

function sighting(over: Partial<AiCaseSighting> = {}): AiCaseSighting {
  return {
    brand: 'BUDWEISER',
    productName: null,
    size: '24 CT',
    packDescription: null,
    countedCases: 8,
    mayBeHidden: false,
    confidence: 0.9,
    sourcePhotoIds: [1],
    ...over,
  };
}

describe('reconcileDelivery', () => {
  it('confirms a line when the count matches the invoice', () => {
    const result = reconcileDelivery([line()], [sighting()]);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.status).toBe(DeliveryStatus.CONFIRMED);
    expect(result.lines[0]!.difference).toBe(0);
    expect(result.lines[0]!.needsAnotherPhoto).toBe(false);
    expect(result.confirmed).toBe(1);
  });

  it('reports the brief\'s worked example as possibly missing, not missing', () => {
    // "Receipt says: Budweiser 24-pack - 8 cases / Visible with confidence: 7 cases"
    const result = reconcileDelivery(
      [line({ expectedCases: 8 })],
      [sighting({ countedCases: 7, mayBeHidden: true, confidence: 0.9 })],
    );

    const only = result.lines[0]!;
    expect(only.status).toBe(DeliveryStatus.POSSIBLY_MISSING);
    expect(only.countedCases).toBe(7);
    expect(only.difference).toBe(-1);
    expect(only.needsAnotherPhoto).toBe(true);
    expect(only.message).toContain('part of the stack may be hidden');
    expect(only.message).toContain('before calling it missing');
    expect(only.message).not.toMatch(/appears to be missing/);
  });

  it('calls a shortfall likely only when the view is clear and the count is confident', () => {
    const result = reconcileDelivery(
      [line({ expectedCases: 8 })],
      [sighting({ countedCases: 6, mayBeHidden: false, confidence: 0.95 })],
    );

    const only = result.lines[0]!;
    expect(only.status).toBe(DeliveryStatus.LIKELY_MISSING);
    expect(only.needsAnotherPhoto).toBe(false);
    expect(only.message).toContain('2 cases appear to be missing');
    expect(result.likelyMissing).toBe(1);
  });

  it('hedges a shortfall when the count itself was unsure, even with nothing hidden', () => {
    const result = reconcileDelivery(
      [line({ expectedCases: 8 })],
      [sighting({ countedCases: 5, mayBeHidden: false, confidence: CONFIDENT_COUNT - 0.01 })],
    );

    const only = result.lines[0]!;
    expect(only.status).toBe(DeliveryStatus.POSSIBLY_MISSING);
    expect(only.needsAnotherPhoto).toBe(true);
    expect(only.message).toContain('I am not confident in the count');
  });

  it('takes the highest count across photos of one stack rather than the sum', () => {
    // The same pallet photographed three times from different angles is still one pallet.
    const result = reconcileDelivery(
      [line({ expectedCases: 8 })],
      [
        sighting({ countedCases: 5, confidence: 0.6, sourcePhotoIds: [1] }),
        sighting({ countedCases: 8, confidence: 0.9, sourcePhotoIds: [2] }),
        sighting({ countedCases: 6, confidence: 0.7, sourcePhotoIds: [3] }),
      ],
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.countedCases).toBe(8);
    expect(result.lines[0]!.status).toBe(DeliveryStatus.CONFIRMED);
    expect(result.lines[0]!.sourcePhotoIds).toEqual([1, 2, 3]);
  });

  it('keeps the best confidence and any hidden-stack warning across duplicate photos', () => {
    const result = reconcileDelivery(
      [line({ expectedCases: 8 })],
      [
        sighting({ countedCases: 7, mayBeHidden: true, confidence: 0.5, sourcePhotoIds: [1] }),
        sighting({ countedCases: 7, mayBeHidden: false, confidence: 0.95, sourcePhotoIds: [2] }),
      ],
    );

    const only = result.lines[0]!;
    expect(only.confidence).toBe(0.95);
    // One angle still could not see behind the stack, so the shortfall stays hedged.
    expect(only.status).toBe(DeliveryStatus.POSSIBLY_MISSING);
  });

  it('flags more cases than the invoice lists instead of silently accepting them', () => {
    const result = reconcileDelivery([line({ expectedCases: 4 })], [sighting({ countedCases: 6 })]);

    const only = result.lines[0]!;
    expect(only.status).toBe(DeliveryStatus.MORE_THAN_INVOICED);
    expect(only.difference).toBe(2);
    expect(only.message).toContain('another delivery');
    expect(result.extra).toBe(0);
  });

  it('does not call an unphotographed line missing', () => {
    const result = reconcileDelivery([line({ itemId: 2, name: 'CORONA', expectedCases: 3 })], []);

    const only = result.lines[0]!;
    expect(only.status).toBe(DeliveryStatus.NOT_PHOTOGRAPHED);
    expect(only.countedCases).toBeNull();
    expect(only.difference).toBeNull();
    expect(only.needsAnotherPhoto).toBe(true);
    expect(only.message).toContain('not in any photo yet');
    expect(only.message).not.toMatch(/missing/);
  });

  it('reports a photographed stack that no invoice line claimed', () => {
    const result = reconcileDelivery(
      [line({ name: 'BUDWEISER', expectedCases: 2 })],
      [
        sighting({ countedCases: 2 }),
        sighting({ brand: 'HEINEKEN', size: '12 CT', countedCases: 3, sourcePhotoIds: [4] }),
      ],
    );

    const extra = result.lines.find((l) => l.status === DeliveryStatus.NOT_ON_INVOICE);
    expect(extra).toBeDefined();
    expect(extra!.itemId).toBeNull();
    expect(extra!.expectedCases).toBeNull();
    expect(extra!.countedCases).toBe(3);
    expect(extra!.message).toContain('not on the invoice');
    expect(result.extra).toBe(1);
  });

  it('will not match a sighting of a different size to an invoice line', () => {
    const result = reconcileDelivery(
      [line({ name: 'BUDWEISER', size: '24 CT', expectedCases: 5 })],
      [sighting({ size: '12 CT', countedCases: 5 })],
    );

    expect(result.lines[0]!.status).toBe(DeliveryStatus.NOT_PHOTOGRAPHED);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]!.status).toBe(DeliveryStatus.NOT_ON_INVOICE);
  });

  it('matches an abbreviated sighting name to the invoice wording', () => {
    const result = reconcileDelivery(
      [line({ name: 'HELLM MAYONNAISE', size: '8 OZ', expectedCases: 2 })],
      [
        sighting({
          brand: 'HELLMANNS',
          productName: 'MAYONNAISE',
          size: '8 OZ',
          countedCases: 2,
        }),
      ],
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.status).toBe(DeliveryStatus.CONFIRMED);
  });

  it('does not let one sighting satisfy two invoice lines', () => {
    const result = reconcileDelivery(
      [
        line({ itemId: 1, name: 'BUDWEISER', expectedCases: 8 }),
        line({ itemId: 2, name: 'BUDWEISER', expectedCases: 8 }),
      ],
      [sighting({ countedCases: 8 })],
    );

    expect(result.lines[0]!.status).toBe(DeliveryStatus.CONFIRMED);
    expect(result.lines[1]!.status).toBe(DeliveryStatus.NOT_PHOTOGRAPHED);
  });

  it('carries the photo warnings through untouched', () => {
    const result = reconcileDelivery([line()], [sighting()], ['Photo 2 is too blurry to count.']);
    expect(result.warnings).toEqual(['Photo 2 is too blurry to count.']);
  });
});

describe('summariseDelivery', () => {
  it('names every outcome present and omits the ones that are not', () => {
    const result = reconcileDelivery(
      [
        line({ itemId: 1, name: 'BUDWEISER', size: '24 CT', expectedCases: 2 }),
        line({ itemId: 2, name: 'CORONA', size: '12 CT', expectedCases: 4 }),
        line({ itemId: 3, name: 'MODELO', size: '18 CT', expectedCases: 1 }),
      ],
      [
        sighting({ brand: 'BUDWEISER', size: '24 CT', countedCases: 2 }),
        sighting({
          brand: 'CORONA',
          size: '12 CT',
          countedCases: 3,
          mayBeHidden: true,
          sourcePhotoIds: [2],
        }),
      ],
    );

    expect(summariseDelivery(result)).toBe(
      '1 confirmed, 1 possibly short, 1 not photographed yet.',
    );
  });

  it('says only what it confirmed when everything checked out', () => {
    const result = reconcileDelivery([line({ expectedCases: 3 })], [sighting({ countedCases: 3 })]);
    expect(summariseDelivery(result)).toBe('1 confirmed.');
  });
});
