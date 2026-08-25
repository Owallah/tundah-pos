'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { PaymentReconciliation } from '@/components/admin/PaymentReconciliation';

export function ReconciliationClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <PaymentReconciliation supabase={supabase} />;
}
