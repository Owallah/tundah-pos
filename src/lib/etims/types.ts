/**
 * etims/types.ts
 *
 * Types transcribed from KRA's "Online Sales Control Unit (OSCU) Requirements
 * & Communication Protocols" v2.0 (April 2023).
 *
 * ⚠️  OPEN QUESTIONS — do not treat any of the following as settled:
 *   K3  Is taxblAmt gross or net? The spec's own sales and purchase samples
 *       disagree. Pin at certification.
 *   K4  Which pmtTyCd for split tender (cash + M-Pesa)? Likely '07' OTHER.
 *   K5  Are tin/bhfId/cmcKey sent in the BODY (per v2.0) or as HTTP HEADERS
 *       (per current third-party SDKs)? Both shapes are supported below.
 *   K6  Exact QR payload / verification URL format.
 *   K7  Must saveStockMaster fire per SKU after every sale, or periodically?
 *   K8  Is there a spec newer than v2.0? Request the current Postman collection.
 */

export const ETIMS_BASE_URL = {
  SANDBOX: 'https://etims-api-sbx.kra.go.ke/etims-api',
  PRODUCTION: 'https://etims-api.kra.go.ke/etims-api',
} as const;

export type EtimsEnvironment = keyof typeof ETIMS_BASE_URL;

/** Spec §4.1 Tax Type. RATES are fetched via selectCodeList, never hardcoded. */
export type TaxTypeCode = 'A' | 'B' | 'C' | 'D' | 'E';

/** Spec §4.10 Sales Receipt Type. */
export type ReceiptTypeCode = 'S' | 'R'; // Sale | Credit Note after Sale

/** Spec §4.9 Transaction Type. */
export type TransactionTypeCode = 'C' | 'N' | 'P' | 'T';

/** Spec §4.11 Payment Method. NOTE: exactly ONE per invoice (see K4). */
export const PAYMENT_TYPE = {
  CASH: '01',
  CREDIT: '02',
  CASH_CREDIT: '03',
  BANK_CHECK: '04',
  DEBIT_CREDIT_CARD: '05',
  MOBILE_MONEY: '06',
  OTHER: '07',
} as const;
export type PaymentTypeCode = (typeof PAYMENT_TYPE)[keyof typeof PAYMENT_TYPE];

/** Spec §4.12 Transaction Progress. */
export const SALES_STATUS = {
  WAIT_APPROVAL: '01',
  APPROVED: '02',
  CANCEL_REQUESTED: '03',
  CANCELLED: '04',
  CREDIT_NOTE_GENERATED: '05',
  TRANSFERRED: '06',
} as const;
export type SalesStatusCode = (typeof SALES_STATUS)[keyof typeof SALES_STATUS];

/** Spec §4.15 Stock In/Out. */
export const STOCK_IO_TYPE = {
  IMPORT: '01',
  PURCHASE: '02',
  RETURN_IN: '03',
  MOVEMENT_IN: '04',
  PROCESSING_IN: '05',
  ADJUSTMENT_IN: '06',
  SALE: '11',
  RETURN_OUT: '12',
  MOVEMENT_OUT: '13',
  PROCESSING_OUT: '14',
  DISCARDING: '15',
  ADJUSTMENT_OUT: '16',
} as const;
export type StockIoTypeCode = (typeof STOCK_IO_TYPE)[keyof typeof STOCK_IO_TYPE];

/** Spec §4.17 Credit Note Reason. */
export const CREDIT_NOTE_REASON = {
  MISSING_QUANTITY: '01',
  MISSING_DATA: '02',
  DAMAGED: '03',
  WASTED: '04',
  RAW_MATERIAL_SHORTAGE: '05',
  REFUND: '06',
} as const;
export type CreditNoteReasonCode =
  (typeof CREDIT_NOTE_REASON)[keyof typeof CREDIT_NOTE_REASON];

/** Spec §4.18 API Response Code. */
export const RESULT_CODE = {
  SUCCESS: '000',
  NO_RESULT: '001',
  URL_ERROR: '891',
  HEADER_ERROR: '892',
  BODY_ERROR: '893',
  COMMS_ERROR: '894',
  METHOD_NOT_ALLOWED: '895',
  REQUEST_STATUS_ERROR: '896',
  CLIENT_ERROR: '899',
  NO_HEADER_INFO: '900',
  INVALID_DEVICE: '901',
  DEVICE_ALREADY_INSTALLED: '902',
  OSCU_ONLY: '903',
  PARAMETER_ERROR: '910',
  NO_REQUEST_BODY: '911',
  METHOD_ERROR: '912',
  DECLARED_SALES_REJECTED: '921',
  INVOICE_BEFORE_SALES: '922',
  MAX_VIEWS_EXCEEDED: '990',
  REGISTRATION_ERROR: '991',
  MODIFICATION_ERROR: '992',
  DELETION_ERROR: '993',
  DUPLICATE_DATA: '994',
  NO_FILE: '995',
  UNKNOWN: '999',
} as const;

/** Codes that mean "stop the queue and get a human" — see ARCHITECTURE §H.4. */
export const ORDERING_VIOLATION_CODES: string[] = [
  RESULT_CODE.DECLARED_SALES_REJECTED,
  RESULT_CODE.INVOICE_BEFORE_SALES,
];

/** Codes that are safe to treat as already-succeeded (idempotent replay). */
export const IDEMPOTENT_SUCCESS_CODES: string[] = [RESULT_CODE.DUPLICATE_DATA];

/** Codes worth retrying with backoff. */
export const RETRYABLE_CODES: string[] = [
  RESULT_CODE.COMMS_ERROR,
  RESULT_CODE.UNKNOWN,
];

// ── Envelope ────────────────────────────────────────────────────────────────

export interface EtimsResponse<T = unknown> {
  resultCd: string;
  resultMsg: string;
  resultDt: string;
  data: T | null;
}

export interface EtimsCredentials {
  /** KRA PIN, 11 chars, e.g. P000000045R. */
  tin: string;
  /** Branch ID, 2 chars. '00' = head office. */
  bhfId: string;
  /** Device serial. Must be the KRA-APPROVED value — never generated. */
  dvcSrlNo: string;
  /** Communication key returned by selectInitOsdcInfo. Server-side only. */
  cmcKey?: string;
}

// ── Device initialisation (§3.3.1) ──────────────────────────────────────────

export interface DeviceInitResponse {
  info: {
    tin: string;
    taxprNm: string;
    bsnsActv: string;
    bhfId: string;
    bhfNm: string;
    bhfOpenDt: string;
    prvncNm: string;
    dstrtNm: string;
    sctrNm: string;
    locDesc: string;
    hqYn: string;
    mgrNm: string;
    mgrTelNo: string;
    mgrEmail: string;
    dvcId: string;
    sdcId: string;
    mrcNo: string;
    /** ⚠️ Secret. Never log, never send to a client. */
    cmcKey: string;
  };
}

// ── Code lists (§3.3.2) ─────────────────────────────────────────────────────

export interface CodeClass {
  cdCls: string;
  cdClsNm: string;
  cdClsDesc: string | null;
  useYn: string;
  dtlList: CodeDetail[];
}

export interface CodeDetail {
  cd: string;
  cdNm: string;
  cdDesc: string | null;
  srtOrd: number;
  /** For tax types (cdCls '04') this carries the RATE, e.g. "16". */
  userDfnCd1: string | null;
  userDfnCd2: string | null;
  userDfnCd3: string | null;
  useYn: string;
}

export interface ItemClassification {
  itemClsCd: string;
  itemClsNm: string;
  itemClsLvl: number;
  taxTyCd: string | null;
  mjrTgYn: string | null;
  useYn: string;
}

// ── Items (§3.3.3) ──────────────────────────────────────────────────────────

export interface ItemSaveRequest {
  itemCd: string;
  itemClsCd: string;
  itemTyCd: string;      // §4.3: 1 Raw Material, 2 Finished Product, 3 Service
  itemNm: string;
  itemStdNm?: string | null;
  orgnNatCd: string;     // 'KE'
  pkgUnitCd: string;
  qtyUnitCd: string;
  taxTyCd: TaxTypeCode;
  btchNo?: string | null;
  bcd?: string | null;
  dftPrc: number;        // NUMBER(18,2)
  grpPrcL1?: number | null;
  grpPrcL2?: number | null;
  grpPrcL3?: number | null;
  grpPrcL4?: number | null;
  grpPrcL5?: number | null;
  addInfo?: string | null;
  sftyQty?: number | null;
  isrcAplcbYn: string;   // 'N' unless pharmacy
  useYn: string;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
}

// ── Sales (§3.3.6) ──────────────────────────────────────────────────────────

export interface SalesItem {
  itemSeq: number;
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd?: string | null;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  prc: number;
  splyAmt: number;
  dcRt: number;
  dcAmt: number;
  isrccCd?: string | null;
  isrccNm?: string | null;
  isrcRt?: number | null;
  isrcAmt?: number | null;
  taxTyCd: TaxTypeCode;
  taxblAmt: number;
  taxAmt: number;
  totAmt: number;
}

export interface SalesReceipt {
  custTin?: string | null;
  custMblNo?: string | null;
  rcptPbctDt: string;    // yyyyMMddHHmmss
  trdeNm?: string | null;
  adrs?: string | null;
  topMsg?: string | null;
  btmMsg?: string | null;
  prchrAcptcYn: string;
}

export interface SalesSaveRequest {
  /** Our own reference. */
  trdInvcNo: string;
  /** ⚠️ Sequential INTEGER per branch, allocated server-side only. §0.2 */
  invcNo: number;
  orgInvcNo: number;     // 0 for a normal sale
  custTin?: string | null;
  custNm?: string | null;
  salesTyCd: TransactionTypeCode;
  rcptTyCd: ReceiptTypeCode;
  pmtTyCd: PaymentTypeCode;
  salesSttsCd: SalesStatusCode;
  cfmDt: string;         // yyyyMMddHHmmss
  salesDt: string;       // yyyyMMdd
  stockRlsDt?: string | null;
  cnclReqDt?: string | null;
  cnclDt?: string | null;
  rfdDt?: string | null;
  rfdRsnCd?: CreditNoteReasonCode | null;
  totItemCnt: number;

  // All 15 tax fields are REQUIRED, even when zero.
  taxblAmtA: number; taxblAmtB: number; taxblAmtC: number;
  taxblAmtD: number; taxblAmtE: number;
  taxRtA: number; taxRtB: number; taxRtC: number; taxRtD: number; taxRtE: number;
  taxAmtA: number; taxAmtB: number; taxAmtC: number; taxAmtD: number; taxAmtE: number;

  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  prchrAcptcYn: string;
  remark?: string | null;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  receipt: SalesReceipt;
  itemList: SalesItem[];
}

/** The five fields that ARE the fiscalisation. */
export interface SalesSaveResponse {
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;   // 26 chars
  rcptSign: string;    // 16 chars
  sdcDateTime: string; // yyyyMMddHHmmss
}

// ── Stock (§3.3.8) ──────────────────────────────────────────────────────────

export interface StockIoItem {
  itemSeq: number;
  itemCd: string;
  itemClsCd: string;
  itemNm: string;
  bcd?: string | null;
  pkgUnitCd: string;
  pkg: number;
  qtyUnitCd: string;
  qty: number;
  itemExprDt?: string | null;
  prc: number;
  splyAmt: number;
  totDcAmt: number;
  taxblAmt: number;
  taxTyCd: TaxTypeCode;
  taxAmt: number;
  totAmt: number;
}

export interface StockIoSaveRequest {
  /** Sequential "stored and released" number. Cloud-allocated, like invcNo. */
  sarNo: number;
  orgSarNo: number;
  regTyCd: 'A' | 'M';
  custTin?: string | null;
  custNm?: string | null;
  custBhfId?: string | null;
  sarTyCd: StockIoTypeCode;
  ocrnDt: string;        // yyyyMMdd
  totItemCnt: number;
  totTaxblAmt: number;
  totTaxAmt: number;
  totAmt: number;
  remark?: string | null;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
  itemList: StockIoItem[];
}

export interface StockMasterSaveRequest {
  itemCd: string;
  rsdQty: number;
  regrId: string;
  regrNm: string;
  modrId: string;
  modrNm: string;
}

export class EtimsError extends Error {
  constructor(
    message: string,
    readonly resultCd: string,
    readonly endpoint: string,
    readonly requestBody?: unknown,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'EtimsError';
  }

  get isRetryable(): boolean {
    return RETRYABLE_CODES.includes(this.resultCd);
  }

  /** Ordering violations must HALT the queue, not retry. */
  get isOrderingViolation(): boolean {
    return ORDERING_VIOLATION_CODES.includes(this.resultCd);
  }

  get isDuplicate(): boolean {
    return IDEMPOTENT_SUCCESS_CODES.includes(this.resultCd);
  }
}
