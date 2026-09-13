import type { ImagePart } from '../ai/gemini';

/**
 * Gets a photograph small enough to send without making the print unreadable.
 *
 * A phone camera produces a 4000px, 5MB JPEG. Sending several of those at once is slow on shop
 * wi-fi and can be refused outright for size. But a receipt photographed and then shrunk too far
 * is a receipt that cannot be read, and an unreadable receipt is a wrong price. 1600px on the long
 * edge is the compromise: roughly a third of the bytes, with the small print still legible.
 */
export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 0.85;

/** A photograph as it is stored: raw bytes, not a Blob. See StoredPhoto for why. */
export interface RawImage {
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
}

export async function toImagePart(image: RawImage, maxEdge: number = MAX_EDGE_PX): Promise<ImagePart> {
  const resized = await downscale(image, maxEdge);
  return { mimeType: resized.mimeType, data: toBase64(resized.bytes) };
}

/**
 * Shrinks an image if the browser can, and returns it untouched if it cannot.
 *
 * Failing to resize is not a reason to fail to process an order: a large photo that works slowly
 * beats an error message. Every failure path here returns the original bytes.
 */
export async function downscale(image: RawImage, maxEdge: number = MAX_EDGE_PX): Promise<RawImage> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return image;

  const blob = new Blob([image.bytes], { type: image.mimeType });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return image;
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxEdge) return image;

    const scale = maxEdge / longest;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) return image;
    context.drawImage(bitmap, 0, 0, width, height);

    const shrunk = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    // A "shrunk" image that came out bigger is not an improvement.
    if (shrunk.size >= image.bytes.byteLength) return image;
    return { bytes: await shrunk.arrayBuffer(), mimeType: 'image/jpeg' };
  } catch {
    return image;
  } finally {
    bitmap.close();
  }
}

/** Base64 with no `data:` prefix, which is what Gemini's inlineData wants. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: a spread of a multi-megabyte array blows the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A displayable URL for a stored photo. The caller revokes it when the view goes away. */
export function toObjectUrl(image: RawImage): string {
  return URL.createObjectURL(new Blob([image.bytes], { type: image.mimeType }));
}

export async function readFile(file: File | Blob): Promise<RawImage> {
  return { bytes: await file.arrayBuffer(), mimeType: file.type || 'image/jpeg' };
}
