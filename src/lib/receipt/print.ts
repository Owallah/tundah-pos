/**
 * receipt/print.ts — hands the receipt to the OS print queue.
 *
 * A browser cannot talk to a network printer directly — no sockets, no raw
 * ESC/POS. The only door it has is window.print(), which hands off to
 * whatever printer is registered at the OS level (Windows, here, with the
 * Xprinter XP-E200L added as a network printer via its own driver). This
 * file's only job is building a print-ready page and calling that door.
 *
 * Both copies (customer receipt, kitchen ticket) are rendered into ONE
 * hidden iframe as two pages, separated by a CSS page break, and printed in
 * a single window.print() call — one click, one physical print job, the
 * printer's own auto-cutter separates the two copies as it feeds through.
 *
 * On a dedicated till machine, launch Chrome/Edge with --kiosk-printing so
 * this fires straight to the default printer with no dialog in the way.
 * Without that flag it still works — the OS print dialog just opens first.
 */

import { renderText, renderKitchenTicket, type ReceiptDocument } from './document';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPrintDocument(doc: ReceiptDocument): string {
  const customer = renderText(doc);
  const kitchen = renderKitchenTicket(doc);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 2mm 1mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font: 13px/1.45 'Courier New', ui-monospace, SFMono-Regular, monospace;
      padding: 3mm 2mm;
    }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .ticket { page-break-after: always; }
    .ticket:last-child { page-break-after: auto; }
    /* Kitchen staff read this at a glance from arm's length — larger and
       bold, unlike the customer copy which stays at normal receipt size. */
    .kitchen pre { font-size: 19px; font-weight: 700; letter-spacing: .01em; }
  </style></head><body>
    <div class="ticket customer"><pre>${escapeHtml(customer)}</pre></div>
    <div class="ticket kitchen"><pre>${escapeHtml(kitchen)}</pre></div>
  </body></html>`;
}

/**
 * Prints both copies in a single job. Resolves once the print call has been
 * made — it cannot know when physical printing actually finishes, only that
 * the OS was asked.
 */
export function printReceipt(doc: ReceiptDocument): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.setAttribute('aria-hidden', 'true');
    document.body.appendChild(iframe);

    // Deliberately NOT srcdoc + onload. An iframe fires an initial `load`
    // for its blank starting document BEFORE srcdoc content finishes
    // loading — sometimes that fires late enough for real content to have
    // already replaced it, sometimes not. That race is exactly what
    // printed nothing but the browser's own header/footer: print() ran
    // against the still-blank document, not the receipt. document.write()
    // has no such race — by the time close() returns, the content is
    // parsed into the frame, synchronously, on this same call stack.
    const frameDoc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!frameDoc) { iframe.remove(); resolve(); return; }

    frameDoc.open();
    frameDoc.write(buildPrintDocument(doc));
    frameDoc.close();

    const win = iframe.contentWindow;
    const finish = () => {
      // Removing the iframe immediately after print() can cancel the job
      // in some browsers — give the print pipeline a moment to pick it up.
      setTimeout(() => { iframe.remove(); resolve(); }, 1000);
    };

    if (!win) { finish(); return; }

    // One frame's grace before printing: document.write() has parsed the
    // content synchronously, but letting layout/paint settle for a frame
    // avoids Chrome occasionally snapshotting the page before it's ready.
    requestAnimationFrame(() => {
      try {
        win.focus();
        win.print();
      } finally {
        finish();
      }
    });
  });
}