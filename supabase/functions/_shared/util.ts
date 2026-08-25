/**
 * Shared helpers for Daraja webhooks.
 *
 * Two rules govern every handler in this directory:
 *
 *   1. ALWAYS return HTTP 200 to Safaricom, even on internal failure.
 *      A non-200 makes Safaricom retry, and retries of a handler that is
 *      already broken produce a duplicate storm on top of an outage.
 *      Failures are logged and surfaced on the reconciliation screen.
 *
 *   2. Store the raw payload BEFORE parsing. If our parsing assumptions are
 *      wrong, the evidence still exists.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/** Safaricom's published source IPs. Verify against current Daraja docs. */
export const SAFARICOM_IPS = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74', '196.201.212.69',
];

export function sourceIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : null;
}

export function isSafaricom(req: Request): boolean {
  const ip = sourceIp(req);
  return ip !== null && SAFARICOM_IPS.includes(ip);
}

/** Service role: webhooks have no user session, so RLS cannot apply. */
export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Daraja expects this exact shape. Any other body is treated as failure. */
export const accepted = () =>
  new Response(
    JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

export const rejected = (reason: string) =>
  new Response(
    JSON.stringify({ ResultCode: 'C2B00016', ResultDesc: reason }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/**
 * Log an inbound callback verbatim before any interpretation. This has saved
 * more integrations than any amount of defensive parsing.
 */
export async function logRaw(
  db: SupabaseClient, kind: string, body: unknown, ip: string | null,
) {
  await db.from('webhook_log').insert({
    kind, source_ip: ip, payload: body as Record<string, unknown>,
  });
}

export function businessId(): string {
  const id = Deno.env.get('BUSINESS_ID');
  if (!id) throw new Error('BUSINESS_ID is not configured for this function.');
  return id;
}
