'use client';

/**
 * TenderPanel — taking the money.
 *
 * Three paths, in the order they should be reached for:
 *   1. C2B    — customer already paid the Till on their own phone. The
 *               payment is on screen within ~1-2s. One tap to attach.
 *   2. Cash   — denomination buttons sized to Kenyan notes.
 *   3. Manual — customer read out a code. Trust-based, reconciled later,
 *               and visibly marked as unverified everywhere it appears.
 *
 * STK Push is deliberately NOT the default. A 30-60s round trip is
 * unworkable for a KES 250 smoothie with eight people waiting.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  addTender, removeTender, computeTotals, isPayable,
  CartError, type Cart, type Tender, type TenderMethod,
} from '../../lib/pos/cart';
import { matchC2BPayment, maskPhone, type CandidatePayment } from '../../lib/mpesa/matcher';
import { NcbaStkPanel } from './NcbaStkPanel';
import type { ApprovalKind, ApprovalResult } from './SupervisorApproval';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';

export interface TenderPanelProps {
  /** Needed for the NCBA STK flow, which calls an Edge Function. */
  supabase: SupabaseClient;
  cart: Cart;
  onCartChange: (next: Cart) => void;
  /** Unmatched C2B payments, polled or pushed via Realtime. */
  candidates: CandidatePayment[];
  tenderOpenedAt: Date;
  onComplete: () => void;
  onCancel: () => void;
  newPaymentId: () => string;
  submitting?: boolean;
  /** A reused manual code needs a supervisor's PIN before it can proceed. */
  onRequestApproval: (
    request: ApprovalKind,
    apply: (result: ApprovalResult) => void,
  ) => void;
}

/** Kenyan notes in circulation. Coins below 50 are handled by exact entry. */
const NOTES: Cents[] = [
  cents(5_000), cents(10_000), cents(20_000), cents(50_000), cents(100_000),
];

export function TenderPanel(props: TenderPanelProps) {
  const {
    supabase, cart, onCartChange, candidates, tenderOpenedAt,
    onComplete, onCancel, newPaymentId, submitting = false,
    onRequestApproval,
  } = props;

  // NCBA STK is the default: the cashier drives it and the AccountNo carries
  // the sale reference, so there is nothing to match afterwards. The old C2B
  // "wait and match" flow is kept as MPESA for a customer who pays unprompted.
  const [mode, setMode] = useState<'STK' | 'CASH' | 'MPESA' | 'MANUAL' | 'CARD'>('STK');
  const [cashInput, setCashInput] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [manualBank, setManualBank] = useState<'NCBA' | 'COOP'>('NCBA');
  const [codeCheck, setCodeCheck] = useState<
    { status: 'idle' } | { status: 'checking' } | { status: 'available' }
    | { status: 'reused'; amountCents: number; usedAt: string | null }
  >({ status: 'idle' });
  const [cardRef, setCardRef] = useState('');
  const [phoneHint, setPhoneHint] = useState('');
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(cart), [cart]);
  const due = totals.balanceDue;
  const ready = isPayable(cart);

  const match = useMemo(
    () => matchC2BPayment(candidates, {
      amountDue: due,
      tenderOpenedAt,
      phoneHint: phoneHint || undefined,
    }),
    [candidates, due, tenderOpenedAt, phoneHint],
  );

  const push = (tender: Tender) => {
    try {
      onCartChange(addTender(cart, tender));
      setError(null);
      setCashInput('');
      setManualCode('');
      setCodeCheck({ status: 'idle' });
    } catch (err) {
      setError(err instanceof CartError ? err.message : String(err));
    }
  };

  // The reused-code fraud shape: a customer shows a real M-Pesa message —
  // genuine, but from an earlier, unrelated payment. Checking the moment a
  // full code is typed catches it before the sale even completes, rather
  // than leaving it for reconciliation to notice weeks later. This is a
  // convenience check only — complete_sale() enforces the real rule
  // server-side regardless of what this says.
  useEffect(() => {
    if (!/^[A-Z0-9]{10}$/.test(manualCode)) {
      setCodeCheck({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setCodeCheck({ status: 'checking' });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { data, error: err } = await supabase.rpc('check_manual_code', {
            p_code: manualCode,
          });
          if (cancelled) return;
          if (err || !data) { setCodeCheck({ status: 'available' }); return; }
          const res = data as { status: string; amount_cents?: number; used_at?: string };
          setCodeCheck(res.status === 'ALREADY_USED'
            ? { status: 'reused', amountCents: res.amount_cents ?? 0, usedAt: res.used_at ?? null }
            : { status: 'available' });
        } catch {
          if (!cancelled) setCodeCheck({ status: 'available' });
        }
      })();
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [manualCode, supabase]);

  const takeCash = (tendered: Cents) => {
    // Cash may exceed the balance — the difference is change from the drawer.
    push({
      paymentId: newPaymentId(),
      method: 'CASH',
      amount: Math.min(tendered, due) as Cents,
      tendered,
    });
  };

  const attachC2B = (c: CandidatePayment) => {
    push({
      paymentId: newPaymentId(),
      method: 'MPESA_C2B' as TenderMethod,
      amount: Math.min(c.amount, due) as Cents,
      mpesaTxnId: c.mpesaTxnId,
      mpesaReceipt: c.receiptNumber,
    });
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="tender-title">
      <div className="till-block__card tender" style={{ maxWidth: 620, borderColor: 'var(--till-line)' }}>

        <header className="tender__head">
          <div>
            <h2 className="till-block__title" id="tender-title">Take payment</h2>
            <p style={{ margin: 0, color: 'var(--till-ink-dim)', fontSize: 'var(--step-sm)' }}>
              {cart.localRef} · {totals.itemCount} {totals.itemCount === 1 ? 'line' : 'lines'}
            </p>
          </div>
          <div className="tender__due">
            <span className="till-total__label">{due > 0 ? 'Balance due' : 'Paid in full'}</span>
            <span className="till-total__value" style={{ fontSize: 'var(--step-xl)' }}>
              {formatKes(due > 0 ? due : totals.total, false)}
            </span>
          </div>
        </header>

        {cart.tenders.length > 0 && (
          <ul className="tender__taken">
            {cart.tenders.map((t) => (
              <li key={t.paymentId}>
                <span>{t.method.replace(/_/g, ' ')}</span>
                {t.mpesaReceipt && <code>{t.mpesaReceipt}</code>}
                <b>{formatKes(t.amount, false)}</b>
                <button
                  onClick={() => onCartChange(removeTender(cart, t.paymentId))}
                  aria-label="Remove this payment"
                  disabled={submitting}
                >
                  ×
                </button>
              </li>
            ))}
            {totals.changeDue > 0 && (
              <li className="tender__change">
                <span>Change to give</span>
                <b>{formatKes(totals.changeDue, false)}</b>
              </li>
            )}
          </ul>
        )}

        {due > 0 && (
          <>
            <div className="tender__modes" role="tablist">
              {(['STK', 'CASH', 'MPESA', 'MANUAL', 'CARD'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className="till-cat"
                  onClick={() => { setMode(m); setError(null); }}
                >
                  {m === 'STK' ? 'Send prompt'
                   : m === 'CASH' ? 'Cash'
                   : m === 'MPESA' ? 'Already paid'
                   : m === 'CARD' ? 'Card'
                   : 'Enter code'}
                </button>
              ))}
            </div>

            {error && <p className="tender__error" role="alert">{error}</p>}

            {mode === 'STK' && (
              <div className="tender__body">
                <NcbaStkPanel
                  supabase={supabase}
                  amountDue={due}
                  saleRef={cart.localRef}
                  onPaid={(mpesaTxnId, amount) => push({
                    paymentId: newPaymentId(),
                    method: 'MPESA_STK',
                    amount,
                    mpesaTxnId,
                  })}
                  onCancel={() => setMode('CASH')}
                />
              </div>
            )}

            {mode === 'CASH' && (
              <div className="tender__body">
                <div className="tender__notes">
                  <button className="till-btn" onClick={() => takeCash(due)}>
                    Exact<br /><small>{formatKes(due, false)}</small>
                  </button>
                  {NOTES.filter((n) => n >= due).slice(0, 4).map((n) => (
                    <button key={n} className="till-btn" onClick={() => takeCash(n)}>
                      {formatKes(n, false)}
                    </button>
                  ))}
                </div>
                <div className="tender__row">
                  <input
                    className="tender__input"
                    inputMode="decimal"
                    placeholder="Other amount"
                    value={cashInput}
                    onChange={(e) => setCashInput(e.target.value)}
                    aria-label="Cash amount received"
                  />
                  <button
                    className="till-btn"
                    disabled={!cashInput.trim()}
                    onClick={() => {
                      try { takeCash(parseKes(cashInput)); }
                      catch { setError('Enter an amount like 250 or 250.50'); }
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            {mode === 'MPESA' && (
              <div className="tender__body">
                {candidates.length === 0 ? (
                  <p className="tender__hint">
                    Waiting for payment. Ask the customer to pay the till number —
                    it appears here within a couple of seconds.
                  </p>
                ) : (
                  <>
                    {match.ambiguous && (
                      <p className="tender__hint" role="status">
                        More than one payment matches. Ask the customer for the last
                        three digits of their number, or pick from the list.
                      </p>
                    )}
                    {match.ambiguous && (
                      <input
                        className="tender__input"
                        inputMode="numeric"
                        maxLength={4}
                        placeholder="Last 3 digits"
                        value={phoneHint}
                        onChange={(e) => setPhoneHint(e.target.value)}
                        aria-label="Last digits of customer phone number"
                      />
                    )}
                    <ul className="tender__matches">
                      {match.candidates.map((s) => {
                        const isBest = match.confident?.candidate.mpesaTxnId
                          === s.candidate.mpesaTxnId;
                        return (
                          <li key={s.candidate.mpesaTxnId}>
                            <button
                              className={`tender__match${isBest ? ' is-best' : ''}`}
                              onClick={() => attachC2B(s.candidate)}
                              disabled={submitting}
                            >
                              <span className="tender__match-amt">
                                {formatKes(s.candidate.amount, false)}
                              </span>
                              <span className="tender__match-who">
                                {s.candidate.payerName ?? 'Unknown'} ·{' '}
                                {maskPhone(s.candidate.phoneNumber)}
                              </span>
                              <span className="tender__match-why">
                                {s.reasons.join(' · ')}
                              </span>
                              <code>{s.candidate.receiptNumber}</code>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}

            {mode === 'MANUAL' && (
              <div className="tender__body">
                <p className="tender__hint">
                  Only when the payment has not appeared. This is recorded as
                  unverified and checked against the statement later.
                </p>
                <div className="tender__row" style={{ marginBottom: 8 }}>
                  <select className="tender__input"
                          value={manualBank}
                          onChange={(e) => setManualBank(e.target.value as 'NCBA' | 'COOP')}
                          aria-label="Which paybill this code is for">
                    <option value="NCBA">NCBA Till</option>
                    <option value="COOP">Co-op Paybill</option>
                  </select>
                </div>
                <div className="tender__row">
                  <input
                    className="tender__input"
                    placeholder="M-Pesa code, e.g. SLK7XU9P2Q"
                    value={manualCode}
                    onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                    maxLength={12}
                    aria-label="M-Pesa confirmation code"
                  />
                  <button
                    className="till-btn"
                    disabled={!/^[A-Z0-9]{10}$/.test(manualCode)
                      || codeCheck.status === 'checking'}
                    onClick={() => {
                      if (codeCheck.status === 'reused') {
                        onRequestApproval(
                          { kind: 'REUSED_MPESA_CODE', code: manualCode, amount: due },
                          (result) => push({
                            paymentId: newPaymentId(),
                            method: 'MPESA_MANUAL',
                            amount: due,
                            mpesaReceipt: manualCode,
                            manualBank,
                            approvedByCashierId: result.approver.cashierId,
                            overrideReason: result.reason,
                          }),
                        );
                        return;
                      }
                      push({
                        paymentId: newPaymentId(),
                        method: 'MPESA_MANUAL',
                        amount: due,
                        mpesaReceipt: manualCode,
                        manualBank,
                      });
                    }}
                  >
                    {codeCheck.status === 'reused'
                      ? 'Needs supervisor approval'
                      : `Add ${formatKes(due, false)}`}
                  </button>
                </div>
                {manualCode.length > 0 && !/^[A-Z0-9]{10}$/.test(manualCode) && (
                  <p className="tender__hint">M-Pesa codes are 10 letters and numbers.</p>
                )}
                {codeCheck.status === 'reused' && (
                  <p className="tender__error" role="alert">
                    This code was already used for a payment of{' '}
                    {formatKes(codeCheck.amountCents as Cents, false)}
                    {codeCheck.usedAt
                      ? ` on ${new Date(codeCheck.usedAt).toLocaleString('en-KE', { hour12: false })}`
                      : ''}.
                    Do not accept it again without checking with the customer
                    directly — a supervisor must approve before this can proceed.
                  </p>
                )}
              </div>
            )}

            {mode === 'CARD' && (
              <div className="tender__body">
                <p className="tender__hint">
                  Co-op Bank PDQ terminal. Enter the reference printed on the slip.
                </p>
                <div className="tender__row">
                  <input
                    className="tender__input"
                    placeholder="PDQ slip reference"
                    value={cardRef}
                    onChange={(e) => setCardRef(e.target.value.toUpperCase())}
                    aria-label="Card terminal slip reference"
                  />
                  <button
                    className="till-btn"
                    disabled={!cardRef.trim()}
                    onClick={() => push({
                      paymentId: newPaymentId(),
                      method: 'CARD',
                      amount: due,
                      cardReference: cardRef.trim(),
                    })}
                  >
                    Add {formatKes(due, false)}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <div className="till-actions" style={{ padding: '18px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={submitting}>
            Back to sale
          </button>
          <button
            className="till-btn"
            disabled={cart.tenders.length === 0 || submitting}
            onClick={() => cart.tenders.forEach((t) =>
              onCartChange(removeTender(cart, t.paymentId)))}
          >
            Clear payments
          </button>
          <button
            className="till-btn till-btn--pay"
            disabled={!ready || submitting}
            onClick={onComplete}
          >
            {submitting ? 'Completing…' : ready
              ? `Complete · ${formatKes(totals.total, false)}`
              : `${formatKes(due, false)} still due`}
          </button>
        </div>
      </div>
    </div>
  );
}