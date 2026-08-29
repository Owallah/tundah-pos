'use client';

/**
 * TillBoot — shift gate.
 *
 * A till cannot sell without an open shift, so this is the first thing a
 * cashier sees each day: pick yourself, enter your PIN, count the float.
 * Once open, it hands off to TillContainer and stays out of the way.
 */

import { useEffect, useMemo, useState } from 'react';
import { browserClient, type TillClaims } from '../../lib/supabase/clients';
import { TillContainer, type TillSession } from './TillContainer';
import type { ReceiptBusiness } from '../../lib/receipt/document';
import { parseKes, formatKes, cents } from '../../lib/money/money';
import { bp } from '../../lib/money/money';

interface RosterEntry {
  cashier_id: string; full_name: string; role: string;
  max_discount_bp: number; can_void: boolean; can_override_price: boolean;
}

interface BusinessRow {
  legal_name: string; trading_name: string | null; kra_pin: string;
  address: string | null; phone: string | null; vat_registered: boolean;
}

export function TillBoot({
  claims, business, openShiftId,
}: {
  claims: TillClaims;
  business: BusinessRow | null;
  openShiftId: string | null;
}) {
  const supabase = useMemo(() => browserClient(), []);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [cashierId, setCashierId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [float, setFloat] = useState('0');
  const [session, setSession] = useState<TillSession | null>(null);
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

  const start = async () => {
    if (!cashierId) return;
    setBusy(true);
    setError(null);
    try {
      // PIN is verified server-side against a bcrypt hash. The hash never
      // reaches the browser, and the roster view excludes it entirely.
      const { data: verified, error: pinErr } = await supabase.rpc('verify_cashier_pin', {
        p_cashier_id: cashierId, p_pin: pin,
      });
      // Do NOT collapse every failure into "wrong PIN". A setup problem —
      // missing JWT claims, unreachable pgcrypto — then wears a wrong-PIN
      // mask and is very hard to diagnose from the till.
      if (pinErr) throw new Error(pinMessage(pinErr.message));

      const who = (verified as RosterEntry[])[0];

      let shiftId = openShiftId;
      let eventName = '';
      let eventId = '';

      if (!shiftId) {
        const { data: opened, error: shiftErr } = await supabase.rpc('open_shift', {
          p_cashier_id: cashierId,
          p_opening_float_cents: parseKes(float || '0'),
        });
        if (shiftErr) throw new Error(
          shiftErr.message.includes('no_active_event')
            ? 'No event is active. A supervisor must activate one before selling.'
            : shiftErr.message,
        );
        const o = opened as { shift_id: string; event_id: string; event_name: string };
        shiftId = o.shift_id; eventId = o.event_id; eventName = o.event_name;
      } else {
        const { data: rep } = await supabase.rpc('shift_report', { p_shift_id: shiftId });
        const r = rep as { event: string };
        eventName = r?.event ?? '';
        const { data: sh } = await supabase
          .from('shifts').select('event_id').eq('shift_id', shiftId).single();
        eventId = (sh as { event_id: string }).event_id;
      }

      const { count } = await supabase
        .from('sales')
        .select('sale_id', { head: true, count: 'exact' })
        .eq('device_id', claims.deviceId!);

      setSession({
        shiftId: shiftId!,
        eventId,
        eventName,
        deviceCode: claims.deviceCode ?? 'TILL',
        businessId: claims.businessId,
        deviceId: claims.deviceId!,
        cashier: {
          cashierId: who.cashier_id,
          name: who.full_name,
          maxDiscountBp: bp(who.max_discount_bp),
          canOverridePrice: who.can_override_price,
          canVoid: who.can_void,
        },
        business: business ? {
          legalName: business.legal_name,
          tradingName: business.trading_name,
          kraPin: business.kra_pin,
          address: business.address,
          phone: business.phone,
          vatRegistered: business.vat_registered,
        } as ReceiptBusiness : {
          legalName: 'Unknown', kraPin: '', vatRegistered: false,
        } as ReceiptBusiness,
        nextSequence: (count ?? 0) + 1,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPin('');
    }
  };

  if (session) return <TillContainer supabase={supabase} session={session} />;

  return (
    <main className="boot">
      <div className="boot__card">
        <h1 className="boot__title">
          {openShiftId ? 'Resume shift' : 'Start shift'}
          <small>{claims.deviceCode}</small>
        </h1>

        <label className="boot__label">Who is on this till?</label>
        <div className="boot__roster">
          {roster.map((c) => (
            <button
              key={c.cashier_id}
              className="till-btn"
              aria-pressed={cashierId === c.cashier_id}
              style={cashierId === c.cashier_id
                ? { borderColor: 'var(--state-ok)', background: 'rgba(62,207,142,.1)' }
                : undefined}
              onClick={() => { setCashierId(c.cashier_id); setError(null); }}
            >
              {c.full_name}
            </button>
          ))}
          {roster.length === 0 && (
            <p className="tender__hint">
              No cashiers set up yet. A supervisor adds them under Staff.
            </p>
          )}
        </div>

        <label className="boot__label" htmlFor="pin">PIN</label>
        <input
          id="pin" className="tender__input" type="password"
          inputMode="numeric" maxLength={6} value={pin} autoComplete="off"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="••••••"
        />

        {!openShiftId && (
          <>
            <label className="boot__label" htmlFor="float">Opening cash float</label>
            <input
              id="float" className="tender__input" inputMode="decimal"
              value={float} onChange={(e) => setFloat(e.target.value)}
            />
            <p className="tender__hint">
              Count the drawer now. The Z report compares this against cash taken.
            </p>
          </>
        )}

        {error && <p className="tender__error" role="alert">{error}</p>}

        <button
          className="till-btn till-btn--pay"
          style={{ width: '100%', marginTop: 8 }}
          disabled={!cashierId || pin.length < 4 || busy}
          onClick={() => void start()}
        >
          {busy ? 'Checking…' : openShiftId ? 'Resume' : `Open shift · ${safeFloat(float)}`}
        </button>

        {/* Setup escape hatch: re-point this machine at a different till. */}
        <button
          className="till-cat"
          style={{ width: '100%', marginTop: 10, minHeight: 44 }}
          onClick={() => void supabase.auth.signOut().then(() => {
            window.location.href = '/login';
          })}
        >
          Sign out ({claims.deviceCode})
        </button>
      </div>
    </main>
  );
}

/** Map database errors to something a person can act on. */
function pinMessage(raw: string): string {
  if (raw.includes('pin_locked')) {
    return 'Too many wrong attempts. A supervisor must unlock this cashier.';
  }
  if (raw.includes('invalid_pin')) {
    return 'That PIN is not correct.';
  }
  if (raw.includes('cashier_not_found_for_business')) {
    return 'This till cannot see that cashier. The sign-in token is missing '
         + 'business details — check the Custom Access Token hook in Supabase.';
  }
  if (raw.includes('crypt') && raw.includes('does not exist')) {
    return 'Setup problem: pgcrypto is not reachable from this function. '
         + 'Apply migration 0013_fix_pgcrypto_search_path.sql.';
  }
  if (raw.includes('permission denied') || raw.includes('42501')) {
    return `Permission denied verifying the PIN. ${raw}`;
  }
  // Anything unrecognised is shown verbatim rather than guessed at.
  return `Could not verify PIN: ${raw}`;
}

function safeFloat(v: string): string {
  try { return formatKes(parseKes(v || '0')); } catch { return 'KES 0.00'; }
}
