import { useRef } from 'react';
import { CameraIcon, GalleryIcon } from './icons';

/**
 * Two separate inputs, on purpose.
 *
 * `capture="environment"` opens the back camera directly - which is what someone standing over a
 * receipt wants - but it also removes any way to pick an existing picture. Keeping a plain file
 * input beside it means a photo taken earlier, or one sent by the supplier, still works.
 *
 * The camera is the large target and the gallery is a quiet second: photographing the receipt in
 * front of you is what happens almost every time.
 */
export function PhotoPicker(props: {
  onPick: (files: File[]) => void;
  captureLabel?: string;
  captureHint?: string;
  galleryLabel?: string;
  disabled?: boolean;
  compact?: boolean;
}): JSX.Element {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  function handle(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    // Clearing the value means photographing the same receipt twice still fires a change event.
    event.target.value = '';
    if (files.length > 0) props.onPick(files);
  }

  const inputs = (
    <>
      <input
        ref={camera}
        className="hidden-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handle}
      />
      <input ref={gallery} className="hidden-input" type="file" accept="image/*" multiple onChange={handle} />
    </>
  );

  if (props.compact === true) {
    return (
      <div className="row">
        {inputs}
        <button
          type="button"
          className="btn btn-secondary grow"
          disabled={props.disabled === true}
          onClick={() => camera.current?.click()}
        >
          <CameraIcon size={20} />
          {props.captureLabel ?? 'Camera'}
        </button>
        <button
          type="button"
          className="btn btn-secondary grow"
          disabled={props.disabled === true}
          onClick={() => gallery.current?.click()}
        >
          <GalleryIcon size={20} />
          {props.galleryLabel ?? 'Gallery'}
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      {inputs}
      <button
        type="button"
        className="capture"
        disabled={props.disabled === true}
        onClick={() => camera.current?.click()}
      >
        <CameraIcon size={32} />
        {props.captureLabel ?? 'Take a photo'}
        {props.captureHint !== undefined && <span className="t-cap">{props.captureHint}</span>}
      </button>
      <button
        type="button"
        className="btn btn-quiet btn-block"
        disabled={props.disabled === true}
        onClick={() => gallery.current?.click()}
      >
        <GalleryIcon size={18} />
        {props.galleryLabel ?? 'Choose from gallery'}
      </button>
    </div>
  );
}
