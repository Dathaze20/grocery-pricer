import { useCallback, useEffect, useState } from 'react';
import { Repository } from '../data/repository';
import { SettingKey } from '../data/schema';
import { Home } from './screens/Home';
import { NewOrder } from './screens/NewOrder';
import { OrderChat } from './screens/OrderChat';
import { DeliveryCheck } from './screens/DeliveryCheck';
import { Settings } from './screens/Settings';
import { OrderItems } from './screens/OrderItems';

export type Screen =
  | { kind: 'home' }
  | { kind: 'newOrder'; orderId: number }
  | { kind: 'order'; orderId: number }
  | { kind: 'items'; orderId: number }
  | { kind: 'delivery'; orderId: number }
  | { kind: 'settings' };

export function App(): JSX.Element {
  const [repo, setRepo] = useState<Repository | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Repository.open()
      .then((opened) => {
        if (!cancelled) setRepo(opened);
      })
      .catch(() => {
        // Private browsing, or storage switched off. Say so rather than showing an empty screen.
        if (!cancelled) {
          setFailed(
            'This browser will not let the app store anything. Grocery Pricer keeps your orders ' +
              'on the device, so it needs storage. Try a normal (not private) window.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const go = useCallback(
    (next: Screen) => {
      setScreen(next);
      if (repo !== null && 'orderId' in next) {
        void repo.putSetting(SettingKey.LAST_OPENED_ORDER, next.orderId);
      }
      window.scrollTo(0, 0);
    },
    [repo],
  );

  // The phone's back gesture should leave the screen, not the app.
  useEffect(() => {
    const onPop = (): void => setScreen({ kind: 'home' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (failed !== null) {
    return (
      <div className="app">
        <header className="topbar">
          <h1>Grocery Pricer</h1>
        </header>
        <main>
          <p className="notice bad">{failed}</p>
        </main>
      </div>
    );
  }

  if (repo === null) {
    return (
      <div className="app">
        <header className="topbar">
          <h1>Grocery Pricer</h1>
        </header>
        <main>
          <p className="muted">
            <span className="spinner" aria-hidden="true" />
            Opening your orders…
          </p>
        </main>
      </div>
    );
  }

  switch (screen.kind) {
    case 'home':
      return <Home repo={repo} go={go} />;
    case 'newOrder':
      return <NewOrder repo={repo} orderId={screen.orderId} go={go} />;
    case 'order':
      return <OrderChat repo={repo} orderId={screen.orderId} go={go} />;
    case 'items':
      return <OrderItems repo={repo} orderId={screen.orderId} go={go} />;
    case 'delivery':
      return <DeliveryCheck repo={repo} orderId={screen.orderId} go={go} />;
    case 'settings':
      return <Settings repo={repo} go={go} />;
  }
}
