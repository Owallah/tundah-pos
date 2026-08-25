/**
 * supabase/clients.ts
 *
 * Three clients, three trust levels. Keeping them in one file makes the
 * distinction impossible to miss during review:
 *
 *   browser()  — anon key, RLS enforced. Ships to the client. Safe.
 *   server()   — anon key + the user's cookies. RLS enforced. Server only.
 *   service()  — SERVICE ROLE. Bypasses RLS entirely. Server only, and only
 *                for machine work: Daraja webhooks, the eTIMS worker, and
 *                the public receipt route.
 *
 * `service()` throws if it is ever reached in a browser bundle. That check is
 * cheap and it turns a catastrophic leak into a build-time crash.
 */

import { createBrowserClient, createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * ⚠️ These MUST be literal `process.env.NEXT_PUBLIC_X` references.
 *
 * Next.js inlines public env vars into the client bundle by STATIC STRING
 * REPLACEMENT at build time. It textually swaps `process.env.NEXT_PUBLIC_FOO`
 * for its value. A dynamic lookup — `process.env[name]` — cannot be analysed
 * statically, so it is left alone, and in the browser `process.env` is
 * effectively empty. The value would be present on the server and undefined
 * in the browser, which is a genuinely confusing way to fail.
 *
 * Do not refactor these into a loop, a map, or a helper that takes the name
 * as an argument. The literal form is load-bearing.
 */
const PUBLIC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLIC_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `${name} is not set.\n\n` +
      `  1. Is .env.local in the project root, next to package.json?\n` +
      `  2. Did you restart 'npm run dev' after creating it? Next.js only\n` +
      `     reads env files at startup.\n` +
      `  3. No quotes or trailing spaces around the value.\n\n` +
      `See DEMO-WALKTHROUGH.md step 7.`,
    );
  }
  return value;
}

/** Browser client. RLS applies; the JWT carries business_id and device_id. */
export function browserClient(): SupabaseClient {
  return createBrowserClient(
    required(PUBLIC_URL, 'NEXT_PUBLIC_SUPABASE_URL'),
    required(PUBLIC_ANON_KEY, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  );
}

export interface CookieAdapter {
  getAll(): Array<{ name: string; value: string }>;
  setAll(cookies: Array<{ name: string; value: string; options?: object }>): void;
}

/** Server client bound to the request's cookies. RLS still applies. */
export function serverClient(cookies: CookieAdapter): SupabaseClient {
  return createServerClient(
    required(PUBLIC_URL, 'NEXT_PUBLIC_SUPABASE_URL'),
    required(PUBLIC_ANON_KEY, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => cookies.getAll(),
        setAll: (all) => {
          try {
            cookies.setAll(all);
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session; ignoring here is correct.
          }
        },
      },
    },
  );
}

/**
 * SERVICE ROLE. Bypasses every RLS policy in the database.
 *
 * Legitimate callers, and nothing else:
 *   - Daraja C2B/STK webhook handlers (no user session exists)
 *   - The eTIMS submission worker
 *   - The public /r/{token} receipt route (unauthenticated by design)
 */
export function serviceClient(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serviceClient() was reached in the browser. The service role key ' +
      'bypasses RLS and must never leave the server.',
    );
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set.');

  // Server-only, so a dynamic lookup would be safe here — but keeping the
  // same literal form avoids anyone "tidying" the file back into a bug.
  return createClient(required(PUBLIC_URL, 'NEXT_PUBLIC_SUPABASE_URL'), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── JWT claims ──────────────────────────────────────────────────────────────

export interface TillClaims {
  businessId: string;
  userRole: 'OWNER' | 'SUPERVISOR' | 'CASHIER' | 'DEVICE';
  deviceId?: string;
  deviceCode?: string;
}

/**
 * Read the claims injected by custom_access_token_hook. If these are missing,
 * the hook is not enabled in the Supabase dashboard and every RLS policy will
 * deny — which is a confusing failure unless it is named explicitly.
 */
export function readClaims(accessToken: string): TillClaims | null {
  try {
    const [, payload] = accessToken.split('.');
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, string>;

    if (!json.business_id) return null;

    return {
      businessId: json.business_id,
      userRole: json.user_role as TillClaims['userRole'],
      deviceId: json.device_id,
      deviceCode: json.device_code,
    };
  } catch {
    return null;
  }
}

export const MISSING_CLAIMS_MESSAGE =
  'This account has no business claims. Enable the Custom Access Token hook ' +
  'in Supabase: Authentication → Hooks → Customize Access Token (JWT) Claims ' +
  '→ custom_access_token_hook.';
