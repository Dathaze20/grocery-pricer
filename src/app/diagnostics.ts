import { generateContentUrl } from '../ai/model';
import { redactSecrets } from '../core/ai-types';
import type { ImagePart } from '../ai/gemini';

/** What one probe actually observed. Facts, not interpretation. */
export interface ProbeResult {
  /**
   * Google answered with a 2xx.
   *
   * Kept apart from `ok` on purpose. A 200 means the request arrived, was accepted and came
   * back - it says nothing about whether the model did the job. A reply that is empty, or
   * refuses, or is not the JSON that was asked for, is a successful delivery of a useless
   * answer, and reporting that as success is how a diagnostic ends up lying.
   */
  readonly delivered: boolean;
  /** Delivered AND the reply is actually usable for what this probe asked. */
  readonly ok: boolean;
  /** The exact model name that was called. One model, never a fallback chain. */
  readonly model: string;
  /** The HTTP status Google really returned, or null if no response arrived at all. */
  readonly status: number | null;
  readonly ms: number;
  /** A short plain reading of what that status means for this shop. */
  readonly verdict: string;
  /** Google's own message, trimmed and with anything key-shaped removed. Empty if none. */
  readonly detail: string;
  /**
   * What the model replied, trimmed for the screen.
   *
   * For display only. Validation runs against the whole reply, never this - truncating first
   * and parsing second is how a successful extraction of a dozen products gets reported as
   * invalid JSON, which is the opposite of what the reply proves.
   */
  readonly reply: string | null;
}

export const PROBE_TIMEOUT_MS = 45_000;

/**
 * Says what an HTTP status means here, in words a shopkeeper can act on.
 *
 * The whole point of this screen: "Gemini is busy right now" and "your key cannot use this
 * model" are the same sentence to somebody standing in a shop, and they need completely
 * different responses. A status with a reading beside it is the difference.
 */
function verdictFor(status: number | null, timedOut: boolean): string {
  if (timedOut) return 'Timed out - no reply arrived in time. The request may be too large, or the connection too slow.';
  if (status === null) return 'The request never reached Google. Check the connection.';
  if (status >= 200 && status < 300) return 'Worked.';
  switch (status) {
    case 400:
      return 'Google refused the request itself (400). Not the key, not the photo - the request.';
    case 401:
      return 'The key was not accepted (401).';
    case 403:
      return 'Refused (403). Either the key, or this Google project is not allowed to use this model.';
    case 404:
      return 'This key may not call this model (404). The key reached Google, so the key is fine.';
    case 429:
      return 'Too many requests, or the free allowance is used up (429).';
    case 500:
      return 'Google had an internal error (500). Not your key and not your photo.';
    case 503:
      return 'Google says the model is overloaded (503). This is their capacity, not your key, your photo or this app. It usually passes.';
    default:
      return status >= 500
        ? `Google had a server error (${status}). Not your key and not your photo.`
        : `Google refused the request (${status}).`;
  }
}

/** Google's own explanation, trimmed and stripped of anything credential-shaped. */
function detailFrom(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: { message?: unknown; status?: unknown } })?.error;
    const message = typeof error?.message === 'string' ? error.message : '';
    const status = typeof error?.status === 'string' ? error.status : '';
    const joined = [status, message].filter((p) => p.length > 0).join(': ');
    return redactSecrets(joined).slice(0, 200);
  } catch {
    // Not structured, so there is nothing Google meant a person to read. The raw body is an
    // error page or a proxy's complaint and has no place on a settings screen.
    return '';
  }
}

/**
 * One request. One model. No retry, no fallback, no second attempt of any kind.
 *
 * Every other path in this app may try another model when one is unavailable. This one must
 * not: a diagnostic that quietly succeeds on a different model than the one it names tells the
 * owner something false, and a diagnostic that retries cannot say what a single attempt costs.
 */
/** Whether the reply does what the probe asked for, and if not, why not. */
export type ReplyCheck = (reply: string) => { usable: boolean; why: string };

async function probe(options: {
  apiKey: string;
  model: string;
  prompt: string;
  images?: readonly ImagePart[];
  json?: boolean;
  check: ReplyCheck;
  fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
  const { apiKey, model, prompt } = options;
  const started = Date.now();

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          ...(options.images ?? []).map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
          })),
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: options.json === true ? 2048 : 64,
      ...(options.json === true ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(generateContentUrl(model), {
      method: 'POST',
      // In a header, as everywhere else in this app. A key in a URL ends up in logs.
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = controller.signal.aborted;
    return {
      delivered: false,
      ok: false,
      model,
      status: null,
      ms: Date.now() - started,
      verdict: verdictFor(null, timedOut),
      detail: timedOut ? '' : redactSecrets(error instanceof Error ? error.message : '').slice(0, 120),
      reply: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => '');
  const ms = Date.now() - started;

  if (!response.ok) {
    return {
      delivered: false,
      ok: false,
      model,
      status: response.status,
      ms,
      verdict: verdictFor(response.status, false),
      detail: detailFrom(text),
      reply: null,
    };
  }

  // Delivered. Now the harder question: is what came back any use?
  //
  // Judged on the whole reply. Only what is shown on screen is shortened.
  const full = replyFrom(text);
  const checked = options.check(full);

  return {
    delivered: true,
    ok: checked.usable,
    model,
    status: response.status,
    ms,
    verdict: checked.usable
      ? 'Worked.'
      : `Google answered (HTTP ${response.status}) but the reply is not usable: ${checked.why}`,
    detail: '',
    reply: forDisplay(full),
  };
}

/** The screen gets a readable extract; the check already had the whole thing. */
export const DISPLAY_LIMIT = 600;

export function forDisplay(reply: string): string {
  return reply.length <= DISPLAY_LIMIT
    ? reply
    : `${reply.slice(0, DISPLAY_LIMIT)}… (${reply.length} characters in all)`;
}

/**
 * The model's own words in full, or a plain note when a 200 carried no text.
 *
 * Deliberately not shortened here. This is what gets validated.
 */
export function replyFrom(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const candidates = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '(a reply with no content)';
    const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
    if (!Array.isArray(parts)) return '(a reply with no content)';
    const joined = parts
      .map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
    return joined.length > 0 ? joined : '(a reply with no content)';
  } catch {
    return '(a reply that was not JSON)';
  }
}

/**
 * Test 1: can this key reach this model at all? Text only, nothing attached.
 *
 * The reply has to actually say OK. A model that answers a two-word instruction with something
 * else is not a model that is going to read a receipt, and a tick beside it would send the
 * investigation off looking at photographs.
 */
export async function probeText(apiKey: string, model: string, fetchImpl?: typeof fetch): Promise<ProbeResult> {
  return probe({
    apiKey,
    model,
    prompt: 'Reply with exactly: OK',
    check: (reply) => {
      // Exact, once punctuation and whitespace are stripped. `includes` let "LOOK", "OKAY"
      // and any sentence containing the letters through, which is not a model following a
      // two-word instruction - it is a model doing something else that happened to match.
      const said = reply.trim().toUpperCase().replace(/[^A-Z]/g, '');
      return said === 'OK'
        ? { usable: true, why: '' }
        : { usable: false, why: 'it did not reply with exactly OK.' };
    },
    fetchImpl,
  });
}

/** Test 2: can it see a photograph? One picture, one short question, no production prompt. */
export async function probeImage(
  apiKey: string,
  model: string,
  image: ImagePart,
  fetchImpl?: typeof fetch,
): Promise<ProbeResult> {
  return probe({
    apiKey,
    model,
    prompt:
      'This is a photograph of a wholesale receipt. Reply with only the first printed product name you can read on it, and nothing else.',
    images: [image],
    // Something readable has to come back. "I cannot read this image" arrives as a perfectly
    // good 200, and it is the opposite of this test passing.
    check: (reply) => {
      const said = reply.trim();
      if (said.length < 2 || said.startsWith('(')) {
        return { usable: false, why: 'it read nothing off the photograph.' };
      }
      if (/\b(cannot|can't|unable|no text|not able|sorry)\b/i.test(said)) {
        return { usable: false, why: 'it said it could not read the photograph.' };
      }
      return { usable: true, why: '' };
    },
    fetchImpl,
  });
}

/** Test 3: can it read the lines? Deliberately a fraction of the production prompt. */
export async function probeExtraction(
  apiKey: string,
  model: string,
  image: ImagePart,
  fetchImpl?: typeof fetch,
): Promise<ProbeResult> {
  return probe({
    apiKey,
    model,
    prompt:
      'Read this wholesale receipt photograph. Return JSON only, shaped {"items":[{"name":string,"casePrice":string,"quantity":number,"discount":string|null}]}. ' +
      'Copy what is printed. Use null where something is not printed. Do not calculate anything.',
    images: [image],
    json: true,
    // Valid JSON with the array that was asked for, and something in it. Prose that happens to
    // mention items, or {"items":[]}, is not an extraction.
    check: (reply) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply);
      } catch {
        return { usable: false, why: 'the reply was not JSON.' };
      }
      const items = (parsed as { items?: unknown })?.items;
      if (!Array.isArray(items)) return { usable: false, why: 'the JSON had no items array.' };
      if (items.length === 0) return { usable: false, why: 'it found no lines on the receipt.' };
      return { usable: true, why: '' };
    },
    fetchImpl,
  });
}
