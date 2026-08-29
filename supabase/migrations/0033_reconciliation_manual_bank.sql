-- 0032_reconciliation_manual_bank.sql
--
-- The "Unverified manual codes" bucket needs manual_bank too (added in
-- 0030) — the owner needs to know which statement to check a given code
-- against now that there are two paybills (NCBA and Co-op).
--
-- mpesa_reconciliation() returns jsonb, not a TABLE(...), so a plain
-- CREATE OR REPLACE is safe here — no drop required.

create or replace function mpesa_reconciliation(
  p_from timestamptz default now() - interval '24 hours',
  p_to   timestamptz default now()
) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'buckets', jsonb_build_object(
      'pending', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, channel, amount_cents, phone_number,
                 initiated_at, checkout_request_id
            from mpesa_transactions
           where business_id = auth_business_id()
             and status = 'PENDING'
             and channel <> 'MANUAL'
             and coalesce(initiated_at, confirmed_at) between p_from and p_to
           order by initiated_at desc) t),

      'verified', (
        select jsonb_build_object(
          'count', count(*), 'total_cents', coalesce(sum(amount_cents), 0))
          from mpesa_transactions
         where business_id = auth_business_id() and status = 'VERIFIED'
           and confirmed_at between p_from and p_to),

      'failed', (
        select jsonb_build_object('count', count(*))
          from mpesa_transactions
         where business_id = auth_business_id()
           and status in ('FAILED','CANCELLED')
           and coalesce(initiated_at, confirmed_at) between p_from and p_to),

      'mismatch', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, mpesa_receipt_number, amount_cents,
                 phone_number, payer_name, confirmed_at, result_desc
            from mpesa_transactions
           where business_id = auth_business_id() and status = 'MISMATCH'
             and confirmed_at between p_from and p_to
           order by confirmed_at desc) t),

      -- manual_bank tells the owner which statement to check this code
      -- against (NCBA or Co-op) — the business now has two paybills.
      'unverified_manual', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select m.mpesa_txn_id, m.mpesa_receipt_number, m.manual_bank,
                 m.amount_cents,
                 s.local_ref, c.full_name as cashier,
                 extract(epoch from (now() - m.initiated_at)) / 3600 as hours_old
            from mpesa_transactions m
            join payments p on p.payment_id = m.payment_id
            join sales s on s.sale_id = p.sale_id
            join cashiers c on c.cashier_id = s.cashier_id
           where m.business_id = auth_business_id()
             and m.channel = 'MANUAL'
             and m.status = 'PENDING'
             and m.initiated_at between p_from and p_to
           order by m.initiated_at) t),

      'unmatched', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, mpesa_receipt_number, amount_cents,
                 phone_number, payer_name, confirmed_at
            from mpesa_transactions
           where business_id = auth_business_id()
             and status = 'VERIFIED' and payment_id is null
             and confirmed_at between p_from and p_to
           order by confirmed_at desc) t)
    ))
$$;
