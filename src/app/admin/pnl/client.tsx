'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { EventPnl } from '@/components/admin/EventPnl';

export function PnlClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <EventPnl supabase={supabase} />;
}
