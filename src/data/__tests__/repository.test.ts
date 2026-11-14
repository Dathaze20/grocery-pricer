import { beforeEach, describe, expect, it } from 'vitest';
import { OrderImageType } from '../../core/ai-types';
import { resetDbHandle } from '../db';
import { Repository } from '../repository';
import { OrderStatus } from '../schema';

let dbCounter = 3000;

async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  dbCounter += 1;
  return Repository.open(`repo-db-${dbCounter}`);
}

describe('deleteEmptyDrafts', () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await freshRepo();
  });

  it('removes a draft nobody put a photo in', async () => {
    const abandoned = await repo.createOrder();

    expect(await repo.deleteEmptyDrafts()).toBe(1);
    expect(await repo.order(abandoned.id)).toBeNull();
  });

  it('keeps a draft that has photos in it', async () => {
    const started = await repo.createOrder();
    await repo.addPhoto({
      orderId: started.id,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'image/jpeg',
      type: OrderImageType.UNKNOWN,
      isDeliveryPhoto: false,
      createdAt: Date.now(),
    });

    // Work in progress, not litter: the shopkeeper photographed a receipt and walked away.
    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect(await repo.order(started.id)).not.toBeNull();
  });

  it('never touches an order that was processed', async () => {
    const done = await repo.createOrder();
    await repo.updateOrder(done.id, { status: OrderStatus.READY, itemCount: 3 });

    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect((await repo.order(done.id))?.status).toBe(OrderStatus.READY);
  });

  it('leaves a failed order alone so its reason can still be read', async () => {
    const failed = await repo.createOrder();
    await repo.updateOrder(failed.id, {
      status: OrderStatus.FAILED,
      failureMessage: 'Free Gemini quota reached.',
    });

    expect(await repo.deleteEmptyDrafts()).toBe(0);
    expect((await repo.order(failed.id))?.failureMessage).toContain('quota');
  });

  it('clears several at once and leaves the rest of the list intact', async () => {
    await repo.createOrder();
    await repo.createOrder();
    const kept = await repo.createOrder();
    await repo.updateOrder(kept.id, { status: OrderStatus.READY });

    expect(await repo.deleteEmptyDrafts()).toBe(2);
    expect((await repo.recentOrders()).map((o) => o.id)).toEqual([kept.id]);
  });
});
