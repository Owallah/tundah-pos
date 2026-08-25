/**
 * mpesa/provider.ts — the payment integration boundary.
 *
 * ═══ READ THIS BEFORE WIRING NCBA ═══════════════════════════════════════════
 *
 * "NCBA's M-Pesa integration" is two different things, and which one you have
 * changes how much code is involved. Establish this with your NCBA relationship
 * manager before touching anything:
 *
 * MODEL A — NCBA COLLECTION ACCOUNT (most likely, and much simpler)
 *   NCBA publishes Paybill **880100** and issues you a short code that is used
 *   as the ACCOUNT NUMBER. Customers pay 880100 / <your code>, and the money
 *   credits your NCBA account in real time.
 *
 *   The API is still Safaricom Daraja. NCBA is where the money lands, not who
 *   you call. The only changes are configuration:
 *     · transactionType  CustomerBuyGoodsOnline -> CustomerPayBillOnline
 *     · shortCode        your till -> 880100
 *     · accountReference becomes MEANINGFUL (see below)
 *
 * MODEL B — NCBA HOSTED PAYMENT API
 *   NCBA fronts the STK Push with their own gateway. Credentials, endpoints
 *   and payload shapes are issued under a corporate agreement and are NOT
 *   public. `NcbaHostedProvider` below is a scaffold with every unknown
 *   marked NCBA-Q#. Do not guess any of them.
 *
 * ═══ THE PART THAT ACTUALLY IMPROVES THE SYSTEM ═════════════════════════════
 *
 * A paybill returns `BillRefNumber` in the C2B callback. A Buy Goods till does
 * not. That single field solves the hardest problem in the current build:
 * three tills sharing one number, with no way to tell which till a payment
 * belongs to.
 *
 * If NCBA permits a free-form suffix on the account number, a cashier can say
 * "pay 880100, account TT1-247" and the match becomes EXACT rather than
 * scored. That removes the ambiguity picker entirely for C2B payments.
 *
 * Whether a suffix is allowed is NCBA-Q3. It is the single most valuable
 * question on the list — ask it first.
 */

import type { Cents } from '../money/money';
import {
  DarajaClient, normalisePhone, type DarajaConfig,
} from './daraja';

// ── The interface the application sees ──────────────────────────────────────

export interface StkRequest {
  phone: string;
  amount: Cents;
  /** Shown on the customer's statement, and the C2B match key on a paybill. */
  accountReference: string;
  description: string;
  saleId?: string;
}

export interface StkResult {
  status: 'SENT' | 'REJECTED' | 'ERROR';
  checkoutRequestId?: string;
  merchantRequestId?: string;
  customerMessage?: string;
  message?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** 'paybill' exposes BillRefNumber on C2B; 'till' does not. */
  readonly collectionMode: 'paybill' | 'till';
  /** The number a cashier reads out to a customer. */
  readonly displayShortCode: string;

  stkPush(req: StkRequest): Promise<StkResult>;
  stkQuery(checkoutRequestId: string): Promise<{ resultCode: number; resultDesc: string }>;
  /** True when C2B callbacks carry a reference we can match on exactly. */
  supportsExactMatching(): boolean;
}

// ── Model A: Daraja, configured for the NCBA collection paybill ─────────────

export interface NcbaPaybillConfig extends Omit<DarajaConfig, 'transactionType'> {
  /** NCBA's collection paybill. 880100 at the time of writing — confirm. */
  collectionShortCode: string;
  /** The short code NCBA issued you. Becomes the account number. */
  ncbaAccountCode: string;
  /**
   * Whether NCBA accepts `<accountCode>-<saleRef>` as the account number.
   * NCBA-Q3. Leave false until confirmed in writing — a rejected account
   * number means the customer's payment fails at the stall.
   */
  allowAccountSuffix: boolean;
}

export class NcbaPaybillProvider implements PaymentProvider {
  readonly name = 'ncba-paybill';
  readonly collectionMode = 'paybill' as const;
  private readonly client: DarajaClient;

  constructor(private readonly config: NcbaPaybillConfig) {
    this.client = new DarajaClient({
      ...config,
      shortCode: config.collectionShortCode,
      // A paybill STK is CustomerPayBillOnline. Sending the Buy Goods type
      // against a paybill is rejected by Safaricom.
      transactionType: 'CustomerPayBillOnline',
    });
  }

  get displayShortCode(): string {
    return this.config.collectionShortCode;
  }

  /**
   * Exact matching is only possible if the account number can carry a
   * per-sale reference. Without the suffix, every till shares one account
   * number and we are back to scoring candidates by amount and timing.
   */
  supportsExactMatching(): boolean {
    return this.config.allowAccountSuffix;
  }

  /**
   * The account number the customer types, or that STK sends.
   *
   * Safaricom truncates AccountReference at 12 characters, so the suffix has
   * to be short. `TT1-000247` fits; a UUID does not.
   */
  accountNumberFor(saleRef?: string): string {
    if (!this.config.allowAccountSuffix || !saleRef) {
      return this.config.ncbaAccountCode;
    }
    return `${this.config.ncbaAccountCode}-${saleRef}`.slice(0, 12);
  }

  async stkPush(req: StkRequest): Promise<StkResult> {
    try {
      const result = await this.client.stkPush({
        phone: normalisePhone(req.phone),
        amount: req.amount,
        accountReference: this.accountNumberFor(req.accountReference),
        description: req.description,
      });

      if (result.ResponseCode !== '0') {
        return { status: 'REJECTED', message: result.ResponseDescription };
      }
      return {
        status: 'SENT',
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        customerMessage: result.CustomerMessage,
      };
    } catch (err) {
      return { status: 'ERROR', message: String(err) };
    }
  }

  async stkQuery(checkoutRequestId: string) {
    const r = await this.client.stkQuery(checkoutRequestId);
    return { resultCode: Number(r.ResultCode), resultDesc: r.ResultDesc ?? '' };
  }
}

// ── Model A (existing): Safaricom Buy Goods till, direct ───────────────────

export class DarajaTillProvider implements PaymentProvider {
  readonly name = 'daraja-till';
  readonly collectionMode = 'till' as const;
  private readonly client: DarajaClient;

  constructor(private readonly config: DarajaConfig) {
    this.client = new DarajaClient(config);
  }

  get displayShortCode(): string { return this.config.shortCode; }

  /** A Buy Goods till returns no usable BillRefNumber. Scoring is required. */
  supportsExactMatching(): boolean { return false; }

  async stkPush(req: StkRequest): Promise<StkResult> {
    try {
      const result = await this.client.stkPush({
        phone: normalisePhone(req.phone),
        amount: req.amount,
        accountReference: req.accountReference,
        description: req.description,
      });
      if (result.ResponseCode !== '0') {
        return { status: 'REJECTED', message: result.ResponseDescription };
      }
      return {
        status: 'SENT',
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        customerMessage: result.CustomerMessage,
      };
    } catch (err) {
      return { status: 'ERROR', message: String(err) };
    }
  }

  async stkQuery(checkoutRequestId: string) {
    const r = await this.client.stkQuery(checkoutRequestId);
    return { resultCode: Number(r.ResultCode), resultDesc: r.ResultDesc ?? '' };
  }
}

// ── Model B: NCBA hosted gateway — SCAFFOLD ONLY ───────────────────────────

export interface NcbaHostedConfig {
  baseUrl: string;          // NCBA-Q4
  clientId: string;         // NCBA-Q5
  clientSecret: string;     // NCBA-Q5
  accountNumber: string;
  callbackUrl: string;
  environment: 'SANDBOX' | 'PRODUCTION';
}

/**
 * NCBA hosted payment API.
 *
 * ⚠️ NOT IMPLEMENTED, DELIBERATELY. NCBA's endpoints, auth scheme and payload
 * shapes are issued under a corporate agreement and are not published. Writing
 * a plausible-looking implementation from guesswork would produce code that
 * compiles, passes review, and fails against the real gateway — the worst
 * possible outcome, because it looks finished.
 *
 * Fill this in from NCBA's integration pack. The questions to send them are
 * in NCBA-MPESA.md.
 */
export class NcbaHostedProvider implements PaymentProvider {
  readonly name = 'ncba-hosted';
  readonly collectionMode = 'paybill' as const;

  constructor(private readonly config: NcbaHostedConfig) {}

  get displayShortCode(): string { return this.config.accountNumber; }
  supportsExactMatching(): boolean { return true; }

  private notImplemented(op: string): never {
    throw new Error(
      `NcbaHostedProvider.${op} is not implemented. NCBA's API specification ` +
      `is issued under agreement and has not been supplied. See NCBA-MPESA.md ` +
      `for the questions to send them, then implement against their pack. ` +
      `Use MPESA_PROVIDER=ncba-paybill in the meantime.`,
    );
  }

  async stkPush(): Promise<StkResult> { this.notImplemented('stkPush'); }
  async stkQuery(): Promise<{ resultCode: number; resultDesc: string }> {
    this.notImplemented('stkQuery');
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export type ProviderKind = 'daraja-till' | 'ncba-paybill' | 'ncba-hosted';

export function createPaymentProvider(
  env: Record<string, string | undefined> = process.env,
): PaymentProvider {
  const kind = (env.MPESA_PROVIDER ?? 'ncba-paybill') as ProviderKind;

  const base = {
    environment: (env.MPESA_ENVIRONMENT === 'PRODUCTION'
      ? 'PRODUCTION' : 'SANDBOX') as 'PRODUCTION' | 'SANDBOX',
    consumerKey: env.MPESA_CONSUMER_KEY ?? '',
    consumerSecret: env.MPESA_CONSUMER_SECRET ?? '',
    passkey: env.MPESA_PASSKEY ?? '',
    callbackUrl: env.MPESA_CALLBACK_URL ?? '',
    confirmationUrl: env.MPESA_CONFIRMATION_URL ?? '',
    validationUrl: env.MPESA_VALIDATION_URL ?? '',
  };

  switch (kind) {
    case 'ncba-paybill':
      return new NcbaPaybillProvider({
        ...base,
        shortCode: env.NCBA_COLLECTION_SHORTCODE ?? '880100',
        collectionShortCode: env.NCBA_COLLECTION_SHORTCODE ?? '880100',
        ncbaAccountCode: env.NCBA_ACCOUNT_CODE ?? '',
        // Default false: an unconfirmed suffix fails the customer's payment.
        allowAccountSuffix: env.NCBA_ALLOW_ACCOUNT_SUFFIX === 'true',
      });

    case 'ncba-hosted':
      return new NcbaHostedProvider({
        baseUrl: env.NCBA_API_BASE_URL ?? '',
        clientId: env.NCBA_CLIENT_ID ?? '',
        clientSecret: env.NCBA_CLIENT_SECRET ?? '',
        accountNumber: env.NCBA_ACCOUNT_CODE ?? '',
        callbackUrl: env.MPESA_CALLBACK_URL ?? '',
        environment: base.environment,
      });

    case 'daraja-till':
    default:
      return new DarajaTillProvider({
        ...base,
        shortCode: env.MPESA_SHORTCODE ?? '',
        storeNumber: env.MPESA_STORE_NUMBER || undefined,
        transactionType: 'CustomerBuyGoodsOnline',
      });
  }
}
