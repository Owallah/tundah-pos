/**
 * pos/catalogue.ts — the single mapper from `event_price_list` rows to
 * CatalogueItem.
 *
 * Extracted because it was written twice (till + backfill) and the branded
 * money types correctly refused the duplicate. Branded types earning their
 * keep: the compiler caught a copy-paste that would otherwise have drifted.
 */

import { cents, bp, type BasisPoints } from '../money/money';
import type { CatalogueItem } from './cart';

/** Shape returned by the event_price_list() RPC. */
export interface EventPriceRow {
  product_id: string;
  sku: string;
  name: string;
  short_name: string;
  category_id: string | null;
  category_name: string | null;
  uom: string;
  price_cents: number | string;
  base_price_cents: number | string;
  is_event_price: boolean;
  tax_ty_cd: string | null;
  tax_rate_bp: number | string;
  item_cls_cd: string | null;
  item_cd: string | null;
  track_stock: boolean;
  qty_on_hand: number | string;
  image_path: string | null;
  tile_order: number | string;
  sellable: boolean;
}

/**
 * Postgres returns bigint and numeric as strings over the wire to avoid
 * precision loss. Coercing here, once, is what keeps `Cents` honest
 * everywhere downstream.
 */
export function toCatalogueItem(row: EventPriceRow): CatalogueItem {
  return {
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    shortName: row.short_name || row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    uom: row.uom,
    priceCents: cents(Number(row.price_cents)),
    basePriceCents: cents(Number(row.base_price_cents)),
    isEventPrice: Boolean(row.is_event_price),
    taxCode: (row.tax_ty_cd as CatalogueItem['taxCode']) ?? null,
    taxRateBp: bp(Number(row.tax_rate_bp)) as BasisPoints,
    itemClsCd: row.item_cls_cd,
    itemCd: row.item_cd,
    trackStock: Boolean(row.track_stock),
    qtyOnHand: Number(row.qty_on_hand),
    imagePath: row.image_path,
    tileOrder: Number(row.tile_order),
    sellable: Boolean(row.sellable),
  };
}

export const toCatalogue = (rows: EventPriceRow[] | null): CatalogueItem[] =>
  (rows ?? []).map(toCatalogueItem);
