/**
 * NullEtimsProvider — the "not onboarded yet" implementation.
 *
 * THIS IS WHAT MAKES THE SCHEDULE WORK. It lets the entire POS run at real
 * events, taking real money, before KRA certification completes. Submissions
 * are marked SKIPPED rather than failing, so the queue does not back up and
 * the owner dashboard shows an honest "eTIMS not enabled" state.
 *
 * It never fabricates a signature. There is no such thing as an offline
 * fiscal invoice (ARCHITECTURE §0.1), so the receipt stays PROVISIONAL.
 */
import type {
  EtimsProvider, DeviceInitResult, DomainSale, DomainCreditNote,
  DomainProduct, DomainStockMovement, FiscalSignature, ProviderCapability,
} from '../provider';
import type { CodeClass, ItemClassification } from '../types';

export class NullEtimsProvider implements EtimsProvider {
  readonly capability: ProviderCapability = 'DISABLED';
  readonly name = 'null';

  private refuse(op: string): never {
    throw new Error(
      `eTIMS is not enabled (${op}). Sales complete and receipts print as ` +
      `PROVISIONAL. Enable by setting ETIMS_PROVIDER=oscu once KRA ` +
      `certification is complete.`,
    );
  }

  async initialiseDevice(): Promise<DeviceInitResult> { this.refuse('initialiseDevice'); }
  async submitSale(_s: DomainSale, _n: number): Promise<FiscalSignature> { this.refuse('submitSale'); }
  async submitCreditNote(_c: DomainCreditNote, _n: number): Promise<FiscalSignature> { this.refuse('submitCreditNote'); }

  // These no-op rather than throw: the worker marks them SKIPPED and moves on.
  async syncCodeList(): Promise<CodeClass[]> { return []; }
  async syncItemClassifications(): Promise<ItemClassification[]> { return []; }
  async registerItem(_p: DomainProduct): Promise<void> { /* no-op */ }
  async submitStockIO(_m: DomainStockMovement, _n: number): Promise<void> { /* no-op */ }
  async submitStockMaster(_c: string, _q: number): Promise<void> { /* no-op */ }
  async fetchNotices(): Promise<Array<{ noticeNo: number; title: string; content: string }>> { return []; }

  async healthCheck() {
    return { reachable: false, message: 'eTIMS provider disabled (NullEtimsProvider)' };
  }
}
