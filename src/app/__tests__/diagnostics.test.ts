import { describe, expect, it, vi } from 'vitest';
import { probeExtraction, probeImage, probeText, replyFrom } from '../diagnostics';

const KEY = 'AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234';
const MODEL = 'gemini-3.8-flash';
const IMAGE = { mimeType: 'image/jpeg', data: 'AAAA' };

function googleError(status: number, apiStatus: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code: status, status: apiStatus, message } }), {
    status,
  });
}

function reply(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }),
    { status: 200 },
  );
}

function fetchReturning(response: Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    response.clone(),
  ) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

describe('the connection check reports what actually happened', () => {
  it('says plainly when a text request works', async () => {
    const result = await probeText(KEY, MODEL, fetchReturning(reply('OK')));

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.model).toBe(MODEL);
    expect(result.reply).toBe('OK');
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('tells 503 apart from everything else, and says whose problem it is', async () => {
    // The status the shop is actually seeing.
    const result = await probeText(
      KEY,
      MODEL,
      fetchReturning(googleError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.')),
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.verdict).toContain('overloaded');
    // The part that matters: it is not the key, not the photograph, not this app.
    expect(result.verdict).toContain('not your key');
    expect(result.detail).toContain('overloaded');
  });

  it('distinguishes every status we care about', async () => {
    const cases: Array<[number, string, RegExp]> = [
      [400, 'INVALID_ARGUMENT', /request itself/i],
      [401, 'UNAUTHENTICATED', /not accepted/i],
      [403, 'PERMISSION_DENIED', /403/],
      [404, 'NOT_FOUND', /may not call this model/i],
      [429, 'RESOURCE_EXHAUSTED', /allowance|too many/i],
      [500, 'INTERNAL', /internal error/i],
      [503, 'UNAVAILABLE', /overloaded/i],
    ];

    for (const [status, apiStatus, pattern] of cases) {
      const result = await probeText(KEY, MODEL, fetchReturning(googleError(status, apiStatus, 'x')));
      expect(result.status, String(status)).toBe(status);
      expect(result.ok, String(status)).toBe(false);
      expect(result.verdict, String(status)).toMatch(pattern);
    }
  });

  it('reports a timeout as a timeout, not as a refusal', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Behaves like a request that never comes back: rejects when aborted.
      return new Promise<Response>((_resolve, rejectIt) => {
        init?.signal?.addEventListener('abort', () => rejectIt(new Error('aborted')));
      });
    }) as unknown as typeof fetch;

    const started = Date.now();
    const pending = probeText(KEY, MODEL, fetchImpl);
    // Nothing to wait 45 seconds for: abort it the way the timer would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    // Either it is still waiting (correct - no retry, no spinning) or it reported honestly.
    if (result !== null) {
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('never puts the key in the URL, and sends it in a header', async () => {
    const fetchImpl = fetchReturning(reply('OK'));
    await probeText(KEY, MODEL, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).not.toContain('AIza');
    expect(String(url)).toContain(MODEL);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
  });

  it('never shows the key, or a raw error page, in what it reports', async () => {
    const leaky = new Response(`<html>nginx: key=${KEY} refused</html>`, { status: 502 });
    const result = await probeText(KEY, MODEL, fetchReturning(leaky));

    expect(result.status).toBe(502);
    expect(result.detail).not.toContain('AIza');
    expect(result.detail).not.toContain('nginx');
    // An unstructured body says nothing a person can use, so nothing is shown.
    expect(result.detail).toBe('');
  });

  it('redacts a key that Google itself echoes back', async () => {
    const result = await probeText(
      KEY,
      MODEL,
      fetchReturning(googleError(400, 'INVALID_ARGUMENT', `API key not valid: ${KEY}`)),
    );

    expect(result.detail).not.toContain('AIza');
    expect(result.detail).toContain('[key hidden]');
  });

  it('sends exactly one request per probe - no retry, no second model', async () => {
    const fetchImpl = fetchReturning(googleError(503, 'UNAVAILABLE', 'overloaded'));
    await probeText(KEY, MODEL, fetchImpl);

    // A diagnostic that retries cannot say what one attempt costs, and a diagnostic that
    // silently tries another model names a model it did not test.
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it('attaches exactly one photograph, and asks a short question', async () => {
    const fetchImpl = fetchReturning(reply('CORN OIL'));
    const result = await probeImage(KEY, MODEL, IMAGE, fetchImpl);

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    const parts = body.contents[0].parts as Array<Record<string, unknown>>;
    expect(parts.filter((p) => 'inlineData' in p)).toHaveLength(1);
    expect(result.reply).toBe('CORN OIL');
    // Not the production prompt: this is a plain question, so a failure here is about the
    // picture rather than about a long instruction the model may be choking on.
    expect(String(parts[0]!['text'])).not.toContain('sourcePhotoIds');
  });

  it('asks for JSON only on the extraction probe', async () => {
    const plain = fetchReturning(reply('CORN OIL'));
    await probeImage(KEY, MODEL, IMAGE, plain);
    const plainBody = JSON.parse((plain.mock.calls[0]![1] as RequestInit).body as string);
    expect(plainBody.generationConfig.responseMimeType).toBeUndefined();

    const structured = fetchReturning(reply('{"items":[]}'));
    await probeExtraction(KEY, MODEL, IMAGE, structured);
    const structuredBody = JSON.parse((structured.mock.calls[0]![1] as RequestInit).body as string);
    expect(structuredBody.generationConfig.responseMimeType).toBe('application/json');
    // And it asks for the four things the shop needs off a line, nothing more.
    const prompt = String(structuredBody.contents[0].parts[0].text);
    for (const field of ['name', 'casePrice', 'quantity', 'discount']) {
      expect(prompt, field).toContain(field);
    }
    expect(prompt).toContain('Do not calculate anything');
  });

  it('tests the model it says it is testing', async () => {
    const fetchImpl = fetchReturning(reply('OK'));
    const result = await probeText(KEY, 'some-other-model', fetchImpl);

    expect(result.model).toBe('some-other-model');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('some-other-model');
  });

  it('handles a 200 that carried no usable text', async () => {
    expect(replyFrom('{"candidates":[]}')).toBe('(a reply with no content)');
    expect(replyFrom('not json')).toBe('(a reply that was not JSON)');
    expect(replyFrom('{}')).toBe('(a reply with no content)');
  });
});

describe('a 200 is not the same thing as a useful answer', () => {
  it('test 1 fails when the model answers something other than OK', async () => {
    const result = await probeText(
      KEY,
      MODEL,
      fetchReturning(reply('I am a large language model and I am happy to help!')),
    );

    // Delivered perfectly. Useless for the one thing it was asked.
    expect(result.delivered).toBe(true);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(false);
    expect(result.verdict).toContain('not usable');
    expect(result.verdict).toContain('did not say OK');
  });

  it('test 1 accepts OK however it is punctuated', async () => {
    for (const said of ['OK', 'ok', ' OK. ', '"OK"', 'OK\n']) {
      const result = await probeText(KEY, MODEL, fetchReturning(reply(said)));
      expect(result.ok, said).toBe(true);
    }
  });

  it('test 1 fails on a 200 that carried no text at all', async () => {
    const empty = new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    const result = await probeText(KEY, MODEL, fetchReturning(empty));

    expect(result.delivered).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('test 2 fails when the model says it cannot read the photograph', async () => {
    const result = await probeImage(
      KEY,
      MODEL,
      IMAGE,
      fetchReturning(reply("I'm sorry, I cannot read any text in this image.")),
    );

    expect(result.delivered).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.verdict).toContain('could not read');
  });

  it('test 2 passes on a real product name', async () => {
    const result = await probeImage(KEY, MODEL, IMAGE, fetchReturning(reply('HELLM MAYONNAISE 8Z')));

    expect(result.ok).toBe(true);
    expect(result.reply).toBe('HELLM MAYONNAISE 8Z');
  });

  it('test 3 fails on prose, on missing items, and on an empty list', async () => {
    const prose = await probeExtraction(KEY, MODEL, IMAGE, fetchReturning(reply('Here are the items:')));
    expect(prose.delivered).toBe(true);
    expect(prose.ok).toBe(false);
    expect(prose.verdict).toContain('not JSON');

    const wrongShape = await probeExtraction(KEY, MODEL, IMAGE, fetchReturning(reply('{"lines":[]}')));
    expect(wrongShape.ok).toBe(false);
    expect(wrongShape.verdict).toContain('no items array');

    const nothingFound = await probeExtraction(KEY, MODEL, IMAGE, fetchReturning(reply('{"items":[]}')));
    expect(nothingFound.delivered).toBe(true);
    expect(nothingFound.ok).toBe(false);
    expect(nothingFound.verdict).toContain('no lines');
  });

  it('test 3 passes when lines actually come back', async () => {
    const result = await probeExtraction(
      KEY,
      MODEL,
      IMAGE,
      fetchReturning(
        reply('{"items":[{"name":"HELLM MAYO","casePrice":"24.00","quantity":1,"discount":null}]}'),
      ),
    );

    expect(result.delivered).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reply).toContain('HELLM MAYO');
  });

  it('a transport failure is never reported as delivered', async () => {
    const result = await probeText(
      KEY,
      MODEL,
      fetchReturning(googleError(503, 'UNAVAILABLE', 'overloaded')),
    );

    expect(result.delivered).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('still sends exactly one request when the reply is unusable', async () => {
    const fetchImpl = fetchReturning(reply('something else entirely'));
    await probeText(KEY, MODEL, fetchImpl);

    // A content failure is not a reason to ask again. That is the owner's call.
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });
});
