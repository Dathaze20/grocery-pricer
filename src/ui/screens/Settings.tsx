import { useCallback, useEffect, useRef, useState } from 'react';
import { GEMINI_API_KEY_URL, SUGGESTED_GEMINI_MODELS, configuredModel } from '../../ai/model';
import { listModels, type AvailableModel } from '../../ai/gemini';
import { aiErrorMessage } from '../../core/ai-types';
import type { Repository } from '../../data/repository';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { Toast } from '../components/Toast';
import { CheckIcon, ExternalLinkIcon } from '../components/icons';
import { useUpdateHold } from '../useUpdateHold';

/**
 * Where the shopkeeper puts their own Gemini key.
 *
 * The field comes first and the explanations fold away behind a summary. Three paragraphs
 * before the first input is a wall to climb every time you come here to change one thing - and
 * the people who need the explanation need it once.
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
  // The answer to "why did Gemini refuse this model?", asked of Google rather than guessed.
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<readonly AvailableModel[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  // True once the user has touched a field. Reading the stored values takes a moment on a cold
  // database, and someone who pastes their key in that moment must not have it wiped from under
  // them - which looks exactly like the app losing the key they just pasted.
  const edited = useRef(false);
  // A key typed but not yet saved is unsaved work; a reload would throw it away.
  const [dirty, setDirty] = useState(false);
  useUpdateHold(dirty, 'blocking');

  useEffect(() => {
    void repo.apiKey().then((stored) => {
      if (!edited.current) setKey(stored ?? '');
    });
    void repo.model().then((stored) => {
      if (!edited.current) setModel(stored ?? '');
    });
  }, [repo]);

  const checkModels = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    setAvailable(null);
    try {
      // The stored key, not the box: this asks Google the same question the failing call asks.
      const stored = await repo.apiKey();
      const result = await listModels({ apiKey: stored });
      if (result.ok) setAvailable(result.value);
      else setCheckError(aiErrorMessage(result.error));
    } finally {
      setChecking(false);
    }
  }, [repo]);

  const save = useCallback(async () => {
    // An empty box is not an instruction to forget the key: pressing Save on a field that has
    // not loaded yet, or was cleared by accident, would silently delete a working key. Removing
    // it is deliberate, and has its own button.
    const hadKey = key.trim().length > 0;
    if (hadKey) await repo.setApiKey(key);
    await repo.setModel(model);
    setSaved(true);
    setDirty(false);
    setToast(hadKey ? 'Key saved' : 'Model saved');
    setTimeout(() => setSaved(false), 2500);
    // Cleared so the same message can be shown again on the next save.
    setTimeout(() => setToast(null), 100);
  }, [repo, key, model]);

  const touch = useCallback(() => {
    edited.current = true;
    setDirty(true);
  }, []);

  return (
    <div className="app">
      <TopBar title="Settings" go={go} back={{ kind: 'home' }} />
      <main>
        <h2 className="t-section" style={{ marginTop: 0 }}>AI setup</h2>

        <div className="card card-pad stack">
          <div>
            <label htmlFor="key">Your Gemini API key</label>
            <div className="field">
              <input
                id="key"
                type={reveal ? 'text' : 'password'}
                value={key}
                autoComplete="off"
                spellCheck={false}
                placeholder="AIza…"
                onChange={(event) => {
                  touch();
                  setKey(event.target.value);
                }}
              />
              <button type="button" className="field-action" onClick={() => setReveal(!reveal)}>
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="model">Model</label>
            <input
              id="model"
              type="text"
              value={model}
              spellCheck={false}
              placeholder="Default"
              onChange={(event) => {
                touch();
                setModel(event.target.value);
              }}
            />
            <p className="t-cap" style={{ marginTop: 'var(--sp-2)' }}>
              Reading your receipts with <strong>{configuredModel(model)}</strong>. Leave empty for
              the default; if Google ever retires it, try{' '}
              {SUGGESTED_GEMINI_MODELS.find((name) => name !== configuredModel(model))}.
            </p>

            <button
              type="button"
              className="btn btn-secondary btn-block"
              style={{ marginTop: 'var(--sp-3)' }}
              disabled={checking}
              onClick={() => void checkModels()}
            >
              {checking ? 'Asking Google...' : 'List the models Google advertises for my key'}
            </button>

            {checkError !== null && <p className="notice warn">{checkError}</p>}

            {available !== null &&
              (available.length === 0 ? (
                <p className="notice warn">
                  Your key reached Google, but Google advertised no model that can read
                  photographs. That points at the Google project the key belongs to rather than at
                  this app.
                </p>
              ) : (
                <div className="stack" style={{ marginTop: 'var(--sp-3)' }}>
                  <p className="t-cap">
                    Google advertises these models to your key. Being listed is not a promise
                    that one will work - a model can be listed and still refuse the request - so
                    if the first choice fails, come back and try another. Tap one, then Save.
                  </p>
                  {available.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="row-button bare"
                      onClick={() => {
                        touch();
                        setModel(candidate.id);
                        setToast(`Model set to ${candidate.id} - press Save to keep it`);
                      }}
                    >
                      <span className="grow stack" style={{ gap: 2 }}>
                        <span className="name">{candidate.id}</span>
                        {candidate.label !== candidate.id && (
                          <span className="t-cap">{candidate.label}</span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
          </div>
        </div>

        <a className="link-row" href={GEMINI_API_KEY_URL} target="_blank" rel="noreferrer">
          <span className="grow">Get a free Gemini API key</span>
          <ExternalLinkIcon size={18} />
        </a>

        <details className="note">
          <summary>How do I get a key?</summary>
          <p>
            Open the link above, sign in with your Google account, press Create API key, then copy
            it here. It is the same Google AI Studio you already use.

            Grocery Pricer never turns billing on and never selects a paid model. What you are
            charged, if anything, is between you and Google: it depends on whether billing is
            enabled on the Google project the key belongs to, which model that project allows,
            and how much you use it. A key on a project with no billing stops at the free
            allowance instead of charging you. Check your usage in Google AI Studio.
          </p>
        </details>

        <details className="note">
          <summary>Where does my data live?</summary>
          <p>
            Orders, photos, prices and this key are stored in this browser, on this device. The key
            never leaves it except to talk to Google. Clearing the browser's site data deletes
            everything; installing the app to the home screen keeps it.
          </p>
        </details>

        {key.length > 0 && (
          <button
            type="button"
            className="btn btn-danger btn-block"
            onClick={() => {
              edited.current = true;
              setDirty(false);
              setKey('');
              void repo.setApiKey(null);
              setToast('Key removed');
              setTimeout(() => setToast(null), 100);
            }}
          >
            Remove the key from this device
          </button>
        )}

        <div className="actionbar">
          <button type="button" className="btn btn-primary btn-block" onClick={() => void save()}>
            {saved ? (
              <>
                <CheckIcon size={20} /> Saved
              </>
            ) : (
              'Save'
            )}
          </button>
        </div>
      </main>
      <Toast message={toast} />
    </div>
  );
}
