'use client';

/**
 * EventPnl — §15 event profit and loss, plus comparison.
 *
 * Two accounting decisions the UI states explicitly, because getting either
 * wrong flatters the numbers:
 *
 * 1. **VAT is excluded from revenue.** It is collected on KRA's behalf and is
 *    not income. Counting it would overstate profit by 16% of every drink.
 *
 * 2. **Stock left at the stall is not a loss.** It is inventory that has not
 *    come home yet. It sits below the profit line, not in it. If it never
 *    comes home, a load-back or stock take turns it into shrinkage — and
 *    then it does hit the P&L.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, type Cents } from '../../lib/money/money';
import { toCsv, downloadCsv, type Column } from '../../lib/reports/csv';

interface Pnl {
  event: { event_id: string; name: string; venue: string | null; status: string;
           start_date: string; end_date: string };
  sales_count: number;
  gross_takings_cents: number; vat_collected_cents: number; discounts_cents: number;
  revenue_cents: number; cogs_cents: number;
  gross_profit_cents: number; gross_margin_pct: number;
  wastage_cents: number; wastage_qty: number;
  samples_cents: number; shrinkage_cents: number; losses_total_cents: number;
  expenses_cents: number; expenses_by_category: Record<string, number>;
  profit_cents: number; net_margin_pct: number;
  stock_left_at_stall_cents: number; stock_left_at_stall_qty: number;
}

interface CompareRow {
  event_id: string; name: string; start_date: string; status: string;
  sales_count: number; revenue_cents: number; cogs_cents: number;
  losses_cents: number; expenses_cents: number; profit_cents: number;
  margin_pct: number; revenue_per_day: number;
}

const COST_CATEGORIES = ['STALL', 'TRANSPORT', 'STAFF', 'ACCOMMODATION', 'LICENCE', 'OTHER'];

export function EventPnl({ supabase }: { supabase: SupabaseClient }) {
  const [events, setEvents] = useState<CompareRow[]>([]);
  const [eventId, setEventId] = useState<string>('');
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [addingCost, setAddingCost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('compare_events');
    if (err) { setError(err.message); return; }
    const rows = (data ?? []) as CompareRow[];
    setEvents(rows);
    if (!eventId && rows.length > 0) setEventId(rows[0].event_id);
    setLoading(false);
  }, [supabase, eventId]);

  const loadPnl = useCallback(async () => {
    if (!eventId) return;
    const { data, error: err } = await supabase.rpc('event_pnl', { p_event_id: eventId });
    if (err) setError(err.message);
    else setPnl(data as Pnl);
  }, [supabase, eventId]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);
  useEffect(() => { void loadPnl(); }, [loadPnl]);

  const exportComparison = () => {
    const cols: Column<CompareRow>[] = [
      { key: 'name', header: 'Event' },
      { key: 'start_date', header: 'Start', kind: 'date' },
      { key: 'sales_count', header: 'Sales', kind: 'number' },
      { key: 'revenue_cents', header: 'Revenue', kind: 'money' },
      { key: 'cogs_cents', header: 'COGS', kind: 'money' },
      { key: 'losses_cents', header: 'Wastage & losses', kind: 'money' },
      { key: 'expenses_cents', header: 'Expenses', kind: 'money' },
      { key: 'profit_cents', header: 'Profit', kind: 'money' },
      { key: 'margin_pct', header: 'Net margin %', kind: 'percent' },
      { key: 'revenue_per_day', header: 'Revenue / day', kind: 'money' },
    ];
    downloadCsv('event-comparison.csv', toCsv(events, cols));
  };

  if (loading) return <main className="admin"><p className="tender__hint">Loading…</p></main>;

  if (events.length === 0) {
    return (
      <main className="admin">
        <h1>No events yet</h1>
        <p style={{ color: 'var(--till-ink-dim)' }}>
          Create an event and record some sales, then the P&amp;L appears here.
        </p>
      </main>
    );
  }

  return (
    <main className="admin report">
      <header className="admin__head">
        <div>
          <h1>Event P&amp;L</h1>
          <p>Revenue excludes VAT, which is collected for KRA and is not income.</p>
        </div>
        <select className="admin__input no-print"
                style={{ width: 260, textAlign: 'left' }}
                value={eventId} onChange={(e) => setEventId(e.target.value)}>
          {events.map((e) => (
            <option key={e.event_id} value={e.event_id}>
              {e.name} — {e.start_date}
            </option>
          ))}
        </select>
      </header>

      {error && <p className="tender__error" role="alert">{error}</p>}

      {pnl && (
        <>
          <section className="pnl">
            <h2 className="z__head">{pnl.event.name}</h2>

            <Line label="Gross takings" value={pnl.gross_takings_cents}
                  note={`${pnl.sales_count} sales`} muted />
            <Line label="Less VAT collected" value={-pnl.vat_collected_cents}
                  note="owed to KRA" muted />

            <Line label="Revenue (excluding VAT)" value={pnl.revenue_cents} strong />
            <Line label="Cost of goods sold" value={-pnl.cogs_cents}
                  note="at cost when sold" />
            <Line label="Gross profit" value={pnl.gross_profit_cents}
                  note={`${pnl.gross_margin_pct}% margin`} strong rule />

            <Line label="Wastage" value={-pnl.wastage_cents}
                  note={pnl.wastage_qty > 0 ? `${pnl.wastage_qty} units spoiled` : undefined} />
            <Line label="Samples and staff" value={-pnl.samples_cents} />
            {pnl.shrinkage_cents > 0 && (
              <Line label="Shrinkage" value={-pnl.shrinkage_cents} note="unaccounted" />
            )}

            {Object.entries(pnl.expenses_by_category).map(([cat, amount]) => (
              <Line key={cat} label={cat.charAt(0) + cat.slice(1).toLowerCase()}
                    value={-amount} />
            ))}
            {pnl.expenses_cents === 0 && (
              <Line label="Event expenses" value={0} note="none recorded" muted />
            )}

            <Line label={pnl.profit_cents >= 0 ? 'Event profit' : 'Event loss'}
                  value={pnl.profit_cents}
                  note={`${pnl.net_margin_pct}% net margin`}
                  strong rule big />
          </section>

          {pnl.stock_left_at_stall_cents > 0 && (
            <section className="admin__warn" style={{
              background: 'rgba(242,160,7,.08)', borderLeftColor: 'var(--state-warn)' }}>
              <strong>
                {formatKes(pnl.stock_left_at_stall_cents as Cents)} of stock still at the stall
              </strong>
              <p>
                {pnl.stock_left_at_stall_qty} units. This is inventory, not a
                loss, so it sits outside the P&amp;L above. Record a load-back
                when it comes home — if it never does, a stock take will turn
                it into shrinkage and it will then reduce this profit.
              </p>
            </section>
          )}

          <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 26 }}>
            <button className="till-cat" onClick={() => setAddingCost(true)}>
              Add expense
            </button>
            <button className="till-cat" onClick={() => window.print()}>
              Print / PDF
            </button>
          </div>
        </>
      )}

      <section className="admin__group">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          Compare events
          <button className="till-cat no-print" style={{ minHeight: 36, padding: '0 12px' }}
                  onClick={exportComparison}>
            Export CSV
          </button>
        </h2>
        <div className="admin__table-scroll">
        <table className="admin__table report__table">
          <thead>
            <tr>
              <th>Event</th>
              <th style={{ textAlign: 'right' }}>Sales</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Expenses</th>
              <th style={{ textAlign: 'right' }}>Profit</th>
              <th style={{ textAlign: 'right' }}>Margin</th>
              <th style={{ textAlign: 'right' }}>Rev / day</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.event_id}
                  style={e.event_id === eventId
                    ? { background: 'var(--till-surface-hi)' } : undefined}>
                <td>{e.name}<small>{e.start_date} · {e.status.toLowerCase()}</small></td>
                <td className="n">{e.sales_count}</td>
                <td className="n">{formatKes(e.revenue_cents as Cents, false)}</td>
                <td className="n">{formatKes(e.expenses_cents as Cents, false)}</td>
                <td className="n" style={{
                  color: e.profit_cents >= 0 ? 'var(--state-ok)' : 'var(--state-stop)' }}>
                  {formatKes(e.profit_cents as Cents, false)}
                </td>
                <td className="n">{e.margin_pct}%</td>
                <td className="n">{formatKes(e.revenue_per_day as Cents, false)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <p className="tender__hint">
          Revenue per day normalises a two-day event against a five-day one —
          usually the more honest comparison when deciding which to book again.
        </p>
      </section>

      {addingCost && (
        <AddCost supabase={supabase} eventId={eventId}
                 onDone={() => { setAddingCost(false); void loadPnl(); void loadEvents(); }}
                 onCancel={() => setAddingCost(false)} />
      )}
    </main>
  );
}

function Line({
  label, value, note, strong, rule, big, muted,
}: {
  label: string; value: number; note?: string;
  strong?: boolean; rule?: boolean; big?: boolean; muted?: boolean;
}) {
  return (
    <div className="pnl__line" data-strong={strong ? 'true' : undefined}
         data-rule={rule ? 'true' : undefined} data-big={big ? 'true' : undefined}
         data-muted={muted ? 'true' : undefined}>
      <span>{label}{note && <em>{note}</em>}</span>
      <b style={big && value < 0 ? { color: 'var(--state-stop)' }
              : big ? { color: 'var(--state-ok)' } : undefined}>
        {value < 0 ? `(${formatKes(Math.abs(value) as Cents, false)})`
                   : formatKes(value as Cents, false)}
      </b>
    </div>
  );
}

function AddCost({
  supabase, eventId, onDone, onCancel,
}: {
  supabase: SupabaseClient; eventId: string;
  onDone: () => void; onCancel: () => void;
}) {
  const [category, setCategory] = useState('STALL');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc('add_event_cost', {
        p_event_id: eventId,
        p_category: category,
        p_description: description,
        p_amount_cents: parseKes(amount),
        p_incurred_on: new Date().toISOString().slice(0, 10),
      });
      if (err) throw new Error(err.message);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 440, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title">Add event expense</h2>

        <label className="boot__label" htmlFor="c-cat">Category</label>
        <select id="c-cat" className="tender__input"
                style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
                value={category} onChange={(e) => setCategory(e.target.value)}>
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
          ))}
        </select>

        <label className="boot__label" htmlFor="c-desc">Description</label>
        <input id="c-desc" className="tender__input"
               style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
               value={description} onChange={(e) => setDescription(e.target.value)}
               placeholder="e.g. two-day stall fee" maxLength={200} />

        <label className="boot__label" htmlFor="c-amt">Amount</label>
        <input id="c-amt" className="tender__input" inputMode="decimal"
               value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '16px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!amount.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Add expense'}
          </button>
        </div>
      </div>
    </div>
  );
}