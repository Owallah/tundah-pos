import { cookies } from 'next/headers';
import { serverClient } from '@/lib/supabase/clients';
import { BackfillClient } from './client';

export const dynamic = 'force-dynamic';

export default async function BackfillPage() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: event } = await supabase
    .from('events').select('event_id, name').eq('status', 'ACTIVE').maybeSingle();

  const { data: shift } = await supabase
    .from('shifts').select('shift_id, cashier_id').eq('status', 'OPEN')
    .order('opened_at', { ascending: false }).limit(1).maybeSingle();

  if (!event || !shift) {
    return (
      <main className="admin">
        <h1>Cannot enter slips yet</h1>
        <p style={{ color: 'var(--till-ink-dim)', maxWidth: '52ch' }}>
          Paper slips are entered against an open shift on an active event.
          Have a till open its shift first, then come back — the slips will
          be attributed to that shift.
        </p>
      </main>
    );
  }

  return (
    <BackfillClient
      eventId={event.event_id}
      shiftId={shift.shift_id}
      cashierId={shift.cashier_id}
    />
  );
}
