'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { StockAdjust } from '@/components/admin/StockAdjust';

export function StockClient({ eventId }: { eventId: string | null }) {
  const supabase = useMemo(() => browserClient(), []);
  return <StockAdjust supabase={supabase} eventId={eventId} />;
}
