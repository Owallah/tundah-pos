'use client';

/**
 * SupervisorApproval — authority elevation at the till.
 *
 * One supervisor covers three tills, so every approval means they physically
 * walk over while a queue waits. Two consequences shape this component:
 *
 *   1. It must be FAST. Supervisor taps their name, types a PIN, done. No
 *      confirmation step, no second screen.
 *   2. It must say exactly what is being approved, in money, before the PIN
 *      is entered. A supervisor approving blind under queue pressure is how
 *      discount fraud starts.
 *
 * The PIN is verified server-side against a bcrypt hash. The roster view
 * excludes `pin_hash` entirely, so the browser never holds anything to brute
 * force. A failed attempt is written to `audit_logs`; five within five
 * minutes locks the cashier out until a supervisor unlocks them.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, bp, type Cents } from '../../lib/money/money';
import type { Authority } from '../../lib/pos/cart';

export type ApprovalKind =
  | { kind: 'DISCOUNT'; lineName: string; amount: Cents; percent: number }
  | { kind: 'PRICE_OVERRIDE'; lineName: string; listPrice: Cents; newPrice: Cents }
  | { kind: 'VOID'; localRef: string; total: Cents }
  | { kind: 'SALE_DISCOUNT'; amount: Cents; percent: number };

export interface ApprovalResult {
  approver: Authority & { name: string };
  reason: string;
}

interface RosterEntry {
  cashier_id: string;
  full_name: string;
  role: string;
  max_discount_bp: number;
  can_void: boolean;
  can_override_price: boolean;
}

export interface SupervisorApprovalProps {
  supabase: SupabaseClient;
  request: ApprovalKind;
  /** A reason is mandatory for price changes and voids; optional for discounts. */
  requireReason?: boolean;
  onApprove: (result: ApprovalResult) => void;
  onCancel: () => void;
}

export function SupervisorApproval({
  supabase, request, requireReason, onApprove, onCancel,
}: SupervisorApprovalProps) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [approverId, setApproverId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsReason = requireReason
    ?? (request.kind === 'PRICE_OVERRIDE' || request.kind === 'VOID');

  // Only staff who can actually grant THIS request are offered. Showing a
  // cashier who will be rejected server-side wastes the queue's time.
  const eligible = useMemo(
    () => roster.filter((r) => canGrant(r, request)),
    [roster, request],
  );

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('cashier_roster')
        .select('cashier_id, full_name, role, max_discount_bp, can_void, can_override_price');
      setRoster((data as RosterEntry[] | null) ?? []);
    })();
  }, [supabase]);

  const submit = async () => {
    if (!approverId) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('verify_cashier_pin', {
        p_cashier_id: approverId, p_pin: pin,
      });
      if (err) {
        throw new Error(
          err.message.includes('pin_locked')
            ? 'Locked after too many wrong attempts. Another supervisor must unlock.'
            : 'That PIN is not correct.',
        );
      }

      const who = (data as RosterEntry[])[0];
      if (!canGrant(who, request)) {
        throw new Error('That supervisor does not have authority for this.');
      }

      onApprove({
        approver: {
          cashierId: who.cashier_id,
          name: who.full_name,
          maxDiscountBp: bp(who.max_discount_bp),
          canOverridePrice: who.can_override_price,
          canVoid: who.can_void,
        },
        reason: reason.trim(),
      });
    } catch (e) {
      setError((e as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const ready = approverId
    && pin.length >= 4
    && (!needsReason || reason.trim().length > 2);

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="appr-title">
      <div className="till-block__card approval">
        <h2 className="till-block__title" id="appr-title">Supervisor approval</h2>

        {/* The request, in money, before any PIN is typed. */}
        <div className="approval__what">{describe(request)}</div>

        <label className="boot__label">Approved by</label>
        {eligible.length === 0 ? (
          <p className="tender__hint">
            Nobody on the roster has authority for this. It cannot be approved
            at the till.
          </p>
        ) : (
          <div className="boot__roster">
            {eligible.map((r) => (
              <button
                key={r.cashier_id}
                className="till-btn"
                aria-pressed={approverId === r.cashier_id}
                style={approverId === r.cashier_id
                  ? { borderColor: 'var(--state-ok)', background: 'rgba(62,207,142,.1)' }
                  : undefined}
                onClick={() => { setApproverId(r.cashier_id); setError(null); }}
              >
                {r.full_name}
                <small style={{ display: 'block', color: 'var(--till-ink-dim)', fontWeight: 500 }}>
                  {r.role.toLowerCase()}
                </small>
              </button>
            ))}
          </div>
        )}

        {needsReason && (
          <>
            <label className="boot__label" htmlFor="appr-reason">Reason</label>
            <input
              id="appr-reason"
              className="tender__input"
              style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. spilled cup, damaged stock"
              maxLength={120}
            />
            <p className="tender__hint">
              This is written to the audit log against the supervisor&rsquo;s name.
            </p>
          </>
        )}

        <label className="boot__label" htmlFor="appr-pin">Supervisor PIN</label>
        <input
          id="appr-pin"
          className="tender__input"
          type="password"
          inputMode="numeric"
          maxLength={6}
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter' && ready) void submit(); }}
          placeholder="••••••"
        />

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '18px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="till-btn till-btn--pay"
            style={{ gridColumn: 'auto' }}
            disabled={!ready || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Checking…' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Mirrors the server checks in complete_sale() and void_sale(). Filtering
 * here is a courtesy to the queue, not a security control — the database
 * rejects an unauthorised approver regardless of what the UI offered.
 */
function canGrant(r: RosterEntry, request: ApprovalKind): boolean {
  switch (request.kind) {
    case 'DISCOUNT':
    case 'SALE_DISCOUNT':
      return r.max_discount_bp >= Math.ceil(request.percent * 100);
    case 'PRICE_OVERRIDE':
      return r.can_override_price;
    case 'VOID':
      return r.can_void;
  }
}

function describe(request: ApprovalKind) {
  switch (request.kind) {
    case 'DISCOUNT':
      return (
        <>
          <span className="approval__label">Discount on {request.lineName}</span>
          <span className="approval__figure">−{formatKes(request.amount)}</span>
          <span className="approval__note">{request.percent.toFixed(1)}% off this line</span>
        </>
      );
    case 'SALE_DISCOUNT':
      return (
        <>
          <span className="approval__label">Discount on the whole sale</span>
          <span className="approval__figure">−{formatKes(request.amount)}</span>
          <span className="approval__note">{request.percent.toFixed(1)}% off the total</span>
        </>
      );
    case 'PRICE_OVERRIDE':
      return (
        <>
          <span className="approval__label">Change price of {request.lineName}</span>
          <span className="approval__figure">
            <s>{formatKes(request.listPrice)}</s> → {formatKes(request.newPrice)}
          </span>
          <span className="approval__note">
            {request.newPrice < request.listPrice ? 'Reduction' : 'Increase'} of{' '}
            {formatKes(Math.abs(request.newPrice - request.listPrice) as Cents)}
          </span>
        </>
      );
    case 'VOID':
      return (
        <>
          <span className="approval__label">Void sale {request.localRef}</span>
          <span className="approval__figure">{formatKes(request.total)}</span>
          <span className="approval__note">
            Stock is returned to the ledger. Only possible before the tax
            invoice is issued.
          </span>
        </>
      );
  }
}
