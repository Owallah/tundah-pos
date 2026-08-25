import { cookies } from 'next/headers';
import { serverClient } from '@/lib/supabase/clients';
import { StockClient } from './client';

export const dynamic = 'force-dynamic';

export default async function StockPage() {
  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: event } = await supabase
    .from('events').select('event_id').eq('status', 'ACTIVE').maybeSingle();

  return <StockClient eventId={event?.event_id ?? null} />;
}
