import { cookies } from 'next/headers';
import { serverClient, readClaims, MISSING_CLAIMS_MESSAGE } from '@/lib/supabase/clients';
import Link from 'next/link';
import { TillBoot } from '@/components/till/TillBoot';

export const dynamic = 'force-dynamic';

/**
 * Resolves session context on the server, then hands off to the client.
 * Two setup failures are named explicitly rather than surfacing as a wall of
 * denied RLS queries, because both are easy to hit and hard to diagnose:
 *   - not signed in as a device account
 *   - signed in, but the JWT claims hook is not enabled
 */
export default async function TillPage() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return <Blocked
      title="Sign in required"
      body="This till is not signed in. Use the device account for this machine, for example till01@…" />;
  }

  const claims = readClaims(session.access_token);
  if (!claims) return <Blocked title="Setup incomplete" body={MISSING_CLAIMS_MESSAGE} />;

  // An owner or supervisor landing here took a wrong turn rather than hitting
  // a fault. Say so, and give them the door.
  if (!claims.deviceId) {
    const isStaff = claims.userRole === 'OWNER' || claims.userRole === 'SUPERVISOR';
    return (
      <Blocked
        title={isStaff ? 'This is the till screen' : 'Not a till account'}
        body={isStaff
          ? `You are signed in as ${claims.userRole.toLowerCase()}. Selling happens on a till account (till01@…). The admin screens are where you want to be.`
          : 'This account is not linked to a device. A supervisor must attach it to a till.'}
        action={isStaff ? { href: '/admin', label: 'Go to admin' } : undefined}
      />
    );
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('legal_name, trading_name, kra_pin, address, phone, vat_registered')
    .eq('business_id', claims.businessId)
    .single();

  const { data: openShift } = await supabase
    .from('shifts')
    .select('shift_id')
    .eq('device_id', claims.deviceId)
    .eq('status', 'OPEN')
    .maybeSingle();

  return (
    <TillBoot
      claims={claims}
      business={business ?? null}
      openShiftId={openShift?.shift_id ?? null}
    />
  );
}

function Blocked({
  title, body, action,
}: { title: string; body: string; action?: { href: string; label: string } }) {
  return (
    <main style={{
      minHeight: '100dvh', display: 'grid', placeContent: 'center', padding: 32,
      background: '#0E1A14', color: '#F2F6F0',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      maxWidth: 560, margin: '0 auto', gap: 10,
    }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>{title}</h1>
      <p style={{ color: '#9DB3A4', lineHeight: 1.55, margin: 0 }}>{body}</p>
      {action && (
        <Link href={action.href} className="till-btn"
          style={{ display: 'grid', placeContent: 'center', marginTop: 8 }}>
          {action.label}
        </Link>
      )}
    </main>
  );
}
