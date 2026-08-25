import Link from 'next/link';
import { cookies } from 'next/headers';
import { serverClient } from '@/lib/supabase/clients';

export const dynamic = 'force-dynamic';

/**
 * Admin home.
 *
 * Deliberately not a dashboard of charts. A supervisor opening this at a
 * venue wants to know three things: is an event active, are the tills
 * trading, and is anything waiting on me. Everything else is a click away.
 */
export default async function AdminHome() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const [{ data: event }, { data: shifts }, { data: variances }, { data: unclassified }] =
    await Promise.all([
    supabase.from('events').select('name, venue, status')
      .eq('status', 'ACTIVE').maybeSingle(),
    supabase.from('shifts')
      .select('shift_id, opened_at, devices(code), cashiers(full_name)')
      .eq('status', 'OPEN'),
    supabase.from('stock_variances').select('variance_id').eq('status', 'OPEN'),
    supabase.from('products').select('product_id')
      .is('etims_tax_ty_cd', null).eq('is_active', true),
  ]);

  // PostgREST returns embedded relations as arrays, even for a to-one
  // relationship. Normalise once here rather than at every use.
  const openShifts = ((shifts ?? []) as Array<{
    shift_id: string; opened_at: string;
    devices: Array<{ code: string }> | { code: string } | null;
    cashiers: Array<{ full_name: string }> | { full_name: string } | null;
  }>).map((s) => ({
    shiftId: s.shift_id,
    openedAt: s.opened_at,
    deviceCode: first(s.devices)?.code ?? '?',
    cashierName: first(s.cashiers)?.full_name ?? '?',
  }));

  return (
    <main className="admin">
      <header className="admin__head">
        <div>
          <h1>Admin</h1>
          <p>
            {event
              ? <>Active event: <strong style={{ color: 'var(--till-ink)' }}>{event.name}</strong>
                  {event.venue ? ` · ${event.venue}` : ''}</>
              : 'No event is active. Tills cannot open a shift until one is.'}
          </p>
        </div>
        <Link className="till-btn" href="/till"
          style={{ display: 'grid', placeContent: 'center', minWidth: 160 }}>
          Open a till
        </Link>
      </header>

      {!event && (
        <section className="admin__warn" role="alert">
          <strong>No active event</strong>
          <p>
            Exactly one event must have <code>status = &apos;ACTIVE&apos;</code>.
            Until then, opening a shift fails with &quot;no active event&quot;.
          </p>
        </section>
      )}

      <section className="recon__summary">
        <div className="recon__stat" data-tone={openShifts.length ? 'ok' : undefined}>
          <span className="till-total__label">Tills trading</span>
          <strong>{openShifts.length}</strong>
          <small>
            {openShifts.length === 0
              ? 'no shifts open'
              : openShifts.map((s) => `${s.deviceCode} · ${s.cashierName}`).join(' · ')}
          </small>
        </div>
        <div className="recon__stat" data-tone={variances?.length ? 'warn' : undefined}>
          <span className="till-total__label">Stock variances</span>
          <strong>{variances?.length ?? 0}</strong>
          <small>sold below recorded stock</small>
        </div>
        <div className="recon__stat" data-tone={unclassified?.length ? 'warn' : undefined}>
          <span className="till-total__label">Unsellable products</span>
          <strong>{unclassified?.length ?? 0}</strong>
          <small>no KRA tax type</small>
        </div>
      </section>

      <section className="admin__group">
        <h2>Before an event</h2>
        <div className="admin__nav">
          <Card
            href="/admin/events"
            title="Events"
            body="Create an event, make it active, close it when the stall packs up. Creating one also creates its stock location, which tills need to sell." />
          <Card
            href="/admin/products"
            title="Products"
            body="The catalogue, and the KRA tax type each item needs before it can be sold. Anything unclassified is pulled to the top." />
          <Card
            href="/admin/staff"
            title="Staff"
            body="Cashiers, PINs, discount limits and who may void or change a price. Also unlocks anyone locked out by failed PINs." />
          <Card
            href="/admin/receive"
            title="Receive stock"
            body="Goods arriving from a supplier into the base store. This is the first step — nothing can be loaded out or sold until stock has been received." />
          <Card
            href="/admin/loadout"
            title="Load out"
            body="Move stock from the base store to the stall, and back again afterwards. Recorded as double-entry so base stock stays real." />
        </div>
      </section>

      <section className="admin__group">
        <h2>During and after</h2>
        <div className="admin__nav">
          <Card
            href="/admin/pricing"
            title="Event pricing"
            body="Set prices for the active event, or copy them forward from a previous one." />
          <Card
            href="/admin/stock"
            title="Stock movements"
            body="Wastage, samples and corrections. For fresh produce this is a daily screen — unrecorded spoilage silently becomes shrinkage." />
          <Card
            href="/admin/sales"
            title="Sales"
            body="Reprint a receipt, or void a sale that has not yet reached KRA." />
          <Card
            href="/admin/reports"
            title="Reports"
            body="Sales by product, category, cashier, hour, payment method and date, plus VAT and stock valuation. Every table exports to CSV." />
          <Card
            href="/admin/pnl"
            title="Event P&L"
            body="Revenue less cost of goods, wastage and expenses, per event — and a comparison across events normalised per trading day." />
          <Card
            href="/admin/reconciliation"
            title="Payment reconciliation"
            body="Mismatched amounts, unverified manual codes, and money that arrived without a matching sale. Work the top three buckets; the rest are informational." />
          <Card
            href="/admin/backfill"
            title="Enter paper slips"
            body="After a connectivity outage, turn the duplicate receipt book into real sales. Enter the time written on the slip, not the time now." />
        </div>
      </section>
    </main>
  );
}

function first<T>(v: T[] | T | null | undefined): T | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="admin__card">
      <strong>{title}</strong>
      <span>{body}</span>
    </Link>
  );
}
