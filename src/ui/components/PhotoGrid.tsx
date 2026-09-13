import { useEffect, useState } from 'react';
import { toObjectUrl } from '../../app/images';
import type { StoredPhoto } from '../../data/schema';

export function PhotoGrid(props: {
  photos: readonly StoredPhoto[];
  onRemove?: (id: number) => void;
}): JSX.Element | null {
  const [urls, setUrls] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    const made = new Map<number, string>();
    for (const photo of props.photos) {
      made.set(photo.id, toObjectUrl({ bytes: photo.bytes, mimeType: photo.mimeType }));
    }
    setUrls(made);
    // Object URLs are a leak if they are never given back.
    return () => {
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, [props.photos]);

  if (props.photos.length === 0) return null;

  return (
    <div className="photos">
      {props.photos.map((photo) => (
        <div className="photo" key={photo.id}>
          <img src={urls.get(photo.id)} alt="" />
          {props.onRemove !== undefined && (
            <button type="button" aria-label="Remove photo" onClick={() => props.onRemove?.(photo.id)}>
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
