import { useCallback, useEffect, useRef, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { ask } from '../../app/conversation';
import { sortWarnings } from '../../core/warnings';
import { readFile } from '../../app/images';
import type { Repository } from '../../data/repository';
import {
  MessageRole,
  type StoredBreakdown,
  type StoredBreakdownRow,
  type StoredMessage,
  type StoredOrder,
  isIncomplete,
} from '../../data/schema';
import type { Screen } from '../App';
import { PhotoPicker } from '../components/PhotoPicker';
import { TopBar } from '../components/TopBar';
import { updates } from '../updates';
import { useUpdateHold } from '../useUpdateHold';
import { CameraIcon, ListIcon, SendIcon, TruckIcon, MicIcon } from '../components/icons';
import { providerFor } from '../services';
import { jobs, type JobState } from '../../app/jobs';
import { pending, type PendingQuestion } from '../../app/pending';
import { dictationAvailable, useDictation } from '../useDictation';

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
  const [queue, setQueue] = useState<readonly PendingQuestion[]>(() => pending.queue(orderId));

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

  // Held outside this component, so walking to the order list and back does not empty it.
  useEffect(() => pending.subscribe(orderId, setQueue), [orderId]);

  const reading = job?.kind === 'running';

  /*
   * Taken from the order, not from the job.
   *
   * A job lives as long as the tab does. The fact that a receipt was only half read has to
   * outlive that - otherwise closing the app turns an incomplete order into one that looks
   * finished, which is the quietest way for a wrong total to be trusted.
   */
  const incomplete = !reading && order !== null && isIncomplete(order);
  // Sorted once per render rather than inside the list, so the three groups agree.
  const warnings = sortWarnings(order?.warnings ?? []);

  // The oldest question that failed. Only one is ever shown: the queue stalls on it, so
  // pressing the button is what moves everything behind it.
  const stuck = queue.find((q) => pending.isBlocked(q.id)) ?? null;

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

        // The photograph is written to the database now, while the page still holds it. A File
        // is a handle to something this tab is keeping alive; leaving the screen would take
        // the only copy of what the owner just photographed.
        let photoId: number | null = null;
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
          photoId = stored.id;
        }

        const asked = trimmed.length > 0 ? trimmed : 'How much is this?';
        // Written once, here, and never again: ask() is told later that it is already in the
        // thread, so answering it does not make the question appear twice.
        await repo.say(orderId, MessageRole.USER, asked, { photoId });
        pending.add(orderId, asked, photoId);

        // One notice for the wait, however many questions are asked during it. Repeating "I
        // will answer this" after every question is noise, not reassurance.
        if (pending.queue(orderId).length === 1) {
          await repo.say(
            orderId,
            MessageRole.APP,
            'I am still reading the receipt, so I do not have the costs yet. I will answer as soon as it is done.',
          );
        }
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

  /** Answers a question that is already written in the conversation, so it is not written again. */
  const answerPending = useCallback(
    async (item: PendingQuestion) => {
      setBusy(true);
      const release = updates.hold('blocking');
      try {
        const provider = await providerFor(repo);
        const photo =
          item.photoId === null
            ? null
            : await (async () => {
                const stored = await repo.photo(item.photoId!);
                return stored === null
                  ? null
                  : { id: stored.id, image: { bytes: stored.bytes, mimeType: stored.mimeType } };
              })();

        const answer = await ask(repo, provider, orderId, item.question, {
          photo,
          alreadyAsked: true,
        });

        // Gemini's failure is text in the thread, but it is not an answer. Completing on it
        // would drop the question for having produced an error message.
        if (answer.failed === true) {
          pending.fail(orderId, item.id);
          return;
        }

        // Only now. Everything above could throw, and a question dropped before its answer
        // exists is a question the owner asked and will never get back.
        pending.complete(orderId, item.id);
      } catch {
        // Kept, with its photograph, and left alone until the owner asks again. Claiming it
        // back automatically would retry a failing model for as long as it keeps failing.
        pending.fail(orderId, item.id);
        await repo.say(
          orderId,
          MessageRole.APP,
          'Something went wrong answering that. Your question is still here.',
        );
      } finally {
        await reload();
        setBusy(false);
        release();
      }
    },
    [repo, orderId, reload],
  );

  /*
   * Answers what was asked while the reading was going on, oldest first, one at a time.
   *
   * Only on success. A receipt that could not be read leaves the costs absent, and the honest
   * thing is to leave those questions unanswered and let the owner retry - inventing a price
   * because somebody asked for one is the one failure this app cannot afford.
   */
  useEffect(() => {
    if (job?.kind !== 'done' || job.result.itemCount === 0) return;
    if (busy || queue.length === 0) return;

    // Claimed, not taken: it comes off the queue only once its answer is saved.
    const next = pending.claimNext(orderId);
    if (next === null) return;
    void answerPending(next);
  }, [job, queue, busy, orderId, answerPending]);


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
              {/*
                * The figures first, then the explanation.
                *
                * Both say the same thing on purpose: the block is for finding one number at a
                * glance over a receipt, the sentences are for understanding it - and the
                * sentences are what is stored, so an answer read back on a build that never
                * knew about blocks is still a whole answer.
                */}
              {message.breakdowns?.map((breakdown, index) => (
                <BreakdownBlock key={`${message.id}-${index}`} breakdown={breakdown} />
              ))}
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

          {job?.kind === 'done' && job.result.outcome === 'complete' && (
            <div className="bubble reply status t-sub">
              Receipt read - {job.result.itemCount}{' '}
              {job.result.itemCount === 1 ? 'product' : 'products'} ready. Ask me what anything
              costs.
            </div>
          )}

          {incomplete && (
            // Deliberately not a tick. Some of the receipt was not read, so the products are
            // usable but the total is not the order, and saying "done" here would be a lie
            // that somebody prices against.
            <div className="bubble reply status">
              Only part of this receipt was read. The total below is not the whole order, and
              any discount printed on a line that was not read is not in these costs - so check
              a product against the receipt before you price from it.
              <button
                type="button"
                className="btn btn-secondary btn-block"
                style={{ marginTop: 'var(--sp-3)' }}
                onClick={() => jobs.start(repo, providerFor, orderId, { reprocess: true })}
              >
                Read the whole receipt again
              </button>
            </div>
          )}

          {job !== null && job.kind !== 'running' && (job.kind === 'failed' || job.result.outcome === 'empty') && (
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

          {stuck !== null && (
            <div className="bubble reply status">
              I could not answer “{stuck.question}”. It is still here, with anything you
              photographed for it.
              <button
                type="button"
                className="btn btn-secondary btn-block"
                style={{ marginTop: 'var(--sp-3)' }}
                disabled={busy}
                onClick={() => pending.retry(orderId)}
              >
                Try answering it again
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

        {/*
          * Asking a question is what this screen is for.
          *
          * A full-width "Check a delivery" sat directly above the question box and outweighed
          * it, so the one thing the app exists to do was the second thing on the screen - and
          * the box under it read as part of the button. Checking a delivery is still here, one
          * tap away, as a quiet line rather than the loudest control.
          */}
        <div className="composer-dock">
        <div className="composer-label">
          <label htmlFor="ask">Ask about prices, discounts or profits</label>
          <button
            type="button"
            className="link-action"
            onClick={() => go({ kind: 'delivery', orderId })}
          >
            <TruckIcon size={16} />
            Check a delivery
          </button>
        </div>

        <div className="composer">
          <input
            id="ask"
            type="text"
            value={text}
            aria-label="Ask about prices, discounts or profits"
            placeholder={dictation.listening ? 'Listening…' : 'Type your question…'}
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
        </div>
        {dictation.error !== null && <p className="notice warn">{dictation.error}</p>}

        {order !== null && order.warnings.length > 0 && (
          /*
           * What the app could not read, kept from when the order was processed.
           *
           * These were being stored and never shown. Only the first ever reached the summary
           * line, and once a partial reading started adding its own note at the front, even
           * that one slot stopped carrying the reasons. A shop looking at a short total had no
           * way to find out what had gone missing.
           *
           * Read straight from the saved order, so it works for receipts processed long ago
           * without re-reading anything.
           */
          <>
            {/*
              * Three different things, told apart.
              *
              * An order came back with two dozen notes, most of them saying a discount was
              * listed twice and counted once - the app working - all filed under "What could
              * not be read", with the ones that mattered buried among them. What needs the
              * owner now is open; what was handled is one line they can unfold if curious.
              */}
            {warnings.unread.length > 0 && (
              <details className="note warn-note" open>
                <summary>Photos or details not read ({warnings.unread.length})</summary>
                <ul>
                  {warnings.unread.map((warning, index) => (
                    <li key={`unread-${index}`}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {warnings.review.length > 0 && (
              <details className="note warn-note" open>
                <summary>Needs review ({warnings.review.length})</summary>
                <ul>
                  {warnings.review.map((warning, index) => (
                    <li key={`review-${index}`}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {warnings.handled.length > 0 && (
              <details className="note">
                <summary>Discounts handled automatically ({warnings.handled.length})</summary>
                <ul>
                  {warnings.handled.map((warning, index) => (
                    <li key={`handled-${index}`}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {job !== null && job.kind !== 'running' && job.result.timings.length > 0 && (
          // Folded away, and durations only: no photograph, no prompt, no reply, no key,
          // nothing off the receipt. It is here so a slow read can be described precisely
          // instead of guessed at.
          <details className="note">
            <summary>How long the last reading took</summary>
            <ul>
              {job.result.timings.map((timing) => (
                <li key={timing.phase}>
                  {timing.phase}: {(timing.ms / 1000).toFixed(1)}s
                </li>
              ))}
            </ul>
          </details>
        )}
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


/**
 * A chat answer's figures, laid out like the product card.
 *
 * Rendered from stored values through React, never as markup: nothing a model produced is
 * given to the browser as HTML. Colour repeats what each label already says, so the block
 * reads the same to somebody who cannot see the difference between red and green.
 */
function BreakdownBlock({ breakdown }: { breakdown: StoredBreakdown }): JSX.Element {
  return (
    <div className="chat-money">
      <p className="chat-money-title">{breakdown.title}</p>
      <dl className="money">
        {breakdown.rows.map((row, index) => (
          <div key={`${row.label}-${index}`} className={toneClass(row.tone)}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {breakdown.notes?.map((note, index) => (
        <p key={`note-${index}`} className="chat-money-note">
          {note}
        </p>
      ))}
    </div>
  );
}

function toneClass(tone: StoredBreakdownRow['tone']): string {
  switch (tone) {
    case 'off':
      return 'money-off';
    case 'keep':
      return 'money-keep';
    case 'warn':
      return 'money-warn';
    case 'strong':
      return 'money-net';
    default:
      return '';
  }
}
