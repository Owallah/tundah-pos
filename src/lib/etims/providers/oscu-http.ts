/**
 * OscuHttpProvider — the real KRA eTIMS OSCU integration.
 *
 * Built directly from KRA's OSCU Requirements & Communication Protocols v2.0.
 * The spec explicitly permits this approach:
 *   "For non Java application, you can directly connect to eTIMS API server
 *    without passing through OSCU Library."
 *
 * ⚠️ NOTHING HERE IS INVENTED. Where the spec is ambiguous or contradicts
 * itself, the code is marked with the open-question id (K3..K8) and made
 * configurable rather than guessed. Resolve every one during KRA sandbox
 * certification BEFORE enabling this provider in production.
 */

import {
  ETIMS_BASE_URL, RESULT_CODE, EtimsError,
  type EtimsEnvironment, type EtimsCredentials, type EtimsResponse,
  type DeviceInitResponse, type CodeClass, type ItemClassification,
  type SalesSaveRequest, type SalesSaveResponse, type SalesItem,
  type StockIoSaveRequest, type ItemSaveRequest, type TaxTypeCode,
} from '../types';
import {
  type EtimsProvider, type DeviceInitResult, type DomainSale,
  type DomainCreditNote, type DomainProduct, type DomainStockMovement,
  type FiscalSignature, type ProviderCapability,
  collapsePaymentMethods, toKraDate, toKraDateTime,
} from '../provider';
import { centsToEtimsDecimal, type Cents } from '../../money/money';

export interface OscuConfig {
  environment: EtimsEnvironment;
  credentials: EtimsCredentials;
  /**
   * K5 — v2.0 documents tin/bhfId/cmcKey in the request BODY. Current
   * third-party SDKs send them as HTTP HEADERS. Support both; confirm which
   * the live endpoint expects during certification.
   */
  authTransport: 'body' | 'header' | 'both';
  /**
   * K3 — is taxblAmt the VAT-INCLUSIVE gross or the VAT-EXCLUSIVE net?
   * KRA's own sales and purchase samples disagree. Default follows the SALES
   * sample (gross), which is the relevant one for a POS.
   */
  taxableAmountConvention: 'gross' | 'net';
  operatorId: string;
  operatorName: string;
  timeoutMs?: number;
}

export class OscuHttpProvider implements EtimsProvider {
  readonly capability: ProviderCapability = 'LIVE';
  readonly name = 'oscu-http';
  private readonly baseUrl: string;

  constructor(private readonly config: OscuConfig) {
    this.baseUrl = ETIMS_BASE_URL[config.environment];
    if (!config.credentials.cmcKey && config.environment === 'PRODUCTION') {
      throw new Error('cmcKey is required in production. Run initialiseDevice() first.');
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const { tin, bhfId, cmcKey } = this.config.credentials;
    const useBody = this.config.authTransport !== 'header';
    const useHeader = this.config.authTransport !== 'body';

    const payload = useBody ? { tin, bhfId, ...(cmcKey ? { cmcKey } : {}), ...body } : body;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (useHeader) {
      headers.tin = tin;
      headers.bhfId = bhfId;
      if (cmcKey) headers.cmcKey = cmcKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new EtimsError(
        `Network failure calling ${endpoint}: ${(err as Error).message}`,
        RESULT_CODE.COMMS_ERROR, endpoint, redact(payload),
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new EtimsError(
        `HTTP ${res.status} from ${endpoint}`,
        RESULT_CODE.COMMS_ERROR, endpoint, redact(payload),
      );
    }

    const json = (await res.json()) as EtimsResponse<T>;

    if (json.resultCd !== RESULT_CODE.SUCCESS) {
      throw new EtimsError(
        `${endpoint} rejected: ${json.resultCd} ${json.resultMsg}`,
        json.resultCd, endpoint, redact(payload), json,
      );
    }
    return json.data as T;
  }

  // ── Initialisation ────────────────────────────────────────────────────────

  async initialiseDevice(): Promise<DeviceInitResult> {
    const { tin, bhfId, dvcSrlNo } = this.config.credentials;
    const data = await this.call<DeviceInitResponse>('/selectInitOsdcInfo', {
      tin, bhfId, dvcSrlNo,
    });
    const i = data.info;
    return {
      dvcId: i.dvcId,
      sdcId: i.sdcId,
      mrcNo: i.mrcNo,
      cmcKey: i.cmcKey,
      taxpayerName: i.taxprNm,
      branchName: i.bhfNm,
    };
  }

  async syncCodeList(since: Date): Promise<CodeClass[]> {
    const data = await this.call<{ clsList: CodeClass[] }>('/selectCodeList', {
      lastReqDt: toKraDateTime(since),
    });
    return data?.clsList ?? [];
  }

  async syncItemClassifications(since: Date): Promise<ItemClassification[]> {
    const data = await this.call<{ itemClsList: ItemClassification[] }>(
      '/selectItemClsList', { lastReqDt: toKraDateTime(since) },
    );
    return data?.itemClsList ?? [];
  }

  async fetchNotices(since: Date) {
    const data = await this.call<{ noticeList: Array<{ noticeNo: number; title: string; cont: string }> }>(
      '/selectNoticeList', { lastReqDt: toKraDateTime(since) },
    );
    return (data?.noticeList ?? []).map((n) => ({
      noticeNo: n.noticeNo, title: n.title, content: n.cont,
    }));
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  async registerItem(p: DomainProduct): Promise<void> {
    const req: ItemSaveRequest = {
      itemCd: p.itemCd,
      itemClsCd: p.itemClsCd,
      itemTyCd: p.itemTypeCd ?? '2',      // Finished Product
      itemNm: p.name,
      itemStdNm: null,
      orgnNatCd: 'KE',
      pkgUnitCd: p.pkgUnitCd,
      qtyUnitCd: p.qtyUnitCd,
      taxTyCd: p.taxCode,
      btchNo: null,
      bcd: p.barcode ?? null,
      dftPrc: centsToEtimsDecimal(p.sellingPrice),
      grpPrcL1: null, grpPrcL2: null, grpPrcL3: null, grpPrcL4: null, grpPrcL5: null,
      addInfo: null,
      sftyQty: null,
      isrcAplcbYn: 'N',
      useYn: 'Y',
      regrId: this.config.operatorId,
      regrNm: this.config.operatorName,
      modrId: this.config.operatorId,
      modrNm: this.config.operatorName,
    };
    await this.call('/saveItem', req as unknown as Record<string, unknown>);
  }

  // ── Sales ─────────────────────────────────────────────────────────────────

  async submitSale(sale: DomainSale, invcNo: number): Promise<FiscalSignature> {
    const req = this.buildSalesRequest(sale, invcNo, 'S', 0);
    const data = await this.call<SalesSaveResponse>(
      '/saveTrnsSalesOsdc', req as unknown as Record<string, unknown>,
    );
    return this.toSignature(invcNo, data, req.pmtTyCd);
  }

  async submitCreditNote(note: DomainCreditNote, invcNo: number): Promise<FiscalSignature> {
    const asSale: DomainSale = {
      saleId: note.creditNoteId,
      localRef: `CN-${note.creditNoteId.slice(0, 8)}`,
      occurredAt: note.occurredAt,
      paymentMethods: ['OTHER'],
      lines: note.lines,
      subtotal: (note.total - note.taxTotal) as Cents,
      discountTotal: 0 as Cents,
      taxTotal: note.taxTotal,
      total: note.total,
    };
    const req = this.buildSalesRequest(asSale, invcNo, 'R', note.originalInvcNo);
    req.rfdRsnCd = note.reason;
    req.rfdDt = toKraDateTime(note.occurredAt);
    req.salesSttsCd = '05';   // Credit Note Generated

    const data = await this.call<SalesSaveResponse>(
      '/saveTrnsSalesOsdc', req as unknown as Record<string, unknown>,
    );
    return this.toSignature(invcNo, data, req.pmtTyCd);
  }

  private buildSalesRequest(
    sale: DomainSale, invcNo: number,
    rcptTyCd: 'S' | 'R', orgInvcNo: number,
  ): SalesSaveRequest {
    const bands = emptyBands();

    const itemList: SalesItem[] = sale.lines.map((l) => {
      const taxable = centsToEtimsDecimal(
        this.config.taxableAmountConvention === 'gross'
          ? l.taxableAmount
          : ((l.taxableAmount - l.taxAmount) as Cents),
      );
      const tax = centsToEtimsDecimal(l.taxAmount);

      bands.taxbl[l.taxCode] += taxable;
      bands.tax[l.taxCode] += tax;
      bands.rate[l.taxCode] = l.taxRateBp / 100;

      return {
        itemSeq: l.lineNo,
        itemCd: l.itemCd,
        itemClsCd: l.itemClsCd,
        itemNm: l.name,
        bcd: l.barcode ?? null,
        pkgUnitCd: l.pkgUnitCd,
        pkg: l.qty,
        qtyUnitCd: l.qtyUnitCd,
        qty: l.qty,
        prc: centsToEtimsDecimal(l.unitPrice),
        splyAmt: centsToEtimsDecimal(l.lineTotal),
        dcRt: 0,
        dcAmt: centsToEtimsDecimal(l.discount),
        isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
        taxTyCd: l.taxCode,
        taxblAmt: taxable,
        taxAmt: tax,
        totAmt: centsToEtimsDecimal(l.lineTotal),
      };
    });

    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      trdInvcNo: sale.localRef,
      invcNo,
      orgInvcNo,
      custTin: sale.customer?.kraPin ?? null,
      custNm: sale.customer?.name ?? null,
      salesTyCd: 'N',
      rcptTyCd,
      pmtTyCd: collapsePaymentMethods(sale.paymentMethods),
      salesSttsCd: '02',                       // Approved
      cfmDt: toKraDateTime(sale.occurredAt),
      salesDt: toKraDate(sale.occurredAt),
      stockRlsDt: toKraDateTime(sale.occurredAt),
      cnclReqDt: null, cnclDt: null, rfdDt: null, rfdRsnCd: null,
      totItemCnt: itemList.length,

      taxblAmtA: round2(bands.taxbl.A), taxblAmtB: round2(bands.taxbl.B),
      taxblAmtC: round2(bands.taxbl.C), taxblAmtD: round2(bands.taxbl.D),
      taxblAmtE: round2(bands.taxbl.E),
      taxRtA: bands.rate.A, taxRtB: bands.rate.B, taxRtC: bands.rate.C,
      taxRtD: bands.rate.D, taxRtE: bands.rate.E,
      taxAmtA: round2(bands.tax.A), taxAmtB: round2(bands.tax.B),
      taxAmtC: round2(bands.tax.C), taxAmtD: round2(bands.tax.D),
      taxAmtE: round2(bands.tax.E),

      totTaxblAmt: round2(Object.values(bands.taxbl).reduce((a, b) => a + b, 0)),
      totTaxAmt: round2(Object.values(bands.tax).reduce((a, b) => a + b, 0)),
      totAmt: centsToEtimsDecimal(sale.total),
      prchrAcptcYn: 'N',
      remark: null,
      regrId: this.config.operatorId,
      regrNm: this.config.operatorName,
      modrId: this.config.operatorId,
      modrNm: this.config.operatorName,
      receipt: {
        custTin: sale.customer?.kraPin ?? null,
        custMblNo: sale.customer?.phone ?? null,
        rcptPbctDt: toKraDateTime(sale.occurredAt),
        trdeNm: null, adrs: null, topMsg: null, btmMsg: null,
        prchrAcptcYn: 'N',
      },
      itemList,
    };
  }

  private toSignature(
    invcNo: number, d: SalesSaveResponse, pmtTyCd: FiscalSignature['pmtTyCd'],
  ): FiscalSignature {
    return {
      invcNo,
      curRcptNo: Number(d.curRcptNo),
      totRcptNo: Number(d.totRcptNo),
      intrlData: d.intrlData,
      rcptSign: d.rcptSign,
      sdcDateTime: parseKraDateTime(d.sdcDateTime),
      pmtTyCd,
      // ⚠️ K6 — the QR payload format is NOT documented in spec v2.0.
      // Left undefined deliberately rather than guessed. Populate once KRA
      // confirms the verification URL pattern during certification.
      qrPayload: undefined,
    };
  }

  // ── Stock ─────────────────────────────────────────────────────────────────
  // ORDERING IS MANDATORY: sale -> stockIO -> stockMaster. §0.3

  async submitStockIO(m: DomainStockMovement, sarNo: number): Promise<void> {
    const round2 = (n: number) => Math.round(n * 100) / 100;
    let totTaxbl = 0, totTax = 0, totAmt = 0;

    const itemList = m.lines.map((l, i) => {
      const taxable = centsToEtimsDecimal(l.taxableAmount);
      const tax = centsToEtimsDecimal(l.taxAmount);
      const amt = centsToEtimsDecimal(l.total);
      totTaxbl += taxable; totTax += tax; totAmt += amt;
      return {
        itemSeq: i + 1,
        itemCd: l.itemCd,
        itemClsCd: l.itemClsCd,
        itemNm: l.name,
        bcd: null,
        pkgUnitCd: l.pkgUnitCd,
        pkg: Math.abs(l.qty),
        qtyUnitCd: l.qtyUnitCd,
        qty: Math.abs(l.qty),
        itemExprDt: null,
        prc: centsToEtimsDecimal(l.unitPrice),
        splyAmt: amt,
        totDcAmt: 0,
        taxblAmt: taxable,
        taxTyCd: l.taxCode,
        taxAmt: tax,
        totAmt: amt,
      };
    });

    const req: StockIoSaveRequest = {
      sarNo,
      orgSarNo: sarNo,
      regTyCd: 'A',
      custTin: null, custNm: null, custBhfId: null,
      sarTyCd: m.ioType,
      ocrnDt: toKraDate(m.occurredAt),
      totItemCnt: itemList.length,
      totTaxblAmt: round2(totTaxbl),
      totTaxAmt: round2(totTax),
      totAmt: round2(totAmt),
      remark: null,
      regrId: this.config.operatorId,
      regrNm: this.config.operatorName,
      modrId: this.config.operatorId,
      modrNm: this.config.operatorName,
      itemList,
    };
    await this.call('/insertStockIO', req as unknown as Record<string, unknown>);
  }

  async submitStockMaster(itemCd: string, remainingQty: number): Promise<void> {
    await this.call('/saveStockMaster', {
      itemCd,
      rsdQty: remainingQty,
      regrId: this.config.operatorId,
      regrNm: this.config.operatorName,
      modrId: this.config.operatorId,
      modrNm: this.config.operatorName,
    });
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.syncCodeList(new Date(Date.now() - 86_400_000));
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        reachable: false,
        latencyMs: Date.now() - started,
        message: err instanceof EtimsError ? `${err.resultCd}: ${err.message}` : String(err),
      };
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function emptyBands() {
  const zero = (): Record<TaxTypeCode, number> => ({ A: 0, B: 0, C: 0, D: 0, E: 0 });
  return { taxbl: zero(), tax: zero(), rate: zero() };
}

export function parseKraDateTime(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) throw new RangeError(`Invalid KRA datetime: "${s}"`);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Never let cmcKey reach a log, an error report, or the database. */
function redact(body: Record<string, unknown>): Record<string, unknown> {
  const { cmcKey, ...safe } = body;
  return cmcKey ? { ...safe, cmcKey: '[REDACTED]' } : safe;
}
