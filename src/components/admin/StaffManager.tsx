'use client';

/**
 * StaffManager — cashiers, PINs and authority (§12).
 *
 * PINs are never displayed or retrievable; they are hashed server-side and
 * the roster view excludes the hash entirely. This screen can only SET a new
 * one, never read the old one.
 *
 * The discount limit deserves thought rather than a default. One supervisor
 * covers three tills, so every approval means them walking over while a queue
 * waits. Set it high enough that routine goodwill — a squashed cup, a
 * short-poured smoothie — stays within cashier authority.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

interface CashierRow {
  cashier_id: string; full_name: string; role: string;
  max_discount_bp: number; can_void: boolean; can_override_price: boolean;
  is_active: boolean; recent_failures: number; is_locked: boolean;
  sales_today: number;
}

export function StaffManager({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<CashierRow[]>([]);
  const [editing, setEditing] = useState<CashierRow | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('list_cashiers');
    if (err) setError(err.message);
    else setRows(data as CashierRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const unlock = async (row: CashierRow) => {
    const { error: err } = await supabase.rpc('unlock_cashier', {
      p_cashier_id: row.cashier_id,
    });
    if (err) setError(err.message);
    else { setNote(`${row.full_name} unlocked.`); await load(); }
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Staff</h1>
          <p>Cashiers sign in at the till with a PIN. PINs are hashed and
             cannot be read back — only replaced.</p>
        </div>
        <button className="till-btn till-btn--pay" style={{ minWidth: 180 }}
                onClick={() => setEditing('new')}>
          Add cashier
        </button>
      </header>

      {note && <p className="admin__ok" role="status">{note}</p>}
      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? <p className="tender__hint">Loading…</p> : (
        <div className="recon">
          {rows.map((row) => (
            <div className="recon__row" key={row.cashier_id}
                 data-urgent={row.is_locked ? 'true' : undefined}
                 style={!row.is_active ? { opacity: 0.5 } : undefined}>
              <div>
                <strong style={{ fontSize: 'var(--step-md)' }}>{row.full_name}</strong>
                <small>
                  {row.role.toLowerCase()}
                  {' · '}discount up to {(row.max_discount_bp / 100).toFixed(0)}%
                  {row.can_override_price && ' · can change prices'}
                  {row.can_void && ' · can void'}
                  {!row.is_active && ' · INACTIVE'}
                </small>
                <small>
                  {row.sales_today} sales today
                  {row.is_locked
                    ? <b style={{ color: 'var(--state-stop)' }}> · LOCKED after {row.recent_failures} failed PINs</b>
                    : row.recent_failures > 0 && ` · ${row.recent_failures} recent failed PINs`}
                </small>
              </div>
              <div className="recon__actions">
                {row.is_locked && (
                  <button className="till-cat" onClick={() => void unlock(row)}>Unlock</button>
                )}
                <button className="till-cat" onClick={() => setEditing(row)}>Edit</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <StaffForm supabase={supabase}
                   cashier={editing === 'new' ? null : editing}
                   onDone={() => { setEditing(null); void load(); }}
                   onCancel={() => setEditing(null)} />
      )}
    </main>
  );
}

function StaffForm({
  supabase, cashier, onDone, onCancel,
}: {
  supabase: SupabaseClient; cashier: CashierRow | null;
  onDone: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(cashier?.full_name ?? '');
  const [role, setRole] = useState(cashier?.role ?? 'CASHIER');
  const [discountPct, setDiscountPct] = useState(
    String((cashier?.max_discount_bp ?? 1000) / 100));
  const [canVoid, setCanVoid] = useState(cashier?.can_void ?? false);
  const [canOverride, setCanOverride] = useState(cashier?.can_override_price ?? false);
  const [isActive, setIsActive] = useState(cashier?.is_active ?? true);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('upsert_cashier', {
      p_cashier_id: cashier?.cashier_id ?? null,
      p_full_name: name,
      p_role: role,
      p_max_discount_bp: Math.round(Number(discountPct) * 100),
      p_can_void: canVoid,
      p_can_override_price: canOverride,
      p_is_active: isActive,
      p_pin: pin || null,
    });
    if (err) { setError(err.message); setBusy(false); return; }
    onDone();
  };

  const pinValid = pin === '' || /^[0-9]{4,6}$/.test(pin);
  const ready = name.trim() && pinValid && (cashier || pin.length >= 4);

  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 480, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title">{cashier ? cashier.full_name : 'Add cashier'}</h2>

        <label className="boot__label" htmlFor="s-name">Name</label>
        <input id="s-name" className="tender__input" style={textish}
               value={name} onChange={(e) => setName(e.target.value)} />

        <label className="boot__label" htmlFor="s-role">Role</label>
        <select id="s-role" className="tender__input" style={textish}
                value={role} onChange={(e) => {
                  setRole(e.target.value);
                  // Supervisors need both powers; that is the point of them.
                  if (e.target.value !== 'CASHIER') {
                    setCanVoid(true); setCanOverride(true);
                  }
                }}>
          <option value="CASHIER">Cashier</option>
          <option value="SUPERVISOR">Supervisor</option>
          <option value="OWNER">Owner</option>
        </select>

        <label className="boot__label" htmlFor="s-disc">Discount limit (%)</label>
        <input id="s-disc" className="tender__input" inputMode="decimal"
               value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
        <p className="tender__hint">
          Above this, a supervisor must walk over and approve. With one
          supervisor across three tills, too low makes them the bottleneck at
          peak trade — 10% is a reasonable starting point for a cashier.
        </p>

        <div style={{ display: 'flex', gap: 20, margin: '14px 0', flexWrap: 'wrap' }}>
          <label style={checkbox}>
            <input type="checkbox" checked={canVoid} style={box}
                   onChange={(e) => setCanVoid(e.target.checked)} />
            Can void sales
          </label>
          <label style={checkbox}>
            <input type="checkbox" checked={canOverride} style={box}
                   onChange={(e) => setCanOverride(e.target.checked)} />
            Can change prices
          </label>
          <label style={checkbox}>
            <input type="checkbox" checked={isActive} style={box}
                   onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        <label className="boot__label" htmlFor="s-pin">
          {cashier ? 'New PIN (leave blank to keep the current one)' : 'PIN'}
        </label>
        <input id="s-pin" className="tender__input" type="password"
               inputMode="numeric" maxLength={6} autoComplete="new-password"
               value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
               placeholder="4 to 6 digits" />
        {!pinValid && <p className="tender__error">PIN must be 4 to 6 digits.</p>}

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '16px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const textish: React.CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)',
};
const checkbox: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  color: 'var(--till-ink-dim)', fontSize: 'var(--step-sm)',
};
const box: React.CSSProperties = { width: 20, height: 20 };
