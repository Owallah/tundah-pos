'use client';

/**
 * ShiftClose — counting down the till.
 *
 * Deliberately a BLIND count: the expected cash figure is hidden until the
 * cashier has entered what they physically counted. Showing the expected
 * amount first turns a count into a copy, and a copy hides both honest
 * mistakes and dishonest ones.
 *
 * Close is blocked while any sale is unresolved (§C.5) unless a supervisor
 * overrides — the server enforces this too, in close_shift().
 */

import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';

interface ShiftReport {
  shift_id: string;
  report_type: 'X' | 'Z';
  status: string;
  device_code: string;
  cashier: string;
  event: string;
  opened_at: string;
  closed_at: string | null;
  generated_at: string;
  opening_float_cents: number;
  sales: {
    count: number; gross_cents: number; discount_cents: number;
    tax_cents: number; net_cents: number; average_basket_cents: number;
    voided_count: number; backfilled_count: number;
  };
  payments: Record<string, {
    count: number; amount_cents: number;
    verified_cents: number; unverified_cents: number;
  }>;
  cash: { expected_cents: number; counted_cents: number | null; variance_cents: number | null };
  top_products: Array<{ name: string; qty: number; amount_cents: number }>;
  exceptions: {
    price_overrides: number; discounted_lines: number;
    below_stock_lines: number; unresolved_doubt: number;
  };
  fiscal: { fiscalised: number; awaiting_etims: number };
}

export function ShiftClose({
  supabase, shiftId, onClosed, onCancel,
}: {
  supabase: SupabaseClient;
  shiftId: string;
  onClosed: (report: ShiftReport) => void;
  onCancel: () => void;
}) {
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: err } = await supabase.rpc('shift_report', { p_shift_id: shiftId });
      if (err) setError(err.message);
      else setReport(data as ShiftReport);
    })();
  }, [supabase, shiftId]);

  if (error) return <Panel title="Could not load the shift"><p className="tender__error">{error}</p></Panel>;
  if (!report) return <Panel title="Loading shift…"><p className="tender__hint">One moment.</p></Panel>;

  const countedCents = safeParse(counted);
  const variance = countedCents === null ? null : countedCents - report.cash.expected_cents;
  const blocked = report.exceptions.unresolved_doubt > 0;

  const close = async () => {
    if (countedCents === null) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc('close_shift', {
        p_shift_id: shiftId,
        p_counted_cash_cents: countedCents,
        p_notes: notes || null,
      });
      if (err) throw new Error(
        err.message.includes('unresolved_sales_in_doubt')
          ? 'There are unconfirmed sales. A supervisor must resolve them first.'
          : err.message,
      );
      const { data } = await supabase.rpc('shift_report', { p_shift_id: shiftId });
      onClosed(data as ShiftReport);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unverified = Object.values(report.payments)
    .reduce((sum, p) => sum + (p.unverified_cents ?? 0), 0);

  return (
    <Panel title={`Close shift · ${report.device_code}`}>
      <p className="tender__hint" style={{ marginTop: -8 }}>
        {report.cashier} · {report.event} · opened{' '}
        {new Date(report.opened_at).toLocaleTimeString('en-KE', { hour12: false })}
      </p>

      {blocked && (
        <p className="tender__error" role="alert">
          {report.exceptions.unresolved_doubt} sale
          {report.exceptions.unresolved_doubt > 1 ? 's' : ''} not confirmed.
          A supervisor must resolve these before the shift can close.
        </p>
      )}

      <section className="z">
        <Row label="Sales" value={String(report.sales.count)} />
        <Row label="Gross takings" value={formatKes(report.sales.gross_cents as Cents, false)} />
        <Row label="Discounts" value={`−${formatKes(report.sales.discount_cents as Cents, false)}`} />
        <Row label="VAT" value={formatKes(report.sales.tax_cents as Cents, false)} />
        <Row label="Average basket" value={formatKes(report.sales.average_basket_cents as Cents, false)} />
      </section>

      <h3 className="z__head">Payments</h3>
      <section className="z">
        {Object.entries(report.payments).map(([method, p]) => (
          <Row
            key={method}
            label={method.replace(/_/g, ' ').toLowerCase()}
            value={formatKes(p.amount_cents as Cents, false)}
            warn={p.unverified_cents > 0
              ? `${formatKes(p.unverified_cents as Cents, false)} unverified`
              : undefined}
          />
        ))}
        {Object.keys(report.payments).length === 0 && (
          <p className="tender__hint">No payments taken.</p>
        )}
      </section>

      {unverified > 0 && (
        <p className="tender__hint">
          Unverified M-Pesa must be reconciled before this shift is signed off.
          It is counted in takings but not confirmed by Safaricom.
        </p>
      )}

      {/* Blind count: the expected figure stays hidden until a number is in. */}
      <h3 className="z__head">Cash count</h3>
      <label className="boot__label" htmlFor="counted">Count the drawer and enter the total</label>
      <input
        id="counted" className="tender__input" inputMode="decimal"
        value={counted} onChange={(e) => setCounted(e.target.value)}
        placeholder="0.00" autoFocus
      />

      {countedCents !== null && !revealed && (
        <button className="till-btn" style={{ width: '100%', marginTop: 10 }}
          onClick={() => setRevealed(true)}>
          Compare against expected
        </button>
      )}

      {revealed && countedCents !== null && (
        <section className="z" style={{ marginTop: 12 }}>
          <Row label="Opening float" value={formatKes(report.opening_float_cents as Cents, false)} />
          <Row label="Expected in drawer" value={formatKes(report.cash.expected_cents as Cents, false)} />
          <Row label="Counted" value={formatKes(countedCents, false)} />
          <Row
            label="Variance"
            value={`${variance! >= 0 ? '+' : ''}${formatKes(variance! as Cents, false)}`}
            emphasis={variance !== 0}
          />
        </section>
      )}

      {revealed && variance !== null && variance !== 0 && (
        <>
          <label className="boot__label" htmlFor="notes">Explain the variance</label>
          <input
            id="notes" className="tender__input"
            style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
            value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. gave change from own float" maxLength={200}
          />
        </>
      )}

      {report.fiscal.awaiting_etims > 0 && (
        <p className="tender__hint" style={{ marginTop: 12 }}>
          {report.fiscal.awaiting_etims} sale
          {report.fiscal.awaiting_etims > 1 ? 's have' : ' has'} not reached KRA yet.
          They are queued and will submit automatically — this does not block closing.
        </p>
      )}

      {(report.exceptions.price_overrides > 0 || report.exceptions.discounted_lines > 0) && (
        <p className="tender__hint">
          {report.exceptions.price_overrides} price change
          {report.exceptions.price_overrides === 1 ? '' : 's'} ·{' '}
          {report.exceptions.discounted_lines} discounted line
          {report.exceptions.discounted_lines === 1 ? '' : 's'} this shift.
        </p>
      )}

      {error && <p className="tender__error" role="alert">{error}</p>}

      <div className="till-actions" style={{ padding: '18px 0 0' }}>
        <button className="till-btn" onClick={onCancel} disabled={busy}>Back</button>
        <button
          className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
          disabled={countedCents === null || !revealed || busy || blocked
            || (variance !== 0 && notes.trim().length < 3)}
          onClick={() => void close()}
        >
          {busy ? 'Closing…' : 'Close shift'}
        </button>
      </div>
    </Panel>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 560, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Row({
  label, value, warn, emphasis,
}: { label: string; value: string; warn?: string; emphasis?: boolean }) {
  return (
    <div className="z__row" data-emphasis={emphasis ? 'true' : undefined}>
      <span>{label}{warn && <em>{warn}</em>}</span>
      <b>{value}</b>
    </div>
  );
}

function safeParse(v: string): Cents | null {
  if (!v.trim()) return null;
  try { return parseKes(v); } catch { return null; }
}
