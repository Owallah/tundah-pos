'use client';

/**
 * EventManager — create, activate and close events (§15).
 *
 * Events are first-class: sales, stock, shifts and costs all hang off one.
 * Two rules the UI has to make visible rather than merely enforce:
 *
 *   - Exactly one event may be ACTIVE. Activating another stands the current
 *     one down, so the button says so before you press it.
 *   - Creating an event also creates its stock location. Forgetting that is
 *     what produces "no_event_location" at the till, mid-queue.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, type Cents } from '../../lib/money/money';

interface EventRow {
  event_id: string; name: string; venue: string | null; county: string | null;
  start_date: string; end_date: string; status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  location_id: string | null;
  sales_count: number; gross_cents: number;
  stock_at_stall: number; open_shifts: number;
}

export function EventManager({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('list_events');
    if (err) setError(err.message);
    else setRows(data as EventRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const activate = async (row: EventRow) => {
    setBusy(row.event_id);
    setError(null);
    const { error: err } = await supabase.rpc('activate_event', { p_event_id: row.event_id });
    if (err) {
      setError(err.message.includes('shifts_open_on_another_event')
        ? 'A till still has an open shift on another event. Close it first.'
        : err.message);
    } else {
      setNote(`${row.name} is now the active event.`);
      await load();
    }
    setBusy(null);
  };

  const close = async (row: EventRow) => {
    setBusy(row.event_id);
    setError(null);
    const { data, error: err } = await supabase.rpc('close_event', { p_event_id: row.event_id });
    if (err) {
      setError(err.message.includes('shifts_still_open')
        ? 'Every till must close its shift before the event can close.'
        : err.message);
    } else {
      const r = data as { stock_left_at_stall: number; gross_cents: number };
      setNote(
        `${row.name} closed. Takings ${formatKes(r.gross_cents as Cents)}.` +
        (r.stock_left_at_stall > 0
          ? ` ⚠ ${r.stock_left_at_stall} units still recorded at the stall — record a load-back.`
          : ''),
      );
      await load();
    }
    setBusy(null);
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Events</h1>
          <p>Sales, stock, shifts and costs all belong to an event. Exactly
             one can be active at a time.</p>
        </div>
        <button className="till-btn till-btn--pay" style={{ minWidth: 180 }}
                onClick={() => setCreating(true)}>
          New event
        </button>
      </header>

      {note && <p className="admin__ok" role="status">{note}</p>}
      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? <p className="tender__hint">Loading…</p> : (
        <div className="recon">
          {rows.map((row) => (
            <div className="recon__row" key={row.event_id}
                 style={row.status === 'ACTIVE'
                   ? { borderLeftColor: 'var(--state-ok)' } : undefined}>
              <div>
                <strong style={{ fontSize: 'var(--step-md)' }}>{row.name}</strong>
                <small>
                  {row.venue ? `${row.venue} · ` : ''}
                  {row.start_date}{row.end_date !== row.start_date ? ` → ${row.end_date}` : ''}
                </small>
                <small>
                  <b style={{ color: row.status === 'ACTIVE' ? 'var(--state-ok)' : undefined }}>
                    {row.status}
                  </b>
                  {' · '}{row.sales_count} sales · {formatKes(row.gross_cents as Cents, false)}
                  {row.open_shifts > 0 && ` · ${row.open_shifts} till open`}
                  {row.stock_at_stall > 0 && ` · ${row.stock_at_stall} units at stall`}
                  {!row.location_id && ' · ⚠ no stock location'}
                </small>
              </div>
              <div className="recon__actions">
                {row.status !== 'ACTIVE' && row.status !== 'CLOSED' && (
                  <button className="till-cat" disabled={busy === row.event_id}
                          onClick={() => void activate(row)}>
                    Activate
                  </button>
                )}
                {row.status === 'ACTIVE' && (
                  <button className="till-cat" disabled={busy === row.event_id}
                          onClick={() => void close(row)}>
                    Close event
                  </button>
                )}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="tender__hint">No events yet. Create one to start selling.</p>
          )}
        </div>
      )}

      {creating && (
        <NewEvent supabase={supabase}
                  onDone={() => { setCreating(false); void load(); }}
                  onCancel={() => setCreating(false)} />
      )}
    </main>
  );
}

function NewEvent({
  supabase, onDone, onCancel,
}: { supabase: SupabaseClient; onDone: () => void; onCancel: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [county, setCounty] = useState('');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [activate, setActivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('create_event', {
      p_name: name, p_venue: venue, p_county: county,
      p_start_date: start, p_end_date: end, p_activate: activate,
    });
    if (err) { setError(err.message); setBusy(false); return; }
    onDone();
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 480, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title">New event</h2>

        <label className="boot__label" htmlFor="ev-name">Name</label>
        <input id="ev-name" className="tender__input" value={name}
               style={textish} onChange={(e) => setName(e.target.value)}
               placeholder="e.g. Nairobi Food Festival" />

        <label className="boot__label" htmlFor="ev-venue">Venue</label>
        <input id="ev-venue" className="tender__input" value={venue}
               style={textish} onChange={(e) => setVenue(e.target.value)} />

        <label className="boot__label" htmlFor="ev-county">County</label>
        <input id="ev-county" className="tender__input" value={county}
               style={textish} onChange={(e) => setCounty(e.target.value)}
               placeholder="Nairobi" />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label className="boot__label" htmlFor="ev-start">Starts</label>
            <input id="ev-start" type="date" className="tender__input" style={textish}
                   value={start} onChange={(e) => { setStart(e.target.value);
                     if (end < e.target.value) setEnd(e.target.value); }} />
          </div>
          <div>
            <label className="boot__label" htmlFor="ev-end">Ends</label>
            <input id="ev-end" type="date" className="tender__input" style={textish}
                   value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <label className="boot__label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={activate}
                 onChange={(e) => setActivate(e.target.checked)}
                 style={{ width: 20, height: 20 }} />
          Make this the active event now
        </label>
        <p className="tender__hint">
          A stock location is created automatically. Without one, tills cannot
          sell.
        </p>

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '10px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create event'}
          </button>
        </div>
      </div>
    </div>
  );
}

const textish: React.CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)',
};
