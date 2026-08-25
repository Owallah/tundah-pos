'use client';

/**
 * EventPricing — the supervisor sets prices for an event.
 *
 * Two things this screen has to get right:
 *
 *   1. Setup speed. A supervisor arriving at a venue should not retype
 *      forty prices. "Copy from previous event" then adjust is the normal
 *      path; starting from base prices is the exception.
 *
 *   2. Visibility of what CANNOT be sold. A product with no KRA tax type is
 *      rejected by complete_sale() at the database. Discovering that mid-
 *      queue is the worst possible time, so unclassified items are surfaced
 *      here, before the event opens.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';

interface PriceRow {
  product_id: string;
  sku: string;
  name: string;
  category_name: string | null;
  price_cents: number;
  base_price_cents: number;
  is_event_price: boolean;
  tax_ty_cd: string | null;
  sellable: boolean;
}

interface EventOption { event_id: string; name: string; start_date: string }

export function EventPricing({
  supabase, eventId, eventName,
}: { supabase: SupabaseClient; eventId: string; eventName: string }) {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [others, setOthers] = useState<EventOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const { data, error: err } = await supabase.rpc('event_price_list', {
      p_event_id: eventId,
    });
    if (err) setError(err.message);
    else setRows(data as PriceRow[]);
  };

  useEffect(() => {
    void load();
    void (async () => {
      const { data } = await supabase
        .from('events')
        .select('event_id, name, start_date')
        .neq('event_id', eventId)
        .order('start_date', { ascending: false })
        .limit(5);
      setOthers((data as EventOption[] | null) ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, eventId]);

  const unclassified = useMemo(() => rows.filter((r) => !r.sellable), [rows]);
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const prices = Object.entries(edits).map(([product_id, raw]) => ({
        product_id,
        // An empty field means "remove the override and fall back to the
        // base price" — not "free".
        price_cents: raw.trim() === '' ? null : parseKes(raw),
      }));

      const { error: err } = await supabase.rpc('set_event_prices', {
        p_event_id: eventId,
        p_prices: prices,
      });
      if (err) throw new Error(err.message);

      setEdits({});
      setMessage(`Saved ${prices.length} price${prices.length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copyFrom = async (fromEventId: string) => {
    setBusy(true);
    try {
      const { data, error: err } = await supabase.rpc('copy_event_prices', {
        p_from_event_id: fromEventId, p_to_event_id: eventId,
      });
      if (err) throw new Error(err.message);
      setMessage(`Copied ${(data as { copied: number }).copied} prices. Adjust as needed, then save.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, PriceRow[]>();
    for (const r of rows) {
      const key = r.category_name ?? 'Other';
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [rows]);

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Prices · {eventName}</h1>
          <p>Prices are VAT-inclusive, as shown to the customer.</p>
        </div>
        <button
          className="till-btn till-btn--pay"
          style={{ minWidth: 200 }}
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : dirty
            ? `Save ${Object.keys(edits).length} change${Object.keys(edits).length === 1 ? '' : 's'}`
            : 'No changes'}
        </button>
      </header>

      {others.length > 0 && (
        <section className="admin__copy">
          <span>Start from a previous event:</span>
          {others.map((e) => (
            <button key={e.event_id} className="till-cat" disabled={busy}
              onClick={() => void copyFrom(e.event_id)}>
              {e.name}
            </button>
          ))}
        </section>
      )}

      {unclassified.length > 0 && (
        <section className="admin__warn" role="alert">
          <strong>{unclassified.length} product{unclassified.length === 1 ? '' : 's'} cannot be sold</strong>
          <p>
            These have no KRA tax type, so the till will refuse them. Send this
            list to the accountant and re-run the catalogue seed once classified.
          </p>
          <ul>{unclassified.map((r) => <li key={r.product_id}>{r.sku} · {r.name}</li>)}</ul>
        </section>
      )}

      {message && <p className="admin__ok" role="status">{message}</p>}
      {error && <p className="tender__error" role="alert">{error}</p>}

      {grouped.map(([category, items]) => (
        <section key={category} className="admin__group">
          <h2>{category}</h2>
          <table className="admin__table">
            <thead>
              <tr>
                <th>Product</th><th>Base</th><th>This event</th><th />
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const edited = edits[r.product_id];
                return (
                  <tr key={r.product_id} data-sellable={r.sellable}>
                    <td>
                      {r.name}
                      <small>{r.sku}{!r.sellable && ' · not classified'}</small>
                    </td>
                    <td className="n">{formatKes(r.base_price_cents as Cents, false)}</td>
                    <td>
                      <input
                        className="admin__input"
                        inputMode="decimal"
                        value={edited ?? (r.is_event_price
                          ? formatKes(r.price_cents as Cents, false) : '')}
                        placeholder={formatKes(r.base_price_cents as Cents, false)}
                        onChange={(e) =>
                          setEdits((s) => ({ ...s, [r.product_id]: e.target.value }))}
                        aria-label={`Event price for ${r.name}`}
                      />
                    </td>
                    <td className="n">
                      {r.is_event_price && !edited && (
                        <button className="till-cat admin__clear"
                          onClick={() => setEdits((s) => ({ ...s, [r.product_id]: '' }))}>
                          Use base
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
