/**
 * middleware.ts — keeps the Supabase session alive.
 *
 * Server Components cannot write cookies, so without this the access token
 * expires and every server-side query starts returning "not signed in" while
 * the browser still looks logged in. On a till running a ten-hour shift that
 * is not a theoretical problem.
 *
 * Refreshing here also means the token is renewed BETWEEN customers rather
 * than reactively in the middle of a sale.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options));
      },
    },
  });

  // Touching getUser() is what triggers the refresh. Do not remove it.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith('/till') || path.startsWith('/admin');

  if (!user && isProtected) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.searchParams.set('next', path);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets, images, and the public receipt route —
    // a customer opening a receipt link must never be bounced to a login page.
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|r/).*)',
  ],
};
