import { describe, expect, it, vi } from 'vitest';
import { aiErrorMessage, isFatalForRun, isTransient, redactSecrets } from '../../core/ai-types';
import { GeminiClient, listModels, parseModels } from '../gemini';

/** Google's own error shape, which is what the client has to read. */
function googleError(status: number, apiStatus: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, status: apiStatus, message } }), {
    status,
  });
}

function clientReturning(response: Response): { client: GeminiClient; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    response.clone(),
  );
  const client = new GeminiClient({ apiKey: 'AIza-test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, fetchImpl };
}

async function failureFor(response: Response) {
  const { client } = clientReturning(response);
  const result = await client.generate({ system: 's', prompt: 'p' });
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

describe('every HTTP failure is told apart', () => {
  it('404 is the model, not the key - and says which model', async () => {
    // The exact failure a new API project hits when it asks for a model it is not offered.
    const error = await failureFor(
      googleError(
        404,
        'NOT_FOUND',
        'models/gemini-2.5-flash is not found for API version v1beta, or is not supported for generateContent.',
      ),
    );

    expect(error.kind).toBe('modelUnavailable');
    if (error.kind !== 'modelUnavailable') return;
    expect(error.status).toBe(404);
    expect(error.model).toBe('gemini-2.5-flash');

    const message = aiErrorMessage(error);
    expect(message).toContain('HTTP 404');
    expect(message).toContain('gemini-2.5-flash');
    // The point of the whole fix: it must not send the owner off to retype a working key.
    expect(message).toContain('the key itself is fine');
    // Points at the Settings control by the name it actually has on screen.
    expect(message).toContain('List the models Google advertises');
    // And it is not worth trying the remaining photos with a model that does not exist.
    expect(isFatalForRun(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
  });

  it('400 about the key is a key problem; any other 400 is the request', async () => {
    const keyProblem = await failureFor(
      googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'),
    );
    expect(keyProblem.kind).toBe('invalidKey');

    const requestProblem = await failureFor(
      googleError(400, 'INVALID_ARGUMENT', 'Unknown name "thinkingConfig" in generationConfig.'),
    );
    expect(requestProblem.kind).toBe('badRequest');
    const message = aiErrorMessage(requestProblem);
    expect(message).toContain('HTTP 400');
    expect(message).toContain('thinkingConfig');
    expect(message).toContain('not your key or your photos');
  });

  it('403 tells a rejected key apart from a restricted project', async () => {
    const badKey = await failureFor(
      googleError(403, 'PERMISSION_DENIED', 'Permission denied on API key.'),
    );
    expect(badKey.kind).toBe('invalidKey');

    const restricted = await failureFor(
      googleError(
        403,
        'PERMISSION_DENIED',
        'Generative Language API has not been used in project 1234 before or it is disabled.',
      ),
    );
    expect(restricted.kind).toBe('accessDenied');
    const message = aiErrorMessage(restricted);
    expect(message).toContain('HTTP 403');
    expect(message).toContain("Google project's access");
    // A disabled project stays disabled for the next photo too.
    expect(isFatalForRun(restricted)).toBe(true);
  });

  it('429 separates a spent free allowance from going too fast', async () => {
    const quota = await failureFor(
      googleError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric free tier requests'),
    );
    expect(quota.kind).toBe('quotaExhausted');
    expect(aiErrorMessage(quota)).toContain('will not charge you');

    const paced = await failureFor(googleError(429, 'UNAVAILABLE', 'Too many requests, slow down'));
    expect(paced.kind).toBe('rateLimited');
    expect(isTransient(paced)).toBe(true);
  });

  it('5xx is reported with its status and stays retryable', async () => {
    const internal = await failureFor(googleError(500, 'INTERNAL', 'Internal error encountered.'));
    expect(internal.kind).toBe('serverError');
    expect(aiErrorMessage(internal)).toContain('HTTP 500');
    expect(isTransient(internal)).toBe(true);

    const busy = await failureFor(googleError(503, 'UNAVAILABLE', 'The model is overloaded.'));
    expect(busy.kind).toBe('overloaded');
    expect(isTransient(busy)).toBe(true);
  });

  it('shows no key, no raw document and no unbounded text, whatever comes back', async () => {
    const leaky = await failureFor(
      new Response('<html><body>nginx error, key=AIzaSyFAKEFAKEFAKEFAKE123456</body></html>', {
        status: 502,
      }),
    );
    const message = aiErrorMessage(leaky);

    expect(message).toContain('HTTP 502');
    expect(message).not.toContain('AIzaSy');
    expect(message).not.toContain('<html>');
    expect(message).not.toContain('nginx');

    // Even a structured message is trimmed rather than printed whole.
    const long = await failureFor(googleError(400, 'INVALID_ARGUMENT', 'x'.repeat(5000)));
    expect(aiErrorMessage(long).length).toBeLessThan(400);
  });

  it('redacts anything key-shaped wherever it appears', () => {
    expect(redactSecrets('called with key=AIzaSyABCDEFGHIJKLMNOP')).not.toContain('AIzaSy');
    expect(redactSecrets('token AIzaSyABCDEFGHIJKLMNOP failed')).toContain('[key hidden]');
  });

  it('never sends the key in the URL', async () => {
    const { client, fetchImpl } = clientReturning(googleError(404, 'NOT_FOUND', 'nope'));
    await client.generate({ system: 's', prompt: 'p' });

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).not.toContain('AIza');
    expect(url).toContain('generateContent');
  });
});

describe('asking Google which models the key may use', () => {
  it('keeps only the models that can answer a generateContent call', () => {
    const models = parseModels(
      JSON.stringify({
        models: [
          { name: 'models/gemini-flash-new', displayName: 'Flash New', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-old', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );

    expect(models.map((m) => m.id)).toEqual(['gemini-flash-new', 'gemini-old']);
    expect(models[0]?.label).toBe('Flash New');
    // No displayName: the id is still something to tap rather than a blank row.
    expect(models[1]?.label).toBe('gemini-old');
  });

  it('survives a reply that is not the shape it expected', () => {
    expect(parseModels('not json')).toEqual([]);
    expect(parseModels('{}')).toEqual([]);
    expect(parseModels('{"models":"nope"}')).toEqual([]);
  });

  it('asks with the key in a header and reports a refusal plainly', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      googleError(403, 'PERMISSION_DENIED', 'API key not valid'),
    );
    const result = await listModels({
      apiKey: 'AIza-test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('AIza');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test-key');
  });

  it('will not ask at all without a key', async () => {
    const result = await listModels({ apiKey: '' });
    expect(result.ok).toBe(false);
  });
});
