import { useCallback, useEffect, useRef, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { ask } from '../../app/conversation';
import { readFile } from '../../app/images';
import type { Repository } from '../../data/repository';
import { MessageRole, type StoredMessage, type StoredOrder } from '../../data/schema';
import type { Screen } from '../App';
import { PhotoPicker } from '../components/PhotoPicker';
import { TopBar } from '../components/TopBar';
import { updates } from '../updates';
import { useUpdateHold } from '../useUpdateHold';
import { CameraIcon, ListIcon, SendIcon, TruckIcon, MicIcon } from '../components/icons';
import { providerFor } from '../services';
import { jobs, type JobState } from '../../app/jobs';
import { dictationAvailable, useDictation } from '../useDictation';

/** A question asked while the receipt was still being read, waiting for the figures. */
interface Pending {
  readonly question: string;
  readonly file?: File;
}

export function OrderChat(props: {
  repo: Repository;
  orderId: number;
  go: (screen: Screen) => void;
}): JSX.Element {
  const { repo, orderId, go } = props;
  const [order, setOrder] = useState<StoredOrder | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobState | null>(() => jobs.stateOf(orderId));
  const [queued, setQueued] = useState<Pending | null>(null);

  const dictation = useDictation((heard) =>
    // Into the field, not out the door: the owner reads it and fixes it before sending.
    setText((current) => (current.trim().length > 0 ? `${current} ${heard}` : heard)),
  );
  const canDictate = dictationAvailable();

  const bottom = useRef<HTMLDivElement>(null);

  // A half-typed question would be thrown away by a reload. This one does belong to the screen:
  // leaving it discards the draft regardless. The request itself is held in send(), below.
  useUpdateHold(text.trim().length > 0, 'blocking');

  const reload = useCallback(async () => {
    setOrder(await repo.order(orderId));
    setMessages(await repo.conversation(orderId));
  }, [repo, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /*
   * Watches the receipt being read, rather than doing the reading.
   *
   * The work belongs to the coordinator, so this screen can be opened, left and opened again
   * without touching it. Arriving here is what the owner does immediately after pressing the
   * button, so in the common case this subscribes to a job that is already under way.
   */
  useEffect(() => jobs.subscribe(orderId, setJob), [orderId]);

  const reading = job?.kind === 'running';

  useEffect(() => {
    if (job?.kind === 'done' || job?.kind === 'failed') void reload();
  }, [job, reload]);


  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = useCallback(
    async (question: string, file?: File, options: { alreadyShown?: boolean } = {}) => {
      const trimmed = question.trim();
      if (trimmed.length === 0 && file === undefined) return;

      /*
       * Nothing is asked of the model while the receipt is still being read.
       *
       * The costs are not in the database yet, so an answer now would be built out of nothing -
       * and a confidently wrong price is worse than no price at all. The question is kept,
       * said back to the owner so they can see it was heard, and put to the model the moment
       * the figures exist.
       */
      if (options.alreadyShown !== true && jobs.isRunning(orderId)) {
        setText('');
        setQueued({ question: trimmed, file });
        await repo.say(orderId, MessageRole.USER, trimmed.length > 0 ? trimmed : 'How much is this?');
        await repo.say(
          orderId,
          MessageRole.APP,
          'I am still reading the receipt, so I do not have the costs yet. I will answer this as soon as it is done.',
        );
        await reload();
        return;
      }

      setBusy(true);
      setText('');
      // Held by the question, not by the screen: the answer is still coming after Back.
      const release = updates.hold('blocking');
      try {
        const provider = await providerFor(repo);
        let photo = null;
        if (file !== undefined) {
          const image = await readFile(file);
          const stored = await repo.addPhoto({
            orderId,
            bytes: image.bytes,
            mimeType: image.mimeType,
            type: OrderImageType.PRODUCT_PHOTO,
            isDeliveryPhoto: false,
            createdAt: Date.now(),
          });
          photo = { id: stored.id, image };
        }
        await ask(repo, provider, orderId, trimmed.length > 0 ? trimmed : 'how much is this', {
          photo,
        });
      } finally {
        await reload();
        setBusy(false);
        release();
      }
    },
    [repo, orderId, reload],
  );

  /*
   * Answers what was asked while the reading was going on.
   *
   * Only on success. If the receipt could not be read there are still no costs, and the
   * honest thing is to leave the question unanswered and say so rather than guess at it.
   */
  useEffect(() => {
    if (job?.kind !== 'done' || queued === null) return;
    const pending = queued;
    setQueued(null);
    void send(pending.question, pending.file, { alreadyShown: true });
  }, [job, queued, send]);

  return (
    <div className="app">
      <TopBar
        title={order?.supplier ?? 'Order'}
        go={go}
        back={{ kind: 'home' }}
        action={{
          label: 'The order',
          icon: <ListIcon size={22} />,
          onClick: () => go({ kind: 'items', orderId }),
        }}
      />
      <main>
        <div className="chat">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`bubble ${message.role === MessageRole.USER ? 'mine' : 'reply'}`}
            >
              {message.text}
            </div>
          ))}
          {reading && (
            <div className="bubble reply status t-sub">
              <span className="spinner on-paper" aria-hidden="true" />
              {job?.kind === 'running' && job.step !== 'Starting'
                ? `${job.step}…`
                : 'Reading your receipt…'}
            </div>
          )}

          {job?.kind === 'done' && job.result.itemCount > 0 && (
            <div className="bubble reply status t-sub">
              Receipt read - {job.result.itemCount}{' '}
              {job.result.itemCount === 1 ? 'product' : 'products'} ready. Ask me what anything
              costs.
            </div>
          )}

          {job?.kind === 'failed' && (
            // The photographs and any approved prices are untouched, so this really is just a
            // matter of pressing it again.
            <div className="bubble reply status">
              {job.result.summary}
              <button
                type="button"
                className="btn btn-secondary btn-block"
                style={{ marginTop: 'var(--sp-3)' }}
                onClick={() => jobs.start(repo, providerFor, orderId, { reprocess: true })}
              >
                Try reading it again
              </button>
            </div>
          )}

          {busy && (
            <div className="bubble reply status t-sub">
              <span className="spinner on-paper" aria-hidden="true" />
              Thinking…
            </div>
          )}
          <div ref={bottom} />
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => go({ kind: 'delivery', orderId })}
        >
          <TruckIcon size={20} />
          Check a delivery
        </button>

        <div className="composer">
          <input
            type="text"
            value={text}
            placeholder={dictation.listening ? 'Listening…' : 'Ask about this order…'}
            enterKeyHint="send"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void send(text);
            }}
          />
          <PhotoPickerButton disabled={busy} onPick={(file) => void send(text, file)} />
          {canDictate && (
            <button
              type="button"
              className={`icon-btn${dictation.listening ? ' listening' : ''}`}
              disabled={busy}
              aria-label={dictation.listening ? 'Stop listening' : 'Ask out loud'}
              aria-pressed={dictation.listening}
              onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
            >
              <MicIcon size={20} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn send"
            disabled={busy}
            aria-label="Send"
            onClick={() => void send(text)}
          >
            <SendIcon size={20} />
          </button>
        </div>
        {dictation.error !== null && <p className="notice warn">{dictation.error}</p>}
      </main>
    </div>
  );
}

/** The chat's camera button. Same two inputs as elsewhere, collapsed into one control. */
function PhotoPickerButton(props: { disabled: boolean; onPick: (file: File) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="icon-btn"
        disabled={props.disabled}
        aria-label="Attach a photo"
        onClick={() => setOpen(true)}
      >
        <CameraIcon size={20} />
      </button>
    );
  }
  return (
    <PhotoPicker
      compact
      captureLabel="Photo"
      galleryLabel="Pick"
      disabled={props.disabled}
      onPick={(files) => {
        setOpen(false);
        const first = files[0];
        if (first !== undefined) props.onPick(first);
      }}
    />
  );
}
