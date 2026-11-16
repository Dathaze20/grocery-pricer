import { describe, expect, it, vi } from 'vitest';
import { GeminiClient, anotherModelMightWork } from '../gemini';
import { APPROVED_GEMINI_MODELS, DEFAULT_GEMINI_MODEL, MAX_MODEL_ATTEMPTS, modelChain, configuredModel } from '../model';
import type { AiError } from '../../core/ai-types';
import { aiErrorMessage } from '../../core/ai-types';

function notFound(model: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`,
      },
    }),
    { status: 404 },
  );
}

function ok(text = '{"supplier":null,"items":[],"warnings":[]}'): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200 },
  );
}

function googleError(status: number, apiStatus: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, status: apiStatus, message } }), {
    status,
  });
}

/** Records which model each call asked for, so the chain can be asserted exactly. */
function recordingFetch(reply: (model: string) => Response) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const text = String(url);
    const model = /models\/([^:]+):/.exec(text)?.[1] ?? '';
    asked.push(decodeURIComponent(model));
    return reply(decodeURIComponent(model));
  });
  return { asked, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('the approved list', () => {
  it('starts at a current model, not the one that is being refused', () => {
    // The exact name that failed on a real shop's phone with HTTP 404.
    expect(DEFAULT_GEMINI_MODEL).not.toBe('gemini-2.5-flash');
    expect(APPROVED_GEMINI_MODELS).not.toContain('gemini-2.5-flash');
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.8-flash');
  });

  it('offers nothing that is wrong for reading a receipt', () => {
    for (const model of APPROVED_GEMINI_MODELS) {
      // No image generators, speech, research agents, robotics or experiments - and no Pro,
      // which costs more without reading printed figures any better.
      expect(model, model).not.toMatch(/-image|-tts|lyria|banana|robotics|computer-use/);
      expect(model, model).not.toMatch(/deep-research|antigravity|gemma/);
      expect(model, model).not.toMatch(/preview|-exp\b|experimental/);
      expect(model, model).not.toMatch(/pro/);
      expect(model, model).toMatch(/flash/);
    }
  });

  it('stays short enough that the fallback cannot wander', () => {
    expect(APPROVED_GEMINI_MODELS.length).toBeLessThanOrEqual(5);
    expect(MAX_MODEL_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});

describe('what the chain tries first', () => {
  it('is exactly as long as the attempt budget, so no entry is unreachable', () => {
    // The bug this replaced: four approved models and three attempts meant the fourth could
    // never be tried, which reads like a safety net and is not one.
    expect(APPROVED_GEMINI_MODELS).toHaveLength(MAX_MODEL_ATTEMPTS);
  });

  it('a fresh installation tries the approved list, in order, and nothing else', () => {
    expect(modelChain({})).toEqual(APPROVED_GEMINI_MODELS);
    expect(modelChain({ override: null, remembered: null })).toEqual(APPROVED_GEMINI_MODELS);
    expect(modelChain({ override: '  ', remembered: '' })).toEqual(APPROVED_GEMINI_MODELS);
  });

  it('a model that worked before is tried first, and the rest stay reachable', () => {
    const second = APPROVED_GEMINI_MODELS[1]!;
    const chain = modelChain({ remembered: second });

    expect(chain[0]).toBe(second);
    expect(chain).toHaveLength(MAX_MODEL_ATTEMPTS);
    // Moved to the front, not added to the front: every approved model is still in the chain.
    expect([...chain].sort()).toEqual([...APPROVED_GEMINI_MODELS].sort());
  });

  it('a remembered model that is no longer approved costs one slot, never the whole list', () => {
    const chain = modelChain({ remembered: 'retired-last-month' });

    expect(chain[0]).toBe('retired-last-month');
    expect(chain).toHaveLength(MAX_MODEL_ATTEMPTS);
    // Two maintained models are still tried after it.
    expect(chain.slice(1)).toEqual(APPROVED_GEMINI_MODELS.slice(0, MAX_MODEL_ATTEMPTS - 1));
  });

  it('an old manual override does not crowd the approved list out with a stale memory', () => {
    // Both set, both stale. Allowing a slot each would leave a single approved model to try,
    // so two names the owner has long forgotten could decide the whole attempt budget.
    const chain = modelChain({ override: 'typed-long-ago', remembered: 'also-stale' });

    expect(chain[0]).toBe('typed-long-ago');
    expect(chain).not.toContain('also-stale');
    expect(chain.slice(1)).toEqual(APPROVED_GEMINI_MODELS.slice(0, MAX_MODEL_ATTEMPTS - 1));
    expect(chain).toHaveLength(MAX_MODEL_ATTEMPTS);
  });

  it('never lists the same model twice, and never exceeds the budget', () => {
    const cases = [
      { override: DEFAULT_GEMINI_MODEL, remembered: DEFAULT_GEMINI_MODEL },
      { override: 'x', remembered: 'x' },
      { remembered: APPROVED_GEMINI_MODELS[2] },
      { override: APPROVED_GEMINI_MODELS[1], remembered: 'y' },
      {},
    ];

    for (const options of cases) {
      const chain = modelChain(options);
      expect(new Set(chain).size, JSON.stringify(options)).toBe(chain.length);
      expect(chain.length, JSON.stringify(options)).toBeLessThanOrEqual(MAX_MODEL_ATTEMPTS);
      expect(chain.length, JSON.stringify(options)).toBeGreaterThan(0);
    }
  });

  it('always ends up trying something from the maintained list', () => {
    for (const options of [{}, { remembered: 'dead' }, { override: 'dead', remembered: 'also' }]) {
      const chain = modelChain(options);
      const approved = chain.filter((m) => APPROVED_GEMINI_MODELS.includes(m));
      expect(approved.length, JSON.stringify(options)).toBeGreaterThanOrEqual(
        MAX_MODEL_ATTEMPTS - 1,
      );
    }
  });
});

describe('falling back when a model is unavailable', () => {
  it('moves to the next model on a 404 and succeeds without being asked', async () => {
    const { asked, fetchImpl } = recordingFetch((model) =>
      model === 'gemini-3.8-flash' ? notFound(model) : ok(),
    );
    const worked: string[] = [];

    const client = new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
      onModelWorked: (m) => worked.push(m),
      fetchImpl,
    });
    const result = await client.generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(true);
    expect(asked).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    // And the working one is reported, so the next receipt starts there.
    expect(worked).toEqual(['gemini-3.5-flash-lite']);
  });

  it('reports the model that worked, not the one that was asked for first', async () => {
    const { fetchImpl } = recordingFetch((model) => (model === 'first' ? notFound(model) : ok()));
    const worked: string[] = [];

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['first', 'second'],
      onModelWorked: (m) => worked.push(m),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(worked).toEqual(['second']);
  });

  it('also falls back on a 403 that is about access rather than the key', async () => {
    const { asked, fetchImpl } = recordingFetch((model) =>
      model === 'first'
        ? googleError(403, 'PERMISSION_DENIED', 'Generative Language API is not enabled for model')
        : ok(),
    );

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['first', 'second'],
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(true);
    expect(asked).toEqual(['first', 'second']);
  });

  it('never tries more models than it is allowed to', async () => {
    const { asked, fetchImpl } = recordingFetch((model) => notFound(model));

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['a', 'b', 'c', 'd', 'e', 'f'],
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(asked).toHaveLength(MAX_MODEL_ATTEMPTS);
  });

  it('gives one plain answer when every model refuses, naming none of them', async () => {
    const { fetchImpl } = recordingFetch((model) => notFound(model));

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['alpha', 'beta', 'gamma'],
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('noWorkingModel');

    const message = aiErrorMessage(result.error);
    // The owner cannot fix this by choosing from a list, so they are not shown one.
    expect(message).not.toContain('alpha');
    expect(message).not.toContain('gamma');
    expect(message).not.toContain('HTTP');
    expect(message).toContain('Google project');
  });

  it('does not report a model as working when none did', async () => {
    const { fetchImpl } = recordingFetch((model) => notFound(model));
    const worked: string[] = [];

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['a', 'b'],
      onModelWorked: (m) => worked.push(m),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(worked).toEqual([]);
  });
});

describe('not falling back for problems a different model cannot fix', () => {
  const unrelated: Array<[string, Response]> = [
    ['a spent free allowance', googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for free tier')],
    ['a rejected key', googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')],
    ['a malformed request', googleError(400, 'INVALID_ARGUMENT', 'Unknown name "nonsense"')],
    ['a server fault', googleError(500, 'INTERNAL', 'Internal error encountered.')],
    ['an overloaded model', googleError(503, 'UNAVAILABLE', 'The model is overloaded.')],
  ];

  for (const [what, response] of unrelated) {
    it(`stops at ${what} instead of spending quota on another model`, async () => {
      const { asked, fetchImpl } = recordingFetch(() => response.clone());

      const result = await new GeminiClient({
        apiKey: 'AIza-test-key',
        models: ['first', 'second', 'third'],
        fetchImpl,
      }).generate({ system: 's', prompt: 'p' });

      expect(result.ok).toBe(false);
      // Exactly one call. Walking the list here would multiply the cost of the same answer.
      expect(asked, what).toEqual(['first']);
      if (!result.ok) expect(result.error.kind).not.toBe('noWorkingModel');
    });
  }

  it('does not fall back when the connection itself fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['first', 'second'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('decides what is worth retrying from the error alone', () => {
    const availability: AiError[] = [
      { kind: 'modelUnavailable', model: 'x', status: 404 },
      { kind: 'accessDenied', status: 403 },
    ];
    const everythingElse: AiError[] = [
      { kind: 'quotaExhausted' },
      { kind: 'invalidKey' },
      { kind: 'missingKey' },
      { kind: 'badRequest', status: 400 },
      { kind: 'rateLimited' },
      { kind: 'serverError', status: 500 },
      { kind: 'overloaded' },
      { kind: 'timeout' },
      { kind: 'network' },
      { kind: 'blocked' },
      { kind: 'truncated' },
      { kind: 'requestTooLarge' },
    ];

    for (const error of availability) expect(anotherModelMightWork(error), error.kind).toBe(true);
    for (const error of everythingElse) expect(anotherModelMightWork(error), error.kind).toBe(false);
  });
});

describe('working through the chain for real', () => {
  it('reaches the last approved model and succeeds there', async () => {
    const chain = modelChain({});
    const lastOne = chain[chain.length - 1]!;
    const { asked, fetchImpl } = recordingFetch((model) =>
      model === lastOne ? ok() : notFound(model),
    );
    const worked: string[] = [];

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: chain,
      onModelWorked: (m) => worked.push(m),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    // The final entry is genuinely reachable - it is not decoration.
    expect(result.ok).toBe(true);
    expect(asked).toEqual([...chain]);
    expect(worked).toEqual([lastOne]);
  });

  it('a fresh installation needs one call when the first model answers', async () => {
    const { asked, fetchImpl } = recordingFetch(() => ok());

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: modelChain({}),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(true);
    // No wasted calls on a healthy install.
    expect(asked).toEqual([DEFAULT_GEMINI_MODEL]);
  });

  it('a remembered model that answers costs one call, not a walk down the list', async () => {
    const remembered = APPROVED_GEMINI_MODELS[2]!;
    const { asked, fetchImpl } = recordingFetch(() => ok());

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: modelChain({ remembered }),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(asked).toEqual([remembered]);
  });

  it('says a dead remembered model should be forgotten, so it is tried once and not again', async () => {
    const { fetchImpl } = recordingFetch((model) => (model === 'dead-name' ? notFound(model) : ok()));
    const rejected: string[] = [];

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: modelChain({ remembered: 'dead-name' }),
      onModelRejected: (m) => rejected.push(m),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(rejected).toContain('dead-name');
  });

  it('every approved model returning 404 gives one plain answer', async () => {
    const chain = modelChain({});
    const { asked, fetchImpl } = recordingFetch((model) => notFound(model));
    const outcomes: Array<AiError | null> = [];

    const result = await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: chain,
      onOutcome: (e) => outcomes.push(e),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    expect(asked).toHaveLength(MAX_MODEL_ATTEMPTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('noWorkingModel');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('noWorkingModel');
  });

  it('reports the outcome exactly once, success or failure', async () => {
    const outcomes: Array<AiError | null> = [];
    const { fetchImpl } = recordingFetch((model) => (model === 'first' ? notFound(model) : ok()));

    await new GeminiClient({
      apiKey: 'AIza-test-key',
      models: ['first', 'second'],
      onOutcome: (e) => outcomes.push(e),
      fetchImpl,
    }).generate({ system: 's', prompt: 'p' });

    // One request, one verdict - a model refused along the way is not a failed request.
    expect(outcomes).toEqual([null]);
  });
});

describe('what a connection check must test', () => {
  it('the head of the chain is what production reaches for first', () => {
    // The bug this covers: the check asked configuredModel, which knows only about a name
    // typed in Advanced. Production starts from modelChain, which puts the model that last
    // worked for this key ahead of the approved list - so a check could test a model that was
    // not the one failing, and report a clean result for the wrong thing.
    expect(modelChain({ remembered: 'what-worked-last-time' })[0]).toBe('what-worked-last-time');
    expect(modelChain({ override: 'typed-in-advanced', remembered: 'what-worked' })[0]).toBe(
      'typed-in-advanced',
    );
    expect(modelChain({})[0]).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('a remembered model outranks the default, which is the case that was being missed', () => {
    const remembered = APPROVED_GEMINI_MODELS[1]!;
    expect(remembered).not.toBe(DEFAULT_GEMINI_MODEL);
    expect(modelChain({ remembered })[0]).toBe(remembered);
    // configuredModel knows nothing of it, which is exactly why it was the wrong source.
    expect(configuredModel(null)).toBe(DEFAULT_GEMINI_MODEL);
  });
});
