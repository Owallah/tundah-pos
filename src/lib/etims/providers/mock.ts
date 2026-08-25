/**
 * MockEtimsProvider — deterministic fake fiscalisation for CI and local dev.
 *
 * Signatures are derived from a hash of the payload so tests are repeatable.
 * Can simulate KRA failure modes so the submission worker's retry, halt and
 * idempotency paths are exercised without touching KRA.
 */
import { createHash } from 'node:crypto';
import type {
  EtimsProvider, DeviceInitResult, DomainSale, DomainCreditNote,
  DomainProduct, DomainStockMovement, FiscalSignature, ProviderCapability,
} from '../provider';
import { collapsePaymentMethods } from '../provider';
import { EtimsError, RESULT_CODE, type CodeClass, type ItemClassification } from '../types';

export interface MockOptions {
  /** Force the next N calls to fail with this code. */
  failWith?: { code: string; times: number };
  latencyMs?: number;
}

export class MockEtimsProvider implements EtimsProvider {
  readonly capability: ProviderCapability = 'MOCK';
  readonly name = 'mock';

  private counter = 0;
  private failures = 0;
  readonly submitted: Array<{ kind: string; ref: string; at: Date }> = [];

  constructor(private readonly opts: MockOptions = {}) {}

  private async gate(kind: string, ref: string): Promise<void> {
    if (this.opts.latencyMs) {
      await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    }
    if (this.opts.failWith && this.failures < this.opts.failWith.times) {
      this.failures++;
      throw new EtimsError(
        `Mock failure ${this.failures}/${this.opts.failWith.times}`,
        this.opts.failWith.code, `/mock/${kind}`,
      );
    }
    this.submitted.push({ kind, ref, at: new Date() });
  }

  private sign(seed: string): { intrlData: string; rcptSign: string } {
    const h = createHash('sha256').update(seed).digest('base64')
      .replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return { intrlData: h.slice(0, 26), rcptSign: h.slice(26, 42) };
  }

  async initialiseDevice(): Promise<DeviceInitResult> {
    return {
      dvcId: '9999900000000001', sdcId: 'KRACU0000000MOCK',
      mrcNo: 'MOCK0000001', cmcKey: 'mock-cmc-key-not-a-real-secret',
      taxpayerName: 'MOCK TAXPAYER', branchName: 'Headquarters',
    };
  }

  async syncCodeList(): Promise<CodeClass[]> {
    return [{
      cdCls: '04', cdClsNm: 'Taxation Type', cdClsDesc: null, useYn: 'Y',
      dtlList: [
        { cd: 'A', cdNm: 'A-EX', cdDesc: 'Exempt', srtOrd: 1, userDfnCd1: '0', userDfnCd2: null, userDfnCd3: null, useYn: 'Y' },
        { cd: 'B', cdNm: 'B-16.00%', cdDesc: 'Standard', srtOrd: 2, userDfnCd1: '16', userDfnCd2: null, userDfnCd3: null, useYn: 'Y' },
        { cd: 'C', cdNm: 'C-0%', cdDesc: 'Zero rated', srtOrd: 3, userDfnCd1: '0', userDfnCd2: null, userDfnCd3: null, useYn: 'Y' },
        { cd: 'D', cdNm: 'D', cdDesc: 'Non-VAT', srtOrd: 4, userDfnCd1: '0', userDfnCd2: null, userDfnCd3: null, useYn: 'Y' },
        { cd: 'E', cdNm: 'E-8%', cdDesc: 'Reduced', srtOrd: 5, userDfnCd1: '8', userDfnCd2: null, userDfnCd3: null, useYn: 'Y' },
      ],
    }];
  }

  async syncItemClassifications(): Promise<ItemClassification[]> {
    return [
      { itemClsCd: '50131500', itemClsNm: 'Fresh fruit', itemClsLvl: 4, taxTyCd: 'C', mjrTgYn: 'N', useYn: 'Y' },
      { itemClsCd: '50202301', itemClsNm: 'Fruit juice / smoothie', itemClsLvl: 5, taxTyCd: 'B', mjrTgYn: 'N', useYn: 'Y' },
    ];
  }

  async registerItem(p: DomainProduct): Promise<void> { await this.gate('ITEM', p.sku); }

  async submitSale(sale: DomainSale, invcNo: number): Promise<FiscalSignature> {
    await this.gate('SALE', sale.localRef);
    this.counter++;
    const { intrlData, rcptSign } = this.sign(`${sale.saleId}:${invcNo}`);
    return {
      invcNo, curRcptNo: this.counter, totRcptNo: this.counter,
      intrlData, rcptSign, sdcDateTime: new Date(),
      pmtTyCd: collapsePaymentMethods(sale.paymentMethods),
      qrPayload: `MOCK|${invcNo}|${rcptSign}`,
    };
  }

  async submitCreditNote(note: DomainCreditNote, invcNo: number): Promise<FiscalSignature> {
    await this.gate('CREDIT_NOTE', note.creditNoteId);
    this.counter++;
    const { intrlData, rcptSign } = this.sign(`${note.creditNoteId}:${invcNo}`);
    return {
      invcNo, curRcptNo: this.counter, totRcptNo: this.counter,
      intrlData, rcptSign, sdcDateTime: new Date(), pmtTyCd: '07',
      qrPayload: `MOCK|${invcNo}|${rcptSign}`,
    };
  }

  async submitStockIO(m: DomainStockMovement): Promise<void> { await this.gate('STOCK_IO', m.movementId); }
  async submitStockMaster(itemCd: string): Promise<void> { await this.gate('STOCK_MASTER', itemCd); }
  async fetchNotices() { return []; }
  async healthCheck() { return { reachable: true, latencyMs: 1, message: 'mock' }; }

  /** Test helper: assert KRA's mandatory ordering was respected. */
  assertOrdering(): void {
    const order = this.submitted.map((s) => s.kind);
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'STOCK_IO' && !order.slice(0, i).includes('SALE')) {
        throw new Error(`STOCK_IO submitted before any SALE (index ${i}) -- KRA returns ${RESULT_CODE.INVOICE_BEFORE_SALES}`);
      }
      if (order[i] === 'STOCK_MASTER' && !order.slice(0, i).includes('STOCK_IO')) {
        throw new Error(`STOCK_MASTER submitted before STOCK_IO (index ${i})`);
      }
    }
  }
}
