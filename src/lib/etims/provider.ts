/**
 * etims/provider.ts — THE INTEGRATION BOUNDARY.
 *
 * The application core knows nothing about KRA. It speaks domain objects with
 * money in integer cents. Everything KRA-specific — field names, date
 * formatting, the cents->decimal(18,2) conversion, tax band arithmetic,
 * itemCd generation, cmcKey lifecycle — lives BEHIND this interface.
 *
 * ARCHITECTURE §H.1 / Principle 6.
 */

import type { Cents } from '../money/money';
import type {
  TaxTypeCode, PaymentTypeCode, CreditNoteReasonCode,
  StockIoTypeCode, CodeClass, ItemClassification,
} from './types';

// ── Domain inputs (no KRA vocabulary) ───────────────────────────────────────

export interface DomainSaleLine {
  lineNo: number;
  productId: string;
  itemCd: string;
  itemClsCd: string;
  name: string;
  barcode?: string | null;
  pkgUnitCd: string;
  qtyUnitCd: string;
  qty: number;
  unitPrice: Cents;
  discount: Cents;
  taxCode: TaxTypeCode;
  taxRateBp: number;
  taxableAmount: Cents;
  taxAmount: Cents;
  lineTotal: Cents;
}

export interface DomainSale {
  saleId: string;
  localRef: string;
  occurredAt: Date;
  customer?: { kraPin?: string | null; name?: string | null; phone?: string | null };
  /** Multiple tenders internally; collapsed to one pmtTyCd at the boundary. K4 */
  paymentMethods: Array<'CASH' | 'MPESA' | 'CARD' | 'OTHER'>;
  lines: DomainSaleLine[];
  subtotal: Cents;
  discountTotal: Cents;
  taxTotal: Cents;
  total: Cents;
}

export interface DomainCreditNote {
  creditNoteId: string;
  originalInvcNo: number;
  reason: CreditNoteReasonCode;
  reasonText?: string;
  occurredAt: Date;
  lines: DomainSaleLine[];
  taxTotal: Cents;
  total: Cents;
}

export interface DomainProduct {
  productId: string;
  sku: string;
  name: string;
  itemCd: string;
  itemClsCd: string;
  taxCode: TaxTypeCode;
  pkgUnitCd: string;
  qtyUnitCd: string;
  barcode?: string | null;
  sellingPrice: Cents;
  /** §4.3: '1' Raw Material, '2' Finished Product, '3' Service. */
  itemTypeCd?: '1' | '2' | '3';
}

export interface DomainStockMovement {
  movementId: string;
  ioType: StockIoTypeCode;
  occurredAt: Date;
  lines: Array<{
    itemCd: string;
    itemClsCd: string;
    name: string;
    pkgUnitCd: string;
    qtyUnitCd: string;
    qty: number;
    unitPrice: Cents;
    taxCode: TaxTypeCode;
    taxableAmount: Cents;
    taxAmount: Cents;
    total: Cents;
  }>;
}

// ── Provider results ────────────────────────────────────────────────────────

/** The fiscal signature. Only KRA can produce this. */
export interface FiscalSignature {
  invcNo: number;
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;
  rcptSign: string;
  sdcDateTime: Date;
  pmtTyCd: PaymentTypeCode;
  /** ⚠️ K6 — exact format unconfirmed. */
  qrPayload?: string;
}

export interface DeviceInitResult {
  dvcId: string;
  sdcId: string;
  mrcNo: string;
  cmcKey: string;
  taxpayerName: string;
  branchName: string;
}

export type ProviderCapability = 'LIVE' | 'MOCK' | 'DISABLED';

// ── The interface ───────────────────────────────────────────────────────────

export interface EtimsProvider {
  readonly capability: ProviderCapability;
  readonly name: string;

  /** One-time device authentication. Returns and persists the cmcKey. */
  initialiseDevice(): Promise<DeviceInitResult>;

  /** Standard code lists (tax rates live here, NOT in application code). */
  syncCodeList(since: Date): Promise<CodeClass[]>;

  /** UNSPSC item classification codes. */
  syncItemClassifications(since: Date): Promise<ItemClassification[]>;

  /** Register a product with KRA. Precondition for selling it. */
  registerItem(product: DomainProduct): Promise<void>;

  /**
   * Submit a completed sale.
   * @param invcNo Cloud-allocated sequential integer. Never client-side.
   */
  submitSale(sale: DomainSale, invcNo: number): Promise<FiscalSignature>;

  submitCreditNote(note: DomainCreditNote, invcNo: number): Promise<FiscalSignature>;

  /** MUST be called after the corresponding sale has been accepted. §0.3 */
  submitStockIO(movement: DomainStockMovement, sarNo: number): Promise<void>;

  /** MUST be called after the corresponding stock IO. §0.3 */
  submitStockMaster(itemCd: string, remainingQty: number): Promise<void>;

  fetchNotices(since: Date): Promise<Array<{ noticeNo: number; title: string; content: string }>>;

  /** Cheap reachability probe for the dashboard. */
  healthCheck(): Promise<{ reachable: boolean; latencyMs?: number; message?: string }>;
}

/**
 * Collapse multiple tenders into the single pmtTyCd that eTIMS accepts.
 *
 * ⚠️ OPEN QUESTION K4. eTIMS has no multi-payment structure, but SAL-04
 * requires split tender (KES 400 cash + KES 600 M-Pesa). '07' OTHER is the
 * most defensible reading; '03' CASH/CREDIT is a possible alternative.
 * CONFIRM WITH KRA BEFORE PRODUCTION.
 */
export function collapsePaymentMethods(
  methods: Array<'CASH' | 'MPESA' | 'CARD' | 'OTHER'>,
): PaymentTypeCode {
  const unique = [...new Set(methods)];
  if (unique.length === 0) return '07';
  if (unique.length > 1) return '07';    // ← K4
  switch (unique[0]) {
    case 'CASH': return '01';
    case 'MPESA': return '06';
    case 'CARD': return '05';
    default: return '07';
  }
}

/** KRA date formats. 14 chars, no separators. Any deviation is rejected. */
export function toKraDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function toKraDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * itemCd generator, per spec §4.19:
 *   KE + productType(1) + pkgUnitCd(2) + qtyUnitCd(1-3) + 7-digit sequence
 * Example: KE2NTU0000012
 */
export function buildItemCd(
  productType: '1' | '2' | '3',
  pkgUnitCd: string,
  qtyUnitCd: string,
  sequence: number,
): string {
  if (sequence < 1 || sequence > 9_999_999) {
    throw new RangeError(`itemCd sequence out of range: ${sequence}`);
  }
  return `KE${productType}${pkgUnitCd}${qtyUnitCd}${String(sequence).padStart(7, '0')}`;
}
