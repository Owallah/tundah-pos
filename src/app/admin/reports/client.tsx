'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { Reports } from '@/components/admin/Reports';

export function ReportsClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <Reports supabase={supabase} />;
}
