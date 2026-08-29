'use client';

/**
 * ReceiptView — what the cashier sees the instant the sale completes.
 *
 * The receipt is PROVISIONAL here by definition: KRA has not signed yet.
 * Normally it becomes a tax invoice within seconds, but the customer must
 * never be shown a fabricated signature, so the state is stated plainly.
 *
 * PDF is generated in the browser. That keeps serverless invocations (and
 * cost) at zero, and it means the download works the moment the sale lands.
 */

import { useMemo, useState } from 'react';
import { renderText, isFiscal, type ReceiptDocument } from '../../lib/receipt/document';
import { formatKes } from '../../lib/money/money';

export function ReceiptView({
  doc, onDone,
}: { doc: ReceiptDocument; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const text = useMemo(() => renderText(doc), [doc]);
  const fiscal = isFiscal(doc);

  const print = async () => {
    setPrinting(true);
    try {
      const { printReceipt } = await import('../../lib/receipt/print');
      await printReceipt(doc);
    } finally {
      setPrinting(false);
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const { pdfFromReceipt } = await import('../../lib/receipt/pdf');
      const bytes = await pdfFromReceipt(doc);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fiscal ? 'invoice' : 'receipt'}-${doc.localRef}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!doc.publicUrl) return;
    const payload = {
      title: fiscal ? 'Tax invoice' : 'Receipt',
      text: `${doc.business.tradingName ?? doc.business.legalName} — ${formatKes(doc.total)}`,
      url: doc.publicUrl,
    };
    if (navigator.share) await navigator.share(payload);
    else await navigator.clipboard.writeText(doc.publicUrl);
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true" aria-labelledby="rcpt-title">
      <div className="till-block__card receipt" style={{ borderColor: 'var(--state-ok)' }}>
        <h2 className="till-block__title" id="rcpt-title">Sale complete</h2>
        <div className="till-block__amount">{formatKes(doc.total)}</div>
        {doc.changeGiven > 0 && (
          <p className="receipt__change">
            Change to give: <strong>{formatKes(doc.changeGiven)}</strong>
          </p>
        )}

        <pre className="receipt__paper">{text}</pre>

        <div className="receipt__actions">
          <button className="till-btn till-btn--pay" onClick={() => void print()} disabled={printing}>
            {printing ? 'Sending to printer…' : 'Print (2 copies)'}
          </button>
          <button className="till-btn" onClick={() => void download()} disabled={busy}>
            {busy ? 'Preparing…' : 'Download PDF'}
          </button>
          <button className="till-btn" onClick={() => void share()} disabled={!doc.publicUrl}>
            Share link
          </button>
          <button className="till-btn till-btn--pay" onClick={onDone} autoFocus>
            Next sale
          </button>
        </div>
      </div>
    </div>
  );
}
