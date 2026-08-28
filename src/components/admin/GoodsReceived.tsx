'use client';

/**
 * GoodsReceived — the first link in the stock chain (INV-05, §14).
 *
 *   Buy from supplier → BASE STORE → load out → EVENT STALL → sale
 *   ^^^^^^^^^^^^^^^^^   this screen
 *
 * Without it there is no supported way to put stock into the system, and
 * every product reads zero at the till.
 *
 * Cost price is captured per line and updated on the product, because COGS
 * and every margin figure come from the cost recorded at the moment of sale.
 * If receiving does not maintain cost, margins are fiction. Movements already
 * written keep the cost they captured, so historic margin never shifts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatKes, parseKes, cents, type Cents } from '../../lib/money/money';

interface SheetRow {
  product_id: string; sku: string; name: string;
  category: string | null; uom: string;
  qty_base: number; qty_all_locations: number;
  cost_price_cents: number; selling_price_cents: number;
  reorder_point: number | null; below_reorder: boolean; sellable: boolean;
}

interface Supplier { supplier_id: string; name: string; phone: string | null }

interface Entry { qty: string; cost: string }

export function GoodsReceived({ supabase }: { supabase: SupabaseClient }) {
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [updateCost, setUpdateCost] = useState(true);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [{ data: sheet, error: e1 }, { data: sups }] = await Promise.all([
      supabase.rpc('goods_received_sheet'),
      supabase.rpc('list_suppliers'),
    ]);
    if (e1) setError(e1.message);
    else setRows(sheet as SheetRow[]);
    setSuppliers((sups as Supplier[] | null) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const entered = useMemo(
    () => Object.entries(entries)
      .map(([id, e]) => ({ id, qty: Number(e.qty), cost: e.cost }))
      .filter((e) => Number.isFinite(e.qty) && e.qty > 0),
    [entries],
  );

  const totalCost = useMemo(() => {
    let sum = 0;
    for (const e of entered) {
      const row = rows.find((r) => r.product_id === e.id);
      if (!row) continue;
      let unit = row.cost_price_cents;
      if (e.cost.trim()) {
        try { unit = parseKes(e.cost); } catch { /* fall back to current */ }
      }
      sum += unit * e.qty;
    }
    return cents(Math.round(sum)) as Cents;
  }, [entered, rows]);

  const lowStock = useMemo(() => rows.filter((r) => r.below_reorder), [rows]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const lines = entered.map((e) => {
        const line: Record<string, unknown> = { product_id: e.id, qty: e.qty };
        if (e.cost.trim()) line.unit_cost_cents = parseKes(e.cost);
        return line;
      });

      const { data, error: err } = await supabase.rpc('record_goods_received', {
        p_lines: lines,
        p_supplier_id: supplierId || null,
        p_reference: reference || null,
        p_update_cost: updateCost,
        p_received_on: receivedOn,
      });
      if (err) throw new Error(err.message);

      const r = data as { lines: number; total_cost_cents: number; supplier: string | null };
      setNote(
        `Received ${r.lines} product${r.lines === 1 ? '' : 's'} · ` +
        `${formatKes(r.total_cost_cents as Cents)}` +
        (r.supplier ? ` from ${r.supplier}` : '') + '.',
      );
      setEntries({});
      setReference('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setEntry = (id: string, patch: Partial<Entry>) =>
    setEntries((s) => {
      const current: Entry = s[id] ?? { qty: '', cost: '' };
      return { ...s, [id]: { ...current, ...patch } };
    });

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Receive stock</h1>
          <p>
            Goods arriving from a supplier into the base store. From there,
            use <b>Load out</b> to send them to an event stall.
          </p>
        </div>
      </header>

      {note && <p className="admin__ok" role="status">{note}</p>}
      {error && <p className="tender__error" role="alert">{error}</p>}

      {lowStock.length > 0 && (
        <section className="admin__warn" style={{
          background: 'rgba(246,129,36,.10)', borderLeftColor: 'var(--brand-mango)' }}>
          <strong>{lowStock.length} product{lowStock.length === 1 ? '' : 's'} at or below reorder point</strong>
          <ul>{lowStock.map((r) => (
            <li key={r.product_id}>
              {r.name} — {r.qty_all_locations} left (reorder at {r.reorder_point})
            </li>
          ))}</ul>
        </section>
      )}

      <section className="admin__copy" style={{ display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', alignItems: 'end' }}>
        <div>
          <label className="boot__label" htmlFor="sup">Supplier</label>
          <select id="sup" className="admin__input"
                  style={{ width: '100%', textAlign: 'left' }}
                  value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Not recorded</option>
            {suppliers.map((s) => (
              <option key={s.supplier_id} value={s.supplier_id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="boot__label" htmlFor="ref">Delivery note / invoice</label>
          <input id="ref" className="admin__input" style={{ width: '100%', textAlign: 'left' }}
                 value={reference} onChange={(e) => setReference(e.target.value)}
                 placeholder="e.g. GRN-001" />
        </div>
        <div>
          <label className="boot__label" htmlFor="on">Received on</label>
          <input id="on" type="date" className="admin__input"
                 style={{ width: '100%', textAlign: 'left' }}
                 value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </div>
        <button className="till-cat" onClick={() => setAddingSupplier(true)}>
          Add supplier
        </button>
      </section>

      {loading ? <p className="tender__hint">Loading…</p> : (
        <section className="admin__group">
          <div className="admin__table-scroll">
          <table className="admin__table">
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>In base</th>
                <th style={{ textAlign: 'right' }}>Current cost</th>
                <th style={{ textAlign: 'right' }}>Receiving</th>
                <th style={{ textAlign: 'right' }}>New cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.product_id} data-sellable={row.sellable}>
                  <td>
                    {row.name}
                    <small>
                      {row.sku}
                      {!row.sellable && ' · not classified — cannot be sold'}
                      {row.below_reorder && ' · below reorder point'}
                    </small>
                  </td>
                  <td className="n">{row.qty_base}</td>
                  <td className="n">{formatKes(row.cost_price_cents as Cents, false)}</td>
                  <td className="n">
                    <input className="admin__input" inputMode="decimal" placeholder="0"
                           style={{ width: 96 }}
                           aria-label={`Quantity received for ${row.name}`}
                           value={entries[row.product_id]?.qty ?? ''}
                           onChange={(e) => setEntry(row.product_id, { qty: e.target.value })} />
                  </td>
                  <td className="n">
                    <input className="admin__input" inputMode="decimal"
                           style={{ width: 110 }}
                           placeholder={formatKes(row.cost_price_cents as Cents, false)}
                           aria-label={`New unit cost for ${row.name}`}
                           value={entries[row.product_id]?.cost ?? ''}
                           onChange={(e) => setEntry(row.product_id, { cost: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="tender__hint">
            Leave <b>New cost</b> blank to keep the current cost. Entering one
            updates the product so the next sale computes margin against what
            you actually paid — sales already recorded keep their original cost.
          </p>
        </section>
      )}

      <div className="loadout__bar">
        <div>
          <span className="till-total__label">
            {entered.length} product{entered.length === 1 ? '' : 's'}
          </span>
          <strong className="till-total__value" style={{ fontSize: 'var(--t-lg)' }}>
            {formatKes(totalCost, false)}
          </strong>
          <small style={{ color: 'var(--ink-dim)' }}> total cost</small>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8,
          color: 'var(--ink-dim)', fontSize: 'var(--t-sm)' }}>
          <input type="checkbox" checked={updateCost} style={{ width: 20, height: 20 }}
                 onChange={(e) => setUpdateCost(e.target.checked)} />
          Update cost prices
        </label>
        <button className="till-btn till-btn--pay" style={{ minWidth: 220 }}
                disabled={entered.length === 0 || busy}
                onClick={() => void submit()}>
          {busy ? 'Recording…' : 'Confirm receipt'}
        </button>
      </div>

      {addingSupplier && (
        <SupplierForm supabase={supabase}
                      onDone={() => { setAddingSupplier(false); void load(); }}
                      onCancel={() => setAddingSupplier(false)} />
      )}
    </main>
  );
}

function SupplierForm({
  supabase, onDone, onCancel,
}: { supabase: SupabaseClient; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [kraPin, setKraPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('upsert_supplier', {
      p_supplier_id: null, p_name: name, p_phone: phone, p_kra_pin: kraPin,
    });
    if (err) { setError(err.message); setBusy(false); return; }
    onDone();
  };

  return (
    <div className="till-block" role="dialog" aria-modal="true">
      <div className="till-block__card" style={{ maxWidth: 420 }}>
        <h2 className="till-block__title">Add supplier</h2>

        <label className="boot__label" htmlFor="sn">Name</label>
        <input id="sn" className="tender__input" style={textish}
               value={name} onChange={(e) => setName(e.target.value)}
               placeholder="e.g. Wakulima Market" />

        <label className="boot__label" htmlFor="sp">Phone</label>
        <input id="sp" className="tender__input" style={textish}
               value={phone} onChange={(e) => setPhone(e.target.value)} />

        <label className="boot__label" htmlFor="sk">KRA PIN (optional)</label>
        <input id="sk" className="tender__input" style={textish}
               value={kraPin} onChange={(e) => setKraPin(e.target.value.toUpperCase())}
               placeholder="Needed later for eTIMS purchase records" />

        {error && <p className="tender__error" role="alert">{error}</p>}

        <div className="till-actions" style={{ padding: '16px 0 0' }}>
          <button className="till-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="till-btn till-btn--pay" style={{ gridColumn: 'auto' }}
                  disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

const textish: React.CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 'var(--t-base)',
};