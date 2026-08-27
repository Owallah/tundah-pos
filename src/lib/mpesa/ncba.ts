/**
 * mpesa/ncba.ts — PaymentProvider adapter for NCBA.
 *
 * The transport lives in ./ncba-client.ts, which is shared with the Deno Edge
 * Functions. This file is Next-only: it adapts the client to the
 * PaymentProvider interface the rest of the app speaks.
 */

import type { Cents } from '../money/money';
import type { PaymentProvider, StkRequest, StkResult } from './provider';
import { NcbaClient, NcbaError, type NcbaConfig } from './ncba-client';

export {
  NcbaClient, NcbaError, NCBA_BASE_URL, normaliseNcbaPhone,
  type NcbaConfig,
} from './ncba-client';
export type { Cents };

// ── PaymentProvider adapter ────────────────────────────────────────────────

export class NcbaProvider implements PaymentProvider {
  readonly name = 'ncba';
  readonly collectionMode = 'paybill' as const;
  private readonly client: NcbaClient;

  constructor(private readonly config: NcbaConfig) {
    this.client = new NcbaClient(config);
  }

  get displayShortCode(): string { return this.config.payBillNo; }

  /** AccountNo carries the sale reference, so matching is exact. */
  supportsExactMatching(): boolean { return true; }

  /** NCBA has no callback — the caller must poll. */
  readonly requiresPolling = true;

  /** NCBA never returns an M-Pesa code, so statements are the audit trail. */
  readonly returnsReceiptNumber = false;

  supportsQr(): boolean { return true; }

  /**
   * The account number the payment carries.
   * Kept short: long references are awkward for a customer to read back.
   */
  accountNumberFor(saleRef: string): string {
    return `${this.config.tillCode}-${saleRef}`.slice(0, 20);
  }

  async stkPush(req: StkRequest): Promise<StkResult> {
    try {
      const res = await this.client.stkPush({
        phone: req.phone,
        amountCents: req.amount,
        accountNo: this.accountNumberFor(req.accountReference),
      });

      // Failure comes back as HTTP 200 with TransactionID null.
      if (!res.TransactionID || res.StatusCode === '1') {
        return {
          status: 'REJECTED',
          message: res.StatusDescription || 'NCBA rejected the request.',
        };
      }

      return {
        status: 'SENT',
        checkoutRequestId: res.TransactionID,
        merchantRequestId: res.ReferenceID ?? undefined,
        customerMessage: res.StatusDescription,
      };
    } catch (err) {
      return {
        status: 'ERROR',
        message: err instanceof NcbaError ? err.message : String(err),
      };
    }
  }

  async stkQuery(transactionId: string) {
    const res = await this.client.stkQuery(transactionId);
    const upper = (res.status ?? '').toUpperCase();
    return {
      // Mapped onto the Daraja convention the rest of the app already speaks:
      // 0 success, 1 failure, -1 still pending.
      resultCode: upper === 'SUCCESS' ? 0 : upper === 'FAILED' ? 1 : -1,
      resultDesc: res.description ?? '',
      rawStatus: upper,
    };
  }

  async generateQr(amountCents: Cents, narration?: string) {
    const res = await this.client.generateQr({ amountCents, narration });
    return { dataUri: res.Base64QrCode, description: res.StatusDescription };
  }
}
