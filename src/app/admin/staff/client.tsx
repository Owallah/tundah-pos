'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { StaffManager } from '@/components/admin/StaffManager';

export function StaffClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <StaffManager supabase={supabase} />;
}
