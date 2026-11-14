import { useCallback, useEffect, useState } from 'react';
import { Money } from '../../core/money';
import type { Repository } from '../../data/repository';
import { OrderStatus, type StoredOrder } from '../../data/schema';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { CameraIcon, ChevronRightIcon, SettingsIcon } from '../components/icons';
import { hasKey } from '../services';

export function Home(props: { repo: Repository; go: (screen: Screen) => void }): JSX.Element {
  const { repo, go } = props;
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  // null until the stored key has been looked up. Starting at `true` would hide the setup
  // prompt for a moment on every launch, including the one launch where it matters.
  const [keyed, setKeyed] = useState<boolean | null>(null);

  useEffect(() => {
    // Clear out abandoned empty drafts before listing, so backing out of NEW ORDER does not
    // leave a row that says "Not processed yet" and has nothing in it to process.
    void repo
      .deleteEmptyDrafts()
      .then(() => repo.recentOrders(15))
      .then(setOrders);
    void hasKey(repo).then(setKeyed);
  }, [repo]);

  const startOrder = useCallback(async () => {
    const order = await repo.createOrder();
    go({ kind: 'newOrder', orderId: order.id });
  }, [repo, go]);

  const latestReady = orders.find((o) => o.status === OrderStatus.READY) ?? null;

  return (
    <div className="app">
      <TopBar
        title="Grocery Pricer"
        wordmark
        go={go}
        action={{
          label: 'Settings',
          icon: <SettingsIcon size={22} />,
          onClick: () => go({ kind: 'settings' }),
        }}
      />
      <main>
        {keyed === false && (
          <button type="button" className="notice warn" onClick={() => go({ kind: 'settings' })}>
            One-time setup: add your Gemini API key before the first order.
          </button>
        )}

        {/* The camera is the point of the app, so it is the largest thing on the screen - but
            it says what it does rather than simply shouting. */}
        <button type="button" className="hero" onClick={() => void startOrder()}>
          <span className="hero-glyph">
            <CameraIcon size={28} />
          </span>
          <span className="grow">
            <span className="hero-title">NEW ORDER</span>
            <br />
            <span className="hero-sub">Photograph a receipt</span>
          </span>
          <ChevronRightIcon size={22} />
        </button>

        {latestReady !== null && (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={() => go({ kind: 'order', orderId: latestReady.id })}
          >
            Ask about the last order
          </button>
        )}

        {orders.length > 0 && (
          <section className="stack">
            <h2 className="t-section">Recent orders</h2>
            <div className="list">
              {orders.map((order) => (
                <button
                  type="button"
                  className="card row-button"
                  key={order.id}
                  onClick={() =>
                    go(
                      order.status === OrderStatus.READY
                        ? { kind: 'order', orderId: order.id }
                        : { kind: 'newOrder', orderId: order.id },
                    )
                  }
                >
                  <span className="grow stack" style={{ gap: 2 }}>
                    <span className="row-line">
                      <span className="name">{order.supplier ?? 'Order'}</span>
                      {order.status === OrderStatus.READY && (
                        <span className="amount price">
                          {Money.fromStorage(order.totalWholesaleCost).format()}
                        </span>
                      )}
                    </span>
                    <span className="row-line">
                      <span className="t-cap">{dateOf(order)}</span>
                      <StatusChip order={order} />
                    </span>
                    {order.status === OrderStatus.FAILED && order.failureMessage !== null && (
                      <span className="t-cap failure-reason">{order.failureMessage}</span>
                    )}
                  </span>
                  <ChevronRightIcon size={18} />
                </button>
              ))}
            </div>
          </section>
        )}

        {orders.length === 0 && (
          <section className="card steps">
            <h2 className="t-section" style={{ marginTop: 0 }}>How it works</h2>
            <div className="step">
              <span className="step-n">1</span>
              <span className="grow">
                <span className="t-title">Photograph the receipt</span>
                <br />
                <span className="t-sub">Several overlapping photos are fine.</span>
              </span>
            </div>
            <div className="step">
              <span className="step-n">2</span>
              <span className="grow">
                <span className="t-title">Press one button</span>
                <br />
                <span className="t-sub">Costs, discounts and shelf prices are worked out here.</span>
              </span>
            </div>
            <div className="step">
              <span className="step-n">3</span>
              <span className="grow">
                <span className="t-title">Ask what anything costs</span>
                <br />
                <span className="t-sub">In plain words, or by photographing the product.</span>
              </span>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function dateOf(order: StoredOrder): string {
  return new Date(order.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function StatusChip(props: { order: StoredOrder }): JSX.Element {
  const { order } = props;
  switch (order.status) {
    case OrderStatus.READY:
      return (
        <span className="chip">
          {order.itemCount} {order.itemCount === 1 ? 'product' : 'products'}
        </span>
      );
    case OrderStatus.DRAFT:
      return <span className="chip chip-muted">Not processed yet</span>;
    case OrderStatus.PROCESSING:
      return <span className="chip chip-muted">Working on it…</span>;
    case OrderStatus.FAILED:
      // The chip is short because it sits in a row; the reason is printed under it, because
      // "needs another go" does not tell anybody whether to add a key, find a signal or
      // retake a blurry photograph.
      return <span className="chip chip-bad">Did not finish</span>;
  }
}
