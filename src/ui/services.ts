import { GeminiProvider } from '../ai/provider';
import type { AiProvider } from '../ai/provider';
import { modelChain } from '../ai/model';
import { Repository } from '../data/repository';

/**
 * Builds a provider from whatever key the shopkeeper has stored, at the moment it is needed.
 *
 * Reading the key per call rather than holding it in a module variable is deliberate: it means
 * removing the key in Settings takes effect immediately, and there is no long-lived copy of it
 * anywhere in the running app.
 *
 * The model is chosen here too, and never by the owner. They get a list of models only if they
 * go looking for one in Advanced; the ordinary path is that the app tries the model that
 * worked last time for this key, and moves down a short approved list if Google has stopped
 * offering it. Which model read the receipt is not a decision a deli owner should have to make.
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
  });
}

export async function hasKey(repo: Repository): Promise<boolean> {
  return (await repo.apiKey()) !== null;
}
