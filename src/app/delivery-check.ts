import { aiErrorMessage, type AiError } from '../core/ai-types';
import { reconcileDelivery, summariseDelivery, type DeliveryReconciliation, type InvoiceLine } from '../core/delivery';
import type { AiProvider, IdentifiedImage } from '../ai/provider';
import type { Repository } from '../data/repository';
import { MessageRole, type StoredDeliveryCheck, type StoredPhoto } from '../data/schema';
import { toImagePart } from './images';

export interface DeliveryCheckResult {
  readonly ok: boolean;
  readonly reconciliation: DeliveryReconciliation | null;
  readonly saved: StoredDeliveryCheck | null;
  readonly error: AiError | null;
  readonly summary: string;
}

/** Photos per counting call. Counting is harder than reading, so fewer at a time. */
export const PHOTOS_PER_COUNT_BATCH = 2;

/**
 * Workflow 2: the pallet arrived, is it all there?
 *
 * The invoice is whatever the app already read and stored. The photographs are what the driver
 * left on the floor. This compares the two and reports the difference *with its evidence* - never
 * as a verdict. A photograph cannot see the back of a stack, and telling a shopkeeper that four
 * cases are missing when they are simply behind the front row starts an argument with a supplier
 * over nothing.
 */
export async function checkDelivery(
  repo: Repository,
  provider: AiProvider,
  orderId: number,
  photoIds: readonly number[],
): Promise<DeliveryCheckResult> {
  const items = await repo.itemsFor(orderId);
  if (items.length === 0) {
    return {
      ok: false,
      reconciliation: null,
      saved: null,
      error: null,
      summary: 'Process the receipt first, then I will know what should have arrived.',
    };
  }

  const photos: StoredPhoto[] = [];
  for (const id of photoIds) {
    const photo = await repo.photo(id);
    if (photo !== null) photos.push(photo);
  }
  if (photos.length === 0) {
    return {
      ok: false,
      reconciliation: null,
      saved: null,
      error: null,
      summary: 'Take a photo of what arrived and I will check it against the invoice.',
    };
  }

  const sightings = [];
  const warnings: string[] = [];
  for (let i = 0; i < photos.length; i += PHOTOS_PER_COUNT_BATCH) {
    const batch = photos.slice(i, i + PHOTOS_PER_COUNT_BATCH);
    const parts: IdentifiedImage[] = [];
    for (const photo of batch) {
      parts.push({
        photoId: photo.id,
        ...(await toImagePart({ bytes: photo.bytes, mimeType: photo.mimeType })),
      });
    }
    const counted = await provider.countCases(parts);
    if (!counted.ok) {
      // A failed count is not an empty delivery. Saying nothing arrived would be worse than
      // saying nothing at all.
      return {
        ok: false,
        reconciliation: null,
        saved: null,
        error: counted.error,
        summary: aiErrorMessage(counted.error),
      };
    }
    sightings.push(...counted.value.sightings);
    warnings.push(...counted.value.warnings);
  }

  const invoice: InvoiceLine[] = items.map((item) => ({
    itemId: item.id,
    name: item.displayName,
    size: item.size,
    expectedCases: item.casesPurchased,
  }));

  const reconciliation = reconcileDelivery(invoice, sightings, warnings);
  const summary = summariseDelivery(reconciliation);

  const saved = await repo.saveDeliveryCheck({
    orderId,
    createdAt: Date.now(),
    lines: reconciliation.lines.map((line) => ({
      itemId: line.itemId,
      name: line.name,
      size: line.size,
      expectedCases: line.expectedCases,
      countedCases: line.countedCases,
      status: line.status,
      confidence: line.confidence,
      needsAnotherPhoto: line.needsAnotherPhoto,
      message: line.message,
      sourcePhotoIds: [...line.sourcePhotoIds],
    })),
    warnings: [...reconciliation.warnings],
  });

  await repo.say(orderId, MessageRole.APP, deliveryMessage(reconciliation, summary));

  return { ok: true, reconciliation, saved, error: null, summary };
}

/** The chat message: the headline, then only the lines that need the shopkeeper to do something. */
function deliveryMessage(result: DeliveryReconciliation, summary: string): string {
  const needsAttention = result.lines.filter(
    (line) => line.status !== 'CONFIRMED' && line.status !== 'NOT_PHOTOGRAPHED',
  );
  const notPhotographed = result.lines.filter((line) => line.status === 'NOT_PHOTOGRAPHED');

  const parts = [summary];
  for (const line of needsAttention) parts.push(line.message);
  if (notPhotographed.length > 0) {
    parts.push(
      `Still to photograph: ${notPhotographed.map((l) => l.name).join(', ')}.`,
    );
  }
  if (result.warnings.length > 0) parts.push(...result.warnings);
  return parts.join('\n\n');
}
