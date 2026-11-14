import { useEffect } from 'react';
import { updates, type HoldKind } from './updates';

/**
 * Holds off an update for as long as `active` is true and this component is mounted.
 *
 * Only for state that genuinely belongs to the screen, such as a half-typed message that
 * navigating away discards anyway. Work that outlives its screen - a receipt being read, a
 * question in flight, a delivery being counted - must take its own hold around the operation
 * and release it in a finally, or Back would release it while the request is still running.
 */
export function useUpdateHold(active: boolean, kind: HoldKind = 'soft'): void {
  useEffect(() => {
    if (!active) return;
    return updates.hold(kind);
  }, [active, kind]);
}
