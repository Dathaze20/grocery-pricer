import { useEffect, useState } from 'react';
import { CheckIcon } from './icons';

/**
 * The "that worked" confirmation.
 *
 * A button that quietly relabels itself is easy to miss, and missing it on the API key screen
 * means wondering whether the key was stored at all. This says so plainly, where the eye already
 * is, and gets out of the way on its own.
 */
export function Toast(props: { message: string | null }): JSX.Element | null {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (props.message === null) return;
    setShown(props.message);
  }, [props.message]);

  /*
   * The countdown has to belong to what is on screen, not to the prop.
   *
   * Callers clear the message a moment after setting it, so that saving twice shows the
   * confirmation twice. Tying the timer to the prop meant that clearing it ran this effect's
   * cleanup and cancelled the countdown - so the toast never went away. It then sat over the
   * top of the list it was reporting on, swallowing taps on the first row: on the items screen
   * that is the first product's own card, which could not be opened again after a save.
   */
  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(timer);
  }, [shown]);

  if (shown === null) return null;

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-check">
        <CheckIcon size={18} />
      </span>
      {shown}
    </div>
  );
}
