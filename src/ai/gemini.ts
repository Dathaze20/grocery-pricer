import type { AiError, AiResult } from '../core/ai-types';
import { aiFail, aiOk } from '../core/ai-types';
import { configuredModel, generateContentUrl, listModelsUrl } from './model';

/** One photograph on its way to Gemini: base64 payload plus its mime type. */
export interface ImagePart {
  readonly mimeType: string;
  /** Base64, with no `data:` prefix. */
  readonly data: string;
}

export interface GeminiRequest {
  readonly system: string;
  readonly prompt: string;
  readonly images?: readonly ImagePart[];
  /** Overrides the configured model for this one call. */
  readonly model?: string | null;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface GeminiConfig {
  /** The user's own key. Read from device storage at call time and never stored here. */
  readonly apiKey: string | null;
  readonly model?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * The only code that talks to Google.
 *
 * It returns text, or an [AiError]. It never throws, never logs the key, and never retries on its
 * own - a caller that retries a quota error just burns the user's remaining free calls faster.
 */
export class GeminiClient {
  constructor(private readonly config: GeminiConfig) {}

  get model(): string {
    return configuredModel(this.config.model);
  }

  async generate(request: GeminiRequest): Promise<AiResult<string>> {
    const key = this.config.apiKey?.trim();
    if (key === undefined || key.length === 0) return aiFail({ kind: 'missingKey' });

    const model = configuredModel(request.model ?? this.config.model);
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: request.prompt },
            ...(request.images ?? []).map((image) => ({
              inlineData: { mimeType: image.mimeType, data: image.data },
            })),
          ],
        },
      ],
      generationConfig: {
        // Transcription, not creative writing. The same receipt should read the same way twice.
        temperature: 0,
        responseMimeType: 'application/json',
        maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    };

    const doFetch = this.config.fetchImpl ?? globalThis.fetch;
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(generateContentUrl(model), {
        method: 'POST',
        headers: {
          // The key travels in a header, never in the URL: URLs end up in logs and history.
          'x-goog-api-key': key,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) return aiFail({ kind: 'timeout' });
      return aiFail({ kind: 'network', detail: shortReason(error) });
    } finally {
      clearTimeout(timer);
    }

    const text = await readBody(response);
    if (!response.ok) return aiFail(httpError(response.status, text, response.headers, model));

    return readCandidate(text);
  }
}

/** One model Google says this key may call. */
export interface AvailableModel {
  /** The name to type into Settings, e.g. `gemini-2.5-flash-lite`. */
  readonly id: string;
  readonly label: string;
}

/**
 * Asks Google which models this key can actually use.
 *
 * This is the question a 404 raises and nothing else can answer: model names change, and a key
 * issued today may not be offered a model that worked last month. Asking is one cheap call, it
 * runs on the owner's own device with the key already stored there, and it turns "Gemini
 * returned an error" into a list to choose from.
 */
export async function listModels(config: GeminiConfig): Promise<AiResult<readonly AvailableModel[]>> {
  const key = config.apiKey?.trim();
  if (key === undefined || key.length === 0) return aiFail({ kind: 'missingKey' });

  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await doFetch(listModelsUrl(), {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) return aiFail({ kind: 'timeout' });
    return aiFail({ kind: 'network', detail: shortReason(error) });
  } finally {
    clearTimeout(timer);
  }

  const body = await readBody(response);
  if (!response.ok) return aiFail(httpError(response.status, body, response.headers));
  return aiOk(parseModels(body));
}

/** Keeps only the models that can do the job this app needs: generateContent. */
export function parseModels(body: string): readonly AvailableModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];

  const models: AvailableModel[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const methods = record['supportedGenerationMethods'];
    const supported = Array.isArray(methods) && methods.includes('generateContent');
    if (!supported || !name.startsWith('models/')) continue;

    const id = name.slice('models/'.length);
    const display = typeof record['displayName'] === 'string' ? record['displayName'] : '';
    models.push({ id, label: display.length > 0 ? display : id });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Maps an HTTP failure onto something worth saying to a shopkeeper.
 *
 * The 429 split matters most. Google returns 429 both for "you are going too fast" and for
 * "your free allowance for today is gone". Only the second one deserves the promise that nothing
 * will be charged, and only the first one is worth retrying.
 */
export function httpError(status: number, body: string, headers?: Headers, model = ''): AiError {
  const detail = errorMessageFrom(body);
  const lower = `${detail} ${body}`.toLowerCase();

  // 400 that names the key is a bad key. Any other 400 is the request, and saying so stops the
  // owner hunting through Settings for a key that was never the problem.
  if (status === 400) {
    return keyIsTheProblem(lower) ? { kind: 'invalidKey' } : { kind: 'badRequest', status, detail };
  }
  if (status === 401) return { kind: 'invalidKey' };
  if (status === 403) {
    // Google uses 403 both for "this key is not valid" and for "this project may not use this".
    // They need different answers: one is retyped in Settings, the other cannot be.
    return keyIsTheProblem(lower)
      ? { kind: 'invalidKey' }
      : { kind: 'accessDenied', status, detail };
  }
  // 404 is not "no such URL" here - the endpoint is fixed and correct. It is Google saying this
  // key may not call this model, which is what happens to a new project asking for an old one.
  if (status === 404) return { kind: 'modelUnavailable', model, status, detail };
  if (status === 413) return { kind: 'requestTooLarge' };
  if (status === 429) {
    const retryAfter = retryAfterSeconds(body, headers);
    // "quota" / "resource_exhausted" is the free allowance running out; a bare rate limit is not.
    const quota =
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('free tier') ||
      lower.includes('billing');
    return quota ? { kind: 'quotaExhausted', retryAfterSeconds: retryAfter } : { kind: 'rateLimited', retryAfterSeconds: retryAfter };
  }
  if (status === 503) return { kind: 'overloaded' };
  if (status >= 500) return { kind: 'serverError', status, detail };
  return { kind: 'serverError', status, detail };
}

/**
 * Whether Google is complaining about the credential itself.
 *
 * Deliberately narrow. "permission" alone used to land here, but a project denied access to a
 * model also says permission, and sending that owner to retype a perfectly good key wastes the
 * one piece of information the response was carrying.
 */
function keyIsTheProblem(lower: string): boolean {
  return (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid api key') ||
    lower.includes('api key expired') ||
    lower.includes('permission denied on api key') ||
    lower.includes('unauthenticated') ||
    lower.includes('please pass a valid api key')
  );
}

function retryAfterSeconds(body: string, headers?: Headers): number | null {
  const header = headers?.get('retry-after');
  if (header !== null && header !== undefined && /^\d+$/.test(header.trim())) return Number(header.trim());
  const match = /"retryDelay"\s*:\s*"(\d+)(?:\.\d+)?s"/.exec(body);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

function errorMessageFrom(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (typeof err === 'object' && err !== null) {
        const record = err as Record<string, unknown>;
        const message = typeof record['message'] === 'string' ? record['message'] : '';
        const statusText = typeof record['status'] === 'string' ? record['status'] : '';
        return [statusText, message].filter((p) => p.length > 0).join(': ');
      }
    }
  } catch {
    // Not JSON, so there is nothing Google meant for a person to read.
  }
  // Deliberately empty rather than a slice of the body. An unstructured failure is an HTML
  // error page or a proxy's complaint, and putting that on a shopkeeper's screen explains
  // nothing while risking whatever else the body happens to contain. The body is still matched
  // against below for classification - it just never becomes something anyone reads.
  return '';
}

/** Pulls the text out of a successful generateContent response, or explains why there isn't any. */
export function readCandidate(body: string): AiResult<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return aiFail({ kind: 'malformedResponse', detail: 'the reply was not JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return aiFail({ kind: 'malformedResponse', detail: 'the reply was not an object' });
  }
  const root = parsed as Record<string, unknown>;

  const feedback = root['promptFeedback'];
  if (typeof feedback === 'object' && feedback !== null) {
    const blockReason = (feedback as Record<string, unknown>)['blockReason'];
    if (typeof blockReason === 'string' && blockReason.length > 0) {
      return aiFail({ kind: 'blocked', reason: blockReason });
    }
  }

  const candidates = root['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return aiFail({ kind: 'malformedResponse', detail: 'the reply contained no candidates' });
  }
  const candidate = candidates[0] as Record<string, unknown>;

  const finish = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : '';
  if (finish === 'MAX_TOKENS') return aiFail({ kind: 'truncated' });
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    return aiFail({ kind: 'blocked', reason: finish });
  }

  const content = candidate['content'];
  const parts =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>)['parts'] : null;
  if (!Array.isArray(parts)) {
    return aiFail({ kind: 'malformedResponse', detail: 'the reply contained no text' });
  }
  const text = parts
    .map((part) =>
      typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string'
        ? ((part as Record<string, unknown>)['text'] as string)
        : '',
    )
    .join('');

  if (text.trim().length === 0) {
    return aiFail({ kind: 'malformedResponse', detail: 'the reply contained no text' });
  }
  return aiOk(text);
}

function shortReason(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return 'the request could not be sent';
}
