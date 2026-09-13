import { describe, expect, it, vi } from 'vitest';
import { aiErrorMessage, isFatalForRun, isTransient } from '../../core/ai-types';
import { GeminiClient, httpError, readCandidate } from '../gemini';
import { DEFAULT_GEMINI_MODEL, configuredModel, generateContentUrl } from '../model';
import { GeminiProvider } from '../provider';

function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200 },
  );
}

function errorResponse(status: number, status_: string, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: { code: status, status: status_, message } }), {
    status,
    headers,
  });
}

describe('the request Gemini is sent', () => {
  it('puts the key in a header and never in the URL', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"items":[]}'));
    const client = new GeminiClient({ apiKey: 'AIza-secret', fetchImpl: fetchImpl as never });

    await client.generate({ system: 's', prompt: 'p' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('AIza-secret');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-secret');
  });

  it('asks for JSON at temperature zero, so one receipt reads the same way twice', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"items":[]}'));
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: fetchImpl as never });

    await client.generate({ system: 's', prompt: 'p' });

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.systemInstruction.parts[0].text).toBe('s');
  });

  it('sends photos as inline data alongside the prompt', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"items":[]}'));
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: fetchImpl as never });

    await client.generate({
      system: 's',
      prompt: 'p',
      images: [{ mimeType: 'image/jpeg', data: 'BASE64' }],
    });

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.contents[0].parts[0].text).toBe('p');
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: 'BASE64' });
  });

  it('refuses to call at all without a key, rather than sending an anonymous request', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}'));
    const client = new GeminiClient({ apiKey: '   ', fetchImpl: fetchImpl as never });

    const result = await client.generate({ system: 's', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.kind).toBe('missingKey');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the configured model in the URL and can be overridden per call', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}'));
    const client = new GeminiClient({ apiKey: 'k', model: 'gemini-2.0-flash', fetchImpl: fetchImpl as never });

    await client.generate({ system: 's', prompt: 'p' });
    await client.generate({ system: 's', prompt: 'p', model: 'gemini-3-something-new' });

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      generateContentUrl('gemini-2.0-flash'),
    );
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe(
      generateContentUrl('gemini-3-something-new'),
    );
  });

  it('falls back to the default model when nothing is configured', () => {
    expect(configuredModel(null)).toBe(DEFAULT_GEMINI_MODEL);
    expect(configuredModel('   ')).toBe(DEFAULT_GEMINI_MODEL);
    expect(configuredModel('gemini-9-flash')).toBe('gemini-9-flash');
  });
});

describe('what a failure is turned into', () => {
  it('treats an exhausted free allowance as quota, and promises no charge', () => {
    const error = httpError(
      429,
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      }),
    );

    expect(error.kind).toBe('quotaExhausted');
    expect(aiErrorMessage(error)).toBe(
      'Free Gemini quota reached. Grocery Pricer will not charge you. Try again after the quota resets.',
    );
    // Retrying a spent allowance only spends the next one, so this must not read as transient.
    expect(isTransient(error)).toBe(false);
    expect(isFatalForRun(error)).toBe(true);
  });

  it('keeps a plain speed limit separate from a spent allowance', () => {
    const error = httpError(
      429,
      JSON.stringify({ error: { code: 429, status: 'UNAVAILABLE', message: 'Too many requests per minute' } }),
    );

    expect(error.kind).toBe('rateLimited');
    expect(isTransient(error)).toBe(true);
    expect(isFatalForRun(error)).toBe(false);
  });

  it('reads a retry delay out of the body or the header', () => {
    const fromBody = httpError(429, '{"error":{"status":"UNAVAILABLE","message":"slow down"},"retryDelay":"37s"}');
    expect(fromBody.kind === 'rateLimited' && fromBody.retryAfterSeconds).toBe(37);

    const fromHeader = httpError(
      429,
      '{"error":{"message":"slow down"}}',
      new Headers({ 'retry-after': '12' }),
    );
    expect(fromHeader.kind === 'rateLimited' && fromHeader.retryAfterSeconds).toBe(12);
  });

  it('recognises a rejected key', () => {
    expect(httpError(400, JSON.stringify({ error: { message: 'API key not valid' } })).kind).toBe('invalidKey');
    expect(httpError(401, '{}').kind).toBe('invalidKey');
    expect(
      httpError(403, JSON.stringify({ error: { message: 'Permission denied on API key' } })).kind,
    ).toBe('invalidKey');
  });

  it('maps overload, oversize and server faults to their own answers', () => {
    expect(httpError(503, '{}').kind).toBe('overloaded');
    expect(httpError(413, '{}').kind).toBe('requestTooLarge');
    const server = httpError(500, '{"error":{"status":"INTERNAL","message":"boom"}}');
    expect(server.kind).toBe('serverError');
    expect(isTransient(server)).toBe(true);
  });

  it('never puts the raw body into what the user reads', () => {
    const error = httpError(500, '<html><body>Internal Server Error at /v1beta/models</body></html>');
    expect(aiErrorMessage(error)).toBe('Gemini returned an error. Try again.');
  });

  it('reports a dropped connection as network, not as a bad key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: fetchImpl as never });

    const result = await client.generate({ system: 's', prompt: 'p' });

    expect(result.ok === false && result.error.kind).toBe('network');
    expect(result.ok === false && aiErrorMessage(result.error)).toContain('Saved orders still work offline');
  });

  it('gives up on a request that never comes back', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const client = new GeminiClient({ apiKey: 'k', fetchImpl: fetchImpl as never, timeoutMs: 5 });

    const result = await client.generate({ system: 's', prompt: 'p' });

    expect(result.ok === false && result.error.kind).toBe('timeout');
  });
});

describe('reading the reply', () => {
  it('joins the text parts of the first candidate', () => {
    const result = readCandidate(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] }),
    );
    expect(result.ok && result.value).toBe('{"a":1}');
  });

  it('calls a reply that ran out of tokens truncated, not malformed', () => {
    const result = readCandidate(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"items":[' }] }, finishReason: 'MAX_TOKENS' }] }),
    );
    expect(result.ok === false && result.error.kind).toBe('truncated');
  });

  it('reports a blocked prompt and a blocked candidate', () => {
    expect(
      readCandidate(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })).ok,
    ).toBe(false);
    const blocked = readCandidate(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }));
    expect(blocked.ok === false && blocked.error.kind).toBe('blocked');
  });

  it('does not mistake an empty reply for an empty order', () => {
    for (const body of ['not json', '{}', '{"candidates":[]}', JSON.stringify({ candidates: [{ content: { parts: [{ text: '  ' }] } }] })]) {
      const result = readCandidate(body);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.kind).toBe('malformedResponse');
    }
  });
});

describe('GeminiProvider', () => {
  const image = { photoId: 7, mimeType: 'image/jpeg', data: 'AAA' };

  it('parses an extraction and keeps the money as printed text', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse(
        JSON.stringify({
          supplier: 'JETRO',
          items: [
            {
              rawName: 'HELLM MAYONNAISE 8Z',
              casePrice: '41.99',
              unitsPerCase: 12,
              sourcePhotoIds: [7],
              sourceText: ['HELLM MAYONNAISE 8Z 41.99'],
              confidence: 0.88,
            },
          ],
          warnings: [],
        }),
      ),
    );
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl: fetchImpl as never });

    const result = await provider.extractOrder([image]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.supplier).toBe('JETRO');
    expect(result.value.items[0]!.casePrice).toBe('41.99');
    expect(typeof result.value.items[0]!.casePrice).toBe('string');
  });

  it('passes a transport failure straight through without inventing an order', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(429, 'RESOURCE_EXHAUSTED', 'quota exceeded'));
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl: fetchImpl as never });

    const result = await provider.extractOrder([image]);

    expect(result.ok === false && result.error.kind).toBe('quotaExhausted');
  });

  it('accepts either spelling of an answer kind from the model', async () => {
    const snake = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => okResponse('{"kind":"product_matches","itemIds":[4]}')) as never,
    });
    const camel = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => okResponse('{"kind":"productMatches","itemIds":[4]}')) as never,
    });
    const items = [{ itemId: 4, name: 'CORN OIL', size: '48 OZ', category: null }];

    for (const provider of [snake, camel]) {
      const result = await provider.resolveQuestion('how much is the oil', items);
      expect(result.ok && result.value.kind).toBe('productMatches');
    }
  });

  it('throws away item ids the model made up', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      fetchImpl: vi.fn(async () => okResponse('{"kind":"productMatches","itemIds":[4,999]}')) as never,
    });

    const result = await provider.resolveQuestion('the oil', [
      { itemId: 4, name: 'CORN OIL', size: null, category: null },
    ]);

    expect(result.ok && result.value.kind === 'productMatches' && result.value.itemIds).toEqual([4]);
  });

  it('sends a question with no images attached', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"kind":"general","reply":"ok"}'));
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl: fetchImpl as never });

    await provider.resolveQuestion('what did I spend', [
      { itemId: 1, name: 'CORN OIL', size: null, category: null },
    ]);

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.contents[0].parts).toHaveLength(1);
  });
});
