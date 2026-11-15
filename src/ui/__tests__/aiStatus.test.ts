import { describe, expect, it } from 'vitest';
import { resetDbHandle } from '../../data/db';
import { Repository } from '../../data/repository';
import { shortAiFault } from '../services';
import type { AiError } from '../../core/ai-types';

let counter = 0;
async function freshRepo(): Promise<Repository> {
  resetDbHandle();
  counter += 1;
  return Repository.open(`ai-status-db-${counter}`);
}

describe('a saved key is not a working key', () => {
  it('starts with nothing confirmed and nothing wrong', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    const key = await repo.apiKey();

    // The state the old status line got wrong: a key is saved, and Gemini has never answered.
    expect(await repo.workingModel(key)).toBeNull();
    expect(await repo.lastAiFault(key)).toBeNull();
  });

  it('confirms only once a model has actually answered', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    const key = await repo.apiKey();

    await repo.rememberWorkingModel(key, 'gemini-3.8-flash');
    expect(await repo.workingModel(key)).toBe('gemini-3.8-flash');
    expect(await repo.lastAiFault(key)).toBeNull();
  });

  it('remembers a failure, in words with no model name or status code in them', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    const key = await repo.apiKey();

    await repo.recordAiFault(key, shortAiFault({ kind: 'noWorkingModel', tried: 3 }));
    const fault = await repo.lastAiFault(key);

    expect(fault).toBeTruthy();
    expect(fault).not.toContain('gemini');
    expect(fault).not.toContain('404');
    expect(fault).not.toContain('HTTP');
  });

  it('clears the failure as soon as a model answers', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    const key = await repo.apiKey();

    await repo.recordAiFault(key, 'something went wrong');
    await repo.rememberWorkingModel(key, 'gemini-3.8-flash');

    expect(await repo.lastAiFault(key)).toBeNull();
    expect(await repo.workingModel(key)).toBe('gemini-3.8-flash');
  });

  it('does not carry a verdict across to a different key', async () => {
    const repo = await freshRepo();
    await repo.recordAiFault('AIza-key-one', 'the key was rejected');
    await repo.rememberWorkingModel('AIza-key-one', 'gemini-3.8-flash');

    // A new key is usually a new Google project. Nothing learned about the old one applies.
    expect(await repo.lastAiFault('AIza-key-two')).toBeNull();
    expect(await repo.workingModel('AIza-key-two')).toBeNull();
  });

  it('can be reset to untested outright', async () => {
    const repo = await freshRepo();
    await repo.rememberWorkingModel('AIza-key-one', 'gemini-3.8-flash');
    await repo.recordAiFault('AIza-key-one', 'a fault');
    await repo.forgetAiHealth();

    expect(await repo.workingModel('AIza-key-one')).toBeNull();
    expect(await repo.lastAiFault('AIza-key-one')).toBeNull();
  });

  it('leaves the key, the override and the order data alone', async () => {
    const repo = await freshRepo();
    await repo.setApiKey('AIza-the-owners-own-key');
    await repo.setModel('typed-by-hand');
    const order = await repo.createOrder();

    await repo.recordAiFault('AIza-the-owners-own-key', 'a fault');
    await repo.forgetAiHealth();

    expect(await repo.apiKey()).toBe('AIza-the-owners-own-key');
    expect(await repo.model()).toBe('typed-by-hand');
    expect((await repo.order(order.id))!.id).toBe(order.id);
  });
});

describe('what a failure is reduced to for the status line', () => {
  const cases: Array<[AiError, string]> = [
    [{ kind: 'noWorkingModel', tried: 3 }, 'Google would not accept'],
    [{ kind: 'modelUnavailable', model: 'gemini-2.5-flash', status: 404 }, 'Google would not accept'],
    [{ kind: 'invalidKey' }, 'rejected'],
    [{ kind: 'quotaExhausted' }, 'free allowance'],
    [{ kind: 'network' }, 'Could not reach Google'],
    [{ kind: 'overloaded' }, 'busy'],
  ];

  for (const [error, expected] of cases) {
    it(`turns ${error.kind} into something a shopkeeper can act on`, () => {
      const text = shortAiFault(error);
      expect(text).toContain(expected);
      // Short enough for one line, and free of anything technical.
      expect(text.length).toBeLessThan(90);
      expect(text).not.toMatch(/gemini-|HTTP|\b40\d\b|\b50\d\b/);
    });
  }

  it('never leaks a model name even when the error carries one', () => {
    const text = shortAiFault({ kind: 'modelUnavailable', model: 'gemini-2.5-flash', status: 404 });
    expect(text).not.toContain('gemini-2.5-flash');
  });
});
