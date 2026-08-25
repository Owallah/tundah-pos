'use client';

import { useEffect, useMemo, useState } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { BackfillSale } from '@/components/admin/BackfillSale';
import type { CatalogueItem } from '@/lib/pos/cart';
import { toCatalogue, type EventPriceRow } from '@/lib/pos/catalogue';

export function BackfillClient({
  eventId, shiftId, cashierId,
}: { eventId: string; shiftId: string; cashierId: string }) {
  const supabase = useMemo(() => browserClient(), []);
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('event_price_list', { p_event_id: eventId });
      setCatalogue(toCatalogue(data as EventPriceRow[] | null));
    })();
  }, [supabase, eventId]);

  return (
    <BackfillSale
      supabase={supabase}
      catalogue={catalogue}
      shiftId={shiftId}
      cashierId={cashierId}
      onDone={() => { window.location.href = '/till'; }}
    />
  );
}
