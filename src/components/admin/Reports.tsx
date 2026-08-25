'use client';

/**
 * Reports — §17.
 *
 * Seven views over the same date range. The range and the event filter are
 * shared state, so switching tabs never silently changes what you are
 * looking at.
 *
 * Every table exports to CSV. "PDF" is the browser's own print-to-PDF, driven
 * by the print stylesheet — it costs nothing, produces a better-looking
 * document than anything I would hand-roll, and the accountant already knows
 * how to use it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toCsv, downloadCsv, reportFilename, money, type Column } from '../../lib/reports/csv';
import { formatKes, type Cents } from '../../lib/money/money';

type Tab = 'product' | 'category' | 'cashier' | 'hour' | 'payment' | 'date' | 'vat' | 'stock';

const TABS: Array<{ id: Tab; label: string; rpc: string }> = [
  { id: 'product',  label: 'By product',  rpc: 'report_by_product' },
  { id: 'category', label: 'By category', rpc: 'report_by_category' },
  { id: 'cashier',  label: 'By cashier',  rpc: 'report_by_cashier' },
  { id: 'hour',     label: 'By hour',     rpc: 'report_by_hour' },
  { id: 'payment',  label: 'Payments',    rpc: 'report_by_payment' },
  { id: 'date',     label: 'By date',     rpc: 'report_by_date' },
  { id: 'vat',      label: 'VAT',         rpc: 'report_vat' },
  { id: 'stock',    label: 'Stock value', rpc: 'report_stock_valuation' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const COLUMNS: Record<Tab, Column<Row>[]> = {
  product: [
    { key: 'sku', header: 'SKU' },
    { key: 'name', header: 'Product' },
    { key: 'category', header: 'Category' },
    { key: 'qty', header: 'Qty', kind: 'number' },
    { key: 'revenue_cents', header: 'Revenue (excl VAT)', kind: 'money' },
    { key: 'cogs_cents', header: 'Cost', kind: 'money' },
    { key: 'margin_cents', header: 'Margin', kind: 'money' },
    { key: 'margin_pct', header: 'Margin %', kind: 'percent' },
    { key: 'share_pct', header: 'Share %', kind: 'percent' },
  ],
  category: [
    { key: 'category', header: 'Category' },
    { key: 'qty', header: 'Qty', kind: 'number' },
    { key: 'revenue_cents', header: 'Revenue', kind: 'money' },
    { key: 'cogs_cents', header: 'Cost', kind: 'money' },
    { key: 'margin_cents', header: 'Margin', kind: 'money' },
    { key: 'margin_pct', header: 'Margin %', kind: 'percent' },
  ],
  cashier: [
    { key: 'cashier', header: 'Cashier' },
    { key: 'device', header: 'Till' },
    { key: 'sales_count', header: 'Sales', kind: 'number' },
    { key: 'gross_cents', header: 'Takings', kind: 'money' },
    { key: 'average_basket_cents', header: 'Avg basket', kind: 'money' },
    { key: 'discount_cents', header: 'Discounts', kind: 'money' },
    { key: 'voided_count', header: 'Voids', kind: 'number' },
    { key: 'price_overrides', header: 'Price changes', kind: 'number' },
  ],
  hour: [
    { key: 'hour', header: 'Hour', kind: 'number' },
    { key: 'sales_count', header: 'Sales', kind: 'number' },
    { key: 'gross_cents', header: 'Takings', kind: 'money' },
    { key: 'items', header: 'Items', kind: 'number' },
  ],
  payment: [
    { key: 'method', header: 'Method' },
    { key: 'count', header: 'Count', kind: 'number' },
    { key: 'amount_cents', header: 'Amount', kind: 'money' },
    { key: 'verified_cents', header: 'Verified', kind: 'money' },
    { key: 'unverified_cents', header: 'Unverified', kind: 'money' },
    { key: 'share_pct', header: 'Share %', kind: 'percent' },
  ],
  date: [
    { key: 'day', header: 'Date', kind: 'date' },
    { key: 'sales_count', header: 'Sales', kind: 'number' },
    { key: 'gross_cents', header: 'Takings', kind: 'money' },
    { key: 'vat_cents', header: 'VAT', kind: 'money' },
    { key: 'average_basket_cents', header: 'Avg basket', kind: 'money' },
  ],
  vat: [
    { key: 'tax_code', header: 'Tax code' },
    { key: 'rate_pct', header: 'Rate %', kind: 'percent' },
    { key: 'taxable_cents', header: 'Taxable', kind: 'money' },
    { key: 'vat_cents', header: 'VAT', kind: 'money' },
    { key: 'net_cents', header: 'Net', kind: 'money' },
    { key: 'lines', header: 'Lines', kind: 'number' },
  ],
  stock: [
    { key: 'location', header: 'Location' },
    { key: 'sku', header: 'SKU' },
    { key: 'name', header: 'Product' },
    { key: 'qty', header: 'Qty', kind: 'number' },
    { key: 'unit_cost_cents', header: 'Unit cost', kind: 'money' },
    { key: 'value_cents', header: 'Value', kind: 'money' },
  ],
};

interface Summary {
  sales_count: number; gross_cents: number; revenue_cents: number;
  vat_cents: number; cogs_cents: number; gross_profit_cents: number;
  margin_pct: number; average_basket_cents: number; items_sold: number;
  discount_cents: number; voided_count: number;
}

const RANGES = [
  { label: 'Today', days: 0 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

export function Reports({ supabase }: { supabase: SupabaseClient }) {
  const [tab, setTab] = useState<Tab>('product');
  const [days, setDays] = useState(30);
  const [eventId, setEventId] = useState<string>('');
  const [events, setEvents] = useState<Array<{ event_id: string; name: string }>>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => {
    const to = new Date();
    const from = days === 0
      ? new Date(new Date().setHours(0, 0, 0, 0))
      : new Date(Date.now() - days * 86_400_000);
    return { from, to };
  }, [days]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('list_events');
      setEvents(((data ?? []) as Array<{ event_id: string; name: string }>)
        .map((e) => ({ event_id: e.event_id, name: e.name })));
    })();
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const args = tab === 'stock'
      ? {}
      : tab === 'vat'
        ? { p_from: range.from.toISOString(), p_to: range.to.toISOString() }
        : {
            p_from: range.from.toISOString(), p_to: range.to.toISOString(),
            p_event_id: eventId || null,
          };

    const rpc = TABS.find((t) => t.id === tab)!.rpc;

    const [{ data: sum }, { data: table, error: err }] = await Promise.all([
      supabase.rpc('report_summary', {
        p_from: range.from.toISOString(), p_to: range.to.toISOString(),
        p_event_id: eventId || null,
      }),
      supabase.rpc(rpc, args),
    ]);

    if (err) setError(err.message);
    else setRows((table ?? []) as Row[]);
    setSummary(sum as Summary);
    setLoading(false);
  }, [supabase, tab, range, eventId]);

  useEffect(() => { void load(); }, [load]);

  const exportCsv = () => {
    const name = TABS.find((t) => t.id === tab)!.label.toLowerCase().replace(/\s+/g, '-');
    downloadCsv(
      reportFilename(name, range.from, range.to),
      toCsv(rows, COLUMNS[tab]),
    );
  };

  return (
    <main className="admin report">
      <header className="admin__head no-print">
        <div>
          <h1>Reports</h1>
          <p>
            {range.from.toLocaleDateString('en-KE')} –{' '}
            {range.to.toLocaleDateString('en-KE')}
            {eventId && events.find((e) => e.event_id === eventId)
              ? ` · ${events.find((e) => e.event_id === eventId)!.name}`
              : ' · all events'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="till-cat" onClick={exportCsv} disabled={rows.length === 0}>
            Export CSV
          </button>
          <button className="till-cat" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
      </header>

      <section className="report__filters no-print">
        <div className="tender__modes" style={{ margin: 0 }}>
          {RANGES.map((r) => (
            <button key={r.days} className="till-cat" aria-pressed={days === r.days}
                    onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        <select className="admin__input" style={{ width: 220, textAlign: 'left' }}
                value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events</option>
          {events.map((e) => (
            <option key={e.event_id} value={e.event_id}>{e.name}</option>
          ))}
        </select>
      </section>

      {summary && (
        <section className="recon__summary">
          <Stat label="Takings" value={formatKes(summary.gross_cents as Cents, false)}
                sub={`${summary.sales_count} sales`} />
          <Stat label="Revenue" value={formatKes(summary.revenue_cents as Cents, false)}
                sub="excluding VAT" />
          <Stat label="Gross profit" value={formatKes(summary.gross_profit_cents as Cents, false)}
                sub={`${summary.margin_pct}% margin`}
                tone={summary.gross_profit_cents > 0 ? 'ok' : 'warn'} />
          <Stat label="VAT collected" value={formatKes(summary.vat_cents as Cents, false)}
                sub="owed to KRA" />
          <Stat label="Avg basket" value={formatKes(summary.average_basket_cents as Cents, false)}
                sub={`${Number(summary.items_sold).toFixed(0)} items sold`} />
        </section>
      )}

      <nav className="report__tabs no-print" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" className="till-cat"
                  aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? <p className="tender__hint">Loading…</p>
       : rows.length === 0 ? <p className="tender__hint">No data for this period.</p>
       : (
        <section className="admin__group">
          <table className="admin__table report__table">
            <thead>
              <tr>
                {COLUMNS[tab].map((c) => (
                  <th key={c.key}
                      style={c.kind && c.kind !== 'text' && c.kind !== 'date'
                        ? { textAlign: 'right' } : undefined}>
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {COLUMNS[tab].map((c) => {
                    const numeric = c.kind && c.kind !== 'text' && c.kind !== 'date';
                    return (
                      <td key={c.key} className={numeric ? 'n' : undefined}>
                        {c.kind === 'money' ? money(Number(row[c.key] ?? 0))
                         : c.kind === 'percent' ? `${Number(row[c.key] ?? 0).toFixed(1)}%`
                         : String(row[c.key] ?? '')}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function Stat({
  label, value, sub, tone,
}: { label: string; value: string; sub: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="recon__stat" data-tone={tone}>
      <span className="till-total__label">{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
