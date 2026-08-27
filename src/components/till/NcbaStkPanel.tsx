'use client';

/**
 * NcbaStkPanel — pushing a prompt to the customer's phone.
 *
 * Replaces the Daraja C2B "wait for a payment to appear and match it" flow.
 * With NCBA the cashier drives: type the number, send the prompt, watch it
 * clear. The AccountNo carries the sale reference, so there is nothing to
 * match and no ambiguity picker.
 *
 * Two things the UI has to be honest about:
 *
 *   · The wait is bounded. A countdown, not an indefinite spinner — a cashier
 *     needs to know how long to keep standing there.
 *   · Giving up is safe. If the customer pays a moment after the cashier
 *     switches to cash, the server refuses to abandon it and the payment is
 *     still recorded for reconciliation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  initiateStk, pollStk, abandonStk, secondsRemaining,
  type StkInitiated, type PollHandle,
} from '../../lib/pos/ncbaStk';
import { formatKes, type Cents } from '../../lib/money/money';

type Phase = 'ENTRY' | 'SENDING' | 'WAITING' | 'PAID' | 'FAILED';

export interface NcbaStkPanelProps {
  supabase: SupabaseClient;
  amountDue: Cents;
  saleRef: string;
  onPaid: (mpesaTxnId: string, amount: Cents) => void;
  onCancel: () => void;
}

export function NcbaStkPanel({
  supabase, amountDue, saleRef, onPaid, onCancel,
}: NcbaStkPanelProps) {
  const [phase, setPhase] = useState<Phase>('ENTRY');
  const [phone, setPhone] = useState('');
  const [initiated, setInitiated] = useState<StkInitiated | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const pollRef = useRef<PollHandle | null>(null);

  // Whole shillings only: a rounded-down prompt leaves the sale short and the
  // shortfall surfaces at cash-up rather than at the till.
  const partShilling = amountDue % 100 !== 0;
  const validPhone = /^(0|254|\+254)?[17]\d{8}$/.test(phone.replace(/\s/g, ''));

  useEffect(() => () => pollRef.current?.cancel(), []);

  // The countdown must feel alive to a cashier standing there watching it.
  // It runs on its own 1-second clock, independent of the network poll
  // (which only checks NCBA every 4s) — otherwise the display only moves
  // in 4-second jumps, right when a request goes out.
  useEffect(() => {
    if (phase !== 'WAITING') return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const send = useCallback(async () => {
    setPhase('SENDING');
    setError(null);
    setHint(null);

    const res = await initiateStk(supabase, {
      phone, amount: amountDue, saleRef,
    });

    if (!res.ok) {
      setError(res.reason);
      setHint(res.hint ?? null);
      setPhase('FAILED');
      return;
    }

    setInitiated(res.data);
    setPhase('WAITING');

    const handle = pollStk(supabase, res.data);
    pollRef.current = handle;

    const outcome = await handle.result;
    switch (outcome.kind) {
      case 'PAID':
        setPhase('PAID');
        onPaid(outcome.mpesaTxnId, amountDue);
        break;
      case 'FAILED':
        setError(outcome.reason);
        setPhase('FAILED');
        break;
      case 'TIMEOUT': {
        // Do not assume a timeout means failure. NCBA's query can lag well
        // past two minutes even after the money has already moved (this is
        // the exact behaviour a live test surfaced). Before offering "try
        // again" or "pay another way" — either of which risks charging the
        // customer twice — check once more whether it actually landed.
        // ncba_abandon() refuses to discard anything the database already
        // has marked VERIFIED, so this is the same safety check the Cancel
        // button already relies on.
        const r = await abandonStk(supabase, outcome.providerTxnId, 'poll timed out');
        if (r === 'ALREADY_VERIFIED' && res.data) {
          setPhase('PAID');
          onPaid(res.data.mpesaTxnId, amountDue);
          break;
        }
        setError('The prompt expired without being completed.');
        setHint('Send it again, or take the payment another way.');
        setPhase('FAILED');
        break;
      }
      default:
        setError(outcome.reason);
        setPhase('FAILED');
    }
  }, [supabase, phone, amountDue, saleRef, onPaid]);

  const giveUp = async () => {
    pollRef.current?.cancel();
    if (initiated) {
      const r = await abandonStk(supabase, initiated.providerTxnId);
      if (r === 'ALREADY_VERIFIED') {
        // The customer paid while the cashier was giving up. The money moved.
        onPaid(initiated.mpesaTxnId, amountDue);
        return;
      }
    }
    onCancel();
  };

  return (
    <div className="stk">
      {phase === 'ENTRY' || phase === 'SENDING' ? (
        <>
          <p className="tender__hint">
            The customer gets a prompt on their phone for{' '}
            <strong style={{ color: 'var(--brand-mango)' }}>
              {formatKes(amountDue)}
            </strong>. They enter their M-Pesa PIN to approve.
          </p>

          {partShilling && (
            <p className="tender__error">
              M-Pesa takes whole shillings only. Take{' '}
              {formatKes((amountDue - (amountDue % 100)) as Cents)} by prompt
              and {formatKes((amountDue % 100) as Cents)} in cash.
            </p>
          )}

          <label className="boot__label" htmlFor="stk-phone">Customer&rsquo;s number</label>
          <input
            id="stk-phone"
            className="tender__input"
            inputMode="tel"
            autoComplete="off"
            placeholder="07XX XXX XXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && validPhone) void send(); }}
            disabled={phase === 'SENDING'}
          />
          {phone.length > 3 && !validPhone && (
            <p className="tender__hint">That does not look like a Kenyan mobile number.</p>
          )}

          <div className="till-actions" style={{ padding: '16px 0 0' }}>
            <button className="till-btn" onClick={onCancel} disabled={phase === 'SENDING'}>
              Back
            </button>
            <button
              className="till-btn till-btn--pay"
              style={{ gridColumn: 'auto' }}
              disabled={!validPhone || partShilling || phase === 'SENDING'}
              onClick={() => void send()}
            >
              {phase === 'SENDING' ? 'Sending…' : 'Send prompt'}
            </button>
          </div>
        </>
      ) : null}

      {phase === 'WAITING' && (
        <div className="stk__waiting">
          <div className="stk__pulse" aria-hidden="true" />
          <strong>Waiting for the customer</strong>
          <p className="tender__hint">
            A prompt for {formatKes(amountDue)} has been sent to {phone}.
            Ask them to enter their M-Pesa PIN.
          </p>
          <div className="stk__countdown">
            {secondsRemaining(elapsed)}s
          </div>
          {initiated?.accountNo && (
            <p className="tender__hint">Reference {initiated.accountNo}</p>
          )}
          <button className="till-btn" style={{ width: '100%', marginTop: 12 }}
                  onClick={() => void giveUp()}>
            Cancel and pay another way
          </button>
        </div>
      )}

      {phase === 'PAID' && (
        <div className="stk__waiting">
          <div className="stk__tick" aria-hidden="true">✓</div>
          <strong style={{ color: 'var(--ok)' }}>Payment received</strong>
          <p className="tender__hint">{formatKes(amountDue)} confirmed by NCBA.</p>
        </div>
      )}

      {phase === 'FAILED' && (
        <>
          <p className="tender__error" role="alert">{error}</p>
          {hint && <p className="tender__hint">{hint}</p>}
          <div className="till-actions" style={{ padding: '16px 0 0' }}>
            <button className="till-btn" onClick={onCancel}>Pay another way</button>
            <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                    onClick={() => { setPhase('ENTRY'); setError(null); setHint(null); }}>
              Try again
            </button>
          </div>
        </>
      )}
    </div>
  );
}