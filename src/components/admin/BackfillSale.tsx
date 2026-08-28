'use client';

/**
 * BackfillSale — entering the paper receipt book.
 *
 * When the hotspot dies, the stall falls back to a duplicate receipt book
 * (ARCHITECTURE §C.6). This screen is how those slips become real sales.
 * It is the difference between a hotspot failure costing an hour of sales
 * versus a day of them.
 *
 * Three rules, all enforced server-side in backfill_sale() as well:
 *   - Supervisor only.
 *   - The slip number is mandatory, so every entry traces to paper.
 *   - The time entered is the time WRITTEN ON THE SLIP, not now. Otherwise
 *     the whole outage collapses into one minute of the sales-by-hour report.
 */

import { useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  emptyCart, addItem, setQty, removeLine, computeTotals,
  type Cart, type CatalogueItem,
} from '../../lib/pos/cart';
import { toSalePayload } from '../../lib/pos/cart';
import { formatKes, parseKes, type Cents } from '../../lib/money/money';

export function BackfillSale({
  supabase, catalogue, shiftId, cashierId, onDone,
}: {
  supabase: SupabaseClient;
  catalogue: CatalogueItem[];
  shiftId: string;
  cashierId: string;
  onDone: () => void;
}) {
  const [cart, setCart] = useState<Cart>(() =>
    emptyCart(crypto.randomUUID(), 'PAPER', new Date()));
  const [slipRef, setSlipRef] = useState('');
  const [occurredAt, setOccurredAt] = useState(localNow());
  const [tender, setTender] = useState<'CASH' | 'MPESA_MANUAL'>('CASH');
  const [mpesaCode, setMpesaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string[]>([]);

  const totals = useMemo(() => computeTotals(cart), [cart]);
  const sellable = useMemo(() => catalogue.filter((c) => c.sellable), [catalogue]);

  const ready = cart.lines.length > 0
    && slipRef.trim().length > 0
    && occurredAt
    && (tender === 'CASH' || /^[A-Z0-9]{10}$/.test(mpesaCode));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saleId = crypto.randomUUID();
      const when = new Date(occurredAt);

      const payload = toSalePayload(
        {
          ...cart,
          saleId,
          tenders: [{
            paymentId: crypto.randomUUID(),
            method: tender,
            amount: totals.total,
            mpesaReceipt: tender === 'MPESA_MANUAL' ? mpesaCode : undefined,
          }],
        },
        {
          shiftId,
          cashierId,
          // Deterministic on the slip number: re-submitting the same slip
          // twice cannot create two sales.
          idempotencyKey: `paper:${slipRef.trim()}`,
          occurredAt: when,
        },
      );

      const { error: err } = await supabase.rpc('backfill_sale', {
        p_payload: { ...payload, backfill_ref: slipRef.trim() },
      });
      if (err) throw new Error(err.message);

      setSaved((s) => [...s, slipRef.trim()]);
      setCart(emptyCart(crypto.randomUUID(), 'PAPER', new Date()));
      setSlipRef('');
      setMpesaCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Enter paper slips</h1>
          <p>
            One slip at a time. Enter the time written on the slip, not the
            time now — the sales-by-hour report depends on it.
          </p>
        </div>
        <button className="till-btn" onClick={onDone}>Done</button>
      </header>

      {saved.length > 0 && (
        <p className="admin__ok" role="status">
          Entered {saved.length} slip{saved.length === 1 ? '' : 's'}: {saved.join(', ')}
        </p>
      )}

      <div className="backfill">
        <section>
          <label className="boot__label" htmlFor="slip">Slip number</label>
          <input id="slip" className="tender__input"
            style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
            value={slipRef} onChange={(e) => setSlipRef(e.target.value)}
            placeholder="e.g. A-0042" />

          <label className="boot__label" htmlFor="when">Time on the slip</label>
          <input id="when" className="tender__input" type="datetime-local"
            style={{ fontSize: 'var(--step-base)' }}
            value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />

          <label className="boot__label">Payment</label>
          <div className="tender__modes">
            <button className="till-cat" aria-pressed={tender === 'CASH'}
              onClick={() => setTender('CASH')}>Cash</button>
            <button className="till-cat" aria-pressed={tender === 'MPESA_MANUAL'}
              onClick={() => setTender('MPESA_MANUAL')}>M-Pesa code</button>
          </div>
          {tender === 'MPESA_MANUAL' && (
            <input className="tender__input" value={mpesaCode} maxLength={10}
              onChange={(e) => setMpesaCode(e.target.value.toUpperCase())}
              placeholder="SLK7XU9P2Q" aria-label="M-Pesa code" />
          )}

          <div className="backfill__total">
            <span className="till-total__label">Slip total</span>
            <span className="till-total__value" style={{ fontSize: 'var(--step-xl)' }}>
              {formatKes(totals.total, false)}
            </span>
          </div>

          {error && <p className="tender__error" role="alert">{error}</p>}

          <button className="till-btn till-btn--pay" style={{ width: '100%' }}
            disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save slip'}
          </button>
        </section>

        <section>
          <label className="boot__label">Items on the slip</label>
          <div className="backfill__grid">
            {sellable.map((item) => (
              <button key={item.productId} className="till-tile"
                onClick={() => setCart(addItem(cart, item, crypto.randomUUID()))}>
                <span className="till-tile__name">{item.shortName}</span>
                <span className="till-tile__price">{formatKes(item.priceCents, false)}</span>
              </button>
            ))}
          </div>

          {cart.lines.map((l) => {
            // Same recomputation rule as the till: the stock-unconfirmed
            // flag is a snapshot, not a fact about the line, so every
            // quantity change here needs the catalogue item too.
            const catalogueItem = catalogue.find((c) => c.productId === l.productId);
            return (
            <div className="till-line" key={l.lineId}>
              <div className="till-line__name">{l.name}</div>
              <div className="till-line__amt">
                {formatKes(Math.round(l.qty * l.unitPrice) as Cents, false)}
              </div>
              <div className="till-line__sub">
                <span className="till-qty">
                  <button onClick={() => setCart(
                    setQty(cart, l.lineId, l.qty - 1, catalogueItem))}>−</button>
                  <output>{l.qty}</output>
                  <button onClick={() => setCart(
                    setQty(cart, l.lineId, l.qty + 1, catalogueItem))}>+</button>
                </span>
                <button className="till-cat" style={{ marginLeft: 'auto', minHeight: 40 }}
                  onClick={() => setCart(removeLine(cart, l.lineId))}>Remove</button>
              </div>
            </div>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
