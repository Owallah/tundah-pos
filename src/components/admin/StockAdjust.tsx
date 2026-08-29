'use client';

/**
 * StockAdjust — wastage, samples and load-back.
 *
 * For a fresh-produce business this is a DAILY screen, not an exceptional
 * one. Fruit spoils, cut fruit does not keep, and samples are handed out all
 * day. Without recording those, every spoiled mango silently becomes
 * shrinkage and the ledger drifts from the shelf within one event.
 *
 * Direction is decided by the movement type, never by the number entered, so
 * a supervisor typing "3" for wastage can never accidentally add stock.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toCatalogue, type EventPriceRow } from '../../lib/pos/catalogue';
import { formatKes, cents, type Cents } from '../../lib/money/money';
import type { CatalogueItem } from '../../lib/pos/cart';

type MovementType = 'WASTAGE' | 'SAMPLE' | 'LOAD_BACK' | 'ADJUSTMENT';

const TYPES: Array<{ value: MovementType; label: string; blurb: string }> = [
  { value: 'WASTAGE', label: 'Wastage',
    blurb: 'Spoiled, dropped or past its best. Reduces stock and shows as a cost against the event.' },
  { value: 'SAMPLE', label: 'Sample / staff',
    blurb: 'Given away or consumed by staff. Reduces stock without a sale.' },
  { value: 'LOAD_BACK', label: 'Load back',
    blurb: 'Returning unsold stock to the base store at the end of an event.' },
  { value: 'ADJUSTMENT', label: 'Correction',
    blurb: 'Fixing a miscount. The only type where a negative number is meaningful.' },
];

export function StockAdjust({
  supabase, eventId,
}: { supabase: SupabaseClient; eventId: string | null }) {
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [type, setType] = useState<MovementType>('WASTAGE');
  const [productId, setProductId] = useState<string>('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    if (!eventId) return;
    void (async () => {
      const { data } = await supabase.rpc('event_price_list', { p_event_id: eventId });
      setCatalogue(toCatalogue(data as EventPriceRow[] | null));
    })();
  }, [supabase, eventId]);

  const product = useMemo(
    () => catalogue.find((c) => c.productId === productId),
    [catalogue, productId],
  );

  const costImpact = useMemo(() => {
    const n = Number(qty);
    if (!product || !Number.isFinite(n)) return null;
    // Selling price is what the business loses in revenue; cost price is the
    // cash already spent. Showing revenue impact makes wastage feel real.
    return cents(Math.round(Math.abs(n) * product.priceCents)) as Cents;
  }, [product, qty]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('record_stock_adjustment', {
        p_product_id: productId,
        p_movement_type: type,
        p_qty: Number(qty),
        p_reason: reason.trim(),
      });
      if (err) throw new Error(err.message);

      const r = data as { product: string; qty_delta: number };
      setLog((l) => [`${r.product}: ${r.qty_delta > 0 ? '+' : ''}${r.qty_delta} (${type.toLowerCase()})`, ...l]);
      setQty('');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!eventId) {
    return (
      <main className="admin">
        <h1>No active event</h1>
        <p style={{ color: 'var(--till-ink-dim)' }}>
          Stock movements are recorded against the active event. Activate one first.
        </p>
      </main>
    );
  }

  const n = Number(qty);
  const validQty = Number.isFinite(n) && n !== 0
    && (type === 'ADJUSTMENT' || n > 0);
  const ready = productId && validQty && reason.trim().length > 2;

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Record stock movement</h1>
          <p>
            Every movement is written to the append-only ledger with your name
            and reason. Nothing here edits a quantity directly.
          </p>
        </div>
      </header>

      <div className="backfill">
        <section>
          <label className="boot__label">Type</label>
          <div className="admin__nav" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {TYPES.map((t) => (
              <button key={t.value} className="till-btn"
                      aria-pressed={type === t.value}
                      style={type === t.value
                        ? { borderColor: 'var(--state-warn)', background: 'rgba(242,160,7,.1)' }
                        : undefined}
                      onClick={() => setType(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="tender__hint" style={{ marginTop: 10 }}>
            {TYPES.find((t) => t.value === type)?.blurb}
          </p>

          <label className="boot__label" htmlFor="prod">Product</label>
          <select id="prod" className="tender__input"
                  style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
                  value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose a product…</option>
            {catalogue.map((c) => (
              <option key={c.productId} value={c.productId}>
                {c.name} — {c.qtyOnHand} on hand
              </option>
            ))}
          </select>

          <label className="boot__label" htmlFor="qty">
            Quantity {type === 'ADJUSTMENT' ? '(negative to reduce)' : ''}
          </label>
          <input id="qty" className="tender__input" inputMode="decimal"
                 value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />

          {costImpact !== null && Number(qty) !== 0 && (
            <p className="tender__hint">
              Revenue impact: <strong style={{ color: 'var(--state-warn)' }}>
                {formatKes(costImpact)}
              </strong> at current event price.
            </p>
          )}

          <label className="boot__label" htmlFor="reason">Reason</label>
          <input id="reason" className="tender__input"
                 style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
                 value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="e.g. overripe, dropped, end of day" maxLength={200} />

          {error && <p className="tender__error" role="alert">{error}</p>}

          <button className="till-btn till-btn--pay" style={{ width: '100%', marginTop: 12 }}
                  disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Recording…' : 'Record movement'}
          </button>
        </section>

        <section>
          <label className="boot__label">Recorded this session</label>
          {log.length === 0 ? (
            <p className="tender__hint">Nothing yet.</p>
          ) : (
            <div className="recon">
              {log.map((entry, i) => (
                <div className="recon__row" key={i}>
                  <div><strong style={{ fontSize: 'var(--step-base)' }}>{entry}</strong></div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
