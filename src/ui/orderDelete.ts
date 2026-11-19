import type { Repository } from '../data/repository';
import { OrderStatus } from '../data/schema';

/**
 * Deleting one saved order, and what came of it.
 *
 * Lives outside the screen because each of these outcomes has to be provable. An order that is
 * being read must survive; a delete that fails must leave the order alone and say so rather than
 * disappearing a row that is still in storage; and neither can be demonstrated by looking at a
 * component. The screen decides what to show - this decides what happens.
 */
export type DeleteOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'processing'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export const STILL_READING =
  'That order is being read right now, so it was left alone. Try again when it has finished.';
export const DELETE_FAILED =
  'That order could not be deleted. Nothing was removed - try again.';

/**
 * Deletes exactly one order, if it is safe to.
 *
 * The status is read again here rather than trusted from the list on screen: a reading can start
 * while a confirmation is open, and deleting an order from under the reader would leave the run
 * writing products into rows that no longer exist.
 */
export async function deleteSavedOrder(repo: Repository, orderId: number): Promise<DeleteOutcome> {
  try {
    const order = await repo.order(orderId);
    // Already gone - someone deleted it on another tab. The list refresh is still right.
    if (order === null) return { kind: 'gone' };
    if (order.status === OrderStatus.PROCESSING) {
      return { kind: 'processing', message: STILL_READING };
    }

    await repo.deleteOrder(orderId);
    return { kind: 'deleted' };
  } catch {
    // Storage refused. The order is still there, so nothing may claim otherwise.
    return { kind: 'failed', message: DELETE_FAILED };
  }
}
