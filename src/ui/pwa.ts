import { registerSW } from 'virtual:pwa-register';
import { updates } from './updates';

/** How often a long-running installed app asks whether a new version has been published. */
export const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * The shortest gap between two checks, so flicking in and out of the app cannot hammer it.
 *
 * Deliberately short. A check is one conditional request for a file of a few hundred bytes, and
 * the cost of being too cautious is someone reopening the app a minute after a deployment and
 * still getting yesterday's version.
 */
export const MIN_CHECK_GAP_MS = 10 * 1000;

/** How long to wait for the new worker to announce it is in charge before reloading regardless. */
export const HANDOVER_TIMEOUT_MS = 3000;

/**
 * Keeps the installed app up to date without anyone having to visit the website.
 *
 * The checks matter more than they look. An installed app on Android is usually *resumed* rather
 * than reloaded - the document stays alive in the background, so reopening it performs no
 * navigation, and a service worker that is only ever checked on navigation is never checked
 * again. That is how an installed app ends up pinned to the version it was installed with.
 *
 * So: check when the app starts, check whenever it is brought back to the foreground, check when
 * the connection returns, and check periodically while it is open.
 */
export function startUpdateChecks(): void {
  if (!('serviceWorker' in navigator)) return;

  let lastCheck = 0;

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Downloaded and waiting. Whether it takes over now is the coordinator's decision.
      updates.noteAvailable();
    },
    onRegisteredSW(_swUrl, registration) {
      if (registration === undefined) return;

      const check = (): void => {
        // Offline is not a failure: the installed version keeps working, and the next check
        // happens when the connection comes back.
        if (!navigator.onLine) return;
        const now = Date.now();
        if (now - lastCheck < MIN_CHECK_GAP_MS) return;
        lastCheck = now;
        void registration.update().catch(() => {
          // A failed check is nothing to report. The app is still usable, and checking again
          // later costs nothing.
        });
      };

      check();
      setInterval(check, UPDATE_INTERVAL_MS);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      window.addEventListener('online', check);
      // Fired when a backgrounded page is restored from the back/forward cache, which is what
      // reopening an installed app often does.
      window.addEventListener('pageshow', (event) => {
        if ((event as PageTransitionEvent).persisted) check();
      });
    },
  });

  // The reload is this app's job rather than the plugin's.
  //
  // The plugin reloads on a handover it recognises as an update, which it decides from whether
  // the page already had a worker in charge when it registered. On the launch where the app is
  // first installed there was none, so a new version arriving in that same session takes over
  // without the page ever reloading - leaving the old interface running on top of it. Watching
  // the handover directly is the same lifecycle, minus the guesswork.
  let handingOver = false;
  let reloaded = false;

  const reloadOnce = (): void => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A handover the app did not ask for is the first install taking charge of the page. That
    // one must not reload: nothing has changed, and reloading on it every time would loop.
    if (!handingOver) return;
    reloadOnce();
  });

  updates.setApplier(() => {
    handingOver = true;
    // Tells the waiting worker to take over. Nothing in IndexedDB is touched: orders, photos,
    // products, price history and the API key belong to the origin, not to the worker.
    void updateServiceWorker(false);
    // If the handover is never announced - it can already have happened - come back anyway.
    // Capped at one reload per page, so a worker that cannot activate cannot cause a loop.
    setTimeout(reloadOnce, HANDOVER_TIMEOUT_MS);
  });
}
