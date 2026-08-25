'use client';

/**
 * SalesHistory — SAL-10 receipt reprint, plus voiding.
 *
 * A customer coming back for a receipt, a supervisor checking a disputed
 * sale, or a wrong order that needs cancelling. All three previously had no
 * screen: `void_sale` existed in the database with nothing calling it.
 *
 * Voiding is only possible BEFORE fiscalisation. Once KRA has signed an
 * invoice the correction is a credit note, because voiding would mean editing
 * an immutable fiscal record.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, type Cents } from '../../lib/money/money';
import { renderText, type ReceiptDocument } from '../../lib/receipt/document';

interface SaleRow {
  sale_id: string; local_ref: string; status: string;
  total_cents: number; occurred_at: string;
  cashier: string; device: string;
  invc_no: number | null; public_token: string | null;
  is_backfilled: boolean; payment_methods: string | null;
}

export function SalesHistory({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [receipt, setReceipt] = useState<{ text: string; row: SaleRow } | null>(null);
  const [voiding, setVoiding] = useState<SaleRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('recent_sales', { p_limit: 50 });
    if (err) setError(err.message);
    else setRows(data as SaleRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const openReceipt = async (row: SaleRow) => {
    setError(null);
    const { data, error: err } = await supabase.rpc('sale_receipt', { p_sale_id: row.sale_id });
    if (err) { setError(err.message); return; }
    setReceipt({ text: renderText(toDocument(data as RawReceipt)), row });
  };

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Sales</h1>
          <p>Last 50 sales. Reprint a receipt, or void one that has not yet
             reached KRA.</p>
        </div>
        <button className="till-btn" onClick={() => void load()}>Refresh</button>
      </header>

      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? (
        <p className="tender__hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="tender__hint">No sales yet.</p>
      ) : (
        <div className="recon">
          {rows.map((row) => (
            <div className="recon__row" key={row.sale_id}
                 data-urgent={row.status === 'VOIDED' ? 'true' : undefined}>
              <div>
                <strong>{formatKes(row.total_cents as Cents)}</strong>
                <small>
                  {row.local_ref} · {row.cashier} · {row.device} ·{' '}
                  {new Date(row.occurred_at).toLocaleString('en-KE', { hour12: false })}
                </small>
                <small>
                  {row.status === 'VOIDED' && <b style={{ color: 'var(--state-stop)' }}>VOIDED · </b>}
                  {row.invc_no
                    ? `Tax invoice ${row.invc_no}`
                    : 'Provisional — not yet fiscalised'}
                  {row.payment_methods ? ` · ${row.payment_methods.toLowerCase()}` : ''}
                  {row.is_backfilled ? ' · from paper' : ''}
                </small>
              </div>
              <div className="recon__actions">
                <button className="till-cat" onClick={() => void openReceipt(row)}>
                  Receipt
                </button>
                {row.public_token && (
                  <a className="till-cat" href={`/r/${row.public_token}`} target="_blank"
                     rel="noreferrer" style={{ display: 'grid', placeContent: 'center' }}>
                    Link
                  </a>
                )}
                {row.status === 'COMPLETED' && !row.invc_no && (
                  <button className="till-cat" onClick={() => setVoiding(row)}>Void</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {receipt && (
        <div className="till-block" role="dialog" aria-modal="true">
          <div className="till-block__card" style={{ maxWidth: 460, borderColor: 'var(--till-line)' }}>
            <h2 className="till-block__title">{receipt.row.local_ref}</h2>
            <pre className="receipt__paper">{receipt.text}</pre>
            <button className="till-btn till-btn--pay" style={{ width: '100%' }}
                    onClick={() => setReceipt(null)}>Close</button>
          </div>
        </div>
      )}

      {voiding && (
        <VoidDialog supabase={supabase} sale={voiding}
                    onDone={() => { setVoiding(null); void load(); }}
                    onCancel={() => setVoiding(null)} />
      )}
    </main>
  );
}

function VoidDialog({
  supabase, sale, onDone, onCancel,
}: {
  supabase: SupabaseClient; sale: SaleRow;
  onDone: () => void; onCancel: () => void;
}) {
  const [roster, setRoster] = useState<Array<{ cashier_id: string; full_name: string }>>([]);
  const [approver, setApprover] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.from('cashier_roster')
        .select('cashier_id, full_name, can_void').eq('can_void', true);
      setRoster((data as Array<{ cashier_id: string; full_name: string }>) ?? []);
    })();
  }, [supabase]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('void_sale', {
      p_sale_id: sale.sale_id,
      p_reason: reason.trim(),
      p_approver_cashier_id: approver,
    });
    if (err) {
      setError(err.message.includes('sale_already_fiscalised')
        ? 'This sale now has a tax invoice. Issue a credit note instead.'
        : err.message);
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <div className="till-block" role="alertdialog" aria-modal="true">
      <div className="till-block__card approval">
        <h2 className="till-block__title">Void sale</h2>
        <div className="approval__what">
          <span className="approval__label">{sale.local_ref} · {sale.cashier}</span>
          <span className="approval__figure">{formatKes(sale.total_cents as Cents)}</span>
          <span className="approval__note">
            Stock returns to the ledger as a new movement. The original
            entries are immutable and stay in the history.
          </span>
        </div>

        <label className="boot__label">Authorised by</label>
        <select className="tender__input"
                style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
                value={approver} onChange={(e) => setApprover(e.target.value)}>
          <option value="">Choose…</option>
          {roster.map((r) => (
            <option key={r.cashier_id} value={r.cashier_id}>{r.full_name}</option>
          ))}
        </select>

        <label className="boot__label">Reason</label>
        <input className="tender__input"
               style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)' }}
               value={reason} onChange={(e) => setReason(e.target.value)}
               placeholder="e.g. wrong order made" maxLength={200} />

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '18px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!approver || reason.trim().length < 3 || busy}
                  onClick={() => void submit()}>
            {busy ? 'Voiding…' : 'Void sale'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── mapping ─────────────────────────────────────────────────────────────────

interface RawReceipt {
  business: ReceiptDocument['business'];
  localRef: string; issuedAt: string; cashierName: string;
  deviceCode: string; eventName: string;
  lines: ReceiptDocument['lines'];
  subtotal: number; discountTotal: number;
  taxBands: ReceiptDocument['taxBands'];
  taxTotal: number; total: number;
  payments: Array<{ method: string; amount: number; verified: boolean; reference: string | null }>;
  changeGiven: number; isBackfilled: boolean; backfillRef: string | null;
  fiscal: null | {
    invcNo: number; curRcptNo: number; totRcptNo: number;
    intrlData: string; rcptSign: string; sdcDateTime: string; qrPayload: string | null;
  };
  publicToken: string | null;
}

function toDocument(r: RawReceipt): ReceiptDocument {
  return {
    business: r.business,
    localRef: r.localRef,
    issuedAt: new Date(r.issuedAt),
    cashierName: r.cashierName,
    deviceCode: r.deviceCode,
    eventName: r.eventName,
    lines: r.lines,
    subtotal: r.subtotal as Cents,
    discountTotal: r.discountTotal as Cents,
    taxBands: r.taxBands,
    taxTotal: r.taxTotal as Cents,
    total: r.total as Cents,
    payments: r.payments.map((p) => ({
      method: p.method, amount: p.amount as Cents,
      verified: p.verified, reference: p.reference,
    })),
    changeGiven: r.changeGiven as Cents,
    isBackfilled: r.isBackfilled,
    backfillRef: r.backfillRef,
    fiscal: r.fiscal ? {
      invcNo: r.fiscal.invcNo, curRcptNo: r.fiscal.curRcptNo,
      totRcptNo: r.fiscal.totRcptNo, intrlData: r.fiscal.intrlData,
      rcptSign: r.fiscal.rcptSign, sdcDateTime: new Date(r.fiscal.sdcDateTime),
      qrPayload: r.fiscal.qrPayload ?? undefined,
    } : undefined,
    publicUrl: r.publicToken ? `/r/${r.publicToken}` : undefined,
  };
}
