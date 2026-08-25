'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { EventManager } from '@/components/admin/EventManager';

export function EventsClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <EventManager supabase={supabase} />;
}
