import { useEffect } from 'react';
import { updates } from './updates';

/**
 * Holds off an update for as long as `active` is true.
 *
 * Used for work that must not be interrupted even if the screen changes underneath it - a
 * receipt being read, a question in flight, a delivery being counted. Leaving the screen is not
 * the same as finishing the work.
 */
export function useUpdateHold(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return updates.hold();
  }, [active]);
}
