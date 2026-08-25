import { cookies } from 'next/headers';
import { serverClient } from '@/lib/supabase/clients';
import { LoadOutClient } from './client';

export const dynamic = 'force-dynamic';

export default async function LoadOutPage() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: event } = await supabase
    .from('events').select('event_id, name').eq('status', 'ACTIVE').maybeSingle();

  return <LoadOutClient eventId={event?.event_id ?? null} eventName={event?.name ?? ''} />;
}
