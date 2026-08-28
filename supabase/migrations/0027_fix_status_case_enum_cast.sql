-- 0027_fix_status_case_enum_cast.sql
--
-- Fixes: `column "status" is of type payment_status but expression is of
-- type text`, thrown at RUNTIME (not at CREATE OR REPLACE time — this is
-- what let it ship silently) by any UPDATE that assigns a CASE expression
-- with two-or-more bare string-literal branches directly into an enum
-- column.
--
-- WHY THIS ONLY SURFACES ON EXECUTION, NOT ON DEPLOY:
-- A single bare string literal assigned to an enum column resolves fine —
-- Postgres defers its type as "unknown" and casts it on assignment. But a
-- CASE expression with two OR MORE untyped string branches resolves its own
-- result type independently, as `text`, before the assignment context is
-- ever consulted. `create or replace function` only parses and stores the
-- function body; it does not execute it, so this class of bug is invisible
-- until the branch actually runs. It was found here by calling the affected
-- functions directly against a real database, not by any earlier review.
--
-- WHERE IT WAS FOUND: verifying the manual-M-Pesa-code auto-upgrade added in
-- 0024 (record_c2b_payment's new branch). The fix is identical wherever the
-- pattern appears; scanning the migration history for it also caught an
-- existing, unrelated instance:
--
--   record_c2b_payment()  — 0024, the new upgrade-a-manual-code branch.
--                            NEVER WORKED: every attempt to auto-upgrade a
--                            manually-typed code once Safaricom's own
--                            confirmation arrived threw this error and
--                            aborted. The manual code stayed stuck exactly
--                            where the cashier left it.
--
--   record_stk_result()   — 0010, pre-dates NCBA entirely. The FAILED/
--                            CANCELLED branch for a Daraja STK push has had
--                            this bug since it was first written. Currently
--                            unreachable (NCBA is the live provider; the
--                            Daraja STK path is not wired to any UI), so it
--                            caused no live incident — but it would have
--                            broken the instant Daraja was used again.
--
-- THE FIX: cast each literal branch explicitly. `'MISMATCH'::payment_status`
-- forces the CASE to resolve as payment_status from the start, so the
-- assignment needs no further coercion.
-- ============================================================================

create or replace function record_c2b_payment(
  p_business_id   uuid,
  p_receipt_number text,
  p_amount_cents  bigint,
  p_phone         text,
  p_payer_name    text,
  p_bill_ref      text,
  p_occurred_at   timestamptz,
  p_raw           jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_existing mpesa_transactions%rowtype;
  v_id uuid := uuid_generate_v7();
  v_mismatch boolean;
begin
  select * into v_existing from mpesa_transactions
   where business_id = p_business_id
     and mpesa_receipt_number = p_receipt_number
   for update;

  if found then
    if v_existing.channel = 'MANUAL' and v_existing.status = 'PENDING' then
      v_mismatch := p_amount_cents is not null
                    and p_amount_cents <> v_existing.amount_cents;

      update mpesa_transactions
         set status = case when v_mismatch then 'MISMATCH'::payment_status
                           else 'VERIFIED'::payment_status end,
             channel = 'C2B', provider = 'DARAJA', verified_by = 'CALLBACK',
             phone_number = coalesce(p_phone, phone_number),
             payer_name = coalesce(p_payer_name, payer_name),
             bill_ref_number = coalesce(nullif(p_bill_ref,''), bill_ref_number),
             amount_cents = coalesce(p_amount_cents, amount_cents),
             confirmed_at = coalesce(p_occurred_at, now()),
             raw_callback = p_raw
       where mpesa_txn_id = v_existing.mpesa_txn_id;

      if v_existing.payment_id is not null then
        update payments
           set status = case when v_mismatch then 'MISMATCH'::payment_status
                             else 'VERIFIED'::payment_status end
         where payment_id = v_existing.payment_id;
      end if;

      return jsonb_build_object(
        'status', case when v_mismatch
                        then 'UPGRADED_FROM_MANUAL_MISMATCH'
                        else 'UPGRADED_FROM_MANUAL' end,
        'mpesa_txn_id', v_existing.mpesa_txn_id,
        'already_matched', v_existing.payment_id is not null);
    end if;

    return jsonb_build_object(
      'status', 'DUPLICATE',
      'mpesa_txn_id', v_existing.mpesa_txn_id,
      'already_matched', v_existing.payment_id is not null);
  end if;

  insert into mpesa_transactions (
    mpesa_txn_id, business_id, channel, direction,
    mpesa_receipt_number, phone_number, payer_name, bill_ref_number,
    amount_cents, status, confirmed_at, raw_callback)
  values (
    v_id, p_business_id, 'C2B', 'C2B',
    p_receipt_number, p_phone, p_payer_name, nullif(p_bill_ref, ''),
    p_amount_cents, 'VERIFIED', coalesce(p_occurred_at, now()), p_raw);

  return jsonb_build_object('status', 'RECORDED', 'mpesa_txn_id', v_id);
end
$fn$;

create or replace function record_stk_result(
  p_checkout_request_id text,
  p_result_code   int,
  p_result_desc   text,
  p_receipt_number text,
  p_amount_cents  bigint,
  p_phone         text,
  p_occurred_at   timestamptz,
  p_raw           jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare v_txn mpesa_transactions%rowtype;
begin
  select * into v_txn from mpesa_transactions
   where checkout_request_id = p_checkout_request_id
   for update;

  if not found then
    return jsonb_build_object('status', 'UNKNOWN_CHECKOUT_REQUEST');
  end if;

  if v_txn.status in ('VERIFIED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object('status', 'ALREADY_RESOLVED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id);
  end if;

  if p_result_code = 0 then
    update mpesa_transactions
       set status = 'VERIFIED',
           mpesa_receipt_number = p_receipt_number,
           phone_number = coalesce(p_phone, phone_number),
           amount_cents = coalesce(p_amount_cents, amount_cents),
           result_code = p_result_code,
           result_desc = p_result_desc,
           confirmed_at = coalesce(p_occurred_at, now()),
           raw_callback = p_raw
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    if p_amount_cents is not null and p_amount_cents <> v_txn.amount_cents then
      update mpesa_transactions set status = 'MISMATCH'
       where mpesa_txn_id = v_txn.mpesa_txn_id;
      update payments set status = 'MISMATCH' where payment_id = v_txn.payment_id;
      return jsonb_build_object('status', 'MISMATCH',
        'expected_cents', v_txn.amount_cents, 'actual_cents', p_amount_cents);
    end if;

    update payments set status = 'VERIFIED' where payment_id = v_txn.payment_id;
    return jsonb_build_object('status', 'VERIFIED', 'mpesa_txn_id', v_txn.mpesa_txn_id);
  end if;

  update mpesa_transactions
     set status = case when p_result_code = 1032 then 'CANCELLED'::payment_status
                       else 'FAILED'::payment_status end,
         result_code = p_result_code, result_desc = p_result_desc, raw_callback = p_raw
   where mpesa_txn_id = v_txn.mpesa_txn_id;

  update payments set status = 'FAILED' where payment_id = v_txn.payment_id;

  return jsonb_build_object('status', 'FAILED', 'result_code', p_result_code);
end
$fn$;
