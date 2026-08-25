'use client';

/**
 * TillScreen — the sale screen.
 *
 * Design constraints, all environmental rather than aesthetic:
 *   - Outdoor stall, direct sun. Dark ground, high-luminance type.
 *   - Queue pressure. One tap adds an item; the total is always visible;
 *     Pay is the largest control on screen.
 *   - No barcodes. Smoothies and cut fruit have none, so the primary input is
 *     a touch grid, colour-coded by category (see till.css).
 *   - Sticky hands. 88px minimum tap targets, no hover affordances.
 *
 * All money logic lives in ../lib/pos/cart.ts. This component renders state
 * and dispatches intent; it never computes a total itself.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  addItem, setQty, computeTotals, isPayable, emptyCart,
  CartError, type Cart, type CatalogueItem, type Authority,
} from '../../lib/pos/cart';
import { formatKes, type Cents } from '../../lib/money/money';
import type { DoubtRecord } from '../../lib/pos/submit';

export type NetworkState = 'online' | 'slow' | 'down';

export interface TillScreenProps {
  catalogue: CatalogueItem[];
  cart: Cart;
  onCartChange: (next: Cart) => void;
  network: NetworkState;
  cashier: Authority & { name: string };
  deviceCode: string;
  eventName: string;
  /** Unresolved sales from a previous connection drop. Blocks selling. */
  doubtful: DoubtRecord[];
  onEditLine: (lineId: string) => void;
  onOpenTender: () => void;
  onCloseShift: () => void;
  onPark: () => void;
  onResolveDoubt: (record: DoubtRecord) => void;
  newLineId: () => string;
}

const CATEGORY_HUE: Record<string, string> = {
  Smoothies: 'var(--hue-mango)',
  Juices: 'var(--hue-passion)',
  'Fresh Fruit': 'var(--hue-avocado)',
  'Cut Fruit': 'var(--hue-watermelon)',
  Other: 'var(--hue-coconut)',
};

const hueFor = (category: string | null) =>
  CATEGORY_HUE[category ?? 'Other'] ?? 'var(--hue-cane)';

export function TillScreen(props: TillScreenProps) {
  const {
    catalogue, cart, onCartChange, network, cashier, deviceCode,
    eventName, doubtful, onEditLine, onOpenTender, onCloseShift, onPark,
    onResolveDoubt, newLineId,
  } = props;

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(cart), [cart]);
  const payable = isPayable(cart) || (cart.lines.length > 0 && totals.total > 0);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of catalogue) {
      const name = item.categoryName ?? 'Other';
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return [...seen.keys()];
  }, [catalogue]);

  const visible = useMemo(
    () =>
      activeCategory
        ? catalogue.filter((i) => (i.categoryName ?? 'Other') === activeCategory)
        : catalogue,
    [catalogue, activeCategory],
  );

  const handleAdd = useCallback(
    (item: CatalogueItem) => {
      try {
        onCartChange(addItem(cart, item, newLineId()));
        setNotice(null);
      } catch (err) {
        // An unclassified product is the expected case here — say why plainly.
        setNotice(err instanceof CartError ? err.message : String(err));
      }
    },
    [cart, onCartChange, newLineId],
  );

  // Selling stops when the connection is down or a sale is unresolved.
  // Both are blocking by design: see ARCHITECTURE §C.2 and §C.5.
  const blocked = network === 'down' || doubtful.length > 0;

  return (
    <div className="till-root">
      <header className="till-status">
        <StatusChip network={network} doubtCount={doubtful.length} />
        <div className="till-status__meta">
          <span>Till <b>{deviceCode}</b></span>
          <span>Cashier <b>{cashier.name}</b></span>
          <span>Event <b>{eventName}</b></span>
          <button
            className="till-cat"
            style={{ minHeight: 36, padding: '0 14px', fontSize: 'var(--step-sm)' }}
            onClick={onCloseShift}
          >
            Close shift
          </button>
        </div>
      </header>

      <section className="till-catalogue" aria-label="Products">
        <div className="till-cats" role="group" aria-label="Filter by category">
          <button
            className="till-cat"
            aria-pressed={activeCategory === null}
            onClick={() => setActiveCategory(null)}
          >
            All
          </button>
          {categories.map((name) => (
            <button
              key={name}
              className="till-cat"
              style={{ ['--accent' as string]: hueFor(name) }}
              aria-pressed={activeCategory === name}
              onClick={() => setActiveCategory(name)}
            >
              {name}
            </button>
          ))}
        </div>

        {notice && (
          <p role="status" style={{ color: 'var(--state-warn)', margin: '0 0 12px' }}>
            {notice}
          </p>
        )}

        <div className="till-grid">
          {visible.map((item) => (
            <ProductTile
              key={item.productId}
              item={item}
              disabled={blocked}
              onAdd={() => handleAdd(item)}
            />
          ))}
        </div>
      </section>

      <aside className="till-cart" aria-label="Current sale">
        <div className="till-cart__head">
          <strong>Sale</strong>
          <span className="till-cart__ref">{cart.localRef}</span>
          <span className="till-cart__count">
            {totals.itemCount === 0
              ? 'empty'
              : `${totals.itemCount} ${totals.itemCount === 1 ? 'line' : 'lines'}`}
          </span>
        </div>

        <div className="till-lines">
          {cart.lines.length === 0 ? (
            <div className="till-empty">
              <b>No items yet</b>
              <span>Tap a product to start the sale.</span>
            </div>
          ) : (
            cart.lines.map((line) => (
              <div className="till-line" key={line.lineId}>
                <button
                  className="till-line__name"
                  onClick={() => onEditLine(line.lineId)}
                  aria-label={`Edit ${line.name}`}
                >
                  {line.name}
                </button>
                <div className="till-line__amt">
                  {formatKes(
                    (Math.round(line.qty * line.unitPrice) - line.discount) as Cents,
                    false,
                  )}
                </div>
                <div className="till-line__sub">
                  <span className="till-qty">
                    <button
                      onClick={() => onCartChange(setQty(cart, line.lineId, line.qty - 1))}
                      aria-label={`Reduce ${line.name}`}
                    >
                      −
                    </button>
                    <output>{line.qty}</output>
                    <button
                      onClick={() => onCartChange(setQty(cart, line.lineId, line.qty + 1))}
                      aria-label={`Add another ${line.name}`}
                    >
                      +
                    </button>
                  </span>
                  <span>× {formatKes(line.unitPrice, false)}</span>
                  {line.priceOverridden && <span className="till-badge">Price changed</span>}
                  {line.discount > 0 && (
                    <span className="till-badge">−{formatKes(line.discount, false)}</span>
                  )}
                  {line.belowRecordedStock && (
                    <span className="till-badge" data-kind="stock">Stock unconfirmed</span>
                  )}
                  <button
                    className="till-cat"
                    style={{ marginLeft: 'auto', minHeight: 40, padding: '0 14px' }}
                    onClick={() => onEditLine(line.lineId)}
                    aria-label={`Options for ${line.name}`}
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="till-totals">
          {totals.discountTotal > 0 && (
            <div className="till-totals__row">
              <span>Discount</span>
              <span>−{formatKes(totals.discountTotal, false)}</span>
            </div>
          )}
          {totals.taxBands
            .filter((b) => b.tax > 0)
            .map((b) => (
              <div className="till-totals__row" key={b.code}>
                <span>VAT {(b.rateBp / 100).toFixed(0)}% (included)</span>
                <span>{formatKes(b.tax, false)}</span>
              </div>
            ))}

          <div className="till-total">
            <span className="till-total__label">Total</span>
            <span className="till-total__value">
              <span className="till-total__cur">KES</span>
              {formatKes(totals.total, false)}
            </span>
          </div>
        </div>

        <div className="till-actions">
          <button className="till-btn" onClick={onPark} disabled={cart.lines.length === 0}>
            Park sale
          </button>
          <button
            className="till-btn"
            onClick={() => onCartChange(emptyCart(cart.saleId, cart.localRef, cart.openedAt))}
            disabled={cart.lines.length === 0}
          >
            Clear
          </button>
          <button
            className="till-btn till-btn--pay"
            onClick={onOpenTender}
            disabled={!payable || blocked}
          >
            {blocked ? 'Selling paused' : `Take payment · ${formatKes(totals.total, false)}`}
          </button>
        </div>
      </aside>

      {doubtful.length > 0 && (
        <SaleInDoubtBlocker record={doubtful[0]} onResolve={onResolveDoubt} />
      )}
      {network === 'down' && doubtful.length === 0 && <ConnectionBlocker />}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function ProductTile({
  item, disabled, onAdd,
}: { item: CatalogueItem; disabled: boolean; onAdd: () => void }) {
  const lowStock = item.trackStock && item.qtyOnHand <= 5;

  return (
    <button
      className="till-tile"
      style={{ ['--accent' as string]: hueFor(item.categoryName) }}
      data-sellable={item.sellable}
      disabled={disabled || !item.sellable}
      onClick={onAdd}
      title={
        item.sellable
          ? undefined
          : 'Not yet classified for KRA. The accountant must set its tax type.'
      }
    >
      {item.isEventPrice && <span className="till-tile__flag" data-kind="event">EVENT</span>}
      {!item.isEventPrice && lowStock && (
        <span className="till-tile__flag" data-kind="low">{item.qtyOnHand} left</span>
      )}
      <span className="till-tile__name">{item.shortName}</span>
      <span className="till-tile__price">{formatKes(item.priceCents, false)}</span>
    </button>
  );
}

function StatusChip({ network, doubtCount }: { network: NetworkState; doubtCount: number }) {
  if (doubtCount > 0) {
    return (
      <span className="till-status__chip" data-state="doubt">
        <span className="till-status__dot" />
        {doubtCount} sale{doubtCount > 1 ? 's' : ''} unresolved
      </span>
    );
  }
  const label = { online: 'Online', slow: 'Slow connection', down: 'No connection' }[network];
  return (
    <span className="till-status__chip" data-state={network}>
      <span className="till-status__dot" />
      {label}
    </span>
  );
}

/**
 * The money-losing case. Blocking and unambiguous: the cashier must not
 * re-ring (double charge) or walk away (cash with no record).
 */
function SaleInDoubtBlocker({
  record, onResolve,
}: { record: DoubtRecord; onResolve: (r: DoubtRecord) => void }) {
  return (
    <div className="till-block" role="alertdialog" aria-modal="true"
         aria-labelledby="doubt-title">
      <div className="till-block__card">
        <h2 className="till-block__title" id="doubt-title">Sale status unknown</h2>
        <div className="till-block__amount">{formatKes(record.amountCents as Cents)}</div>
        <p className="till-block__body">
          The connection dropped while completing <strong>{record.localRef}</strong>.
          It may or may not have gone through. <strong>Do not ring this sale again.</strong>
        </p>
        <ul>
          <li>Give the customer the printed slip for this sale</li>
          <li>This till will check automatically when the connection returns</li>
          <li>The supervisor confirms it before the shift can close</li>
        </ul>
        <button className="till-btn till-btn--pay" onClick={() => onResolve(record)}>
          Check now
        </button>
      </div>
    </div>
  );
}

function ConnectionBlocker() {
  return (
    <div className="till-block" role="alertdialog" aria-modal="true"
         aria-labelledby="conn-title">
      <div className="till-block__card">
        <h2 className="till-block__title" id="conn-title">No connection</h2>
        <p className="till-block__body">
          This till cannot reach the server, so sales cannot be completed.
          The cart is saved and will still be here when the connection returns.
        </p>
        <ul>
          <li>Check the hotspot phone: battery, signal, tethering still on</li>
          <li>Switch the till to the backup phone on the other network</li>
          <li>If it stays down past five minutes, start the paper receipt book</li>
        </ul>
        <p className="till-block__body" style={{ marginBottom: 0 }}>
          Paper slips are entered afterwards by a supervisor using
          <strong> Backfill sale</strong>.
        </p>
      </div>
    </div>
  );
}
