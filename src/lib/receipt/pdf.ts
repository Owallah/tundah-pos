/**
 * receipt/pdf.ts — client-side PDF generation.
 *
 * Generated in the browser on purpose: no serverless invocation, no storage
 * write, no cost, and it works the instant the sale completes.
 *
 * Lazily imported by ReceiptView so pdf-lib never enters the till's initial
 * bundle — the cashier's first paint is what matters most.
 */

import { renderText, isFiscal, type ReceiptDocument } from './document';

/** 80mm roll width in PDF points (1pt = 1/72"). 80mm ≈ 226.77pt. */
const WIDTH = 227;
const MARGIN = 12;
const FONT_SIZE = 8.5;
const LINE_HEIGHT = 11;

export async function pdfFromReceipt(doc: ReceiptDocument): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');

  const lines = renderText(doc).split('\n');
  const height = MARGIN * 2 + lines.length * LINE_HEIGHT;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${isFiscal(doc) ? 'Tax invoice' : 'Receipt'} ${doc.localRef}`);
  pdf.setProducer('Nyota POS');
  pdf.setCreationDate(doc.issuedAt);

  const page = pdf.addPage([WIDTH, height]);
  // Courier keeps the 32-column alignment that renderText() produces.
  const font = await pdf.embedFont(StandardFonts.Courier);

  lines.forEach((line, i) => {
    page.drawText(line, {
      x: MARGIN,
      y: height - MARGIN - (i + 1) * LINE_HEIGHT + 3,
      size: FONT_SIZE,
      font,
    });
  });

  return pdf.save();
}
