/**
 * mpesa/daraja.ts — Safaricom Daraja integration.
 *
 * ⚠️ SERVER-SIDE ONLY. Consumer key, secret and passkey must never reach a
 * browser bundle. This module is imported by Supabase Edge Functions and
 * Next.js Route Handlers only. ARCHITECTURE Principle 7.
 *
 * PATH PRIORITY for this business (low ticket value, long queues):
 *   1. C2B  — customer pays the Till directly; Safaricom posts to our
 *             Confirmation URL; the cashier taps to match. ~1-2s, verified.
 *   2. STK  — cashier pushes a prompt. 30-60s round trip. Fallback only.
 *   3. MANUAL — cashier types the code. Trust-based, reconciled later.
 */

import type { Cents } from '../money/money';

/**
 * Base64 without Node's Buffer. This module runs in three places — Next.js
 * server, Deno Edge Functions, and the test runner — so it must not assume
 * a runtime. `btoa` is available in all three.
 */
function base64(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  // Node fallback for older runtimes.
  return (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } })
    .Buffer!.from(input, 'utf-8').toString('base64');
}

export const DARAJA_BASE_URL = {
  SANDBOX: 'https://sandbox.safaricom.co.ke',
  PRODUCTION: 'https://api.safaricom.co.ke',
} as const;

export type DarajaEnvironment = keyof typeof DARAJA_BASE_URL;

export interface DarajaConfig {
  environment: DarajaEnvironment;
  consumerKey: string;
  consumerSecret: string;
  /** Buy Goods Till or Paybill shortcode. */
  shortCode: string;
  /** For Buy Goods, the STK "store number" may differ from the till. */
  storeNumber?: string;
  /** Lipa na M-Pesa Online passkey. */
  passkey: string;
  transactionType: 'CustomerBuyGoodsOnline' | 'CustomerPayBillOnline';
  callbackUrl: string;
  confirmationUrl: string;
  validationUrl: string;
  timeoutMs?: number;
}

export class DarajaError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly httpStatus?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'DarajaError';
  }
}

// ── Callback payload shapes ─────────────────────────────────────────────────

export interface StkCallback {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}

export interface C2BConfirmation {
  TransactionType: string;
  TransID: string;               // the M-Pesa receipt number
  TransTime: string;             // yyyyMMddHHmmss
  TransAmount: string;
  BusinessShortCode: string;
  BillRefNumber: string;
  InvoiceNumber: string;
  OrgAccountBalance: string;
  ThirdPartyTransID: string;
  MSISDN: string;                // masked in production
  FirstName: string;
  MiddleName: string;
  LastName: string;
}

export interface NormalisedPayment {
  receiptNumber: string;
  amount: Cents;
  phoneNumber: string | null;
  payerName: string | null;
  billRef: string | null;
  occurredAt: Date;
  channel: 'C2B' | 'STK';
  checkoutRequestId?: string;
}

// ── Client ──────────────────────────────────────────────────────────────────

export class DarajaClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;

  constructor(private readonly config: DarajaConfig) {
    this.baseUrl = DARAJA_BASE_URL[config.environment];
  }

  /** OAuth token, cached. Daraja tokens live ~3600s; we refresh at 3300s. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;

    const basic = base64(`${this.config.consumerKey}:${this.config.consumerSecret}`);

    const res = await fetch(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );

    if (!res.ok) {
      throw new DarajaError('OAuth token request failed', '/oauth/v1/generate', res.status);
    }

    const json = (await res.json()) as { access_token: string; expires_in: string };
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) - 300) * 1000,
    };
    return this.token.value;
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const token = await this.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    try {
      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new DarajaError(
          `Daraja ${endpoint} returned ${res.status}`, endpoint, res.status, json,
        );
      }
      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
           `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  private password(ts: string): string {
    return base64(`${this.config.shortCode}${this.config.passkey}${ts}`);
  }

  // ── C2B: the PRIMARY path ─────────────────────────────────────────────────

  /**
   * Register the Confirmation and Validation URLs against the shortcode.
   * Run ONCE per environment (and again if the URLs change). Safaricom then
   * posts every payment to that Till in real time.
   *
   * Use a stable Supabase Edge Function URL -- NOT a Vercel deployment URL,
   * which changes on every deploy.
   */
  async registerC2BUrls(responseType: 'Completed' | 'Cancelled' = 'Completed') {
    return this.post<{ ResponseDescription: string; OriginatorCoversationID: string }>(
      '/mpesa/c2b/v1/registerurl',
      {
        ShortCode: this.config.shortCode,
        ResponseType: responseType,   // 'Completed' = accept even if we're down
        ConfirmationURL: this.config.confirmationUrl,
        ValidationURL: this.config.validationUrl,
      },
    );
  }

  /** Sandbox only. Simulates a customer paying the Till. */
  async simulateC2B(phone: string, amount: Cents, billRef = '') {
    if (this.config.environment !== 'SANDBOX') {
      throw new DarajaError('simulateC2B is sandbox-only', '/mpesa/c2b/v1/simulate');
    }
    return this.post('/mpesa/c2b/v1/simulate', {
      ShortCode: this.config.shortCode,
      CommandID: this.config.transactionType === 'CustomerBuyGoodsOnline'
        ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: Math.round(amount / 100),
      Msisdn: phone,
      BillRefNumber: billRef,
    });
  }

  // ── STK Push: the fallback ────────────────────────────────────────────────

  async stkPush(params: {
    phone: string;
    amount: Cents;
    accountReference: string;
    description: string;
  }) {
    const ts = this.timestamp();
    return this.post<{
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResponseCode: string;
      ResponseDescription: string;
      CustomerMessage: string;
    }>('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.config.shortCode,
      Password: this.password(ts),
      Timestamp: ts,
      TransactionType: this.config.transactionType,
      // Daraja takes whole shillings only.
      Amount: Math.round(params.amount / 100),
      PartyA: normalisePhone(params.phone),
      PartyB: this.config.storeNumber ?? this.config.shortCode,
      PhoneNumber: normalisePhone(params.phone),
      CallBackURL: this.config.callbackUrl,
      AccountReference: params.accountReference.slice(0, 12),
      TransactionDesc: params.description.slice(0, 13),
    });
  }

  /** Poll when the callback hasn't arrived. The single most common failure. */
  async stkQuery(checkoutRequestId: string) {
    const ts = this.timestamp();
    return this.post<{
      ResponseCode: string;
      ResultCode: string;
      ResultDesc: string;
      MerchantRequestID: string;
      CheckoutRequestID: string;
    }>('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: this.config.shortCode,
      Password: this.password(ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    });
  }
}

// ── Callback normalisation ──────────────────────────────────────────────────

export function normaliseStkCallback(cb: StkCallback): {
  checkoutRequestId: string;
  success: boolean;
  resultCode: number;
  resultDesc: string;
  payment?: NormalisedPayment;
} {
  const s = cb.Body.stkCallback;
  const base = {
    checkoutRequestId: s.CheckoutRequestID,
    success: s.ResultCode === 0,
    resultCode: s.ResultCode,
    resultDesc: s.ResultDesc,
  };

  if (s.ResultCode !== 0 || !s.CallbackMetadata) return base;

  const meta = new Map(s.CallbackMetadata.Item.map((i) => [i.Name, i.Value]));
  const amountKes = Number(meta.get('Amount') ?? 0);
  const receipt = String(meta.get('MpesaReceiptNumber') ?? '');
  const phone = meta.get('PhoneNumber');
  const txDate = String(meta.get('TransactionDate') ?? '');

  return {
    ...base,
    payment: {
      receiptNumber: receipt,
      amount: Math.round(amountKes * 100) as Cents,
      phoneNumber: phone ? String(phone) : null,
      payerName: null,
      billRef: null,
      occurredAt: parseDarajaTimestamp(txDate) ?? new Date(),
      channel: 'STK',
      checkoutRequestId: s.CheckoutRequestID,
    },
  };
}

export function normaliseC2BConfirmation(c: C2BConfirmation): NormalisedPayment {
  const name = [c.FirstName, c.MiddleName, c.LastName]
    .filter(Boolean).join(' ').trim() || null;

  return {
    receiptNumber: c.TransID,
    amount: Math.round(Number(c.TransAmount) * 100) as Cents,
    phoneNumber: c.MSISDN || null,
    payerName: name,
    billRef: c.BillRefNumber || null,
    occurredAt: parseDarajaTimestamp(c.TransTime) ?? new Date(),
    channel: 'C2B',
  };
}

export function parseDarajaTimestamp(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** 0712345678 / +254712345678 / 254712345678 -> 254712345678 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
}

/**
 * Safaricom's published source IPs. The Confirmation URL is a public endpoint
 * that creates payment records -- restrict it.
 * ⚠️ VERIFY THIS LIST against current Daraja documentation before go-live;
 * Safaricom has changed it in the past.
 */
export const SAFARICOM_IP_ALLOWLIST = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74', '196.201.212.69',
];

export function isSafaricomSource(ip: string | null): boolean {
  if (!ip) return false;
  const first = ip.split(',')[0].trim();
  return SAFARICOM_IP_ALLOWLIST.includes(first);
}
