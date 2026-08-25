'use client';

import { useMemo } from 'react';
import { browserClient } from '@/lib/supabase/clients';
import { ProductManager } from '@/components/admin/ProductManager';

export function ProductsClient() {
  const supabase = useMemo(() => browserClient(), []);
  return <ProductManager supabase={supabase} />;
}
