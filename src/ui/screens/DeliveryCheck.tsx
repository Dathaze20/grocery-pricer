import { useCallback, useEffect, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { DeliveryStatus } from '../../core/delivery';
import { readFile } from '../../app/images';
import { checkDelivery } from '../../app/delivery-check';
import type { Repository } from '../../data/repository';
import type { StoredDeliveryLine, StoredPhoto } from '../../data/schema';
import type { Screen } from '../App';
import { PhotoGrid } from '../components/PhotoGrid';
import { PhotoPicker } from '../components/PhotoPicker';
import { TopBar } from '../components/TopBar';
import { providerFor } from '../services';

/**
 * Workflow 2: what arrived against what was invoiced.
 *
 * The screen is built around the honest answer. A shortfall the photographs cannot settle is
 * shown as "take another photo", not as a missing case, because the next thing that happens is a
 * phone call to a supplier.
 */
export function DeliveryCheck(props: {
  repo: Repository;
  orderId: number;
  go: (screen: Screen) => void;
}): JSX.Element {
  const { repo, orderId, go } = props;
  const [photos, setPhotos] = useState<StoredPhoto[]>([]);
  const [lines, setLines] = useState<StoredDeliveryLine[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const all = await repo.photosFor(orderId);
    setPhotos(all.filter((photo) => photo.isDeliveryPhoto));
    const checks = await repo.deliveryChecksFor(orderId);
    if (checks.length > 0) {
      setLines(checks[0]!.lines);
      setSummary(null);
    }
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
          type: OrderImageType.PRODUCT_PHOTO,
          isDeliveryPhoto: true,
          createdAt: Date.now(),
        });
      }
      await reload();
    },
    [repo, orderId, reload],
  );

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = await providerFor(repo);
      const result = await checkDelivery(repo, provider, orderId, photos.map((p) => p.id));
      if (!result.ok) {
        setError(result.summary);
        return;
      }
      setSummary(result.summary);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [repo, orderId, photos, reload]);

  return (
    <div className="app">
      <TopBar title="Delivery check" go={go} back={{ kind: 'order', orderId }} />
      <main>
        <p className="muted">
          Photograph what the driver left. Take one picture per stack, and a second from another
          angle for anything piled deep - I can only count what the camera can see.
        </p>

        <PhotoPicker onPick={(files) => void add(files)} disabled={busy} cameraLabel="Photo of the stack" />
        <PhotoGrid
          photos={photos}
          onRemove={busy ? undefined : (id) => void repo.deletePhoto(id).then(reload)}
        />

        {error !== null && <p className="notice bad">{error}</p>}

        <button
          type="button"
          className="primary"
          disabled={busy || photos.length === 0}
          onClick={() => void run()}
        >
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Counting…
            </>
          ) : (
            'CHECK AGAINST THE INVOICE'
          )}
        </button>

        {summary !== null && <p className="notice info">{summary}</p>}

        {lines !== null && (
          <div className="list">
            {lines.map((line, index) => (
              <div className="card" key={`${line.itemId ?? 'extra'}-${index}`}>
                <div className="row">
                  <span className="grow title">
                    {line.name}
                    {line.size !== null ? ` ${line.size}` : ''}
                  </span>
                  <span className={`tag ${tone(line.status)}`}>{label(line.status)}</span>
                </div>
                <p className="muted">{line.message}</p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function label(status: StoredDeliveryLine['status']): string {
  switch (status) {
    case DeliveryStatus.CONFIRMED:
      return 'All there';
    case DeliveryStatus.POSSIBLY_MISSING:
      return 'Check again';
    case DeliveryStatus.LIKELY_MISSING:
      return 'Looks short';
    case DeliveryStatus.MORE_THAN_INVOICED:
      return 'Extra';
    case DeliveryStatus.NOT_PHOTOGRAPHED:
      return 'Not photographed';
    case DeliveryStatus.NOT_ON_INVOICE:
      return 'Not on the invoice';
    default:
      return status;
  }
}

function tone(status: StoredDeliveryLine['status']): string {
  if (status === DeliveryStatus.CONFIRMED) return '';
  if (status === DeliveryStatus.LIKELY_MISSING) return 'bad';
  return 'warn';
}
