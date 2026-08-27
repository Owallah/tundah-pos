/**
 * cors.ts — CORS handling for Edge Functions called directly from the
 * browser via supabase.functions.invoke().
 *
 * The Daraja/NCBA WEBHOOK functions (mpesa-c2b-confirm, ncba-stk's own
 * downstream calls to NCBA, etc.) are called server-to-server and don't
 * need this — a bank's server doesn't send a CORS preflight.
 *
 * Anything called with supabase.functions.invoke() from a 'use client'
 * component DOES need this. That request carries an Authorization header
 * and a Content-Type: application/json body, both of which are
 * "non-simple" and force the browser to send an OPTIONS preflight first.
 * Without a CORS-aware response to that preflight, the browser blocks the
 * whole exchange and the fetch() throws — which surfaces in the app as
 * supabase-js's FunctionsFetchError: "Failed to send a request to the
 * Edge Function". That symptom is the signature of a missing CORS
 * handler, not a broken function.
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Call first, before any other request handling. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}

/** JSON response with CORS headers attached, for every other reply. */
export function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
