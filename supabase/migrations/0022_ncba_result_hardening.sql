-- 0022_ncba_result_hardening.sql
--
-- Two related fixes, both prompted by a live test: a cashier confirmed the
-- customer paid, but the till kept showing "waiting" until timeout.
--
-- 1. record_ncba_result() matched p_status with an EXACT, untrimmed string
--    comparison against 'SUCCESS' / 'FAILED'. NCBA's own specification
--    already has multiple inconsistencies against real behaviour (the
--    GET/POST mismatch on token auth, documented in ncba-client.ts). If the
--    live query response differs from the spec sample in wording, casing
--    edge cases, or stray whitespace, the payment falls into the "anything
--    else -> PENDING" branch and is never recognised — the till polls until
--    the 2-minute timeout even though NCBA already confirmed the payment.
--
-- 2. That PENDING branch never stored the raw response. So the first time
--    this happens, there is no record of what NCBA actually sent — nothing
--    to compare against the spec, nothing to hand to NCBA support. Fixed by
--    storing the raw response and description on every single poll, not
--    only on a terminal outcome.
--
-- This does not change the terminal states themselves (VERIFIED/FAILED
-- still require a status word to match) — it only widens which words count,
-- and makes every poll leave evidence behind.

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
  v_matched_success boolean;
  v_matched_failed boolean;
begin
  select * into v_txn from mpesa_transactions
   where provider = 'NCBA' and provider_txn_id = p_provider_txn_id
   for update;

  if not found then
    return jsonb_build_object('status', 'UNKNOWN_TRANSACTION');
  end if;

  -- Recorded on every poll, terminal or not, so a stuck payment always
  -- leaves behind exactly what NCBA said, for the next person to diagnose.
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

  -- 'SUCCESS' is the documented word. The others are a safety net for live
  -- behaviour the spec doesn't mention — confirm the real word with NCBA
  -- and this list can shrink back down once it's certain.
  v_matched_success := v_status in ('SUCCESS', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED', 'CONFIRMED', 'PAID');
  v_matched_failed  := v_status in ('FAILED', 'FAILURE', 'CANCELLED', 'REJECTED', 'DECLINED');

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

  if v_matched_failed then
    update mpesa_transactions
       set status = 'FAILED'
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    update payments set status = 'FAILED' where payment_id = v_txn.payment_id;

    return jsonb_build_object('status', 'FAILED', 'reason', p_description,
                              'matched_word', v_status);
  end if;

  -- Still processing, or a word we don't recognise yet. Either way the raw
  -- response above is now on record — check mpesa_transactions.raw_callback
  -- for this row if a payment gets stuck here repeatedly.
  return jsonb_build_object('status', 'PENDING',
                            'mpesa_txn_id', v_txn.mpesa_txn_id,
                            'raw_status_word', v_status);
end
$fn$;

revoke execute on function record_ncba_result(text, text, text, jsonb)
  from authenticated, anon;
