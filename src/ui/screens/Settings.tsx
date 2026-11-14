import { useCallback, useEffect, useRef, useState } from 'react';
import { GEMINI_API_KEY_URL, SUGGESTED_GEMINI_MODELS, configuredModel } from '../../ai/model';
import type { Repository } from '../../data/repository';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { Toast } from '../components/Toast';
import { CheckIcon } from '../components/icons';

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
  const [toast, setToast] = useState<string | null>(null);
  // True once the user has touched a field. Reading the stored values takes a moment on a cold
  // database, and someone who pastes their key in that moment must not have it wiped from under
  // them - which looks exactly like the app losing the key they just pasted.
  const edited = useRef(false);

  useEffect(() => {
    void repo.apiKey().then((stored) => {
      if (!edited.current) setKey(stored ?? '');
    });
    void repo.model().then((stored) => {
      if (!edited.current) setModel(stored ?? '');
    });
  }, [repo]);

  const save = useCallback(async () => {
    // An empty box is not an instruction to forget the key: pressing Save on a field that has
    // not loaded yet, or was cleared by accident, would silently delete a working key. Removing
    // it is deliberate, and has its own button.
    const hadKey = key.trim().length > 0;
    if (hadKey) await repo.setApiKey(key);
    await repo.setModel(model);
    setSaved(true);
    setToast(hadKey ? 'Key saved' : 'Model saved');
    setTimeout(() => setSaved(false), 2500);
    // Cleared so the same message can be shown again on the next save.
    setTimeout(() => setToast(null), 100);
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
            onChange={(event) => {
              edited.current = true;
              setKey(event.target.value);
            }}
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
            placeholder="Default"
            onChange={(event) => {
              edited.current = true;
              setModel(event.target.value);
            }}
          />
          <p className="muted">
            Reading your receipts with <strong>{configuredModel(model)}</strong>. Leave empty for
            the default; if Google ever retires it, try{' '}
            {SUGGESTED_GEMINI_MODELS.find((name) => name !== configuredModel(model))}.
          </p>

          <button type="button" className="primary button-done" onClick={() => void save()}>
            {saved ? (
              <>
                <CheckIcon size={20} /> Saved
              </>
            ) : (
              'Save'
            )}
          </button>

          {key.length > 0 && (
            <button
              type="button"
              className="secondary danger"
              onClick={() => {
                edited.current = true;
                setKey('');
                void repo.setApiKey(null);
                setToast('Key removed');
                setTimeout(() => setToast(null), 100);
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
      <Toast message={toast} />
    </div>
  );
}
