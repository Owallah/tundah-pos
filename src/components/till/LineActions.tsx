'use client';

/**
 * LineActions — what happens when a cashier taps a cart line.
 *
 * Routes each action to the right authority path:
 *   - Quantity and remove: always allowed to the cashier.
 *   - Discount within the cashier's own limit: applied immediately.
 *   - Discount above it: raises an approval request.
 *   - Price change: ALWAYS raises an approval request, regardless of limit.
 *
 * The routing decision lives in cart.ts (which throws `NEEDS_APPROVAL`), not
 * here. This component catches that and turns it into a request, so the UI
 * and the server can never disagree about who may do what.
 */

import { useState } from 'react';
import {
  setQty, removeLine, applyLineDiscount, overridePrice,
  CartError, type Cart, type CartLine, type Authority, type CatalogueItem,
} from '../../lib/pos/cart';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';
import type { ApprovalKind, ApprovalResult } from './SupervisorApproval';

export interface LineActionsProps {
  cart: Cart;
  line: CartLine;
  /**
   * The catalogue entry for this line's product. Used only to recompute the
   * "stock unconfirmed" flag when the quantity changes here -- see the
   * comment on setQty() in cart.ts for why that recomputation has to happen
   * on every change rather than once.
   */
  item?: CatalogueItem;
  cashier: Authority & { name: string };
  onCartChange: (next: Cart) => void;
  onRequestApproval: (
    request: ApprovalKind,
    apply: (result: ApprovalResult) => void,
  ) => void;
  onClose: () => void;
}

export function LineActions({
  cart, line, item, cashier, onCartChange, onRequestApproval, onClose,
}: LineActionsProps) {
  const [mode, setMode] = useState<'MENU' | 'DISCOUNT' | 'PRICE'>('MENU');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const lineGross = cents(Math.round(line.qty * line.unitPrice));

  const applyDiscount = (amount: Cents) => {
    const percent = lineGross === 0 ? 0 : (amount / lineGross) * 100;
    try {
      onCartChange(applyLineDiscount(cart, line.lineId, amount, cashier));
      onClose();
    } catch (err) {
      if (err instanceof CartError && err.code === 'NEEDS_APPROVAL') {
        onRequestApproval(
          { kind: 'DISCOUNT', lineName: line.name, amount, percent },
          (result) => {
            onCartChange(
              applyLineDiscount(cart, line.lineId, amount, cashier, result.approver),
            );
            onClose();
          },
        );
      } else {
        setError(err instanceof CartError ? err.message : String(err));
      }
    }
  };

  // A price change always needs a supervisor — there is no cashier-level
  // allowance for it, which matches the server rule in complete_sale().
  const applyPrice = (newPrice: Cents) => {
    onRequestApproval(
      {
        kind: 'PRICE_OVERRIDE',
        lineName: line.name,
        listPrice: line.listPrice,
        newPrice,
      },
      (result) => {
        try {
          onCartChange(
            overridePrice(cart, line.lineId, newPrice, result.approver, result.reason),
          );
          onClose();
        } catch (err) {
          setError(err instanceof CartError ? err.message : String(err));
        }
      },
    );
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="line-title">
      <div className="till-block__card" style={{ maxWidth: 460, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title" id="line-title">{line.name}</h2>
        <p className="till-block__body" style={{ marginBottom: 18 }}>
          {line.qty} × {formatKes(line.unitPrice)}
          {line.priceOverridden && (
            <> · was <s>{formatKes(line.listPrice)}</s></>
          )}
          {line.discount > 0 && <> · −{formatKes(line.discount)} off</>}
        </p>

        {error && <p className="tender__error" role="alert">{error}</p>}

        {mode === 'MENU' && (
          <>
            <label className="boot__label">Quantity</label>
            <div className="line__qty">
              <button className="till-btn"
                onClick={() => onCartChange(setQty(cart, line.lineId, line.qty - 1))}>−</button>
              <output>{line.qty}</output>
              <button className="till-btn"
                onClick={() => onCartChange(setQty(cart, line.lineId, line.qty + 1))}>+</button>
            </div>

            <div className="line__menu">
              <button className="till-btn" onClick={() => { setMode('DISCOUNT'); setValue(''); }}>
                Discount
              </button>
              <button className="till-btn" onClick={() => { setMode('PRICE'); setValue(''); }}>
                Change price
              </button>
              <button
                className="till-btn"
                onClick={() => { onCartChange(removeLine(cart, line.lineId)); onClose(); }}
              >
                Remove line
              </button>
              <button className="till-btn till-btn--pay" onClick={onClose}>Done</button>
            </div>
          </>
        )}

        {mode === 'DISCOUNT' && (
          <>
            <label className="boot__label">Discount off this line</label>
            <div className="line__quick">
              {[5, 10, 20, 50].map((pct) => (
                <button
                  key={pct}
                  className="till-btn"
                  onClick={() => applyDiscount(cents(Math.round((lineGross * pct) / 100)))}
                >
                  {pct}%
                </button>
              ))}
            </div>
            <div className="tender__row" style={{ marginTop: 10 }}>
              <input
                className="tender__input" inputMode="decimal" value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Amount off" aria-label="Discount amount"
              />
              <button
                className="till-btn"
                disabled={!value.trim()}
                onClick={() => {
                  try { applyDiscount(parseKes(value)); }
                  catch { setError('Enter an amount like 20 or 20.50'); }
                }}
              >
                Apply
              </button>
            </div>
            <p className="tender__hint" style={{ marginTop: 10 }}>
              Up to {(cashier.maxDiscountBp / 100).toFixed(0)}% is within your
              limit. Above that needs a supervisor.
            </p>
            <button className="till-btn" style={{ width: '100%' }}
              onClick={() => setMode('MENU')}>Back</button>
          </>
        )}

        {mode === 'PRICE' && (
          <>
            <label className="boot__label">New unit price</label>
            <div className="tender__row">
              <input
                className="tender__input" inputMode="decimal" value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={formatKes(line.listPrice, false)}
                aria-label="New unit price"
              />
              <button
                className="till-btn"
                disabled={!value.trim()}
                onClick={() => {
                  try { applyPrice(parseKes(value)); }
                  catch { setError('Enter a price like 200 or 200.50'); }
                }}
              >
                Set
              </button>
            </div>
            <p className="tender__hint" style={{ marginTop: 10 }}>
              List price is {formatKes(line.listPrice)}. Any change needs a
              supervisor and a reason, and is recorded against their name.
            </p>
            <button className="till-btn" style={{ width: '100%' }}
              onClick={() => setMode('MENU')}>Back</button>
          </>
        )}
      </div>
    </div>
  );
}
