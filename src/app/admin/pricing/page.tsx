import { cookies } from 'next/headers';
import { serverClient } from '@/lib/supabase/clients';
import { EventPricingClient } from './client';

export const dynamic = 'force-dynamic';

export default async function PricingPage() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: event } = await supabase
    .from('events')
    .select('event_id, name')
    .eq('status', 'ACTIVE')
    .maybeSingle();

  if (!event) {
    return (
      <main className="admin">
        <h1>No active event</h1>
        <p style={{ color: 'var(--till-ink-dim)' }}>
          Activate an event before setting its prices. Tills cannot open a
          shift without one either.
        </p>
      </main>
    );
  }

  return <EventPricingClient eventId={event.event_id} eventName={event.name} />;
}
