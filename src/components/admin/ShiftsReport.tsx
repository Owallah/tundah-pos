'use client';

/**
 * ShiftsReport — when did each cashier work, and what happened at close.
 *
 * The data this reads (opened_at, closed_at, counted vs expected cash,
 * variance, the cashier's own explanation) has existed on `shifts` since the
 * very first migration. Nothing captures anything new here — this screen
 * only reads what ShiftClose.tsx (the till side) was already writing, with
 * no admin screen ever showing it back.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, type Cents } from '../../lib/money/money';

interface ShiftRow {
  shift_id: string; cashier: string; device_code: string; event_name: string;
  status: string;
  opened_at: string; closed_at: string | null;
  opening_float_cents: number;
  counted_cash_cents: number | null; expected_cash_cents: number | null;
  variance_cents: number | null;
  close_notes: string | null;
  closed_with_unresolved_doubt: boolean;
}

const RANGES = [
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 7 days', hours: 168 },
  { label: 'Last 30 days', hours: 720 },
];

export function ShiftsReport({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [hours, setHours] = useState(168);
  const [events, setEvents] = useState<Array<{ event_id: string; name: string }>>([]);
  const [eventId, setEventId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('list_events');
      setEvents(((data ?? []) as Array<{ event_id: string; name: string }>)
        .map((e) => ({ event_id: e.event_id, name: e.name })));
    })();
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const from = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data, error: err } = await supabase.rpc('list_shifts', {
      p_from: from, p_to: new Date().toISOString(),
      p_event_id: eventId || null,
    });
    if (err) setError(err.message);
    else setRows((data ?? []) as ShiftRow[]);
    setLoading(false);
  }, [supabase, hours, eventId]);

  useEffect(() => { void load(); }, [load]);

  const duration = (opened: string, closed: string | null) => {
    const end = closed ? new Date(closed) : new Date();
    const mins = Math.round((end.getTime() - new Date(opened).getTime()) / 60_000);
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${h}h ${m}m${closed ? '' : ' (still open)'}`;
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Shifts</h1>
          <p>When each cashier clocked in and out, and what they said about
             any cash variance at close.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="admin__input" style={{ width: 200, textAlign: 'left' }}
                  value={eventId} onChange={(e) => setEventId(e.target.value)}
                  aria-label="Filter by event">
            <option value="">All events</option>
            {events.map((ev) => (
              <option key={ev.event_id} value={ev.event_id}>{ev.name}</option>
            ))}
          </select>
          {RANGES.map((r) => (
            <button key={r.label} className="till-cat" aria-pressed={hours === r.hours}
                    onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? (
        <p className="tender__hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="tender__hint">No shifts in this window.</p>
      ) : (
        <div className="admin__table-scroll">
          <table className="admin__table">
            <thead>
              <tr>
                <th>Cashier</th>
                <th>Till</th>
                <th>Event</th>
                <th>Clocked in</th>
                <th>Clocked out</th>
                <th>Duration</th>
                <th style={{ textAlign: 'right' }}>Float</th>
                <th style={{ textAlign: 'right' }}>Expected</th>
                <th style={{ textAlign: 'right' }}>Counted</th>
                <th style={{ textAlign: 'right' }}>Variance</th>
                <th>Cashier's note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.shift_id}>
                  <td>{r.cashier}</td>
                  <td>{r.device_code}</td>
                  <td>{r.event_name}</td>
                  <td>{new Date(r.opened_at).toLocaleString('en-KE', { hour12: false })}</td>
                  <td>{r.closed_at
                    ? new Date(r.closed_at).toLocaleString('en-KE', { hour12: false })
                    : <em>still open</em>}</td>
                  <td>{duration(r.opened_at, r.closed_at)}</td>
                  <td className="n">{formatKes(r.opening_float_cents as Cents, false)}</td>
                  <td className="n">{r.expected_cash_cents != null
                    ? formatKes(r.expected_cash_cents as Cents, false) : '—'}</td>
                  <td className="n">{r.counted_cash_cents != null
                    ? formatKes(r.counted_cash_cents as Cents, false) : '—'}</td>
                  <td className="n" style={r.variance_cents
                    ? { color: r.variance_cents < 0 ? 'var(--state-stop)' : 'var(--state-warn)' }
                    : undefined}>
                    {r.variance_cents != null
                      ? `${r.variance_cents > 0 ? '+' : ''}${formatKes(r.variance_cents as Cents, false)}`
                      : '—'}
                  </td>
                  <td>
                    {r.close_notes ?? (r.variance_cents ? <em>no note given</em> : '—')}
                    {r.closed_with_unresolved_doubt && (
                      <small style={{ display: 'block', color: 'var(--state-stop)' }}>
                        Closed with an unresolved sale
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
