'use client';

/**
 * AdminShell — navigation and sign-out for every admin screen.
 *
 * Previously `/admin/layout.tsx` rendered `{children}` with no chrome at all:
 * no sign-out, no links between the screens, no way back to `/admin` from a
 * sub-page. The only exit from `/admin/pricing` was the browser back button.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
import { browserClient } from '@/lib/supabase/clients';

// Grouped by when you use them: setup before an event, then operations
// during and after it.
const SETUP = [
  { href: '/admin/events', label: 'Events' },
  { href: '/admin/receive', label: 'Receive stock' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/pricing', label: 'Pricing' },
  { href: '/admin/staff', label: 'Staff' },
  { href: '/admin/loadout', label: 'Load out' },
];

const OPERATIONS = [
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/pnl', label: 'P&L' },
  { href: '/admin/stock', label: 'Stock' },
  { href: '/admin/sales', label: 'Sales' },
  { href: '/admin/shifts', label: 'Shifts' },
  { href: '/admin/reconciliation', label: 'Payments' },
  { href: '/admin/backfill', label: 'Paper slips' },
];

interface NavLink { href: string; label: string; exact?: boolean }

const LINKS: NavLink[] = [
  { href: '/admin', label: 'Overview', exact: true },
  ...SETUP, ...OPERATIONS,
];

export function AdminShell({
  children, userLabel,
}: { children: React.ReactNode; userLabel: string }) {
  const supabase = useMemo(() => browserClient(), []);
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    await supabase.auth.signOut();
    // Full navigation so server components drop the stale session cookie.
    window.location.href = '/login';
  };

  return (
    <div className="shell">
      <nav className="shell__nav" aria-label="Admin sections">
        <Link href="/admin" className="shell__brand">Tundah Taamu Delights Ltd</Link>

        <div className="shell__links">
          {LINKS.map((l) => {
            const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} className="shell__link"
                    aria-current={active ? 'page' : undefined}>
                {l.label}
              </Link>
            );
          })}
        </div>

        <div className="shell__user">
          <span>{userLabel}</span>
          <Link href="/till" className="shell__ghost">Till</Link>
          <button className="shell__ghost" onClick={() => void signOut()} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </nav>

      {children}
    </div>
  );
}
