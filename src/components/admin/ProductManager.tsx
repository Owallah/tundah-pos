'use client';

/**
 * ProductManager — the catalogue (INV-01, INV-02).
 *
 * The organising principle is the tax classification. A product without one
 * is rejected by complete_sale() at the database, so it is not a warning —
 * it is an unsellable item. Those are pulled to the top and counted in the
 * header, because discovering it at the till mid-queue is the worst case.
 *
 * Kenyan VAT for this business, as a reminder in the form itself:
 *   unprocessed fruit → usually A or C · blended drinks → B (16%)
 * The borderline cases (cut fruit, fresh juice) are the accountant's call.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';

interface ProductRow {
  product_id: string; sku: string; name: string; short_name: string | null;
  category: string | null; uom: string;
  cost_price_cents: number; selling_price_cents: number;
  tax_ty_cd: string | null; item_cls_cd: string | null; item_cd: string | null;
  track_stock: boolean; is_active: boolean; tile_order: number;
  qty_base: number; sellable: boolean;
}

const TAX_TYPES = [
  { code: 'B', label: 'B — Standard 16%', hint: 'Blended smoothies, prepared juice, packaged drinks' },
  { code: 'C', label: 'C — Zero rated', hint: 'Typically unprocessed produce' },
  { code: 'A', label: 'A — Exempt', hint: 'Exempt supplies' },
  { code: 'D', label: 'D — Non-VAT', hint: 'If the business is not VAT registered' },
  { code: 'E', label: 'E — 8%', hint: 'Reduced rate' },
];

export function ProductManager({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('list_products');
    if (err) setError(err.message);
    else setRows(data as ProductRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const unclassified = useMemo(() => rows.filter((r) => !r.sellable && r.is_active), [rows]);
  const ordered = useMemo(
    () => [...rows].sort((a, b) =>
      Number(a.sellable) - Number(b.sellable) || a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Products</h1>
          <p>
            {unclassified.length === 0
              ? 'Every active product has a KRA tax type and can be sold.'
              : `${unclassified.length} product${unclassified.length === 1 ? '' : 's'} cannot be sold until classified.`}
          </p>
        </div>
        <button className="till-btn till-btn--pay" style={{ minWidth: 180 }}
                onClick={() => setEditing('new')}>
          New product
        </button>
      </header>

      {unclassified.length > 0 && (
        <section className="admin__warn" role="alert">
          <strong>Unclassified — the till will refuse these</strong>
          <p>
            <code>complete_sale()</code> rejects any product without a tax
            type, so they cannot slip onto an invoice unclassified. Set the
            type your accountant specified.
          </p>
          <ul>{unclassified.map((r) => <li key={r.product_id}>{r.sku} · {r.name}</li>)}</ul>
        </section>
      )}

      {error && <p className="tender__error" role="alert">{error}</p>}

      {loading ? <p className="tender__hint">Loading…</p> : (
        <div className="recon">
          {ordered.map((row) => (
            <div className="recon__row" key={row.product_id}
                 data-urgent={!row.sellable && row.is_active ? 'true' : undefined}
                 style={!row.is_active ? { opacity: 0.5 } : undefined}>
              <div>
                <strong>{formatKes(row.selling_price_cents as Cents)}</strong>
                <small>
                  {row.name} · {row.sku}
                  {row.category ? ` · ${row.category}` : ''}
                  {!row.is_active && ' · INACTIVE'}
                </small>
                <small>
                  {row.tax_ty_cd
                    ? `Tax ${row.tax_ty_cd}${row.item_cls_cd ? ` · ${row.item_cls_cd}` : ' · no UNSPSC code'}`
                    : '⚠ no tax type — cannot be sold'}
                  {row.track_stock ? ` · ${row.qty_base} at base` : ' · not stock tracked'}
                </small>
              </div>
              <div className="recon__actions">
                <button className="till-cat" onClick={() => setEditing(row)}>Edit</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ProductForm supabase={supabase}
                     product={editing === 'new' ? null : editing}
                     existingCategories={
                       Array.from(new Set(
                         rows.map((r) => r.category).filter((c): c is string => !!c),
                       )).sort()
                     }
                     onDone={() => { setEditing(null); void load(); }}
                     onCancel={() => setEditing(null)} />
      )}
    </main>
  );
}

function ProductForm({
  supabase, product, existingCategories, onDone, onCancel,
}: {
  supabase: SupabaseClient; product: ProductRow | null;
  existingCategories: string[];
  onDone: () => void; onCancel: () => void;
}) {
  const [sku, setSku] = useState(product?.sku ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [shortName, setShortName] = useState(product?.short_name ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  // Free-text entry is only shown once "+ New category…" is picked, or when
  // editing a product whose category isn't in the known list for some
  // reason (renamed/deleted elsewhere) — never hide an existing value.
  const [addingCategory, setAddingCategory] = useState(
    !!category && !existingCategories.includes(category),
  );
  const [uom, setUom] = useState(product?.uom ?? 'EA');
  const [cost, setCost] = useState(
    product ? formatKes(product.cost_price_cents as Cents, false) : '');
  const [price, setPrice] = useState(
    product ? formatKes(product.selling_price_cents as Cents, false) : '');
  const [taxCode, setTaxCode] = useState(product?.tax_ty_cd ?? '');
  const [clsCode, setClsCode] = useState(product?.item_cls_cd ?? '');
  const [trackStock, setTrackStock] = useState(product?.track_stock ?? true);
  const [isActive, setIsActive] = useState(product?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc('upsert_product', {
        p_product_id: product?.product_id ?? null,
        p_sku: sku, p_name: name, p_short_name: shortName || name.slice(0, 18),
        p_category: category, p_uom: uom,
        p_cost_price_cents: cost ? parseKes(cost) : 0,
        p_selling_price_cents: parseKes(price),
        p_tax_ty_cd: taxCode || null,
        p_item_cls_cd: clsCode || null,
        p_track_stock: trackStock,
        p_is_active: isActive,
        p_tile_order: product?.tile_order ?? 0,
      });
      if (err) throw new Error(err.message);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const priceValid = (() => {
    try { parseKes(price); return true; } catch { return false; }
  })();

  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 520, borderColor: 'var(--till-line)' }}>
        <h2 className="till-block__title">
          {product ? product.name : 'New product'}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <div>
            <label className="boot__label" htmlFor="p-sku">SKU</label>
            <input id="p-sku" className="tender__input" style={textish}
                   value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="boot__label" htmlFor="p-name">Name</label>
            <input id="p-name" className="tender__input" style={textish}
                   value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label className="boot__label" htmlFor="p-short">Tile label</label>
            <input id="p-short" className="tender__input" style={textish} maxLength={18}
                   value={shortName} onChange={(e) => setShortName(e.target.value)}
                   placeholder="≤18 chars" />
          </div>
          <div>
            <label className="boot__label" htmlFor="p-cat">Category</label>
            {addingCategory ? (
              <input id="p-cat" className="tender__input" style={textish}
                     value={category} onChange={(e) => setCategory(e.target.value)}
                     placeholder="Smoothies" autoFocus
                     onBlur={() => {
                       // Empty new-category entry silently reverts to the
                       // dropdown rather than leaving the form stuck open
                       // on a blank required-looking field.
                       if (!category.trim() && existingCategories.length > 0) {
                         setAddingCategory(false);
                       }
                     }} />
            ) : (
              <select id="p-cat" className="tender__input" style={textish}
                      value={category}
                      onChange={(e) => {
                        if (e.target.value === '__new__') { setAddingCategory(true); setCategory(''); }
                        else setCategory(e.target.value);
                      }}>
                <option value="">No category</option>
                {existingCategories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
                <option value="__new__">+ New category…</option>
              </select>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div>
            <label className="boot__label" htmlFor="p-uom">Unit</label>
            <select id="p-uom" className="tender__input" style={textish}
                    value={uom} onChange={(e) => setUom(e.target.value)}>
              <option value="EA">Each</option>
              <option value="KG">Kilogram</option>
              <option value="LTR">Litre</option>
            </select>
          </div>
          <div>
            <label className="boot__label" htmlFor="p-cost">Cost</label>
            <input id="p-cost" className="tender__input" inputMode="decimal"
                   value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="boot__label" htmlFor="p-price">Sell price</label>
            <input id="p-price" className="tender__input" inputMode="decimal"
                   value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <p className="tender__hint">Prices include VAT, as shown to the customer.</p>

        <label className="boot__label" htmlFor="p-tax">KRA tax type</label>
        <select id="p-tax" className="tender__input" style={textish}
                value={taxCode} onChange={(e) => setTaxCode(e.target.value)}>
          <option value="">Not classified — cannot be sold</option>
          {TAX_TYPES.map((t) => (
            <option key={t.code} value={t.code}>{t.label}</option>
          ))}
        </select>
        <p className="tender__hint">
          {taxCode
            ? TAX_TYPES.find((t) => t.code === taxCode)?.hint
            : 'Unprocessed fruit is usually A or C; blended drinks are B. Cut fruit and fresh juice are contested — ask the accountant.'}
        </p>

        <label className="boot__label" htmlFor="p-cls">UNSPSC item class</label>
        <input id="p-cls" className="tender__input" style={textish} maxLength={10}
               value={clsCode} onChange={(e) => setClsCode(e.target.value)}
               placeholder="e.g. 50131500" />
        <p className="tender__hint">
          From KRA&rsquo;s classification list. Needed before eTIMS go-live, not
          before selling.
        </p>

        <div style={{ display: 'flex', gap: 20, marginTop: 14, flexWrap: 'wrap' }}>
          <label style={checkbox}>
            <input type="checkbox" checked={trackStock} style={box}
                   onChange={(e) => setTrackStock(e.target.checked)} />
            Track stock
          </label>
          <label style={checkbox}>
            <input type="checkbox" checked={isActive} style={box}
                   onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
        </div>

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '16px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!sku.trim() || !name.trim() || !priceValid || busy}
                  onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const textish: React.CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 'var(--step-base)',
};
const checkbox: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  color: 'var(--till-ink-dim)', fontSize: 'var(--step-sm)',
};
const box: React.CSSProperties = { width: 20, height: 20 };
