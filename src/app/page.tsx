import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { serverClient, readClaims } from '@/lib/supabase/clients';

export const dynamic = 'force-dynamic';

/**
 * The root just routes. Where you land depends on what kind of account you are.
 *
 * Wrapped in a guard because a missing environment variable here surfaces as
 * "An error occurred in the Server Components render" with only a digest —
 * which tells an operator nothing. Sending them to /setup names the actual
 * problem instead.
 */
export default async function Home() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    redirect('/setup');
  }

  const store = await cookies();
  const supabase = serverClient({
    getAll: () => store.getAll(),
    setAll: (all) => all.forEach((c) => store.set(c.name, c.value, c.options)),
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const claims = readClaims(session.access_token);
  redirect(claims?.userRole === 'DEVICE' ? '/till' : '/admin');
}
