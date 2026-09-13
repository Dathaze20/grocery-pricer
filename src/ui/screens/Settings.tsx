import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_GEMINI_MODEL, GEMINI_API_KEY_URL, SUGGESTED_GEMINI_MODELS } from '../../ai/model';
import type { Repository } from '../../data/repository';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';

/**
 * Where the shopkeeper puts their own Gemini key.
 *
 * The key is typed here and stored here, on this device. It is not in the source, not in the
 * build, not in the repository, and not on any server of ours - there is no server of ours. The
 * only place it goes is Google, on the calls the shopkeeper asks for.
 */
export function Settings(props: { repo: Repository; go: (screen: Screen) => void }): JSX.Element {
  const { repo, go } = props;
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void repo.apiKey().then((stored) => setKey(stored ?? ''));
    void repo.model().then((stored) => setModel(stored ?? ''));
  }, [repo]);

  const save = useCallback(async () => {
    await repo.setApiKey(key);
    await repo.setModel(model);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }, [repo, key, model]);

  return (
    <div className="app">
      <TopBar title="Settings" go={go} back={{ kind: 'home' }} />
      <main>
        <section className="card stack">
          <h2>AI setup</h2>
          <p className="muted">
            Grocery Pricer reads your receipts with Google Gemini. You use your own key, on Google's
            free tier. Nothing is charged to you, and the key never leaves this device except to
            talk to Google.
          </p>
          <a className="button secondary center" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">
            Get a free Gemini API key →
          </a>
          <p className="muted">
            Open that page, sign in with your Google account, press Create API key, then copy it
            here. It is the same Google AI Studio you already use.
          </p>

          <label htmlFor="key">Your Gemini API key</label>
          <input
            id="key"
            type={reveal ? 'text' : 'password'}
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder="AIza…"
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="button" className="secondary" onClick={() => setReveal(!reveal)}>
            {reveal ? 'Hide the key' : 'Show the key'}
          </button>

          <label htmlFor="model">Model</label>
          <input
            id="model"
            type="text"
            value={model}
            spellCheck={false}
            placeholder={DEFAULT_GEMINI_MODEL}
            onChange={(event) => setModel(event.target.value)}
          />
          <p className="muted">
            Leave this empty unless Google retires a model. Suggested: {SUGGESTED_GEMINI_MODELS.join(', ')}.
          </p>

          <button type="button" className="primary" onClick={() => void save()}>
            {saved ? 'Saved' : 'Save'}
          </button>

          {key.length > 0 && (
            <button
              type="button"
              className="secondary danger"
              onClick={() => {
                setKey('');
                void repo.setApiKey(null);
              }}
            >
              Remove the key from this device
            </button>
          )}
        </section>

        <section className="card stack">
          <h2>Where your data lives</h2>
          <p className="muted">
            Orders, photos, prices and this key are stored in this browser, on this device. Clearing
            the browser's site data deletes them. Installing the app to the home screen keeps them.
          </p>
        </section>
      </main>
    </div>
  );
}
