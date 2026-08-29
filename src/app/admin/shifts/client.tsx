'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { ShiftsReport } from '@/components/admin/ShiftsReport';

export function ShiftsClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <ShiftsReport supabase={supabase} />;
}
