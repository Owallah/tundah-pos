'use client';

/**
 * PaymentReconciliation — PAY-05.
 *
 * Six buckets, ordered by how much they need a human:
 *
 *   Mismatch          money moved, but not the amount we expected
 *   Unverified manual a cashier typed a code by hand — now a real ledger row
 *                     (channel MANUAL), auto-upgraded if Safaricom's own
 *                     confirmation for that code shows up later
 *   Unmatched         money arrived that no sale claimed
 *   Pending           STK sent, no callback yet — usually self-resolving
 *   Verified          the happy path, shown as a total only
 *   Failed            cancelled or timed out, no action needed
 *
 * The ordering is the point. A supervisor with five minutes should spend
 * them on the top three; the bottom three are there for completeness.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, type Cents } from '../../lib/money/money';
import { maskPhone } from '../../lib/mpesa/matcher';
import { toCsv, downloadCsv, reportFilename, type Column } from '../../lib/reports/csv';

interface PendingRow {
  mpesa_txn_id: string; channel: string; amount_cents: number;
  phone_number: string | null; initiated_at: string; checkout_request_id: string;
}
interface MismatchRow {
  mpesa_txn_id: string; mpesa_receipt_number: string; amount_cents: number;
  phone_number: string | null; payer_name: string | null;
  confirmed_at: string; result_desc: string | null;
}
interface ManualRow {
  mpesa_txn_id: string; mpesa_receipt_number: string; manual_bank: string | null;
  amount_cents: number;
  local_ref: string; cashier: string; hours_old: number;
}
interface UnmatchedRow {
  mpesa_txn_id: string; mpesa_receipt_number: string; amount_cents: number;
  phone_number: string | null; payer_name: string | null; confirmed_at: string;
}
interface LedgerRow {
  mpesa_txn_id: string; channel: string; provider: string; status: string;
  mpesa_receipt_number: string | null;
  provider_txn_id: string | null; provider_reference: string | null;
  amount_cents: number;
  phone_number: string | null; payer_name: string | null;
  initiated_at: string | null; confirmed_at: string | null;
  local_ref: string | null; cashier: string | null; event_name: string | null;
}

interface Reconciliation {
  from: string; to: string;
  buckets: {
    pending: PendingRow[];
    verified: { count: number; total_cents: number };
    failed: { count: number };
    mismatch: MismatchRow[];
    unverified_manual: ManualRow[];
    unmatched: UnmatchedRow[];
  };
}

const RANGES = [
  { label: 'Today', hours: 24 },
  { label: 'Last 3 days', hours: 72 },
  { label: 'Last week', hours: 168 },
];

export function PaymentReconciliation({ supabase }: { supabase: SupabaseClient }) {
  const [data, setData] = useState<Reconciliation | null>(null);
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [events, setEvents] = useState<Array<{ event_id: string; name: string }>>([]);
  const [eventId, setEventId] = useState<string>('');
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data: d } = await supabase.rpc('list_events');
      setEvents(((d ?? []) as Array<{ event_id: string; name: string }>)
        .map((e) => ({ event_id: e.event_id, name: e.name })));
    })();
  }, [supabase]);

  const load = useCallback(async () => {
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data: d, error: err } = await supabase.rpc('mpesa_reconciliation', {
      p_from: from, p_to: new Date().toISOString(),
    });
    if (err) setError(err.message);
    else setData(d as Reconciliation);
  }, [supabase, hours]);

  useEffect(() => { void load(); }, [load]);

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data: d, error: err } = await supabase.rpc('mpesa_ledger', {
      p_event_id: eventId || null, p_from: from, p_to: new Date().toISOString(),
    });
    if (err) setError(err.message);
    else setLedger(d as LedgerRow[]);
    setLedgerLoading(false);
  }, [supabase, hours, eventId]);

  useEffect(() => { void loadLedger(); }, [loadLedger]);

  const exportLedgerCsv = () => {
    if (!ledger) return;
    const columns: Column<LedgerRow>[] = [
      { key: 'confirmed_at', header: 'Confirmed at', kind: 'date' },
      { key: 'channel', header: 'Channel' },
      { key: 'provider', header: 'Provider' },
      { key: 'status', header: 'Status' },
      { key: 'mpesa_receipt_number', header: 'Code / receipt' },
      { key: 'provider_txn_id', header: 'NCBA reference' },
      { key: 'amount_cents', header: 'Amount', kind: 'money' },
      { key: 'phone_number', header: 'Phone' },
      { key: 'payer_name', header: 'Payer' },
      { key: 'local_ref', header: 'Sale ref' },
      { key: 'cashier', header: 'Cashier' },
      { key: 'event_name', header: 'Event' },
    ];
    const csv = toCsv(ledger, columns);
    const to = new Date();
    const from = new Date(Date.now() - hours * 3_600_000);
    downloadCsv(reportFilename('mpesa-ledger', from, to), csv);
  };

  const resolve = async (txnId: string, action: 'ACCEPT' | 'WRITE_OFF', note?: string) => {
    setBusy(txnId);
    setError(null);
    try {
      const { error: err } = await supabase.rpc('resolve_mpesa', {
        p_mpesa_txn_id: txnId, p_action: action, p_note: note ?? null,
      });
      if (err) throw new Error(err.message);
      await Promise.all([load(), loadLedger()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const needsAttention = useMemo(() => {
    if (!data) return 0;
    return data.buckets.mismatch.length
      + data.buckets.unverified_manual.length
      + data.buckets.unmatched.length;
  }, [data]);

  if (error && !data) {
    return <main className="admin"><p className="tender__error">{error}</p></main>;
  }
  if (!data) {
    return <main className="admin"><p className="tender__hint">Loading…</p></main>;
  }

  const b = data.buckets;

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Payment reconciliation</h1>
          <p>
            {needsAttention === 0
              ? 'Nothing needs attention. Everything reconciles.'
              : `${needsAttention} item${needsAttention === 1 ? '' : 's'} need a decision.`}
          </p>
        </div>
        <div className="tender__modes" style={{ margin: 0 }}>
          {RANGES.map((r) => (
            <button key={r.hours} className="till-cat"
              aria-pressed={hours === r.hours} onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="tender__error" role="alert">{error}</p>}

      <section className="recon__summary">
        <Stat label="Verified" value={formatKes(b.verified.total_cents as Cents, false)}
          sub={`${b.verified.count} payment${b.verified.count === 1 ? '' : 's'}`} tone="ok" />
        <Stat label="Awaiting decision" value={String(needsAttention)}
          sub="mismatch, unverified, unmatched" tone={needsAttention ? 'warn' : undefined} />
        <Stat label="In flight" value={String(b.pending.length)}
          sub="STK awaiting callback" />
        <Stat label="Failed" value={String(b.failed.count)} sub="cancelled or timed out" />
      </section>

      {/* ── Mismatch: money moved, wrong amount ─────────────────────────── */}
      <Bucket
        title="Amount mismatch"
        count={b.mismatch.length}
        blurb="Safaricom confirmed a different amount from the one requested.
               Accept if the customer genuinely paid this, or write it off and
               raise a credit note."
      >
        {b.mismatch.map((r) => (
          <div className="recon__row" key={r.mpesa_txn_id}>
            <div>
              <strong>{formatKes(r.amount_cents as Cents)}</strong>
              <small>
                {r.mpesa_receipt_number} · {r.payer_name ?? 'Unknown'} ·{' '}
                {maskPhone(r.phone_number)} ·{' '}
                {new Date(r.confirmed_at).toLocaleString('en-KE', { hour12: false })}
              </small>
              {r.result_desc && <small>{r.result_desc}</small>}
            </div>
            <div className="recon__actions">
              <button className="till-cat" disabled={busy === r.mpesa_txn_id}
                onClick={() => void resolve(r.mpesa_txn_id, 'ACCEPT')}>
                Accept
              </button>
              <button className="till-cat" disabled={busy === r.mpesa_txn_id}
                onClick={() => void resolve(r.mpesa_txn_id, 'WRITE_OFF', 'amount mismatch')}>
                Write off
              </button>
            </div>
          </div>
        ))}
      </Bucket>

      {/* ── Unverified manual codes: the fraud-shaped bucket ────────────── */}
      <Bucket
        title="Unverified manual codes"
        count={b.unverified_manual.length}
        blurb="A cashier typed these codes by hand. If Safaricom's own
               confirmation for the same code arrives later, this resolves
               itself automatically. Otherwise, check the code against the
               actual NCBA/Safaricom statement, then Accept or Write off."
      >
        {b.unverified_manual.map((r) => (
          <div className="recon__row" key={r.mpesa_txn_id}
               data-urgent={r.hours_old > 24 ? 'true' : undefined}>
            <div>
              <strong>{formatKes(r.amount_cents as Cents)}</strong>
              <small>
                {r.manual_bank && (
                  <span style={{
                    display: 'inline-block', marginRight: 6, padding: '1px 6px',
                    borderRadius: 4, fontSize: '0.85em', fontWeight: 600,
                    background: 'var(--till-surface-hi)', color: 'var(--till-ink-dim)',
                  }}>
                    {r.manual_bank === 'NCBA' ? 'NCBA' : 'Co-op'}
                  </span>
                )}
                <code>{r.mpesa_receipt_number}</code> · {r.local_ref} ·{' '}
                {r.cashier}
              </small>
              {r.hours_old > 24 && (
                <small style={{ color: 'var(--state-stop)' }}>
                  {Math.floor(r.hours_old)} hours unverified — investigate
                </small>
              )}
            </div>
            <div className="recon__actions">
              <button className="till-cat" disabled={busy === r.mpesa_txn_id}
                onClick={() => void resolve(r.mpesa_txn_id, 'ACCEPT')}>
                Accept
              </button>
              <button className="till-cat" disabled={busy === r.mpesa_txn_id}
                onClick={() => void resolve(r.mpesa_txn_id, 'WRITE_OFF',
                  'manual code not found on statement')}>
                Write off
              </button>
            </div>
          </div>
        ))}
      </Bucket>

      {/* ── Unmatched: money in, no sale claimed it ─────────────────────── */}
      <Bucket
        title="Unmatched payments"
        count={b.unmatched.length}
        blurb="Money arrived that no cashier attached to a sale. Often a customer
               who paid then left, or a payment matched at a till after this
               window. Check against the sales list before writing off."
      >
        {b.unmatched.map((r) => (
          <div className="recon__row" key={r.mpesa_txn_id}>
            <div>
              <strong>{formatKes(r.amount_cents as Cents)}</strong>
              <small>
                {r.mpesa_receipt_number} · {r.payer_name ?? 'Unknown'} ·{' '}
                {maskPhone(r.phone_number)} ·{' '}
                {new Date(r.confirmed_at).toLocaleString('en-KE', { hour12: false })}
              </small>
            </div>
            <div className="recon__actions">
              <button className="till-cat" disabled={busy === r.mpesa_txn_id}
                onClick={() => void resolve(r.mpesa_txn_id, 'WRITE_OFF',
                  'unattributed income')}>
                Record as unattributed
              </button>
            </div>
          </div>
        ))}
      </Bucket>

      {/* ── Pending: usually self-resolving ─────────────────────────────── */}
      <Bucket
        title="Awaiting Safaricom"
        count={b.pending.length}
        blurb="STK requests with no callback yet. The reconciler chases these
               every five minutes for an hour, so they normally clear on their
               own. No action needed unless they persist."
      >
        {b.pending.map((r) => (
          <div className="recon__row" key={r.mpesa_txn_id}>
            <div>
              <strong>{formatKes(r.amount_cents as Cents)}</strong>
              <small>
                {r.channel} · {maskPhone(r.phone_number)} · sent{' '}
                {new Date(r.initiated_at).toLocaleTimeString('en-KE', { hour12: false })}
              </small>
            </div>
          </div>
        ))}
      </Bucket>

      {/* ── All transactions: the full ledger, not just problem rows ─────── */}
      <section className="admin__group">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          All M-Pesa transactions
          <select className="admin__input" style={{ width: 220, textAlign: 'left' }}
                  value={eventId} onChange={(e) => setEventId(e.target.value)}
                  aria-label="Filter by event">
            <option value="">All events</option>
            {events.map((ev) => (
              <option key={ev.event_id} value={ev.event_id}>{ev.name}</option>
            ))}
          </select>
          <button className="till-cat no-print" style={{ minHeight: 36, padding: '0 12px' }}
                  onClick={exportLedgerCsv} disabled={!ledger || ledger.length === 0}>
            Export CSV
          </button>
        </h2>
        <p className="tender__hint">
          Every transaction in the selected window, any status — this is the
          full record to check against the actual NCBA or Safaricom
          statement, not just the ones needing a decision above.
          {eventId && ' Rows with no linked sale cannot be attributed to an '
            + 'event, so they are left out while a specific event is selected.'}
        </p>
        {ledgerLoading ? (
          <p className="tender__hint">Loading…</p>
        ) : !ledger || ledger.length === 0 ? (
          <p className="tender__hint">Nothing in this window.</p>
        ) : (
          <div className="admin__table-scroll">
            <table className="admin__table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Code / receipt</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Payer / phone</th>
                  <th>Sale</th>
                  <th>Cashier</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.mpesa_txn_id}>
                    <td>
                      {new Date(r.confirmed_at ?? r.initiated_at ?? '')
                        .toLocaleString('en-KE', { hour12: false })}
                    </td>
                    <td>{r.channel}{r.provider !== 'DARAJA' ? ` · ${r.provider}` : ''}</td>
                    <td>{r.status}</td>
                    <td>{r.mpesa_receipt_number
                      ? <code>{r.mpesa_receipt_number}</code>
                      : r.provider_txn_id
                        ? (
                          <span title="NCBA never issues a Safaricom-style receipt code; this is NCBA's own transaction reference instead.">
                            <code>{r.provider_txn_id}</code>
                            <small style={{ display: 'block' }}>NCBA ref</small>
                          </span>
                        )
                        : '—'}</td>
                    <td className="n">{formatKes(r.amount_cents as Cents, false)}</td>
                    <td>{r.payer_name ?? maskPhone(r.phone_number)}</td>
                    <td>{r.local_ref ?? '—'}</td>
                    <td>{r.cashier ?? '—'}</td>
                    <td>{r.event_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Bucket({
  title, count, blurb, children,
}: { title: string; count: number; blurb: string; children: React.ReactNode }) {
  return (
    <section className="admin__group">
      <h2>
        {title}
        <span className="recon__count" data-zero={count === 0 ? 'true' : undefined}>
          {count}
        </span>
      </h2>
      {count === 0
        ? <p className="tender__hint">Nothing here.</p>
        : <><p className="tender__hint">{blurb}</p><div className="recon">{children}</div></>}
    </section>
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
