import { useCallback, useEffect, useState } from 'react';
import { Money } from '../../core/money';
import type { Repository } from '../../data/repository';
import { OrderStatus, type StoredOrder, isIncomplete } from '../../data/schema';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { CameraIcon, ChevronRightIcon, SettingsIcon, TrashIcon } from '../components/icons';
import { hasKey } from '../services';
import { deleteSavedOrder } from '../orderDelete';

export function Home(props: { repo: Repository; go: (screen: Screen) => void }): JSX.Element {
  const { repo, go } = props;
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  // null until the stored key has been looked up. Starting at `true` would hide the setup
  // prompt for a moment on every launch, including the one launch where it matters.
  const [keyed, setKeyed] = useState<boolean | null>(null);
  /*
   * The order the owner has asked to delete, and what is in it.
   *
   * Held as the order itself rather than an id, so the confirmation can describe exactly what
   * would go - the date, how many products were read, what it came to. An id in a dialog is not
   * something anyone can check against the receipt in their hand. The count is looked up when
   * they ask, not for every row on the screen.
   */
  const [pending, setPending] = useState<{ order: StoredOrder; products: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const listed = await repo.recentOrders(15);
    setOrders(listed);
  }, [repo]);

  useEffect(() => {
    // Clear out abandoned empty drafts before listing, so backing out of NEW ORDER does not
    // leave a row that says "Not processed yet" and has nothing in it to process.
    void repo
      .deleteEmptyDrafts()
      .then(() => repo.recentOrders(15))
      .then(setOrders);
    void hasKey(repo).then(setKeyed);
  }, [repo]);

  const askDelete = useCallback(
    async (order: StoredOrder) => {
      // An order being read is work in progress, and deleting it from under the reader would
      // leave the run writing into rows that are no longer there.
      if (order.status === OrderStatus.PROCESSING) return;
      setDeleteError(null);
      const items = await repo.itemsFor(order.id);
      setPending({ order, products: items.length });
    },
    [repo],
  );

  const confirmDelete = useCallback(async () => {
    if (pending === null) return;
    setDeleting(true);
    const outcome = await deleteSavedOrder(repo, pending.order.id);
    setDeleting(false);

    if (outcome.kind === 'failed') {
      // The order is still there, so the dialog stays open saying so. Closing it would read as
      // a deletion that happened.
      setDeleteError(outcome.message);
      return;
    }

    setPending(null);
    if (outcome.kind === 'processing') setDeleteError(outcome.message);
    // Re-read from storage rather than removing the row on screen and hoping it matched.
    await refresh();
  }, [pending, repo, refresh]);

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
            {deleteError !== null && (
              <p className="notice warn" role="status">
                {deleteError}
              </p>
            )}
            <div className="list">
              {orders.map((order) => (
                <div className="card order-row" key={order.id}>
                <button
                  type="button"
                  className="row-button bare grow"
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
                        // A partial total is not the purchase total, so it is never shown as
                        // one. The figure is still useful - it is what was read - but it is
                        // marked as a floor rather than a sum anyone should pay against.
                        <span className={`amount price${isIncomplete(order) ? ' partial' : ''}`}>
                          {isIncomplete(order) ? 'at least ' : ''}
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
                {/* Not offered while an order is being read: see askDelete. */}
                {order.status !== OrderStatus.PROCESSING && (
                  <button
                    type="button"
                    className="btn btn-quiet row-delete"
                    aria-label={`Delete the ${dateOf(order)} order`}
                    onClick={() => void askDelete(order)}
                  >
                    <TrashIcon size={18} />
                  </button>
                )}
                </div>
              ))}
            </div>
          </section>
        )}

        {pending !== null && (
          /*
           * Deleting an order throws away its photographs as well as its products, and there is
           * no undoing it. So the question says exactly which order - the date, how many
           * products came off it, what it came to - and Cancel is the first and plainest button
           * on it. A mis-tap on a row must not be able to cost anybody a receipt.
           */
          <div className="notice warn" role="alertdialog" aria-label="Delete this order?">
            <p style={{ marginTop: 0 }}>
              <strong>Delete the {dateOf(pending.order)} order?</strong>
            </p>
            <p className="t-cap" style={{ marginTop: 0 }}>
              {pending.products === 1 ? '1 product' : `${pending.products} products`}
              {pending.order.totalWholesaleCost > 0 &&
                `, ${Money.fromStorage(pending.order.totalWholesaleCost).format()}`}
              . Its photographs go with it, and this cannot be undone. Everything else you have
              saved - your other orders, your prices and what the app remembers about products -
              stays.
            </p>
            <div className="stack">
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => setPending(null)}
              >
                Cancel - keep it
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-block"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? 'Deleting...' : 'Delete this order'}
              </button>
            </div>
          </div>
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
      // Still openable, still useful - the products that were read are real - but nobody
      // should have to remember which of their orders was only half read.
      if (isIncomplete(order)) {
        return <span className="chip chip-warn">Incomplete receipt</span>;
      }
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
