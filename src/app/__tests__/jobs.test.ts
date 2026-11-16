import { describe, expect, it, vi } from 'vitest';
import { FakeAiProvider } from '../../ai/fake';
import { Money } from '../../core/money';
import { Repository } from '../../data/repository';
import { resetDbHandle } from '../../data/db';
import { OrderImageType, type AiExtractedItem } from '../../core/ai-types';
import { OrderStatus } from '../../data/schema';
import { jobs, type JobState } from '../jobs';

let n = 0;
async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  n += 1;
  return Repository.open(`jobs-db-${n}`);
}

async function orderWithPhoto(repo: Repository): Promise<number> {
  const order = await repo.createOrder();
  await repo.addPhoto({
    orderId: order.id,
    bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    mimeType: 'image/jpeg',
    type: OrderImageType.RECEIPT,
    isDeliveryPhoto: false,
    createdAt: Date.now(),
  });
  return order.id;
}

function item(over: Partial<AiExtractedItem> = {}): AiExtractedItem {
  return {
    rawName: 'HELLM MAYONNAISE 8Z',
    canonicalName: "Hellmann's Mayonnaise",
    casePrice: '24.00',
    unitsPerCase: 6,
    casesPurchased: 1,
    sourcePhotoIds: [1],
    sourceText: ['HELLM MAYONNAISE 8Z 24.00'],
    confidence: 0.9,
    ...over,
  };
}

/** Waits for the job to reach a final state, the way the chat screen does. */
async function settle(orderId: number): Promise<JobState> {
  return new Promise((resolve) => {
    const stop = jobs.subscribe(orderId, (state) => {
      if (state.kind === 'done' || state.kind === 'failed') {
        stop();
        resolve(state);
      }
    });
  });
}

describe('processing that outlives the screen that started it', () => {
  it('runs to completion with nobody watching, then reports to a late subscriber', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });

    // Started, and then nobody is listening - exactly what happens when New Order unmounts.
    jobs.start(repo, async () => provider, orderId);
    const state = await settle(orderId);

    expect(state.kind).toBe('done');
    expect(await repo.itemsFor(orderId)).toHaveLength(1);
    expect((await repo.order(orderId))!.status).toBe(OrderStatus.READY);

    // A screen arriving afterwards is told the outcome rather than finding nothing.
    const late: JobState[] = [];
    jobs.subscribe(orderId, (s) => late.push(s))();
    expect(late[0]?.kind).toBe('done');
  });

  it('reports progress to whoever is listening', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });

    const steps: string[] = [];
    jobs.subscribe(orderId, (s) => {
      if (s.kind === 'running') steps.push(s.step);
    });

    jobs.start(repo, async () => provider, orderId);
    await settle(orderId);

    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]).toBe('Starting');
  });

  it('will not start the same order twice', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });

    const build = vi.fn(async () => provider);
    // A second press, or coming back to the chat while the first run is still going.
    jobs.start(repo, build, orderId);
    jobs.start(repo, build, orderId);
    jobs.start(repo, build, orderId);
    await settle(orderId);

    expect(build).toHaveBeenCalledTimes(1);
    expect(await repo.itemsFor(orderId)).toHaveLength(1);
  });

  it('says it is running while it runs, and stops saying so afterwards', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });

    jobs.start(repo, async () => provider, orderId);
    expect(jobs.isRunning(orderId)).toBe(true);
    await settle(orderId);
    expect(jobs.isRunning(orderId)).toBe(false);
  });

  it('reports a failure without touching the photographs or approved prices', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();
    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });

    jobs.start(repo, async () => provider, orderId);
    await settle(orderId);
    const first = (await repo.itemsFor(orderId))[0]!;
    await repo.approvePrice(first.id, Money.of('6.25'));

    provider.queueFailure({ kind: 'timeout' });
    jobs.start(repo, async () => provider, orderId, { reprocess: true });
    const state = await settle(orderId);

    expect(state.kind).toBe('failed');
    // The retry button in the chat relies on all of this still being here.
    expect(await repo.photosFor(orderId, false)).toHaveLength(1);
    const after = await repo.itemsFor(orderId);
    expect(after).toHaveLength(1);
    expect(after[0]!.approvedPrice).toBe(Money.of('6.25').toStorage());
  });

  it('can be retried after a failure and succeed', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);
    const provider = new FakeAiProvider();

    provider.queueFailure({ kind: 'timeout' });
    jobs.start(repo, async () => provider, orderId);
    expect((await settle(orderId)).kind).toBe('failed');

    provider.queueExtraction({ supplier: 'JETRO', items: [item()], warnings: [] });
    jobs.start(repo, async () => provider, orderId);
    expect((await settle(orderId)).kind).toBe('done');
    expect(await repo.itemsFor(orderId)).toHaveLength(1);
  });

  it('turns a thrown error into a reported failure rather than a lost job', async () => {
    const repo = await freshRepo();
    const orderId = await orderWithPhoto(repo);

    jobs.start(
      repo,
      async () => {
        throw new Error('no provider today');
      },
      orderId,
    );
    const state = await settle(orderId);

    expect(state.kind).toBe('failed');
    expect(jobs.isRunning(orderId)).toBe(false);
    if (state.kind === 'failed') expect(state.result.summary).toContain('no provider today');
  });
});
