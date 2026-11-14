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
    const timer = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(timer);
  }, [props.message]);

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
