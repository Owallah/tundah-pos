'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { LoadOut } from '@/components/admin/LoadOut';

export function LoadOutClient(props: { eventId: string | null; eventName: string }) {
  const supabase = useMemo(() => browserClient(), []);
  return <LoadOut supabase={supabase} {...props} />;
}
