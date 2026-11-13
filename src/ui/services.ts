import { GeminiProvider } from '../ai/provider';
import type { AiProvider } from '../ai/provider';
import { Repository } from '../data/repository';

/**
 * Builds a provider from whatever key the shopkeeper has stored, at the moment it is needed.
 *
 * Reading the key per call rather than holding it in a module variable is deliberate: it means
 * removing the key in Settings takes effect immediately, and there is no long-lived copy of it
 * anywhere in the running app.
 */
export async function providerFor(repo: Repository): Promise<AiProvider> {
  const [apiKey, model] = await Promise.all([repo.apiKey(), repo.model()]);
  return new GeminiProvider({ apiKey, model });
}

export async function hasKey(repo: Repository): Promise<boolean> {
  return (await repo.apiKey()) !== null;
}
