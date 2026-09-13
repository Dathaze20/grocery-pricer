import { useCallback, useEffect, useState } from 'react';
import { Money } from '../../core/money';
import type { Repository } from '../../data/repository';
import { OrderStatus, type StoredOrder } from '../../data/schema';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { hasKey } from '../services';

export function Home(props: { repo: Repository; go: (screen: Screen) => void }): JSX.Element {
  const { repo, go } = props;
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const [keyed, setKeyed] = useState(true);

  useEffect(() => {
    void repo.recentOrders(15).then(setOrders);
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
        go={go}
        action={{ label: 'Settings', onClick: () => go({ kind: 'settings' }) }}
      />
      <main>
        {!keyed && (
          <button type="button" className="notice warn" onClick={() => go({ kind: 'settings' })}>
            One-time setup: add your free Gemini key before the first order.
          </button>
        )}

        <button type="button" className="primary huge" onClick={() => void startOrder()}>
          NEW ORDER
        </button>

        {latestReady !== null && (
          <button
            type="button"
            className="secondary"
            onClick={() => go({ kind: 'order', orderId: latestReady.id })}
          >
            Ask about the last order
          </button>
        )}

        {orders.length > 0 && (
          <section className="stack">
            <h2 className="muted">Recent orders</h2>
            <div className="list">
              {orders.map((order) => (
                <button
                  type="button"
                  className="card list-row"
                  key={order.id}
                  onClick={() =>
                    go(
                      order.status === OrderStatus.READY
                        ? { kind: 'order', orderId: order.id }
                        : { kind: 'newOrder', orderId: order.id },
                    )
                  }
                >
                  <span className="title">
                    {order.supplier ?? 'Order'} · {new Date(order.createdAt).toLocaleDateString()}
                  </span>
                  <span className="sub">{describe(order)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {orders.length === 0 && (
          <p className="muted center">
            Photograph a receipt, press one button, then ask what anything costs.
          </p>
        )}
      </main>
    </div>
  );
}

function describe(order: StoredOrder): string {
  switch (order.status) {
    case OrderStatus.READY:
      return `${order.itemCount} ${order.itemCount === 1 ? 'product' : 'products'} · ${Money.fromStorage(
        order.totalWholesaleCost,
      ).format()}`;
    case OrderStatus.DRAFT:
      return 'Not processed yet';
    case OrderStatus.PROCESSING:
      return 'Working on it…';
    case OrderStatus.FAILED:
      return order.failureMessage ?? 'Something went wrong';
  }
}
