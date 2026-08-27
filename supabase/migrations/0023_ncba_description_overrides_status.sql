-- 0023_ncba_description_overrides_status.sql
--
-- Live test finding: a cashier confirmed the customer's payment went through
-- on the customer's phone, but the till showed a failure. The stored raw
-- response (captured by 0022) showed NCBA returning:
--
--   { "status": "FAILED", "description": "The transaction is still under
--     processing" }
--
-- NCBA's status WORD said FAILED while the DESCRIPTION said the opposite —
-- still in progress, not finished either way. Our matching only looked at
-- the status word, so it took a mislabelled "FAILED" at face value and
-- locked the transaction as terminally failed (FAILED is not reopened by a
-- later poll — see the `v_txn.status in (...)` guard below). That is the
-- single worst outcome this app can produce: the customer's money moves,
-- and the system declares defeat anyway, which is exactly the shape of bug
-- that invites a cashier to charge the same customer twice.
--
-- Fix: when the description text itself says the transaction is still in
-- progress, that overrides a "FAILED" status word. Worst case now is the
-- till keeps polling for the full two minutes and times out into a
-- reconciliation task — recoverable — rather than a silent false failure.
--
-- This is deliberately a text-pattern check, not a rewrite of what "FAILED"
-- means, because a genuine failure (insufficient funds, PIN declined,
-- cancelled by the customer) must still fail promptly. Only descriptions
-- that explicitly say the transaction is still moving get the pass.

create or replace function record_ncba_result(
  p_provider_txn_id text,
  p_status text,
  p_description text,
  p_raw jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_txn mpesa_transactions%rowtype;
  v_status text := upper(trim(coalesce(p_status, '')));
  v_desc text := lower(trim(coalesce(p_description, '')));
  v_matched_success boolean;
  v_matched_failed boolean;
  v_desc_says_pending boolean;
begin
  select * into v_txn from mpesa_transactions
   where provider = 'NCBA' and provider_txn_id = p_provider_txn_id
   for update;

  if not found then
    return jsonb_build_object('status', 'UNKNOWN_TRANSACTION');
  end if;

  update mpesa_transactions
     set last_polled_at = now(),
         poll_count = poll_count + 1,
         result_desc = coalesce(p_description, result_desc),
         raw_callback = coalesce(p_raw, raw_callback)
   where mpesa_txn_id = v_txn.mpesa_txn_id;

  -- Terminal states are never reopened by a later poll.
  if v_txn.status in ('VERIFIED','FAILED','CANCELLED') then
    return jsonb_build_object('status', 'ALREADY_RESOLVED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id,
                              'resolved_as', v_txn.status);
  end if;

  v_matched_success := v_status in ('SUCCESS', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED', 'CONFIRMED', 'PAID');
  v_matched_failed  := v_status in ('FAILED', 'FAILURE', 'CANCELLED', 'REJECTED', 'DECLINED');

  -- The description overrides a "FAILED" status word when it explicitly
  -- describes an in-progress transaction, not a finished one.
  v_desc_says_pending := v_desc ~ '(still|currently).*(process|pending)'
                      or v_desc ~ 'processing'
                      or v_desc ~ 'in progress'
                      or v_desc ~ 'awaiting';

  if v_matched_success then
    update mpesa_transactions
       set status = 'VERIFIED', verified_by = 'QUERY',
           confirmed_at = now()
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    update payments set status = 'VERIFIED' where payment_id = v_txn.payment_id;

    return jsonb_build_object('status', 'VERIFIED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id,
                              'matched_word', v_status);
  end if;

  if v_matched_failed and v_desc_says_pending then
    -- NCBA's status word says FAILED but its own description says the
    -- opposite. Do not trust the word — leave PENDING for the next poll.
    return jsonb_build_object('status', 'PENDING',
                              'mpesa_txn_id', v_txn.mpesa_txn_id,
                              'raw_status_word', v_status,
                              'note', 'status word overridden by description');
  end if;

  if v_matched_failed then
    update mpesa_transactions
       set status = 'FAILED'
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    update payments set status = 'FAILED' where payment_id = v_txn.payment_id;

    return jsonb_build_object('status', 'FAILED', 'reason', p_description,
                              'matched_word', v_status);
  end if;

  -- Still processing, or a word we don't recognise yet.
  return jsonb_build_object('status', 'PENDING',
                            'mpesa_txn_id', v_txn.mpesa_txn_id,
                            'raw_status_word', v_status);
end
$fn$;

revoke execute on function record_ncba_result(text, text, text, jsonb)
  from authenticated, anon;
