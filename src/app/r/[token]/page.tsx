/**
 * /r/[token] — the public receipt page.
 *
 * This is the ONLY unauthenticated surface in the system, so it is built to
 * fail closed:
 *
 *   1. It reads through the SERVICE ROLE and projects an explicit field
 *      allowlist. It does NOT expose a table via a public RLS policy — a
 *      public policy is one careless migration away from leaking the whole
 *      table, whereas an allowlist has to be deliberately widened.
 *   2. The token is 32 random bytes (256 bits). Enumeration is not a concern;
 *      guessing is not feasible.
 *   3. Nothing about cost, margin, cashier identity, device internals, other
 *      sales, or customer phone numbers crosses this boundary.
 *
 * ARCHITECTURE §I.3.
 */

import { notFound } from 'next/navigation';
import { serviceClient } from '@/lib/supabase/clients';
import {
  HtmlReceiptProvider, type ReceiptDocument,
} from '@/lib/receipt/document';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface PageProps {
  params: Promise<{ token: string }>;
}

/** Everything the public may see. Adding a field here is a security decision. */
interface PublicInvoiceRow {
  invc_no: number;
  cur_rcpt_no: number;
  tot_rcpt_no: number;
  intrl_data: string;
  rcpt_sign: string;
  sdc_date_time: string;
  qr_payload: string | null;
  issued_at: string;
  receipt_payload: ReceiptPayload;
}

interface ReceiptPayload {
  business: ReceiptDocument['business'];
  localRef: string;
  cashierName: string;
  deviceCode: string;
  eventName: string;
  lines: ReceiptDocument['lines'];
  subtotal: number;
  discountTotal: number;
  taxBands: ReceiptDocument['taxBands'];
  taxTotal: number;
  total: number;
  payments: ReceiptDocument['payments'];
  changeGiven: number;
  isBackfilled: boolean;
  backfillRef?: string | null;
}

export default async function ReceiptPage({ params }: PageProps) {
  const { token } = await params;

  // Cheap shape check before touching the database.
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) notFound();

  const db = serviceClient();

  const { data, error } = await db
    .from('invoices')
    .select(
      'invc_no, cur_rcpt_no, tot_rcpt_no, intrl_data, rcpt_sign, ' +
      'sdc_date_time, qr_payload, issued_at, receipt_payload',
    )
    .eq('public_token', token)
    .maybeSingle<PublicInvoiceRow>();

  if (error || !data) notFound();

  const p = data.receipt_payload;

  const doc: ReceiptDocument = {
    business: p.business,
    localRef: p.localRef,
    issuedAt: new Date(data.issued_at),
    cashierName: p.cashierName,
    deviceCode: p.deviceCode,
    eventName: p.eventName,
    lines: p.lines,
    subtotal: p.subtotal as ReceiptDocument['subtotal'],
    discountTotal: p.discountTotal as ReceiptDocument['discountTotal'],
    taxBands: p.taxBands,
    taxTotal: p.taxTotal as ReceiptDocument['taxTotal'],
    total: p.total as ReceiptDocument['total'],
    payments: p.payments,
    changeGiven: p.changeGiven as ReceiptDocument['changeGiven'],
    isBackfilled: p.isBackfilled,
    backfillRef: p.backfillRef,
    fiscal: {
      invcNo: data.invc_no,
      curRcptNo: data.cur_rcpt_no,
      totRcptNo: data.tot_rcpt_no,
      intrlData: data.intrl_data,
      rcptSign: data.rcpt_sign,
      sdcDateTime: new Date(data.sdc_date_time),
      qrPayload: data.qr_payload ?? undefined,
    },
  };

  const rendered = await new HtmlReceiptProvider().render(doc);

  return (
    <div dangerouslySetInnerHTML={{ __html: extractBody(String(rendered.body)) }} />
  );
}

/**
 * The provider emits a full document; here we only need its body, because
 * Next owns <html> and <head>. The style block is carried across with it.
 */
function extractBody(html: string): string {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
  return `<style>${style}</style>${body}`;
}
