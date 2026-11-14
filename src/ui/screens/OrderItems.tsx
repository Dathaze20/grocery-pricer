import { useCallback, useEffect, useMemo, useState } from 'react';
import { Money } from '../../core/money';
import { ItemConfidence } from '../../core/models';
import { NameNormalizer } from '../../core/matching';
import { CostCalculator } from '../../core/cost';
import { makeDiscount, type DiscountScope } from '../../core/models';
import { caseEconomics, priceForTargetProfit, stepProfitTarget } from '../../core/profit';
import { APPROVED_PRICE_BELOW_COST } from '../../app/processing';
import type { Repository } from '../../data/repository';
import type { StoredItem } from '../../data/schema';
import type { Screen } from '../App';
import { TopBar } from '../components/TopBar';
import { useUpdateHold } from '../useUpdateHold';
import { holdsUnsavedWork, readPriceEdit } from '../priceEdit';
import { Toast } from '../components/Toast';
import { CheckIcon } from '../components/icons';

/**
 * The order, one product per row.
 *
 * Four numbers decide everything the shopkeeper does here - what it cost, what it sells for,
 * what the case earns, and whether that is enough - so those four are on the face of the row
 * and everything else is behind "Details". A receipt can run to ninety lines, so there is a
 * search box rather than a scroll.
 */
export function OrderItems(props: {
  repo: Repository;
  orderId: number;
  go: (screen: Screen) => void;
}): JSX.Element {
  const { repo, orderId, go } = props;
  const [items, setItems] = useState<StoredItem[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setItems(await repo.itemsFor(orderId));
  }, [repo, orderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = useMemo(() => {
    const needle = NameNormalizer.normalize(filter);
    if (needle.length === 0) return items;
    return items.filter((item) =>
      NameNormalizer.normalize(`${item.displayName} ${item.rawName} ${item.size ?? ''}`).includes(needle),
    );
  }, [items, filter]);

  const saved = useCallback(
    async (message: string) => {
      setToast(message);
      setTimeout(() => setToast(null), 100);
      await reload();
    },
    [reload],
  );

  return (
    <div className="app">
      <TopBar title="The order" go={go} back={{ kind: 'order', orderId }} />
      <main>
        {items.length === 0 && <p className="muted">Nothing in this order yet.</p>}

        {items.length > 6 && (
          <input
            type="text"
            inputMode="search"
            value={filter}
            placeholder="Search this order"
            aria-label="Search this order"
            onChange={(event) => setFilter(event.target.value)}
          />
        )}

        {filter.length > 0 && (
          <p className="t-cap">
            {shown.length} of {items.length} products
          </p>
        )}

        <div className="list">
          {shown.map((item) => (
            <ItemRow
              key={item.id}
              repo={repo}
              item={item}
              open={openId === item.id}
              onToggle={() => setOpenId(openId === item.id ? null : item.id)}
              onSaved={saved}
            />
          ))}
        </div>
      </main>
      <Toast message={toast} />
    </div>
  );
}

function ItemRow(props: {
  repo: Repository;
  item: StoredItem;
  open: boolean;
  onToggle: () => void;
  onSaved: (message: string) => Promise<void>;
}): JSX.Element {
  const { repo, item } = props;

  const unitsPerCase = item.unitsPerCase ?? null;
  // Subtracting the printed discount from the case price is only right for a whole-case
  // discount. A per-unit discount multiplies by the pack count, a subset discount applies to
  // some of it, a custom one is spread over the cases bought, and an unknown one must not move
  // the cost at all. CostCalculator already knows all of that and is what priced this order, so
  // the screen asks it rather than doing different arithmetic and disagreeing with itself.
  const netCaseCost = netCaseCostOf(item);

  const approved = item.approvedPrice === null ? null : Money.fromStorage(item.approvedPrice);
  const suggested = item.suggestedPrice === null ? null : Money.fromStorage(item.suggestedPrice);
  const live = approved ?? suggested;

  // The box is the only record of what the shopkeeper is editing. A parsed copy kept beside it
  // drifts the moment the box is cleared, and then Save writes a number nobody can see.
  const [priceText, setPriceText] = useState(live === null ? '' : live.toPlainString());
  const [targetText, setTargetText] = useState('');

  const edit = readPriceEdit(priceText, live);
  const draft = edit.value;
  /**
   * What the owner asked the case to earn, when they have asked.
   *
   * Held separately from the achieved profit on purpose. Stepping from what the last price
   * happened to earn compounds the rounding - press + three times on a case of twelve and the
   * profit climbs by $1.08 each time instead of $1.00. Stepping the target keeps + and - exact
   * and reversible, and the difference between the two is shown rather than hidden.
   */
  const [target, setTarget] = useState<Money | null>(null);

  useEffect(() => {
    setPriceText(live === null ? '' : live.toPlainString());
    // Only when the stored price itself changes - typing must not be overwritten.
  }, [item.approvedPrice, item.suggestedPrice]);

  const economics =
    netCaseCost !== null && unitsPerCase !== null && unitsPerCase > 0
      ? caseEconomics({
          netCaseCost,
          sellableUnits: unitsPerCase,
          retailPrice: draft,
          casesPurchased: item.casesPurchased,
        })
      : null;

  const dirty = edit.dirty;
  const unapproved = approved === null && draft !== null && !dirty;

  // Unsaved work, of any kind: a changed price, a half-typed one, an emptied box, or an exact
  // profit target being typed. An automatic update reloads the page and would take all of it.
  useUpdateHold(holdsUnsavedWork(edit, targetText), 'blocking');

  const setPrice = useCallback((price: Money) => {
    const safe = price.isNegative ? Money.ZERO : price.roundedToCents();
    setPriceText(safe.toPlainString());
  }, []);

  /** + and - move the target profit on the case by a dollar, then work back to a shelf price. */
  const step = useCallback(
    (direction: 1 | -1) => {
      if (economics === null || netCaseCost === null || unitsPerCase === null) return;
      const from = target ?? economics.profitPerCase ?? Money.ZERO;
      const next = stepProfitTarget(from, direction);
      setTarget(next);
      setPrice(priceForTargetProfit(netCaseCost, unitsPerCase, next).retailPrice);
    },
    [economics, netCaseCost, unitsPerCase, target, setPrice],
  );

  const applyTarget = useCallback(() => {
    if (netCaseCost === null || unitsPerCase === null) return;
    const wanted = Money.parseOrNull(targetText);
    if (wanted === null) return;
    setTarget(wanted);
    setPrice(priceForTargetProfit(netCaseCost, unitsPerCase, wanted).retailPrice);
    setTargetText('');
  }, [netCaseCost, unitsPerCase, targetText, setPrice]);

  const save = useCallback(async () => {
    // Saves what the box is showing, or nothing at all. There is no second copy to fall back on.
    const current = readPriceEdit(priceText, live);
    if (current.value === null) return;
    await repo.approvePrice(item.id, current.value);
    await props.onSaved(`Saved ${item.displayName}`);
  }, [repo, item.id, item.displayName, priceText, live, props]);

  const cancel = useCallback(() => {
    setTarget(null);
    setTargetText('');
    setPriceText(live === null ? '' : live.toPlainString());
  }, [live]);

  const belowCostNow = economics?.belowCost === true;
  const approvedNowBelowCost = item.issues.includes(APPROVED_PRICE_BELOW_COST);

  return (
    <div className="card card-pad stack">
      <button type="button" className="row-button bare" onClick={props.onToggle}>
        <span className="grow stack" style={{ gap: 2 }}>
          <span className="row-line">
            <span className="name">{item.displayName}</span>
            <span className={`amount price ${approved !== null && !dirty ? 'owner-price' : ''}`}>
              {(draft ?? live)?.format() ?? '—'}
            </span>
          </span>
          <span className="row-line">
            <span className="t-cap">
              {item.size !== null ? `${item.size} · ` : ''}
              {item.trueUnitCost === null
                ? 'cost not read'
                : `cost ${Money.fromStorage(item.trueUnitCost).format()} each`}
            </span>
            {/* Three states, said in words as well as colour: a price the owner set, one the
                app is proposing, and one being edited that is not saved yet. */}
            <span className={`t-cap ${dirty ? 'is-unsaved' : ''}`}>
              {dirty ? 'Not saved yet' : approved !== null ? 'Your price' : 'Suggested'}
            </span>
          </span>
        </span>
      </button>

      <div className="pc-strip">
        <span className="pc-label">Profit per case</span>
        <span className={`pc-value ${profitTone(economics?.profitPerCase ?? null)}`}>
          {economics?.profitPerCase === null || economics === null
            ? '—'
            : economics.profitPerCase.format()}
        </span>
      </div>

      {target !== null && economics?.profitPerCase != null && (
        <p className="t-cap">
          {economics.profitPerCase.equals(target)
            ? `Exactly the ${target.format()} a case you asked for.`
            : `You asked for ${target.format()} a case; the nearest whole-cent price earns ${economics.profitPerCase.format()}.`}
        </p>
      )}

      {belowCostNow && (
        <p className="notice bad">Below cost — every sale loses money at this price.</p>
      )}
      {!belowCostNow && approvedNowBelowCost && (
        <p className="notice warn">
          Your saved price is now under the new cost. Worth raising.
        </p>
      )}
      {item.confidence === ItemConfidence.PROBLEM && (
        <p className="notice warn">The cost could not be read from the receipt, so there is no profit to show.</p>
      )}

      {economics !== null && (
        <>
          <div className="pc-controls">
            <button
              type="button"
              className="btn btn-secondary pc-step"
              aria-label={`Lower profit per case on ${item.displayName} by one dollar`}
              onClick={() => step(-1)}
            >
              −
            </button>
            <label className="pc-price grow">
              <span className="t-cap">Sell each</span>
              <input
                type="text"
                inputMode="decimal"
                value={priceText}
                aria-label={`Selling price for ${item.displayName}`}
                onChange={(event) => {
                  setPriceText(event.target.value);
                  setTarget(null);
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary pc-step"
              aria-label={`Raise profit per case on ${item.displayName} by one dollar`}
              onClick={() => step(1)}
            >
              +
            </button>
          </div>

          {edit.message !== null && (
            <p className="notice warn" role="alert">
              {edit.message}
            </p>
          )}

          {edit.canSave ? (
            <div className="row">
              <button
                type="button"
                className="btn btn-primary grow"
                aria-label={`Save the price for ${item.displayName}`}
                onClick={() => void save()}
              >
                <CheckIcon size={18} /> Save
              </button>
              <button type="button" className="btn btn-quiet" onClick={cancel}>
                Cancel
              </button>
            </div>
          ) : dirty ? (
            // Nothing saveable, but something to undo.
            <button type="button" className="btn btn-quiet btn-block" onClick={cancel}>
              Cancel
            </button>
          ) : (
            unapproved && (
              // Taking the suggestion is a decision too, and it is the common one. Until it is
              // made the price stays labelled a suggestion.
              <button
                type="button"
                className="btn btn-secondary btn-block"
                aria-label={`Use ${draft?.format()} for ${item.displayName}`}
                onClick={() => void save()}
              >
                <CheckIcon size={18} /> Use {draft?.format()}
              </button>
            )
          )}
        </>
      )}

      {props.open && (
        <div className="stack">
          {economics !== null && (
            <>
              <label htmlFor={`target-${item.id}`}>Aim for a profit per case of</label>
              <div className="row">
                <input
                  id={`target-${item.id}`}
                  type="text"
                  inputMode="decimal"
                  className="grow"
                  placeholder="e.g. 12.83"
                  value={targetText}
                  onChange={(event) => setTargetText(event.target.value)}
                />
                <button type="button" className="btn btn-secondary" onClick={applyTarget}>
                  Work out price
                </button>
              </div>
              <TargetReadout
                netCaseCost={netCaseCost}
                unitsPerCase={unitsPerCase}
                targetText={targetText}
              />
              <dl className="facts">
                <div>
                  <dt>Case cost</dt>
                  <dd className="price">{netCaseCost?.format() ?? '—'}</dd>
                </div>
                <div>
                  <dt>In the case</dt>
                  <dd>{unitsPerCase ?? '—'} to sell</dd>
                </div>
                <div>
                  <dt>Case takes</dt>
                  <dd className="price">{economics.caseRevenue?.format() ?? '—'}</dd>
                </div>
                {item.casesPurchased > 1 && (
                  <div>
                    <dt>{item.casesPurchased} cases bought</dt>
                    <dd className="price">{economics.totalProfit?.format() ?? '—'} in total</dd>
                  </div>
                )}
                {item.discount !== null && (
                  <div>
                    <dt>Discount</dt>
                    <dd className="price">
                      {Money.fromStorage(item.discount.amount).format()} ({item.discount.scope})
                    </dd>
                  </div>
                )}
                {item.previousPrice !== null && (
                  <div>
                    <dt>Last time</dt>
                    <dd className="price">{Money.fromStorage(item.previousPrice).format()}</dd>
                  </div>
                )}
              </dl>
              <p className="t-cap">
                Profit per case is gross — before rent, staff, breakage and card fees.
              </p>
            </>
          )}
          {item.pricingRationale !== null && <p className="t-cap">{item.pricingRationale}</p>}
          {item.sourceText.length > 0 && <p className="t-cap">Read from: “{item.sourceText[0]}”</p>}
        </div>
      )}
    </div>
  );
}

/** Says what a typed target would really earn, rather than letting the number imply it. */
function TargetReadout(props: {
  netCaseCost: Money | null;
  unitsPerCase: number | null;
  targetText: string;
}): JSX.Element | null {
  const target = Money.parseOrNull(props.targetText);
  if (target === null || props.netCaseCost === null || props.unitsPerCase === null) return null;

  const result = priceForTargetProfit(props.netCaseCost, props.unitsPerCase, target);
  if (result.exact) {
    return (
      <p className="t-cap">
        {result.retailPrice.format()} each earns exactly {result.achieved.format()} a case.
      </p>
    );
  }
  return (
    <p className="t-cap">
      Closest is {result.retailPrice.format()} each, which earns {result.achieved.format()} a case —
      shelf prices move in whole cents, so {target.format()} exactly is not reachable.
    </p>
  );
}

/** The net cost of one case, from the same engine that priced the order. */
function netCaseCostOf(item: StoredItem): Money | null {
  if (item.casePrice === null || item.unitsPerCase === null || item.unitsPerCase <= 0) return null;
  const casePrice = Money.fromStorage(item.casePrice);
  const discount =
    item.discount === null
      ? null
      : makeDiscount(
          item.discount.description,
          Money.fromStorage(item.discount.amount),
          item.discount.scope as DiscountScope,
          item.discount.appliesToUnits,
        );

  return CostCalculator.calculate({
    casePrice,
    unitsPerCase: item.unitsPerCase,
    casesPurchased: Math.max(item.casesPurchased, 1),
    looseUnits: item.looseUnits,
    discount,
  }).netCaseCost;
}

function profitTone(profit: Money | null): string {
  if (profit === null) return '';
  if (profit.isNegative) return 'is-loss';
  return 'is-profit';
}
