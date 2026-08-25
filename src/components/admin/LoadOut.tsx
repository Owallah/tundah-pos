'use client';

/**
 * LoadOut — moving stock between the base store and the event stall (INV-05).
 *
 * Double-entry: stock leaves BASE and arrives at the EVENT location in one
 * transaction. The old seed only wrote the arrival, which left base store
 * stock fictional and made shrinkage impossible to compute.
 *
 * The screen is built for the loading bay, not a desk. Both columns are on
 * screen at once — what is at base, what is already at the stall — so a
 * supervisor counting crates can see the effect before committing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, cents, type Cents } from '../../lib/money/money';

interface SheetRow {
  product_id: string; sku: string; name: string;
  category: string | null; uom: string;
  qty_base: number; qty_event: number;
  cost_price_cents: number; sellable: boolean;
}

type Direction = 'OUT' | 'BACK';

export function LoadOut({
  supabase, eventId, eventName,
}: { supabase: SupabaseClient; eventId: string | null; eventName: string }) {
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [direction, setDirection] = useState<Direction>('OUT');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!eventId) { setLoading(false); return; }
    const { data, error: err } = await supabase.rpc('load_out_sheet', {
      p_event_id: eventId,
    });
    if (err) setError(err.message);
    else setRows(data as SheetRow[]);
    setLoading(false);
  }, [supabase, eventId]);

  useEffect(() => { void load(); }, [load]);

  const entered = useMemo(
    () => Object.entries(qty)
      .map(([id, v]) => ({ id, n: Number(v) }))
      .filter((e) => Number.isFinite(e.n) && e.n > 0),
    [qty],
  );

  const totalCost = useMemo(() => {
    let sum = 0;
    for (const e of entered) {
      const row = rows.find((r) => r.product_id === e.id);
      if (row) sum += row.cost_price_cents * e.n;
    }
    return cents(Math.round(sum)) as Cents;
  }, [entered, rows]);

  // Warn rather than block: recorded stock is often behind reality, and a
  // supervisor holding the crate knows better than the ledger does.
  const overdrawn = useMemo(
    () => entered.filter((e) => {
      const row = rows.find((r) => r.product_id === e.id);
      if (!row) return false;
      return e.n > (direction === 'OUT' ? row.qty_base : row.qty_event);
    }),
    [entered, rows, direction],
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('record_load_out', {
      p_event_id: eventId,
      p_direction: direction,
      p_lines: entered.map((e) => ({ product_id: e.id, qty: e.n })),
    });
    if (err) {
      setError(err.message);
    } else {
      const r = data as { lines: number; cost_cents: number };
      setNote(
        `${direction === 'OUT' ? 'Loaded out' : 'Loaded back'} ${r.lines} ` +
        `product${r.lines === 1 ? '' : 's'} · ${formatKes(r.cost_cents as Cents)} at cost.`,
      );
      setQty({});
      await load();
    }
    setBusy(false);
  };

  if (!eventId) {
    return (
      <main className="admin">
        <h1>No active event</h1>
        <p style={{ color: 'var(--till-ink-dim)', maxWidth: '52ch' }}>
          Stock is loaded out to a specific event. Activate one under
          Events first.
        </p>
      </main>
    );
  }

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>{direction === 'OUT' ? 'Load out' : 'Load back'}</h1>
          <p>
            {direction === 'OUT'
              ? `Moving stock from the base store to ${eventName}.`
              : `Returning unsold stock from ${eventName} to the base store.`}
          </p>
        </div>
        <div className="tender__modes" style={{ margin: 0 }}>
          <button className="till-cat" aria-pressed={direction === 'OUT'}
                  onClick={() => { setDirection('OUT'); setQty({}); }}>
            Load out
          </button>
          <button className="till-cat" aria-pressed={direction === 'BACK'}
                  onClick={() => { setDirection('BACK'); setQty({}); }}>
            Load back
          </button>
        </div>
      </header>

      {note && <p className="admin__ok" role="status">{note}</p>}
      {error && <p className="tender__error" role="alert">{error}</p>}

      {overdrawn.length > 0 && (
        <section className="admin__warn">
          <strong>More than the ledger shows</strong>
          <p>
            {overdrawn.length} line{overdrawn.length === 1 ? '' : 's'} exceed the
            recorded quantity. That is allowed — the crate in your hands is
            more authoritative than the ledger — but it will show as a negative
            balance until a stock take corrects it.
          </p>
        </section>
      )}

      {loading ? <p className="tender__hint">Loading…</p> : (
        <section className="admin__group">
          <table className="admin__table">
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Base</th>
                <th style={{ textAlign: 'right' }}>At stall</th>
                <th style={{ textAlign: 'right' }}>
                  {direction === 'OUT' ? 'Send' : 'Return'}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const available = direction === 'OUT' ? row.qty_base : row.qty_event;
                const n = Number(qty[row.product_id] ?? '');
                const over = Number.isFinite(n) && n > available;
                return (
                  <tr key={row.product_id} data-sellable={row.sellable}>
                    <td>
                      {row.name}
                      <small>
                        {row.sku}
                        {!row.sellable && ' · not classified — cannot be sold'}
                      </small>
                    </td>
                    <td className="n">{row.qty_base}</td>
                    <td className="n">{row.qty_event}</td>
                    <td className="n">
                      <input
                        className="admin__input"
                        style={over ? { borderColor: 'var(--state-warn)' } : undefined}
                        inputMode="decimal"
                        value={qty[row.product_id] ?? ''}
                        placeholder="0"
                        aria-label={`Quantity to move for ${row.name}`}
                        onChange={(e) => setQty((s) => ({
                          ...s, [row.product_id]: e.target.value,
                        }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <div className="loadout__bar">
        <div>
          <span className="till-total__label">
            {entered.length} product{entered.length === 1 ? '' : 's'}
          </span>
          <strong className="till-total__value" style={{ fontSize: 'var(--step-lg)' }}>
            {formatKes(totalCost, false)}
          </strong>
          <small style={{ color: 'var(--till-ink-dim)' }}> at cost</small>
        </div>
        <button className="till-btn till-btn--pay" style={{ minWidth: 220 }}
                disabled={entered.length === 0 || busy}
                onClick={() => void submit()}>
          {busy ? 'Recording…'
                : direction === 'OUT' ? 'Confirm load out' : 'Confirm load back'}
        </button>
      </div>
    </main>
  );
}
