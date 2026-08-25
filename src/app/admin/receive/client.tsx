'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { GoodsReceived } from '@/components/admin/GoodsReceived';

export function ReceiveClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <GoodsReceived supabase={supabase} />;
}
