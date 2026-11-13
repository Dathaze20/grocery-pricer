import { useCallback, useEffect, useRef, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { ask } from '../../app/conversation';
import { readFile } from '../../app/images';
import type { Repository } from '../../data/repository';
import { MessageRole, type StoredMessage, type StoredOrder } from '../../data/schema';
import type { Screen } from '../App';
import { PhotoPicker } from '../components/PhotoPicker';
import { TopBar } from '../components/TopBar';
import { providerFor } from '../services';

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
  const bottom = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setOrder(await repo.order(orderId));
    setMessages(await repo.conversation(orderId));
  }, [repo, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const send = useCallback(
    async (question: string, file?: File) => {
      const trimmed = question.trim();
      if (trimmed.length === 0 && file === undefined) return;
      setBusy(true);
      setText('');
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
      }
    },
    [repo, orderId, reload],
  );

  return (
    <div className="app">
      <TopBar
        title={order?.supplier ?? 'Order'}
        go={go}
        back={{ kind: 'home' }}
        action={{ label: 'The order', onClick: () => go({ kind: 'items', orderId }) }}
      />
      <main>
        <div className="chat">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`bubble ${message.role === MessageRole.USER ? 'user' : 'app'}`}
            >
              {message.text}
            </div>
          ))}
          {busy && (
            <div className="bubble app muted">
              <span className="spinner" aria-hidden="true" />
              Thinking…
            </div>
          )}
          <div ref={bottom} />
        </div>

        <button type="button" className="secondary" onClick={() => go({ kind: 'delivery', orderId })}>
          Check a delivery against this order
        </button>

        <div className="composer">
          <input
            type="text"
            value={text}
            placeholder="Ask about this order…"
            enterKeyHint="send"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void send(text);
            }}
          />
          <PhotoPickerButton disabled={busy} onPick={(file) => void send(text, file)} />
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label="Send"
            onClick={() => void send(text)}
          >
            ➤
          </button>
        </div>
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
        className="icon-button"
        disabled={props.disabled}
        aria-label="Attach a photo"
        onClick={() => setOpen(true)}
      >
        📷
      </button>
    );
  }
  return (
    <PhotoPicker
      cameraLabel="Photo"
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
