import { useCallback, useEffect, useState } from 'react';
import { Money } from '../../core/money';
import { ItemConfidence } from '../../core/models';
import type { Repository } from '../../data/repository';
import type { StoredItem } from '../../data/schema';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';

/**
 * The order as a list.
 *
 * Secondary on purpose: the point of the app is not to review 150 rows. It is here for when the
 * shopkeeper wants to check one thing, fix a price, or see why a figure is what it is.
 */
export function OrderItems(props: {
  repo: Repository;
  orderId: number;
  go: (screen: Screen) => void;
}): JSX.Element {
  const { repo, orderId, go } = props;
  const [items, setItems] = useState<StoredItem[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(async () => {
    setItems(await repo.itemsFor(orderId));
  }, [repo, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (item: StoredItem) => {
      const price = Money.parseOrNull(draft);
      if (price === null) return;
      await repo.approvePrice(item.id, price);
      setOpenId(null);
      setDraft('');
      await reload();
    },
    [repo, draft, reload],
  );

  return (
    <div className="app">
      <TopBar title="The order" go={go} back={{ kind: 'order', orderId }} />
      <main>
        {items.length === 0 && <p className="muted">Nothing in this order yet.</p>}
        <div className="list">
          {items.map((item) => (
            <div className="card card-pad" key={item.id}>
              <button
                type="button"
                className="row-button"
                style={{ border: 0, background: 'transparent', padding: 0 }}
                onClick={() => {
                  setOpenId(openId === item.id ? null : item.id);
                  setDraft(priceText(item));
                }}
              >
                <span className="grow stack" style={{ gap: 2 }}>
                  <span className="row-line">
                    <span className="name">{item.displayName}</span>
                    <span className="amount price">{priceLabel(item)}</span>
                  </span>
                  <span className="row-line">
                    <span className="t-cap">
                      {item.size ?? ''}
                      {item.size !== null ? ' · ' : ''}cost {costText(item)}
                    </span>
                    {item.confidence !== ItemConfidence.HIGH && (
                      <span
                        className={`chip ${
                          item.confidence === ItemConfidence.PROBLEM ? 'chip-bad' : 'chip-warn'
                        }`}
                      >
                        {item.confidence === ItemConfidence.PROBLEM ? 'Needs a price' : 'Check'}
                      </span>
                    )}
                  </span>
                </span>
              </button>

              {openId === item.id && (
                <div className="stack" style={{ marginTop: 'var(--sp-3)' }}>
                  <p className="t-cap">{item.pricingRationale ?? ''}</p>
                  {item.sourceText.length > 0 && (
                    <p className="t-cap">Read from: “{item.sourceText[0]}”</p>
                  )}
                  <div>
                    <label htmlFor={`price-${item.id}`}>What you charge</label>
                    <input
                      id={`price-${item.id}`}
                      type="text"
                      inputMode="decimal"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  </div>
                  <button type="button" className="btn btn-secondary btn-block" onClick={() => void save(item)}>
                    Save this price
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

function costText(item: StoredItem): string {
  return item.trueUnitCost === null ? 'cost not read' : Money.fromStorage(item.trueUnitCost).format();
}

function priceLabel(item: StoredItem): string {
  if (item.approvedPrice !== null) return Money.fromStorage(item.approvedPrice).format();
  if (item.suggestedPrice !== null) return Money.fromStorage(item.suggestedPrice).format();
  return '—';
}

function priceText(item: StoredItem): string {
  const price = item.approvedPrice ?? item.suggestedPrice;
  return price === null ? '' : Money.fromStorage(price).toPlainString();
}
