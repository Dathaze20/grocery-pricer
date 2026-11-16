import { useCallback, useEffect, useState } from 'react';
import { OrderImageType } from '../../core/ai-types';
import { readFile } from '../../app/images';
import { jobs } from '../../app/jobs';
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
  // There is no busy state left on this screen: pressing the button leaves it. What remains is
  // whether a photograph is being added, which is quick and local.
  const busy = false;
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

  /**
   * Starts the work and gets out of the way.
   *
   * The owner used to be held on this screen watching a progress line, and when the reading
   * ran long there was nothing to do but stare at it. The job is handed to the coordinator,
   * which is not tied to this component, and the chat opens at once - so the receipt is read
   * while its owner is already asking questions or photographing a case.
   */
  const process = useCallback(() => {
    setError(null);
    jobs.start(repo, providerFor, orderId);
    go({ kind: 'order', orderId });
  }, [repo, orderId, go]);

  const cancel = useCallback(() => {
    void repo.order(orderId).then(async (order) => {
      // An untouched draft is not worth keeping in the list.
      if (order !== null && order.status === OrderStatus.DRAFT && photos.length === 0) {
        await repo.deleteOrder(orderId);
      }
      go({ kind: 'home' });
    });
  }, [repo, orderId, photos.length, go]);

  const count = photos.length;

  return (
    <div className="app">
      <TopBar title="New order" go={go} back={{ kind: 'home' }} />
      <main>
        {count === 0 ? (
          <div className="fill-center">
            <p className="muted">
              Photograph the whole receipt. Several photos are fine — overlap them rather than
              leaving a gap, and I will work out which lines are the same.
            </p>
            <PhotoPicker
              onPick={(files) => void add(files)}
              disabled={busy}
              captureLabel="Take a photo"
              captureHint="of the receipt"
            />
          </div>
        ) : (
          <>
            <div className="row">
              <h2 className="t-section grow" style={{ marginTop: 0 }}>
                {count} {count === 1 ? 'photo' : 'photos'}
              </h2>
            </div>
            <PhotoGrid photos={photos} onRemove={busy ? undefined : (id) => void remove(id)} />
            <PhotoPicker
              compact
              onPick={(files) => void add(files)}
              disabled={busy}
              captureLabel="Add photo"
            />
          </>
        )}

        {error !== null && <p className="notice bad">{error}</p>}

        <div className="actionbar">
          <button
            type="button"
            className="btn btn-primary btn-block"
            aria-label="Process order"
            disabled={busy || count === 0}
            onClick={process}
          >
            PROCESS ORDER
          </button>
          <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
      </main>
    </div>
  );
}
