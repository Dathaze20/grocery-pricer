import { useEffect, useState } from 'react';
import { updates, type UpdateStatus } from '../updates';

/**
 * Says that a new version is ready while something is going on that a reload would interrupt.
 *
 * It is not a prompt that has to be answered: the update applies by itself the moment the work
 * in hand is finished. This is for the person who would rather have it now - and even then it
 * waits for anything mid-flight, because tapping a button is not consent to lose an order that
 * is still being read.
 */
export function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>(updates.status);

  useEffect(() => updates.subscribe(setStatus), []);

  if (!status.available) return null;

  // Already asked for, and waiting on work that must not be interrupted.
  if (status.requested) {
    return (
      <div className="update-banner" role="status">
        Update will apply when this finishes
      </div>
    );
  }

  return (
    <button type="button" className="update-banner" onClick={() => updates.requestApply()}>
      Update ready · tap to restart
    </button>
  );
}
