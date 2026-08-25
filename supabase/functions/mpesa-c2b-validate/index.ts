/**
 * mpesa-c2b-validate — optional pre-authorisation hook.
 *
 * Only invoked if Safaricom has enabled validation for the shortcode; it is
 * off by default and must be requested from them.
 *
 * We ACCEPT everything. Rejecting means the customer's payment fails while
 * they are standing at the stall — far worse than accepting money we later
 * reconcile. Amount and attribution problems are handled on the
 * reconciliation screen, where a human can see the whole picture.
 */

import { admin, accepted, sourceIp, logRaw } from '../_shared/util.ts';

Deno.serve(async (req) => {
  const db = admin();
  const ip = sourceIp(req);
  try {
    await logRaw(db, 'c2b_validate', await req.json(), ip);
  } catch {
    await logRaw(db, 'c2b_validate_unparseable', { ip }, ip);
  }
  return accepted();
});
