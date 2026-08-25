'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { EventPricing } from '@/components/admin/EventPricing';

export function EventPricingClient(props: { eventId: string; eventName: string }) {
  const supabase = useMemo(() => browserClient(), []);
  return <EventPricing supabase={supabase} {...props} />;
}
