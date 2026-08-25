'use client';

/**
 * CashierSwitch — change who is on the till without closing the shift (§12).
 *
 * Three cashiers rotating across a break previously needed a full shift
 * open/close cycle each time, and every sale in between was attributed to
 * whoever opened the shift. That makes the per-cashier report meaningless
 * and, more seriously, misattributes discounts and voids in the audit log.
 *
 * The shift, its float and its cash reconciliation stay with the DEVICE.
 * Only the operator changes.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bp } from '../../lib/money/money';
import type { Authority } from '../../lib/pos/cart';

interface RosterEntry {
  cashier_id: string; full_name: string; role: string;
  max_discount_bp: number; can_void: boolean; can_override_price: boolean;
}

export type ActiveCashier = Authority & { name: string };

export function CashierSwitch({
  supabase, current, onSwitch, onCancel,
}: {
  supabase: SupabaseClient;
  current: ActiveCashier;
  onSwitch: (next: ActiveCashier) => void;
  onCancel: () => void;
}) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('cashier_roster')
        .select('cashier_id, full_name, role, max_discount_bp, can_void, can_override_price');
      setRoster((data as RosterEntry[] | null) ?? []);
    })();
  }, [supabase]);

  const others = useMemo(
    () => roster.filter((r) => r.cashier_id !== current.cashierId),
    [roster, current.cashierId],
  );

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('verify_cashier_pin', {
        p_cashier_id: selected, p_pin: pin,
      });
      if (err) {
        throw new Error(
          err.message.includes('pin_locked')
            ? 'Locked after too many wrong attempts. A supervisor must unlock.'
            : err.message.includes('invalid_pin')
              ? 'That PIN is not correct.'
              : `Could not verify PIN: ${err.message}`,
        );
      }
      const who = (data as RosterEntry[])[0];
      onSwitch({
        cashierId: who.cashier_id,
        name: who.full_name,
        maxDiscountBp: bp(who.max_discount_bp),
        canOverridePrice: who.can_override_price,
        canVoid: who.can_void,
      });
    } catch (e) {
      setError((e as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="switch-title">
      <div className="till-block__card" style={{ maxWidth: 460, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title" id="switch-title">Switch cashier</h2>
        <p className="till-block__body">
          Currently <strong>{current.name}</strong>. The shift and its cash
          float stay with this till — only the operator changes.
        </p>

        <label className="boot__label">Taking over</label>
        <div className="boot__roster">
          {others.map((r) => (
            <button
              key={r.cashier_id}
              className="till-btn"
              aria-pressed={selected === r.cashier_id}
              style={selected === r.cashier_id
                ? { borderColor: 'var(--state-ok)', background: 'rgba(62,207,142,.1)' }
                : undefined}
              onClick={() => { setSelected(r.cashier_id); setError(null); }}
            >
              {r.full_name}
            </button>
          ))}
        </div>

        <label className="boot__label" htmlFor="switch-pin">Their PIN</label>
        <input
          id="switch-pin" className="tender__input" type="password"
          inputMode="numeric" maxLength={6} autoComplete="off"
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter' && selected && pin.length >= 4) void submit(); }}
          placeholder="••••••"
        />

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '18px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!selected || pin.length < 4 || busy}
                  onClick={() => void submit()}>
            {busy ? 'Checking…' : 'Switch'}
          </button>
        </div>
      </div>
    </div>
  );
}
