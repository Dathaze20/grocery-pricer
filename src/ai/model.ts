/**
 * The one place a Gemini model name is written down.
 *
 * Google retires and renames models faster than an app can be rebuilt, so the name is never
 * hard-coded anywhere else. Everything resolves through here, and a user whose account has a
 * different model available can override it in Settings without waiting for a new release.
 */

/**
 * The models this app will choose on its own, best first.
 *
 * Deliberately tiny. Google advertises dozens to a key - research agents, image generators,
 * speech, robotics, experiments - and a shopkeeper must never be asked to tell them apart. The
 * job here is narrow and always the same: read a photograph of a receipt and return JSON. So
 * this list holds only current multimodal Flash-tier models, and the rest are excluded on
 * purpose:
 *
 *   - Pro tier, which costs more and reads printed figures no better.
 *   - *-image, *-tts, lyria, nano-banana: these make pictures or speech. Wrong tool.
 *   - deep-research, antigravity, robotics, computer-use: agents, not readers.
 *   - *-preview and *-exp, because an experiment can be withdrawn mid-shift.
 *
 * Newest-capable first, then lighter and more widely available. `gemini-flash-latest` sits in
 * the middle as the alias that survives a rename: if every pinned name here were retired at
 * once, that one still resolves to whatever Flash currently is.
 */
export const APPROVED_GEMINI_MODELS: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash-lite',
];

/**
 * Where a fresh install starts.
 *
 * gemini-2.5-flash was the previous default and is now refused outright to newer API keys -
 * HTTP 404, while still appearing among the models Google advertises for that very key. That
 * is the whole reason the chain above exists: a name can stop working without warning, and the
 * app must try the next one rather than hand its owner a list of model names to choose from.
 */
export const DEFAULT_GEMINI_MODEL = APPROVED_GEMINI_MODELS[0]!;

/**
 * How many models one request may try before giving up.
 *
 * Small on purpose. Each attempt is a real call with photographs attached: slow on shop wi-fi
 * and spending the owner's free allowance. Three covers a retired primary plus two
 * alternatives, and past that something is wrong that another model will not fix.
 */
export const MAX_MODEL_ATTEMPTS = 3;

/** Offered in Advanced, for troubleshooting. Settings also accepts any name typed by hand. */
export const SUGGESTED_GEMINI_MODELS: readonly string[] = APPROVED_GEMINI_MODELS;

/** Where a user goes to create their own free key. Shown as a link in Settings. */
export const GEMINI_API_KEY_URL = 'https://aistudio.google.com/app/apikey';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * A build may pre-set the model (`VITE_GEMINI_MODEL`) without pre-setting a key. Note what is
 * deliberately absent: there is no VITE_GEMINI_API_KEY. A key baked into a build is a key
 * published to everyone who loads the page.
 */
export function configuredModel(override?: string | null): string {
  const trimmed = override?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  const fromBuild = (import.meta.env?.VITE_GEMINI_MODEL as string | undefined)?.trim();
  return fromBuild !== undefined && fromBuild.length > 0 ? fromBuild : DEFAULT_GEMINI_MODEL;
}

/** The models this key may call. Used to answer a 404 with a list rather than a shrug. */
export function listModelsUrl(): string {
  return `${GEMINI_API_BASE}/models?pageSize=200`;
}

/**
 * The order in which to try models for one request.
 *
 * A name the owner typed in Advanced goes first - a deliberate choice deserves to be honoured -
 * and the model that last worked for this key goes next, so the ordinary case is a single call
 * to a model already known to answer. The approved list follows as backup, which is what stops
 * a troubleshooting experiment from leaving the app unable to read anything at all.
 */
export function modelChain(options: {
  override?: string | null;
  remembered?: string | null;
}): readonly string[] {
  const chain: string[] = [];
  const add = (name: string | null | undefined): void => {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length > 0 && !chain.includes(trimmed)) chain.push(trimmed);
  };

  add(options.override);
  add(options.remembered);
  for (const name of APPROVED_GEMINI_MODELS) add(name);
  return chain;
}

export function generateContentUrl(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}
