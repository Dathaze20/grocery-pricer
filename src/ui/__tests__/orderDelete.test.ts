import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderImageType } from '../../core/ai-types';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { OrderStatus } from '../../data/schema';
import { DELETE_FAILED, STILL_READING, deleteSavedOrder } from '../orderDelete';

let n = 0;
async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  n += 1;
  return Repository.open(`delete-db-${n}`);
}

async function savedOrder(repo: Repository): Promise<number> {
  const order = await repo.createOrder();
  await repo.addPhoto({
    orderId: order.id,
    bytes: new Uint8Array([1, 2, 3]).buffer,
    mimeType: 'image/jpeg',
    type: OrderImageType.RECEIPT,
    isDeliveryPhoto: false,
    createdAt: Date.now(),
  });
  return order.id;
}

describe('deleting a saved order', () => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('deletes the one it was asked to', async () => {
    const id = await savedOrder(repo);

    expect(await deleteSavedOrder(repo, id)).toEqual({ kind: 'deleted' });
    expect(await repo.order(id)).toBeNull();
  });

  it('leaves every other order exactly where it was', async () => {
    const keep = await savedOrder(repo);
    const remove = await savedOrder(repo);

    await deleteSavedOrder(repo, remove);

    expect(await repo.order(keep)).not.toBeNull();
    expect(await repo.photosFor(keep)).toHaveLength(1);
  });

  it('refuses an order that is being read right now', async () => {
    const id = await savedOrder(repo);
    await repo.updateOrder(id, { status: OrderStatus.PROCESSING });

    const outcome = await deleteSavedOrder(repo, id);

    expect(outcome).toEqual({ kind: 'processing', message: STILL_READING });
    // Still there, photographs and all - the reading is writing into it.
    expect(await repo.order(id)).not.toBeNull();
    expect(await repo.photosFor(id)).toHaveLength(1);
  });

  it('refuses it even when it started processing after the question was asked', async () => {
    const id = await savedOrder(repo);
    // What the screen saw when it opened the confirmation.
    expect((await repo.order(id))!.status).toBe(OrderStatus.DRAFT);
    await repo.updateOrder(id, { status: OrderStatus.PROCESSING });

    expect((await deleteSavedOrder(repo, id)).kind).toBe('processing');
    expect(await repo.order(id)).not.toBeNull();
  });

  it('says a failure is a failure, and does not pretend the order went', async () => {
    const id = await savedOrder(repo);
    const boom = vi.spyOn(repo, 'deleteOrder').mockRejectedValue(new Error('storage refused'));

    const outcome = await deleteSavedOrder(repo, id);

    expect(outcome).toEqual({ kind: 'failed', message: DELETE_FAILED });
    expect(await repo.order(id)).not.toBeNull();
    boom.mockRestore();
  });

  it('treats an order that has already gone as nothing to do', async () => {
    const id = await savedOrder(repo);
    await repo.deleteOrder(id);

    expect(await deleteSavedOrder(repo, id)).toEqual({ kind: 'gone' });
  });

});
