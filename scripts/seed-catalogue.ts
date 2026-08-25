#!/usr/bin/env tsx
/**
 * scripts/seed-catalogue.ts
 *
 * Imports the accountant's classified catalogue CSV into Supabase.
 * Idempotent: upserts on (business_id, sku), so re-run it after every
 * classification update without creating duplicates.
 *
 *   npm run seed:catalogue -- --file supabase/seed/catalogue.csv
 *   npm run seed:catalogue -- --file ... --dry-run
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only).
 */

import { readFileSync } from 'node:fs';
import { parseKes } from '../src/lib/money/money';

interface Row {
  sku: string;
  name: string;
  short_name?: string;
  category?: string;
  uom: string;
  cost_price: string;
  selling_price: string;
  etims_tax_ty_cd?: string;
  etims_item_cls_cd?: string;
  pkg_unit_cd?: string;
  qty_unit_cd?: string;
  track_stock?: string;
  barcode?: string;
  tile_order?: string;
}

const VALID_TAX_TYPES = ['A', 'B', 'C', 'D', 'E'];

/** Minimal RFC4180 parser — handles quoted fields containing commas. */
function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) throw new Error('Empty CSV');

  const keys = header.map((h) => h.trim());
  return body.map((cells) => {
    const obj: Record<string, string> = {};
    keys.forEach((k, i) => { obj[k] = (cells[i] ?? '').trim(); });
    return obj as unknown as Row;
  });
}

interface Validated {
  ok: Array<Row & { sellable: boolean }>;
  errors: string[];
  unclassified: string[];
}

function validate(rows: Row[]): Validated {
  const errors: string[] = [];
  const unclassified: string[] = [];
  const seen = new Set<string>();
  const ok: Array<Row & { sellable: boolean }> = [];

  rows.forEach((r, idx) => {
    const line = idx + 2;

    if (!r.sku) { errors.push(`Line ${line}: missing sku`); return; }
    if (seen.has(r.sku)) { errors.push(`Line ${line}: duplicate sku "${r.sku}"`); return; }
    seen.add(r.sku);

    if (!r.name) errors.push(`Line ${line} (${r.sku}): missing name`);

    for (const field of ['cost_price', 'selling_price'] as const) {
      try { parseKes(r[field]); }
      catch { errors.push(`Line ${line} (${r.sku}): invalid ${field} "${r[field]}"`); }
    }

    if (r.uom && !['EA', 'KG', 'L', 'G', 'ML'].includes(r.uom)) {
      errors.push(`Line ${line} (${r.sku}): unexpected uom "${r.uom}"`);
    }

    const tax = (r.etims_tax_ty_cd ?? '').toUpperCase();
    if (tax && !VALID_TAX_TYPES.includes(tax)) {
      errors.push(`Line ${line} (${r.sku}): invalid tax type "${tax}"`);
    }
    if (!tax) unclassified.push(r.sku);

    if (r.short_name && r.short_name.length > 18) {
      errors.push(`Line ${line} (${r.sku}): short_name >18 chars, will overflow the tile`);
    }

    ok.push({ ...r, sellable: Boolean(tax) });
  });

  return { ok, errors, unclassified };
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : 'supabase/seed/catalogue.csv';
  const dryRun = args.includes('--dry-run');

  const rows = parseCsv(readFileSync(file, 'utf8'));
  const { ok, errors, unclassified } = validate(rows);

  console.log(`\nParsed ${rows.length} rows from ${file}`);

  if (errors.length) {
    console.error(`\n✗ ${errors.length} error(s):\n`);
    errors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }

  if (unclassified.length) {
    console.warn(
      `\n⚠  ${unclassified.length} product(s) have NO KRA tax type and CANNOT BE SOLD:\n`,
    );
    unclassified.forEach((s) => console.warn(`    ${s}`));
    console.warn(
      `\n   complete_sale() rejects these at the database level, so they cannot\n` +
      `   slip into a sale unclassified. Send this list to the accountant (Q7).\n` +
      `   Fresh/cut fruit vs blended drinks is the distinction that matters.\n`,
    );
  }

  const sellable = ok.filter((r) => r.sellable).length;
  console.log(`\n${sellable}/${ok.length} products are sellable today.`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.\n');
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const businessId = process.env.BUSINESS_ID;

  if (!url || !key || !businessId) {
    console.error(
      '\n✗ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and BUSINESS_ID are required.\n' +
      '  Use --dry-run to validate the CSV without them.\n',
    );
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Categories first.
  const categories = [...new Set(ok.map((r) => r.category).filter(Boolean))] as string[];
  const categoryIds = new Map<string, string>();

  for (const name of categories) {
    const { data, error } = await db
      .from('categories')
      .upsert({ business_id: businessId, name }, { onConflict: 'business_id,name' })
      .select('category_id, name')
      .single();
    if (error) throw new Error(`Category "${name}": ${error.message}`);
    categoryIds.set(name, data.category_id);
  }
  console.log(`Upserted ${categories.length} categories.`);

  const products = ok.map((r) => ({
    business_id: businessId,
    sku: r.sku,
    name: r.name,
    short_name: r.short_name || r.name.slice(0, 18),
    category_id: r.category ? categoryIds.get(r.category) : null,
    uom: r.uom || 'EA',
    cost_price_cents: parseKes(r.cost_price),
    selling_price_cents: parseKes(r.selling_price),
    etims_tax_ty_cd: r.etims_tax_ty_cd?.toUpperCase() || null,
    etims_item_cls_cd: r.etims_item_cls_cd || null,
    etims_pkg_unit_cd: r.pkg_unit_cd || 'NT',
    etims_qty_unit_cd: r.qty_unit_cd || 'U',
    track_stock: (r.track_stock ?? 'TRUE').toUpperCase() !== 'FALSE',
    tile_order: r.tile_order ? Number(r.tile_order) : 0,
    is_active: true,
  }));

  const { error } = await db
    .from('products')
    .upsert(products, { onConflict: 'business_id,sku' });
  if (error) throw new Error(`Product upsert failed: ${error.message}`);

  console.log(`Upserted ${products.length} products.`);

  const barcodes = ok
    .filter((r) => r.barcode)
    .map((r) => ({ barcode: r.barcode!, sku: r.sku }));

  if (barcodes.length) {
    const { data: prods } = await db
      .from('products')
      .select('product_id, sku')
      .eq('business_id', businessId)
      .in('sku', barcodes.map((b) => b.sku));

    const bySku = new Map((prods ?? []).map((p) => [p.sku, p.product_id]));
    const { error: bErr } = await db.from('product_barcodes').upsert(
      barcodes.map((b) => ({
        barcode: b.barcode,
        product_id: bySku.get(b.sku)!,
        business_id: businessId,
      })),
      { onConflict: 'barcode' },
    );
    if (bErr) throw new Error(`Barcode upsert failed: ${bErr.message}`);
    console.log(`Upserted ${barcodes.length} barcodes.`);
  }

  console.log('\n✓ Catalogue seeded.\n');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
