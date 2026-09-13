import { useCallback, useEffect, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { readFile } from '../../app/images';
import { processOrder } from '../../app/processing';
import type { Repository } from '../../data/repository';
import { OrderStatus, type StoredPhoto } from '../../data/schema';
import type { Screen } from '../App';
import { PhotoGrid } from '../components/PhotoGrid';
import { PhotoPicker } from '../components/PhotoPicker';
import { TopBar } from '../components/TopBar';
import { providerFor } from '../services';

export function NewOrder(props: {
  repo: Repository;
  orderId: number;
  go: (screen: Screen) => void;
}): JSX.Element {
  const { repo, orderId, go } = props;
  const [photos, setPhotos] = useState<StoredPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setPhotos(await repo.photosFor(orderId, false));
  }, [repo, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const image = await readFile(file);
        await repo.addPhoto({
          orderId,
          bytes: image.bytes,
          mimeType: image.mimeType,
          type: OrderImageType.UNKNOWN,
          isDeliveryPhoto: false,
          createdAt: Date.now(),
        });
      }
      await reload();
    },
    [repo, orderId, reload],
  );

  const remove = useCallback(
    async (id: number) => {
      await repo.deletePhoto(id);
      await reload();
    },
    [repo, reload],
  );

  const process = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStep('Starting');
    try {
      const provider = await providerFor(repo);
      const result = await processOrder(repo, provider, orderId, { onProgress: setStep });
      if (result.ok) {
        go({ kind: 'order', orderId });
        return;
      }
      setError(result.summary);
      if (result.error?.kind === 'missingKey') go({ kind: 'settings' });
    } finally {
      setBusy(false);
      setStep(null);
    }
  }, [repo, orderId, go]);

  return (
    <div className="app">
      <TopBar title="New order" go={go} back={{ kind: 'home' }} />
      <main>
        <p className="muted">
          Photograph the whole receipt. Several photos are fine - overlap them rather than leaving
          a gap, and I will work out which lines are the same.
        </p>

        <PhotoPicker onPick={(files) => void add(files)} disabled={busy} />

        <PhotoGrid photos={photos} onRemove={busy ? undefined : (id) => void remove(id)} />

        {error !== null && <p className="notice bad">{error}</p>}

        <button
          type="button"
          className="primary huge"
          disabled={busy || photos.length === 0}
          onClick={() => void process()}
        >
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {step ?? 'Working'}…
            </>
          ) : (
            'PROCESS ORDER'
          )}
        </button>

        {photos.length === 0 && <p className="muted center">Add a photo to get started.</p>}

        <button
          type="button"
          className="secondary danger"
          disabled={busy}
          onClick={() => {
            void repo.order(orderId).then(async (order) => {
              // An untouched draft is not worth keeping in the list.
              if (order !== null && order.status === OrderStatus.DRAFT && photos.length === 0) {
                await repo.deleteOrder(orderId);
              }
              go({ kind: 'home' });
            });
          }}
        >
          Cancel
        </button>
      </main>
    </div>
  );
}
