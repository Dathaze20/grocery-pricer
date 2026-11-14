import { useEffect, useState } from 'react';
import { updates, type UpdateStatus } from '../updates';

/**
 * Says that a new version is ready while something is going on that a reload would interrupt.
 *
 * It is not a prompt that has to be answered: the update applies by itself the moment the work
 * in hand is finished. This is for the person who would rather have it now.
 */
export function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>(updates.status);

  useEffect(() => updates.subscribe(setStatus), []);

  if (!status.available) return null;

  return (
    <button type="button" className="update-banner" onClick={() => updates.applyNow()}>
      Update ready · tap to restart now
    </button>
  );
}
