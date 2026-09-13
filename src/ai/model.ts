/**
 * The one place a Gemini model name is written down.
 *
 * Google retires and renames models faster than an app can be rebuilt, so the name is never
 * hard-coded anywhere else. Everything resolves through here, and a user whose account has a
 * different model available can override it in Settings without waiting for a new release.
 */

/**
 * Default model: a current multimodal Flash model, available on the Google AI Studio free tier.
 *
 * Flash rather than Pro on purpose. This app sends photographs of receipts, and Flash's free
 * allowance is what makes the whole thing free for a corner shop.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Models offered in Settings. The list is a convenience, not a limit - Settings also accepts a
 * typed-in name so a model released after this build still works.
 */
export const SUGGESTED_GEMINI_MODELS: readonly string[] = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];

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

export function generateContentUrl(model: string): string {
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
}
