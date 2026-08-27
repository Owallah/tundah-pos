/**
 * mpesa/ncba-client.ts — NCBA Till STK Push & dynamic QR, transport layer.
 *
 * Runtime-agnostic on purpose: this file runs in Next.js AND in Deno Edge
 * Functions, so it must not import anything app-side. The PaymentProvider
 * adapter lives in ./ncba.ts and is Next-only.
 *
 * Implemented against NCBA Bank PLC's "NCBA Till STK Push & Dynamic QR Code
 * API" specification (2024). Every endpoint, field name and response shape
 * below comes from that document.
 *
 * ═══ HOW THIS DIFFERS FROM DARAJA ══════════════════════════════════════════
 *
 * 1. NO CALLBACK. The specification contains no webhook. The only way to
 *    learn an outcome is to poll /stk-push/query. Everything built for the
 *    Daraja C2B confirmation webhook does not apply here.
 *
 * 2. NO RECEIPT NUMBER. The query returns exactly {status, description}.
 *    No M-Pesa code, no amount, no payer number. A payment can be confirmed
 *    while we still cannot record the Safaricom code an accountant would
 *    match a statement against. Handled by marking these verified_by='QUERY'
 *    and listing them separately for statement reconciliation.
 *
 * 3. FAILURES ARRIVE AS HTTP 200. Both success and failure return 200; the
 *    StatusCode field carries the verdict. Checking res.ok is not enough.
 *
 * 4. AccountNo IS OURS TO USE. This is the field that finally solves the
 *    three-tills-one-number problem — the payment carries the till and sale
 *    reference, so matching is exact rather than scored.
 *
 * ═══ QR IS THE INTERESTING PART ════════════════════════════════════════════
 *
 * For a KES 250 smoothie with eight people waiting, a dynamic QR beats STK:
 * the cashier types nothing (no phone number), the amount is pre-filled, and
 * the customer scans and pays. STK requires typing a phone number and waiting
 * for a prompt. QR removes both.
 */

import type { Cents } from '../money/money';

export const NCBA_BASE_URL = 'https://c2bapis.ncbagroup.com';

export interface NcbaConfig {
  baseUrl?: string;
  /** Username from the signed instruction letter to NCBA. */
  username: string;
  /** Secret key from the same letter. */
  password: string;
  /** NCBA's collection paybill. 880100 per the specification. */
  payBillNo: string;
  /** Your NCBA Till short code, e.g. PAY100D. */
  tillCode: string;
  timeoutMs?: number;
}

// ── Response shapes, verbatim from the specification ────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;   // 18000 (5 hours)
  status: number;
}

interface StkInitiateResponse {
  TransactionID: string | null;
  StatusCode: string;
  StatusDescription: string;
  ReferenceID: string | null;
}

interface StkQueryResponse {
  status: string;        // "SUCCESS" | "FAILED"
  description: string;
}

interface QrResponse {
  StatusCode: string;    // "0" success, "2" failure
  StatusDescription: string;
  Base64QrCode: string;  // data:image/png;base64,...
}

export class NcbaError extends Error {
  constructor(
    message: string,
    readonly statusCode?: string,
    readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'NcbaError';
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export class NcbaClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;

  constructor(private readonly config: NcbaConfig) {
    this.baseUrl = (config.baseUrl ?? NCBA_BASE_URL).replace(/\/$/, '');
  }

  /**
   * Tokens last 18000s (5 hours). Refreshed at 90% of life so a long event
   * day never stalls mid-sale waiting on an expired token.
   *
   * ⚠️ The specification is INCONSISTENT here: the STK section documents this
   * as GET, the QR section documents the same URL as POST. We try GET first
   * and fall back to POST. Confirm which is correct with NCBA (question N1).
   */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const basic = btoa(`${this.config.username}:${this.config.password}`);
    const url = `${this.baseUrl}/payments/api/v1/auth/token`;

    let res: Response | null = null;
    for (const method of ['GET', 'POST'] as const) {
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/json',
          },
        });
        if (res.ok) break;
        // 401 is a credentials problem, not a method problem — stop trying.
        if (res.status === 401) break;
      } catch {
        res = null;
      }
    }

    if (!res || !res.ok) {
      throw new NcbaError(
        res?.status === 401
          ? 'NCBA rejected the credentials. Check the username and secret key '
            + 'from the signed instruction letter.'
          : `NCBA token request failed (HTTP ${res?.status ?? 'no response'}).`,
        String(res?.status ?? ''),
        '/auth/token',
      );
    }

    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new NcbaError('NCBA returned no access_token.', undefined, '/auth/token');
    }

    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 18000) * 900,  // 90% of life
    };
    return this.token.value;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new NcbaError(`HTTP ${res.status} from ${path}`, String(res.status), path);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Initiate an STK push.
   *
   * NOTE ON AMOUNT: the specification types Amount as a string and gives no
   * guidance on decimals. We send whole shillings only, because a rounded-
   * down push would leave the sale permanently short. Confirm whether NCBA
   * accepts decimals (question N3).
   */
  async stkPush(params: {
    phone: string;
    amountCents: Cents;
    accountNo: string;
  }): Promise<StkInitiateResponse> {
    if (params.amountCents % 100 !== 0) {
      throw new NcbaError(
        'NCBA STK accepts whole shillings only. Take the shillings by STK and '
        + 'the remainder in cash.',
      );
    }

    return this.post<StkInitiateResponse>('/payments/api/v1/stk-push/initiate', {
      TelephoneNo: normaliseNcbaPhone(params.phone),
      Amount: String(Math.round(params.amountCents / 100)),
      PayBillNo: this.config.payBillNo,
      AccountNo: params.accountNo,
      Network: 'Safaricom',
      TransactionType: 'CustomerPayBillOnline',
    });
  }

  async stkQuery(transactionId: string): Promise<StkQueryResponse> {
    return this.post<StkQueryResponse>('/payments/api/v1/stk-push/query', {
      TransactionID: transactionId,
    });
  }

  /**
   * Generate a dynamic QR code as a base64 PNG data URI.
   *
   * The `till` field accepts `CODE#narration`. We put the sale reference in
   * the narration so a scanned payment is traceable to the exact sale — the
   * same trick as AccountNo on the STK path.
   */
  async generateQr(params: { amountCents?: Cents; narration?: string }): Promise<QrResponse> {
    const till = params.narration
      ? `${this.config.tillCode}#${params.narration}`
      : this.config.tillCode;

    const body: Record<string, unknown> = { till };
    if (params.amountCents !== undefined) {
      body.amount = Math.round(params.amountCents / 100);
    }

    const res = await this.post<QrResponse>('/payments/api/v1/qr/generate', body);

    // "0" is success, "2" is failure — and both arrive as HTTP 200.
    if (res.StatusCode !== '0' || !res.Base64QrCode) {
      throw new NcbaError(
        res.StatusDescription || 'NCBA could not generate a QR code.',
        res.StatusCode,
        '/qr/generate',
      );
    }
    return res;
  }
}

/** NCBA's sample is `254XXXXXXXX`. Same normalisation as Daraja. */
export function normaliseNcbaPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}
