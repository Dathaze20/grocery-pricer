import { useRef } from 'react';

/**
 * Two separate inputs, on purpose.
 *
 * `capture="environment"` opens the back camera directly - which is what someone standing over a
 * receipt wants - but it also removes any way to pick an existing picture. Keeping a plain file
 * input beside it means a photo taken earlier, or one sent by the supplier, still works.
 */
export function PhotoPicker(props: {
  onPick: (files: File[]) => void;
  cameraLabel?: string;
  galleryLabel?: string;
  disabled?: boolean;
}): JSX.Element {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  function handle(event: React.ChangeEvent<HTMLInputElement>): void {
    const files = [...(event.target.files ?? [])];
    // Clearing the value means photographing the same receipt twice still fires a change event.
    event.target.value = '';
    if (files.length > 0) props.onPick(files);
  }

  return (
    <div className="row">
      <input
        ref={camera}
        className="hidden-input"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handle}
      />
      <input
        ref={gallery}
        className="hidden-input"
        type="file"
        accept="image/*"
        multiple
        onChange={handle}
      />
      <button
        type="button"
        className="secondary"
        disabled={props.disabled === true}
        onClick={() => camera.current?.click()}
      >
        📷 {props.cameraLabel ?? 'Take a photo'}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.disabled === true}
        onClick={() => gallery.current?.click()}
      >
        🖼 {props.galleryLabel ?? 'Choose'}
      </button>
    </div>
  );
}
