'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { SalesHistory } from '@/components/admin/SalesHistory';

export function SalesClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <SalesHistory supabase={supabase} />;
}
