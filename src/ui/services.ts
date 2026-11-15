import { GeminiProvider } from '../ai/provider';
import type { AiProvider } from '../ai/provider';
import { modelChain } from '../ai/model';
import type { AiError } from '../core/ai-types';
import { Repository } from '../data/repository';

/**
 * Why reading a receipt did not work, in words fit for a status line.
 *
 * No model names, no HTTP statuses, no Google error text. The screen that failed already
 * carries the full explanation; this is the one line Settings shows afterwards, and a deli
 * owner should be able to act on it without knowing what a model is.
 */
export function shortAiFault(error: AiError): string {
  switch (error.kind) {
    case 'noWorkingModel':
    case 'modelUnavailable':
    case 'accessDenied':
      return 'Google would not accept the request. Check the key or try again later.';
    case 'invalidKey':
      return 'The key was rejected. Check it above.';
    case 'missingKey':
      return 'No key saved yet.';
    case 'quotaExhausted':
      return 'The free allowance is used up for now.';
    case 'rateLimited':
    case 'overloaded':
      return 'Gemini was busy. Try again in a moment.';
    case 'network':
    case 'timeout':
      return 'Could not reach Google. Check the connection.';
    default:
      return 'The last receipt could not be read.';
  }
}

/**
 * Builds a provider from whatever key the shopkeeper has stored, at the moment it is needed.
 *
 * Reading the key per call rather than holding it in a module variable is deliberate: it means
 * removing the key in Settings takes effect immediately, and there is no long-lived copy of it
 * anywhere in the running app.
 *
 * The model is chosen here too, and never by the owner. They see a list of models only if they
 * go looking in Advanced; the ordinary path is that the app starts with the model that worked
 * last time for this key and moves down a short approved list if Google has stopped offering
 * it. Which model read the receipt is not a decision a deli owner should have to make.
 */
export async function providerFor(repo: Repository): Promise<AiProvider> {
  const apiKey = await repo.apiKey();
  const [override, remembered] = await Promise.all([repo.model(), repo.workingModel(apiKey)]);

  return new GeminiProvider({
    apiKey,
    models: modelChain({ override, remembered }),

    // Written down as soon as a model answers, so the next receipt starts with one that works
    // instead of walking the list again. Fire-and-forget: a failed write costs one extra
    // attempt next time and must never fail the request that just succeeded.
    onModelWorked: (model) => {
      void repo.rememberWorkingModel(apiKey, model).catch(() => undefined);
    },

    // A remembered model that has stopped working must not keep its place at the front of the
    // chain, or every receipt from now on starts with a wasted call to a dead name.
    onModelRejected: (model) => {
      if (model === remembered) void repo.forgetWorkingModel().catch(() => undefined);
    },

    // So Settings can say whether Gemini has actually answered, rather than assuming that a
    // saved key means a working one.
    onOutcome: (error) => {
      if (error === null || error.kind === 'missingKey') return;
      void repo.recordAiFault(apiKey, shortAiFault(error)).catch(() => undefined);
    },
  });
}

export async function hasKey(repo: Repository): Promise<boolean> {
  return (await repo.apiKey()) !== null;
}
