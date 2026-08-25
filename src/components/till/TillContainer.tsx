'use client';

/**
 * TillContainer — the orchestration layer.
 *
 * Owns: catalogue loading, cart state, network health, C2B candidate polling,
 * submission, and what the cashier sees after a sale.
 *
 * Owns NO money logic. Every total comes from cart.ts; every decision about
 * retry and doubt comes from submit.ts. This file wires them and renders.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TillScreen } from './TillScreen';
import { TenderPanel } from './TenderPanel';
import { ReceiptView } from './ReceiptView';
import { LineActions } from './LineActions';
import { ShiftClose } from './ShiftClose';
import {
  SupervisorApproval, type ApprovalKind, type ApprovalResult,
} from './SupervisorApproval';
import { useNetworkHealth } from '../../hooks/useNetworkHealth';
import {
  emptyCart, type Cart, type CatalogueItem, type Authority,
} from '../../lib/pos/cart';
import {
  submitSale, resolveDoubtfulSale, createBrowserDoubtStorage,
  type SubmitOutcome, type DoubtRecord,
} from '../../lib/pos/submit';
import { toSalePayload } from '../../lib/pos/cart';
import { buildReceipt } from '../../lib/receipt/build';
import type { ReceiptDocument, ReceiptBusiness } from '../../lib/receipt/document';
import type { CandidatePayment } from '../../lib/mpesa/matcher';
import { cents, type Cents } from '../../lib/money/money';
import { toCatalogue, type EventPriceRow } from '../../lib/pos/catalogue';

export interface TillSession {
  shiftId: string;
  eventId: string;
  eventName: string;
  deviceCode: string;
  cashier: Authority & { name: string };
  business: ReceiptBusiness;
  /** Monotonic per-device counter, persisted server-side at shift open. */
  nextSequence: number;
}

export interface TillContainerProps {
  supabase: SupabaseClient;
  session: TillSession;
}

type Stage = 'SELLING' | 'TENDER' | 'RECEIPT' | 'CLOSING';

const C2B_POLL_MS = 3_000;

export function TillContainer({ supabase, session }: TillContainerProps) {
  const storage = useMemo(() => createBrowserDoubtStorage(), []);
  const network = useNetworkHealth(supabase);

  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);
  const [sequence, setSequence] = useState(session.nextSequence);
  const [cart, setCart] = useState<Cart>(() => newCart(session, session.nextSequence));
  const [stage, setStage] = useState<Stage>('SELLING');
  const [tenderOpenedAt, setTenderOpenedAt] = useState(new Date());
  const [candidates, setCandidates] = useState<CandidatePayment[]>([]);
  const [doubtful, setDoubtful] = useState<DoubtRecord[]>([]);
  const [receipt, setReceipt] = useState<ReceiptDocument | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  // An approval request carries its own apply() callback, so the container
  // never needs to know what is being approved -- only that someone did.
  const [approval, setApproval] = useState<
    { request: ApprovalKind; apply: (r: ApprovalResult) => void } | null
  >(null);

  // ── Catalogue: fetched once per shift, then held in memory. Scanning,
  //    search and pricing never touch the network. ARCHITECTURE §C.2.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error: err } = await supabase.rpc('event_price_list', {
        p_event_id: session.eventId,
      });
      if (cancelled) return;
      if (err) { setError(`Could not load products: ${err.message}`); return; }
      setCatalogue(toCatalogue(data as EventPriceRow[] | null));
    })();
    return () => { cancelled = true; };
  }, [supabase, session.eventId]);

  // ── Recover anything left in doubt by a previous connection drop. This
  //    runs on every boot, so a laptop restarted mid-sale surfaces it at once.
  useEffect(() => {
    setDoubtful(storage.list());
  }, [storage]);

  useEffect(() => {
    if (network.state === 'online' && doubtful.length > 0) {
      void handleResolveDoubt(doubtful[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network.state]);

  // ── Unmatched C2B payments, while the tender panel is open. Realtime is
  //    the primary channel; this poll is the fallback when the socket drops.
  useEffect(() => {
    if (stage !== 'TENDER') return;

    const load = async () => {
      const { data } = await supabase.rpc('unmatched_mpesa', { p_since_minutes: 15 });
      setCandidates((data as RawMpesaRow[] | null)?.map(toCandidate) ?? []);
    };

    void load();
    const timer = setInterval(() => void load(), C2B_POLL_MS);

    const channel = supabase
      .channel('mpesa-inbox')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'mpesa_transactions' },
        () => void load())
      .subscribe();

    return () => {
      clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [stage, supabase]);

  // ── Submission ────────────────────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    setSubmitting(true);
    setError(null);

    const payload = toSalePayload(cart, {
      shiftId: session.shiftId,
      cashierId: session.cashier.cashierId,
      // Deterministic, not random: a retry after an ambiguous timeout must
      // produce the SAME key or it double-writes. ARCHITECTURE §C.4.
      idempotencyKey: `${session.deviceCode}:sale:${cart.saleId}`,
      occurredAt: new Date(),
    });

    const outcome = await submitSale(payload as Record<string, unknown>, {
      rpc: async (fn, args) => {
        const { data, error: err } = await supabase.rpc(fn, args);
        if (err) throw err;
        return data;
      },
      storage,
    });

    setSubmitting(false);
    applyOutcome(outcome);
  }, [cart, session, supabase, storage]);

  const applyOutcome = (outcome: SubmitOutcome) => {
    switch (outcome.kind) {
      case 'COMPLETED':
      case 'ALREADY_COMPLETED': {
        setReceipt(buildReceipt(cart, {
          business: session.business,
          cashierName: session.cashier.name,
          deviceCode: session.deviceCode,
          eventName: session.eventName,
          issuedAt: new Date(),
          // No fiscal block yet — KRA has not signed. The receipt is
          // PROVISIONAL and says so. It upgrades in place once the queue
          // drains, usually within seconds.
        }));
        setStage('RECEIPT');
        break;
      }
      case 'REJECTED':
        setError(outcome.message);
        setStage('TENDER');
        break;
      case 'IN_DOUBT':
        setDoubtful(storage.list());
        setStage('SELLING');
        break;
    }
  };

  const handleResolveDoubt = useCallback(async (record: DoubtRecord) => {
    const outcome = await resolveDoubtfulSale(record, {
      rpc: async (fn, args) => {
        const { data, error: err } = await supabase.rpc(fn, args);
        if (err) throw err;
        return data;
      },
      storage,
    });
    setDoubtful(storage.list());
    if (outcome.kind === 'ALREADY_COMPLETED' || outcome.kind === 'COMPLETED') {
      startNextSale();
    }
  }, [supabase, storage]);

  const startNextSale = useCallback(() => {
    const next = sequence + 1;
    setSequence(next);
    setCart(newCart(session, next));
    setCandidates([]);
    setReceipt(null);
    setError(null);
    setStage('SELLING');
  }, [sequence, session]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <TillScreen
        catalogue={catalogue}
        cart={cart}
        onCartChange={setCart}
        network={network.state}
        cashier={session.cashier}
        deviceCode={session.deviceCode}
        eventName={session.eventName}
        doubtful={doubtful}
        onEditLine={setEditingLineId}
        onCloseShift={() => setStage('CLOSING')}
        onOpenTender={() => { setTenderOpenedAt(new Date()); setStage('TENDER'); }}
        onPark={() => void parkSale(supabase, cart, session).then(startNextSale)}
        onResolveDoubt={(r) => void handleResolveDoubt(r)}
        newLineId={() => crypto.randomUUID()}
      />

      {editingLineId && (() => {
        const line = cart.lines.find((l) => l.lineId === editingLineId);
        if (!line) return null;
        return (
          <LineActions
            cart={cart}
            line={line}
            cashier={session.cashier}
            onCartChange={setCart}
            onRequestApproval={(request, apply) => setApproval({ request, apply })}
            onClose={() => setEditingLineId(null)}
          />
        );
      })()}

      {approval && (
        <SupervisorApproval
          supabase={supabase}
          request={approval.request}
          onApprove={(result) => { approval.apply(result); setApproval(null); }}
          onCancel={() => setApproval(null)}
        />
      )}

      {stage === 'TENDER' && (
        <TenderPanel
          cart={cart}
          onCartChange={setCart}
          candidates={candidates}
          tenderOpenedAt={tenderOpenedAt}
          submitting={submitting}
          onComplete={() => void handleComplete()}
          onCancel={() => setStage('SELLING')}
          newPaymentId={() => crypto.randomUUID()}
        />
      )}

      {stage === 'CLOSING' && (
        <ShiftClose
          supabase={supabase}
          shiftId={session.shiftId}
          onCancel={() => setStage('SELLING')}
          onClosed={() => { window.location.reload(); }}
        />
      )}

      {stage === 'RECEIPT' && receipt && (
        <ReceiptView doc={receipt} onDone={startNextSale} />
      )}

      {error && stage !== 'TENDER' && (
        <p role="alert" className="till-toast">{error}</p>
      )}
    </>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function newCart(session: TillSession, sequence: number): Cart {
  return emptyCart(
    crypto.randomUUID(),
    `${session.deviceCode}-${String(sequence).padStart(6, '0')}`,
    new Date(),
  );
}

async function parkSale(supabase: SupabaseClient, cart: Cart, session: TillSession) {
  if (cart.lines.length === 0) return;
  await supabase.from('parked_sales').insert({
    device_id: undefined,           // stamped from the JWT by RLS check
    shift_id: session.shiftId,
    cashier_id: session.cashier.cashierId,
    label: cart.localRef,
    cart: cart as unknown as Record<string, unknown>,
  });
}

interface RawMpesaRow {
  mpesa_txn_id: string; receipt_number: string; amount_cents: number;
  phone_number: string | null; payer_name: string | null; confirmed_at: string;
}

function toCandidate(r: RawMpesaRow): CandidatePayment {
  return {
    mpesaTxnId: r.mpesa_txn_id,
    receiptNumber: r.receipt_number,
    amount: cents(r.amount_cents) as Cents,
    phoneNumber: r.phone_number,
    payerName: r.payer_name,
    confirmedAt: new Date(r.confirmed_at),
    matched: false,
  };
}
