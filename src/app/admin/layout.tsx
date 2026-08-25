import { cookies } from 'next/headers';
import { serverClient, readClaims } from '@/lib/supabase/clients';
import { AdminShell } from '@/components/admin/AdminShell';

/**
 * Admin routes are supervisor/owner only. This is a convenience gate — the
 * real enforcement is RLS plus the auth_is_staff() checks inside every admin
 * RPC. A cashier reaching this URL directly is still refused by the database.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: { session } } = await supabase.auth.getSession();
  const claims = session ? readClaims(session.access_token) : null;

  if (!claims || !['OWNER', 'SUPERVISOR'].includes(claims.userRole)) {
    return (
      <main style={{
        minHeight: '100dvh', display: 'grid', placeContent: 'center', padding: 32,
        background: '#0E1A14', color: '#F2F6F0',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif', textAlign: 'center', gap: 10,
      }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Supervisors only</h1>
        <p style={{ color: '#9DB3A4', margin: 0, maxWidth: '44ch' }}>
          Sign in with a supervisor or owner account to manage prices, stock
          and payments.
        </p>
        <a href="/login" style={{ color: '#3ECF8E' }}>Sign in</a>
      </main>
    );
  }

  const label = `${session!.user.email ?? ''} · ${claims.userRole.toLowerCase()}`;
  return <AdminShell userLabel={label}>{children}</AdminShell>;
}
