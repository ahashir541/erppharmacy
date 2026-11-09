-- 0018: Phase 5 — suppliers, purchase orders, goods received (with bonus),
-- supplier invoices, purchase returns and claims, customer accounts, udhaar
-- payments, supplier payments, cheques, open bills and ageing, statements,
-- supplier statement matching and udhaar reminders.
--
-- Rules:
--   * Every balance comes from ledger_entries. A statement is the ledger in
--     date order; its closing balance is party_balances to the paisa.
--   * Which bills are still open: explicit allocations first, then every
--     other payment or credit pays the oldest bill first (app.open_items).
--   * A store keeper receives goods without seeing cost: quantities go in
--     grn_lines; prices go in grn_line_costs via the supplier invoice.
--   * Bonus ("10 + 1") stock costs nothing extra, so it lowers the batch's
--     average cost: the cost layer holds paid + bonus units for the line's
--     net cost.

-- ---- Document numbers (cloud documents only; counter bills use the PC's own numbers) ----
create table app.doc_counters (
  tenant_id   uuid not null,
  kind        text not null,
  next_value  bigint not null,
  primary key (tenant_id, kind)
);

create or replace function app.next_doc_number(p_tenant uuid, p_kind text, p_prefix text) returns text
language plpgsql security definer set search_path = public, app as $$
declare n bigint;
begin
  insert into app.doc_counters as c (tenant_id, kind, next_value) values (p_tenant, p_kind, 1)
  on conflict (tenant_id, kind) do update set next_value = c.next_value + 1
  returning next_value into n;
  return p_prefix || '-' || lpad(n::text, 6, '0');
end $$;

-- The branch's local date for a moment (bills, statements and ageing are by business date).
create or replace function app.business_date(p_branch uuid, p_at timestamptz default now()) returns date
language sql stable security definer set search_path = public, app as $$
  select (p_at at time zone coalesce((select time_zone from branches where id = p_branch), 'Asia/Karachi'))::date
$$;

-- Read functions are for people allowed to see the numbers.
create or replace function app.require_perm(p_code text) returns uuid
language plpgsql stable security definer set search_path = public, app as $$
begin
  -- Balances and statements are for the owner's cloud session, never a counter PC (D13).
  if app.current_user_id() is null or app.tenant_id() is null or not app.has_perm(p_code) then
    raise exception 'Permission % is required', p_code using errcode = '42501';
  end if;
  return app.current_user_id();
end $$;

create or replace function app.party_name(p_party_type text, p_party uuid) returns text
language sql stable security definer set search_path = public, app as $$
  select case p_party_type
    when 'customer_account' then (select name from customer_accounts where id = p_party)
    else (select name from suppliers where id = p_party) end
$$;

-- A customer account or supplier of the caller's pharmacy.
create or replace function app.party_exists(p_party_type text, p_party uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select case p_party_type
    when 'customer_account' then exists (select 1 from customer_accounts where id = p_party and tenant_id = app.tenant_id())
    when 'supplier' then exists (select 1 from suppliers where id = p_party and tenant_id = app.tenant_id())
    else false end
$$;

-- ---- Open bills ------------------------------------------------------------
-- A party's ledger split into what they owe (owed) and what they paid or were credited (paid).
-- A reversal and the entry it reverses cancel each other out.
create or replace function app.party_entries(p_party_type text, p_party uuid)
returns table (id uuid, owed bigint, paid bigint, entry_type text, entry_date date, due_date date,
               reference_type text, reference_id uuid, occurred_at timestamptz)
language sql volatile security definer set search_path = public, app as $$
  select e.id,
         case when p_party_type = 'customer_account' then e.debit else e.credit end,
         case when p_party_type = 'customer_account' then e.credit else e.debit end,
         e.entry_type, e.entry_date, e.due_date, e.reference_type, e.reference_id, e.occurred_at
  from ledger_entries e
  where e.party_type = p_party_type
    and (e.customer_account_id = p_party or e.supplier_id = p_party)
    and e.entry_type <> 'reversal'
    and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id)
$$;

-- Explicit "this payment was for that bill" links still in force.
create or replace function app.party_allocations(p_party_type text, p_party uuid)
returns table (payment_entry_id uuid, charge_entry_id uuid, amount bigint)
language sql volatile security definer set search_path = public, app as $$
  select a.payment_entry_id, a.charge_entry_id, a.amount
  from ledger_allocations a
  where a.charge_entry_id in (select x.id from app.party_entries(p_party_type, p_party) x)
    and a.payment_entry_id in (select x.id from app.party_entries(p_party_type, p_party) x)
$$;

-- What is still unpaid on each bill: explicit allocations first, then everything else pays the
-- oldest bill first. The open amounts add up to the balance (when it is owed, not an advance).
-- Volatile on purpose (here and above): a stable function would not see a bill posted earlier in
-- the same call.
create or replace function app.open_items(p_party_type text, p_party uuid)
returns table (entry_id uuid, entry_type text, entry_date date, due_date date, reference_type text,
               reference_id uuid, amount bigint, open_amount bigint)
language plpgsql volatile security definer set search_path = public, app as $$
#variable_conflict use_column
declare
  pool bigint;
  c record;
  take bigint;
begin
  -- Payments and credits not tied to a particular bill pay the oldest bills first.
  select coalesce(sum(x.paid), 0) - coalesce((select sum(a.amount) from app.party_allocations(p_party_type, p_party) a), 0)
  into pool from app.party_entries(p_party_type, p_party) x;
  for c in
    select x.*, x.owed - coalesce((select sum(a.amount) from app.party_allocations(p_party_type, p_party) a
                                   where a.charge_entry_id = x.id), 0) as left_after_explicit
    from app.party_entries(p_party_type, p_party) x where x.owed > 0
    order by coalesce(x.due_date, x.entry_date), x.occurred_at, x.id
  loop
    take := least(c.left_after_explicit, greatest(pool, 0));
    pool := pool - take;
    entry_id := c.id; entry_type := c.entry_type; entry_date := c.entry_date; due_date := c.due_date;
    reference_type := c.reference_type; reference_id := c.reference_id; amount := c.owed;
    open_amount := c.left_after_explicit - take;
    return next;
  end loop;
end $$;

-- Ties a payment to particular bills (optional). Checked before the payment is recorded, against
-- what is open at that moment; recorded once the payment exists.
create or replace function app.check_allocations(p_party_type text, p_party uuid, p_amount bigint, p_allocations jsonb)
returns void
language plpgsql volatile security definer set search_path = public, app as $$
declare
  a record;
  total bigint := 0;
begin
  for a in select (x ->> 'entry_id')::uuid as entry_id, sum((x ->> 'amount')::bigint) as amt
           from jsonb_array_elements(coalesce(p_allocations, '[]')) x group by 1 loop
    if a.amt is null or a.amt <= 0 then raise exception 'Allocation amounts must be above 0' using errcode = '22023'; end if;
    if coalesce((select o.open_amount from app.open_items(p_party_type, p_party) o where o.entry_id = a.entry_id), 0) < a.amt then
      raise exception 'More than the open amount was allocated to a bill' using errcode = '22023';
    end if;
    total := total + a.amt;
  end loop;
  if total > p_amount then raise exception 'Allocations add up to more than the payment' using errcode = '22023'; end if;
end $$;

-- ---- Money in and out --------------------------------------------------------
-- One payment to or from a party. Cash goes through an open drawer; wallets, cards and bank
-- transfers through a bank account; cheques wait as 'pending' until they clear.
create or replace function app.post_payment(p jsonb, p_party_type text, p_party uuid, p_uid uuid, p_branch uuid)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  eid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  amt bigint := app.try_bigint(p ->> 'amount');
  method text := coalesce(p ->> 'method', 'cash');
  is_cust boolean := p_party_type = 'customer_account';
  ds drawer_sessions;
  ba bank_accounts;
  at timestamptz := coalesce((p ->> 'paid_at')::timestamptz, now());
  chq jsonb := p -> 'cheque';
  dev uuid := app.ctx_device_id();
begin
  if amt is null or amt <= 0 then raise exception 'The amount must be above 0' using errcode = '22023'; end if;
  if method not in ('cash', 'jazzcash', 'easypaisa', 'bank_transfer', 'cheque', 'card') then
    raise exception 'Unknown payment method %', method using errcode = '22023';
  end if;
  if method = 'cash' then
    select * into ds from drawer_sessions where id = (p ->> 'drawer_session_id')::uuid and tenant_id = tid;
    if not found or ds.status <> 'open' then
      raise exception 'Cash needs an open cash drawer' using errcode = 'P0001';
    end if;
    if app.current_user_id() is null and ds.branch_id is distinct from app.device_branch_id() then
      raise exception 'That drawer is at another branch' using errcode = '42501';
    end if;
  elsif method <> 'cheque' then
    select * into ba from bank_accounts where id = (p ->> 'bank_account_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Choose the account the money went through' using errcode = 'P0002'; end if;
  elsif chq is null or coalesce(chq ->> 'number', '') = '' or (chq ->> 'date') is null then
    raise exception 'Cheque number and date are required' using errcode = '22023';
  end if;
  perform app.check_allocations(p_party_type, p_party, amt, p -> 'allocations');

  insert into ledger_entries (id, tenant_id, branch_id, party_type, customer_account_id, supplier_id, entry_type,
                              debit, credit, entry_date, reference_type, reference_id, payment_method, memo,
                              occurred_at, created_by, device_id)
  values (eid, tid, p_branch, p_party_type, case when is_cust then p_party end, case when not is_cust then p_party end,
          'payment', case when is_cust then 0 else amt end, case when is_cust then amt else 0 end,
          coalesce((p ->> 'entry_date')::date, app.business_date(p_branch, at)),
          p ->> 'reference_type', (p ->> 'reference_id')::uuid, method, p ->> 'memo', at, p_uid, dev);

  if method = 'cheque' then
    insert into cheques (tenant_id, direction, party_type, customer_account_id, supplier_id, bank_account_id, cheque_number,
                         drawer_bank, cheque_date, amount, ledger_entry_id, created_by, device_id)
    values (tid, case when is_cust then 'received' else 'issued' end, p_party_type,
            case when is_cust then p_party end, case when not is_cust then p_party end,
            (chq ->> 'bank_account_id')::uuid, chq ->> 'number', chq ->> 'bank', (chq ->> 'date')::date, amt, eid, p_uid, dev);
  else
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, bank_account_id, movement_type, amount,
                                reference_type, reference_id, memo, occurred_at, created_by, device_id)
    values (tid, coalesce(ds.branch_id, p_branch), ds.id, ba.id,
            case when is_cust then 'udhaar_collection' else 'supplier_payment' end,
            case when is_cust then amt else -amt end, 'ledger_entry', eid, p ->> 'memo', at, p_uid, dev);
  end if;

  insert into ledger_allocations (tenant_id, payment_entry_id, charge_entry_id, amount, created_by, device_id)
  select tid, eid, (x ->> 'entry_id')::uuid, (x ->> 'amount')::bigint, p_uid, dev
  from jsonb_array_elements(coalesce(p -> 'allocations', '[]')) x;
  perform app.log_event('payment', 'ledger_entries', eid,
                        jsonb_build_object('party_type', p_party_type, 'party_id', p_party, 'amount', amt, 'method', method), p_branch);
  return eid;
end $$;

-- ---- Customers and their khata ----------------------------------------------
-- p: name (required), name_ur, phone, cnic, address, guarantor_name, guarantor_phone,
--    reminders_opt_in, can_buy_on_account, notes; account_id (to add a family member to an
--    existing account) or account_name / kind / default_due_days for a new account;
--    credit_limit and opening_balance (both need udhaar.set_limits).
create or replace function public.create_customer(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  br uuid := coalesce(app.device_branch_id(), (p ->> 'branch_id')::uuid);
  acct customer_accounts;
  cid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
begin
  perform app.require_decision(uid, 'customers.manage', br, null, null, 'other');
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Customer name is required' using errcode = '22023'; end if;
  if exists (select 1 from customers where id = cid) then
    return jsonb_build_object('customer_id', cid, 'account_id', (select account_id from customers where id = cid), 'duplicate', true);
  end if;
  if p ? 'account_id' then
    select * into acct from customer_accounts where id = (p ->> 'account_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  else
    insert into customer_accounts (tenant_id, account_number, name, kind, default_due_days, created_by, device_id)
    values (tid, app.next_doc_number(tid, 'customer_account', 'C'), coalesce(nullif(trim(p ->> 'account_name'), ''), trim(p ->> 'name')),
            coalesce(p ->> 'kind', 'individual'), (p ->> 'default_due_days')::int, uid, app.ctx_device_id())
    returning * into acct;
  end if;
  insert into customers (id, tenant_id, account_id, name, name_ur, phone, cnic, address, guarantor_name, guarantor_phone,
                         can_buy_on_account, reminders_opt_in, notes, created_by, device_id)
  values (cid, tid, acct.id, trim(p ->> 'name'), p ->> 'name_ur', p ->> 'phone', p ->> 'cnic', p ->> 'address',
          p ->> 'guarantor_name', p ->> 'guarantor_phone', coalesce((p ->> 'can_buy_on_account')::boolean, true),
          coalesce((p ->> 'reminders_opt_in')::boolean, false), p ->> 'notes', uid, app.ctx_device_id());
  if p ? 'credit_limit' then
    perform app.require_decision(uid, 'udhaar.set_limits', br, null, null, 'other');
    insert into credit_limits (tenant_id, account_id, limit_amount, reason, created_by, device_id)
    values (tid, acct.id, (p ->> 'credit_limit')::bigint, 'new customer', uid, app.ctx_device_id());
  end if;
  if coalesce((p ->> 'opening_balance')::bigint, 0) <> 0 then
    perform app.require_decision(uid, 'udhaar.set_limits', br, null, null, 'other');
    perform app.post_opening(tid, 'customer_account', acct.id, (p ->> 'opening_balance')::bigint,
                             coalesce((p ->> 'opening_date')::date, current_date), uid, br);
  end if;
  return jsonb_build_object('customer_id', cid, 'account_id', acct.id, 'account_number', acct.account_number, 'duplicate', false);
end $$;

create or replace function public.update_customer(p_customer uuid, p_changes jsonb, p_session uuid default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
begin
  perform app.require_decision(uid, 'customers.manage', app.device_branch_id(), null, null, 'other');
  update customers set
    name = coalesce(nullif(trim(p_changes ->> 'name'), ''), name),
    name_ur = case when p_changes ? 'name_ur' then p_changes ->> 'name_ur' else name_ur end,
    phone = case when p_changes ? 'phone' then p_changes ->> 'phone' else phone end,
    cnic = case when p_changes ? 'cnic' then p_changes ->> 'cnic' else cnic end,
    address = case when p_changes ? 'address' then p_changes ->> 'address' else address end,
    guarantor_name = case when p_changes ? 'guarantor_name' then p_changes ->> 'guarantor_name' else guarantor_name end,
    guarantor_phone = case when p_changes ? 'guarantor_phone' then p_changes ->> 'guarantor_phone' else guarantor_phone end,
    can_buy_on_account = coalesce((p_changes ->> 'can_buy_on_account')::boolean, can_buy_on_account),
    reminders_opt_in = coalesce((p_changes ->> 'reminders_opt_in')::boolean, reminders_opt_in),
    notes = case when p_changes ? 'notes' then p_changes ->> 'notes' else notes end
  where id = p_customer and tenant_id = app.tenant_id() and archived_at is null;
  if not found then raise exception 'Customer not found' using errcode = 'P0002'; end if;
end $$;

-- An opening balance when a pharmacy moves its old khata or supplier dues to MedFlow (once per party).
create or replace function app.post_opening(p_tenant uuid, p_party_type text, p_party uuid, p_amount bigint,
                                            p_date date, p_uid uuid, p_branch uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  eid uuid;
  is_cust boolean := p_party_type = 'customer_account';
begin
  if exists (select 1 from ledger_entries where party_type = p_party_type and entry_type = 'opening'
             and (customer_account_id = p_party or supplier_id = p_party)) then
    raise exception 'This account already has an opening balance' using errcode = 'P0001';
  end if;
  -- Positive = they owe us (customer) / we owe them (supplier). Negative = an advance.
  insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, supplier_id, entry_type, debit, credit,
                              entry_date, due_date, memo, occurred_at, created_by, device_id)
  values (p_tenant, p_branch, p_party_type, case when is_cust then p_party end, case when not is_cust then p_party end, 'opening',
          case when (p_amount > 0) = is_cust then abs(p_amount) else 0 end,
          case when (p_amount > 0) <> is_cust then abs(p_amount) else 0 end,
          p_date, p_date, 'opening balance', now(), p_uid, app.ctx_device_id())
  returning id into eid;
  return eid;
end $$;

create or replace function public.record_opening_balance(p_party_type text, p_party uuid, p_amount bigint, p_as_of date)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin(case p_party_type when 'supplier' then 'suppliers.manage' else 'udhaar.set_limits' end);
begin
  if p_party_type not in ('customer_account', 'supplier') then raise exception 'Unknown account type' using errcode = '22023'; end if;
  if not app.party_exists(p_party_type, p_party) then raise exception 'Account not found' using errcode = 'P0002'; end if;
  if coalesce(p_amount, 0) = 0 then raise exception 'The amount cannot be 0' using errcode = '22023'; end if;
  return app.post_opening(app.tenant_id(), p_party_type, p_party, p_amount, p_as_of, uid, null);
end $$;

create or replace function public.set_credit_limit(p_account uuid, p_amount bigint, p_reason text default '') returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('udhaar.set_limits');
begin
  if not exists (select 1 from customer_accounts where id = p_account and tenant_id = app.tenant_id()) then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if p_amount is null or p_amount < 0 then raise exception 'The limit cannot be negative' using errcode = '22023'; end if;
  insert into credit_limits (tenant_id, account_id, limit_amount, reason, created_by)
  values (app.tenant_id(), p_account, p_amount, coalesce(p_reason, ''), uid);
end $$;

create or replace function public.set_udhaar_block(p_account uuid, p_blocked boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('udhaar.block');
begin
  if p_blocked and coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  update customer_accounts set udhaar_blocked = p_blocked, blocked_reason = case when p_blocked then p_reason end
  where id = p_account and tenant_id = app.tenant_id();
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  perform app.log_event(case when p_blocked then 'udhaar_blocked' else 'udhaar_unblocked' end, 'customer_accounts', p_account,
                        jsonb_build_object('reason', p_reason), null);
end $$;

-- Money a customer pays against their khata. Works at the counter too; the receipt shows the
-- amount paid, never the balance (D13).
-- p: id (made on the device), account_id, amount, method, drawer_session_id | bank_account_id | cheque{number,date,bank},
--    allocations [{entry_id, amount}] (optional), memo
create or replace function public.receive_udhaar_payment(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  acct customer_accounts;
  br uuid;
  eid uuid;
begin
  if (p ->> 'id') is not null and exists (select 1 from ledger_entries where id = (p ->> 'id')::uuid) then
    return jsonb_build_object('entry_id', (p ->> 'id')::uuid, 'duplicate', true);
  end if;
  select * into acct from customer_accounts where id = (p ->> 'account_id')::uuid and tenant_id = tid;
  if not found then raise exception 'Account not found' using errcode = 'P0002'; end if;
  br := coalesce(app.device_branch_id(), (p ->> 'branch_id')::uuid,
                 (select branch_id from drawer_sessions where id = (p ->> 'drawer_session_id')::uuid));
  perform app.require_decision(uid, 'udhaar.receive_payment', br, app.try_bigint(p ->> 'amount'), null, 'other');
  eid := app.post_payment(p, 'customer_account', acct.id, uid, br);
  return jsonb_build_object('entry_id', eid, 'account_number', acct.account_number, 'name', acct.name,
                            'amount', app.try_bigint(p ->> 'amount'), 'duplicate', false);
end $$;

-- Writing off what a customer will never pay (needs udhaar.write_off; a limit can ask for approval).
create or replace function public.write_off_udhaar(p_account uuid, p_amount bigint, p_reason text, p_approval uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('udhaar.write_off');
  bal bigint;
  eid uuid := app.uuid_v7();
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  perform app.require_decision(uid, 'udhaar.write_off', null, p_amount, p_approval, 'other', eid);
  select balance into bal from party_balances where party_type = 'customer_account' and party_id = p_account and tenant_id = app.tenant_id();
  if p_amount is null or p_amount <= 0 or p_amount > coalesce(bal, 0) then
    raise exception 'You can write off up to what is owed' using errcode = '22023';
  end if;
  insert into ledger_entries (id, tenant_id, party_type, customer_account_id, entry_type, credit, entry_date, memo, approval_id,
                              occurred_at, created_by)
  values (eid, app.tenant_id(), 'customer_account', p_account, 'write_off', p_amount, current_date, p_reason, p_approval, now(), uid);
  return eid;
end $$;

-- ---- Suppliers ---------------------------------------------------------------
create or replace function public.save_supplier(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('suppliers.manage');
  tid uuid := app.tenant_id();
  sid uuid := (p ->> 'id')::uuid;
begin
  if sid is null or not exists (select 1 from suppliers where id = sid and tenant_id = tid) then
    if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Supplier name is required' using errcode = '22023'; end if;
    if exists (select 1 from suppliers where tenant_id = tid and lower(name) = lower(trim(p ->> 'name'))) then
      raise exception 'A supplier with this name already exists' using errcode = '23505';
    end if;
    insert into suppliers (id, tenant_id, name, contact_name, phone, whatsapp, email, address, city, ntn, strn,
                           payment_terms_days, credit_limit, lead_time_days, created_by)
    values (coalesce(sid, app.uuid_v7()), tid, trim(p ->> 'name'), p ->> 'contact_name', p ->> 'phone', p ->> 'whatsapp',
            p ->> 'email', p ->> 'address', p ->> 'city', p ->> 'ntn', p ->> 'strn', (p ->> 'payment_terms_days')::int,
            (p ->> 'credit_limit')::bigint, (p ->> 'lead_time_days')::int, uid)
    returning id into sid;
  else
    update suppliers set
      name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      contact_name = case when p ? 'contact_name' then p ->> 'contact_name' else contact_name end,
      phone = case when p ? 'phone' then p ->> 'phone' else phone end,
      whatsapp = case when p ? 'whatsapp' then p ->> 'whatsapp' else whatsapp end,
      email = case when p ? 'email' then p ->> 'email' else email end,
      address = case when p ? 'address' then p ->> 'address' else address end,
      city = case when p ? 'city' then p ->> 'city' else city end,
      ntn = case when p ? 'ntn' then p ->> 'ntn' else ntn end,
      strn = case when p ? 'strn' then p ->> 'strn' else strn end,
      payment_terms_days = case when p ? 'payment_terms_days' then (p ->> 'payment_terms_days')::int else payment_terms_days end,
      credit_limit = case when p ? 'credit_limit' then (p ->> 'credit_limit')::bigint else credit_limit end,
      lead_time_days = case when p ? 'lead_time_days' then (p ->> 'lead_time_days')::int else lead_time_days end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = sid;
  end if;
  return sid;
end $$;

-- ---- Purchase orders -----------------------------------------------------------
-- p: id?, branch_id, supplier_id, expected_date, notes,
--    lines [{product_unit_id, qty, bonus_qty, expected_unit_cost (needs purchases.view_cost)}]
create or replace function public.create_purchase_order(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('purchases.orders');
  tid uuid := app.tenant_id();
  br uuid := (p ->> 'branch_id')::uuid;
  poid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  num text;
  l jsonb;
  pu product_units;
  n int := 0;
begin
  perform app.assert_branch(br);
  perform app.require_decision(uid, 'purchases.orders', br, null, null, 'other');
  if exists (select 1 from purchase_orders where id = poid) then
    return jsonb_build_object('purchase_order_id', poid, 'duplicate', true);
  end if;
  if not exists (select 1 from suppliers where id = (p ->> 'supplier_id')::uuid and tenant_id = tid and is_active and archived_at is null) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Add at least one item' using errcode = '22023'; end if;
  num := app.next_doc_number(tid, 'purchase_order', 'PO');
  insert into purchase_orders (id, tenant_id, branch_id, supplier_id, po_number, order_date, expected_date, notes, created_by)
  values (poid, tid, br, (p ->> 'supplier_id')::uuid, num, app.business_date(br), (p ->> 'expected_date')::date, p ->> 'notes', uid);
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into pu from product_units where id = (l ->> 'product_unit_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
    if (l ->> 'expected_unit_cost') is not null and app.permission_decision(uid, 'purchases.view_cost', br) <> 'allow' then
      raise exception 'Permission purchases.view_cost is required to enter costs' using errcode = '42501';
    end if;
    insert into po_lines (tenant_id, purchase_order_id, product_id, product_unit_id, qty, bonus_qty, expected_unit_cost,
                          suggested_qty, created_by)
    values (tid, poid, pu.product_id, pu.id, (l ->> 'qty')::bigint, coalesce((l ->> 'bonus_qty')::bigint, 0),
            (l ->> 'expected_unit_cost')::bigint, (l ->> 'suggested_qty')::bigint, uid);
    n := n + 1;
  end loop;
  return jsonb_build_object('purchase_order_id', poid, 'po_number', num, 'lines', n, 'duplicate', false);
end $$;

-- Marks the order sent and returns the message text for WhatsApp / PDF (no prices: the
-- supplier quotes their own).
create or replace function public.send_purchase_order(p_po uuid, p_via text) returns text
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('purchases.orders');
  po purchase_orders;
  msg text;
begin
  select * into po from purchase_orders where id = p_po and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if po.status not in ('draft', 'sent') then raise exception 'This order is already %', po.status using errcode = 'P0001'; end if;
  update purchase_orders set status = 'sent', sent_via = p_via, sent_at = now() where id = po.id;
  select (select name from tenants where id = po.tenant_id) || E'\nPurchase order ' || po.po_number || ' — ' ||
         to_char(po.order_date, 'DD Mon YYYY') || E'\n' ||
         string_agg(format('%s. %s%s %s × %s%s', ord, pr.brand_name, coalesce(' ' || pr.strength, ''), u.name, pl.qty,
                           case when pl.bonus_qty > 0 then ' + ' || pl.bonus_qty || ' bonus' else '' end), E'\n' order by ord)
  into msg
  from (select pl.*, row_number() over (order by pl.created_at, pl.id) ord from po_lines pl where pl.purchase_order_id = po.id) pl
  join products pr on pr.id = pl.product_id
  join product_units pu on pu.id = pl.product_unit_id
  join units u on u.id = pu.unit_id;
  return msg;
end $$;

create or replace function public.cancel_purchase_order(p_po uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('purchases.orders');
begin
  update purchase_orders set status = 'cancelled', notes = concat_ws(E'\n', notes, 'Cancelled: ' || p_reason)
  where id = p_po and tenant_id = app.tenant_id() and status in ('draft', 'sent');
  if not found then raise exception 'Only an order not yet received can be cancelled' using errcode = 'P0001'; end if;
end $$;

-- ---- Goods received ------------------------------------------------------------
-- What arrived, counted at the branch. A store keeper can post it without prices.
-- p: id (made on the device), branch_id, supplier_id, purchase_order_id?, supplier_invoice_number?, received_at?, notes,
--    lines [{id?, po_line_id?, product_unit_id, batch_number, expiry_date, qty, bonus_qty, retail_price?, mrp?,
--            unit_cost?, discount_amount?, scheme_discount?, tax_amount?}]  (costs need purchases.view_cost)
--    invoice? {...} as for post_purchase_invoice, to record the supplier's bill in the same step.
create or replace function public.post_grn(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  br uuid := coalesce((p ->> 'branch_id')::uuid, app.device_branch_id());
  gid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  sup suppliers;
  po purchase_orders;
  l jsonb;
  pu product_units;
  pol po_lines;
  bid uuid;
  lid uuid;
  exp date;
  num text;
  received timestamptz := coalesce((p ->> 'received_at')::timestamptz, now());
  min_days int;
  warnings jsonb := '[]';
  has_cost boolean;
  can_cost boolean;
  inv jsonb;
begin
  perform app.assert_branch(br);
  perform app.require_decision(uid, 'purchases.receive', br, null, null, 'other');
  if exists (select 1 from grns where id = gid) then
    return jsonb_build_object('grn_id', gid, 'grn_number', (select grn_number from grns where id = gid), 'duplicate', true);
  end if;
  select * into sup from suppliers where id = (p ->> 'supplier_id')::uuid and tenant_id = tid and archived_at is null;
  if not found then raise exception 'Supplier not found' using errcode = 'P0002'; end if;
  if (p ->> 'purchase_order_id') is not null then
    select * into po from purchase_orders where id = (p ->> 'purchase_order_id')::uuid and tenant_id = tid for update;
    if not found or po.supplier_id <> sup.id or po.branch_id <> br then
      raise exception 'That order is not from this supplier for this branch' using errcode = 'P0002';
    end if;
    if po.status in ('received', 'cancelled') then raise exception 'That order is already %', po.status using errcode = 'P0001'; end if;
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Add at least one item' using errcode = '22023'; end if;
  can_cost := app.permission_decision(uid, 'purchases.view_cost', br) = 'allow';
  min_days := coalesce((app.setting(tid, br, 'purchases.min_expiry_days') #>> '{}')::int, 90);

  num := app.next_doc_number(tid, 'grn', 'GRN');
  insert into grns (id, tenant_id, branch_id, supplier_id, purchase_order_id, grn_number, supplier_invoice_number, received_at,
                    status, posted_at, notes, created_by, device_id)
  values (gid, tid, br, sup.id, po.id, num, nullif(trim(p ->> 'supplier_invoice_number'), ''), received, 'posted', now(),
          p ->> 'notes', uid, app.ctx_device_id());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into pu from product_units where id = (l ->> 'product_unit_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
    if coalesce((l ->> 'qty')::bigint, 0) < 0 or coalesce((l ->> 'bonus_qty')::bigint, 0) < 0
       or coalesce((l ->> 'qty')::bigint, 0) + coalesce((l ->> 'bonus_qty')::bigint, 0) = 0 then
      raise exception 'Enter how many arrived' using errcode = '22023';
    end if;
    exp := app.try_date(l ->> 'expiry_date');
    if exp is null then raise exception 'Expiry date is required' using errcode = '22023'; end if;
    if exp <= app.business_date(br, received) then
      raise exception 'Batch % is already expired; do not receive it', l ->> 'batch_number' using errcode = 'P0001';
    end if;
    if exp < app.business_date(br, received) + min_days then
      warnings := warnings || jsonb_build_object('kind', 'short_dated', 'batch_number', upper(trim(l ->> 'batch_number')),
                                                 'expiry_date', exp, 'days_left', exp - app.business_date(br, received));
    end if;
    if (l ->> 'po_line_id') is not null then
      select * into pol from po_lines where id = (l ->> 'po_line_id')::uuid and purchase_order_id = po.id;
      if not found or pol.product_id <> pu.product_id then
        raise exception 'That order line is for another item' using errcode = 'P0001';
      end if;
    end if;
    has_cost := (l ->> 'unit_cost') is not null;
    if has_cost and not can_cost then
      raise exception 'Permission purchases.view_cost is required to enter costs' using errcode = '42501';
    end if;
    bid := app.get_or_create_batch(tid, pu.product_id, l ->> 'batch_number', exp, uid, pu.id,
                                   app.try_bigint(l ->> 'retail_price'), app.try_bigint(l ->> 'mrp'), sup.id);
    lid := coalesce((l ->> 'id')::uuid, app.uuid_v7());
    insert into grn_lines (id, tenant_id, grn_id, po_line_id, product_id, product_unit_id, batch_id, qty, bonus_qty,
                           qty_base, bonus_qty_base, created_by, device_id)
    values (lid, tid, gid, (l ->> 'po_line_id')::uuid, pu.product_id, pu.id, bid, coalesce((l ->> 'qty')::bigint, 0),
            coalesce((l ->> 'bonus_qty')::bigint, 0), coalesce((l ->> 'qty')::bigint, 0) * pu.factor_to_base,
            coalesce((l ->> 'bonus_qty')::bigint, 0) * pu.factor_to_base, uid, app.ctx_device_id());
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type,
                                 reference_id, reference_line_id, occurred_at, created_by, device_id)
    values (tid, br, pu.product_id, bid, 'purchase',
            (coalesce((l ->> 'qty')::bigint, 0) + coalesce((l ->> 'bonus_qty')::bigint, 0)) * pu.factor_to_base,
            'grn', gid, lid, received, uid, app.ctx_device_id());
    if has_cost then
      perform app.set_grn_line_cost(lid, l, uid);
    end if;
  end loop;

  if po.id is not null then perform app.refresh_po_status(po.id); end if;
  perform app.log_event('grn_posted', 'grns', gid, jsonb_build_object('grn_number', num, 'supplier', sup.name), br);

  if p ? 'invoice' then
    inv := public.post_purchase_invoice((p -> 'invoice') || jsonb_build_object('grn_id', gid), p_session);
  end if;
  return jsonb_build_object('grn_id', gid, 'grn_number', num, 'warnings', warnings, 'invoice', inv, 'duplicate', false);
end $$;

-- The money side of one received line, from the supplier's bill. Writes the batch's cost layer
-- (paid + bonus units for the line's net cost). Tax is part of the cost (D37).
create or replace function app.set_grn_line_cost(p_line uuid, c jsonb, p_uid uuid) returns bigint
language plpgsql security definer set search_path = public, app as $$
declare
  gl grn_lines;
  g grns;
  unit_cost bigint := app.try_bigint(c ->> 'unit_cost');
  disc bigint := coalesce(app.try_bigint(c ->> 'discount_amount'), 0);
  scheme bigint := coalesce(app.try_bigint(c ->> 'scheme_discount'), 0);
  tax bigint := coalesce(app.try_bigint(c ->> 'tax_amount'), 0);
  net bigint;
begin
  select * into gl from grn_lines where id = p_line;
  select * into g from grns where id = gl.grn_id;
  if exists (select 1 from grn_line_costs where grn_line_id = p_line) then
    raise exception 'This line already has its price' using errcode = 'P0001';
  end if;
  if unit_cost is null or unit_cost < 0 or disc < 0 or scheme < 0 or tax < 0 then
    raise exception 'Prices and discounts cannot be negative' using errcode = '22023';
  end if;
  net := gl.qty * unit_cost - disc - scheme + tax;
  if net < 0 then raise exception 'Discounts are more than the line is worth' using errcode = '22023'; end if;
  insert into grn_line_costs (grn_line_id, tenant_id, unit_cost, trade_price, discount_amount, scheme_discount, tax_amount,
                              line_net, created_by, device_id)
  values (p_line, gl.tenant_id, unit_cost, app.try_bigint(c ->> 'trade_price'), disc, scheme, tax, net, p_uid, app.ctx_device_id());
  insert into batch_cost_layers (tenant_id, batch_id, grn_line_id, source, qty_base, total_cost, trade_price, occurred_at,
                                 created_by, device_id)
  values (gl.tenant_id, gl.batch_id, gl.id, 'grn', gl.qty_base + gl.bonus_qty_base, net,
          app.try_bigint(c ->> 'trade_price'), g.received_at, p_uid, app.ctx_device_id());
  return net;
end $$;

create or replace function app.refresh_po_status(p_po uuid) returns void
language sql security definer set search_path = public, app as $$
  update purchase_orders po set status = case
      when not exists (
        select 1 from po_lines pl
        where pl.purchase_order_id = po.id
          and pl.qty + pl.bonus_qty > coalesce((select sum(gl.qty + gl.bonus_qty) from grn_lines gl join grns g on g.id = gl.grn_id
                                                where gl.po_line_id = pl.id and g.status = 'posted'), 0))
      then 'received' else 'partially_received' end
  where po.id = p_po
$$;

-- ---- Supplier invoices ----------------------------------------------------------
-- The supplier's bill for goods received. Lines without a price get one here; the totals are
-- worked out from the lines and must match the paper (expected_grand_total) when given.
-- p: id?, grn_id, supplier_invoice_number, invoice_date, due_date? (default: supplier's payment terms),
--    line_costs [{grn_line_id, unit_cost, discount_amount, scheme_discount, tax_amount, trade_price}],
--    expected_grand_total?, paid_at_receipt? + payment {method, drawer_session_id | bank_account_id | cheque}
create or replace function public.post_purchase_invoice(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  g grns;
  sup suppliers;
  iid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  c jsonb;
  sub bigint;
  disc bigint;
  tax bigint;
  grand bigint;
  inv_date date;
  due date;
  paid bigint := coalesce(app.try_bigint(p ->> 'paid_at_receipt'), 0);
  charge uuid := app.uuid_v7();
  pay uuid;
begin
  select * into g from grns where id = (p ->> 'grn_id')::uuid and tenant_id = tid;
  if not found or g.status <> 'posted' then raise exception 'Goods received note not found' using errcode = 'P0002'; end if;
  perform app.require_decision(uid, 'purchases.invoices', g.branch_id, null, null, 'other');
  perform app.require_decision(uid, 'purchases.view_cost', g.branch_id, null, null, 'other');
  if exists (select 1 from purchase_invoices where id = iid) then
    return jsonb_build_object('purchase_invoice_id', iid, 'duplicate', true);
  end if;
  if exists (select 1 from purchase_invoices where grn_id = g.id and status = 'posted') then
    raise exception 'This delivery already has its invoice' using errcode = 'P0001';
  end if;
  select * into sup from suppliers where id = g.supplier_id;
  if coalesce(trim(coalesce(p ->> 'supplier_invoice_number', g.supplier_invoice_number)), '') = '' then
    raise exception 'The supplier''s invoice number is required' using errcode = '22023';
  end if;
  for c in select * from jsonb_array_elements(coalesce(p -> 'line_costs', '[]')) loop
    if not exists (select 1 from grn_lines where id = (c ->> 'grn_line_id')::uuid and grn_id = g.id) then
      raise exception 'That line is not on this delivery' using errcode = 'P0002';
    end if;
    perform app.set_grn_line_cost((c ->> 'grn_line_id')::uuid, c, uid);
  end loop;
  if exists (select 1 from grn_lines gl where gl.grn_id = g.id and not exists (select 1 from grn_line_costs where grn_line_id = gl.id)) then
    raise exception 'Every line needs its price before the invoice can be posted' using errcode = 'P0001';
  end if;
  select sum(gl.qty * c2.unit_cost), sum(c2.discount_amount + c2.scheme_discount), sum(c2.tax_amount)
  into sub, disc, tax
  from grn_lines gl join grn_line_costs c2 on c2.grn_line_id = gl.id where gl.grn_id = g.id;
  grand := sub - disc + tax;
  if (p ->> 'expected_grand_total') is not null and (p ->> 'expected_grand_total')::bigint <> grand then
    raise exception 'The invoice says Rs %, but the lines add up to Rs %',
      to_char((p ->> 'expected_grand_total')::bigint / 100.0, 'FM999,999,999,990.00'), to_char(grand / 100.0, 'FM999,999,999,990.00')
      using errcode = 'P0001', hint = 'total_mismatch';
  end if;
  if paid < 0 or paid > grand then raise exception 'Paid at delivery must be between 0 and the invoice total' using errcode = '22023'; end if;
  inv_date := coalesce((p ->> 'invoice_date')::date, app.business_date(g.branch_id, g.received_at));
  due := coalesce((p ->> 'due_date')::date, inv_date + coalesce(sup.payment_terms_days, 0));

  insert into purchase_invoices (id, tenant_id, branch_id, supplier_id, grn_id, supplier_invoice_number, invoice_date, due_date,
                                 subtotal, discount_total, tax_total, grand_total, paid_at_receipt, status, posted_at, created_by)
  values (iid, tid, g.branch_id, sup.id, g.id, trim(coalesce(p ->> 'supplier_invoice_number', g.supplier_invoice_number)),
          inv_date, due, sub, disc, tax, grand, paid, 'posted', now(), uid);
  insert into ledger_entries (id, tenant_id, branch_id, party_type, supplier_id, entry_type, credit, entry_date, due_date,
                              reference_type, reference_id, memo, occurred_at, created_by, device_id)
  values (charge, tid, g.branch_id, 'supplier', sup.id, 'purchase_invoice', grand, inv_date, due, 'purchase_invoice', iid,
          'Invoice ' || trim(coalesce(p ->> 'supplier_invoice_number', g.supplier_invoice_number)), now(), uid, app.ctx_device_id());
  if paid > 0 then
    pay := app.post_payment(coalesce(p -> 'payment', '{}') || jsonb_build_object(
             'amount', paid, 'reference_type', 'purchase_invoice', 'reference_id', iid,
             'allocations', jsonb_build_array(jsonb_build_object('entry_id', charge, 'amount', paid))),
           'supplier', sup.id, uid, g.branch_id);
  end if;
  return jsonb_build_object('purchase_invoice_id', iid, 'subtotal', sub, 'discount_total', disc, 'tax_total', tax,
                            'grand_total', grand, 'due_date', due, 'paid', paid, 'ledger_entry_id', charge, 'duplicate', false);
end $$;

-- ---- Returns to the supplier -----------------------------------------------------
-- Stock leaves now; the supplier's credit note comes later (often months for expiry returns),
-- so the value waits as a claim until settle_purchase_return.
-- p: id?, branch_id, supplier_id, reason, notes, lines [{batch_id, qty_base}]
create or replace function public.post_purchase_return(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  br uuid := coalesce((p ->> 'branch_id')::uuid, app.device_branch_id());
  rid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  l jsonb;
  b batches;
  bal bigint;
  q bigint;
  value bigint := 0;
  num text;
begin
  perform app.assert_branch(br);
  perform app.require_decision(uid, 'purchases.returns', br, null, null, 'other');
  if exists (select 1 from purchase_returns where id = rid) then
    return jsonb_build_object('purchase_return_id', rid, 'duplicate', true);
  end if;
  if not exists (select 1 from suppliers where id = (p ->> 'supplier_id')::uuid and tenant_id = tid) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Add at least one item' using errcode = '22023'; end if;
  num := app.next_doc_number(tid, 'purchase_return', 'PR');
  insert into purchase_returns (id, tenant_id, branch_id, supplier_id, return_number, reason, status, notes, created_by, device_id)
  values (rid, tid, br, (p ->> 'supplier_id')::uuid, num, coalesce(p ->> 'reason', 'other'), 'sent', p ->> 'notes', uid, app.ctx_device_id());
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into b from batches where id = (l ->> 'batch_id')::uuid and tenant_id = tid;
    if not found then raise exception 'Batch not found' using errcode = 'P0002'; end if;
    q := app.try_bigint(l ->> 'qty_base');
    if q is null or q <= 0 then raise exception 'Quantity must be above 0' using errcode = '22023'; end if;
    select sb.qty_base into bal from stock_balances sb where sb.branch_id = br and sb.batch_id = b.id for update;
    if coalesce(bal, 0) < q then
      raise exception 'Only % of batch % are in stock', coalesce(bal, 0), b.batch_number using errcode = 'P0001';
    end if;
    insert into purchase_return_lines (tenant_id, purchase_return_id, product_id, batch_id, qty_base, created_by, device_id)
    values (tid, rid, b.product_id, b.id, q, uid, app.ctx_device_id());
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reference_id,
                                 reason, occurred_at, created_by, device_id)
    values (tid, br, b.product_id, b.id, 'purchase_return', -q, 'purchase_return', rid, p ->> 'reason', now(), uid, app.ctx_device_id());
    value := value + coalesce(app.batch_cogs(b.id, q), 0);
  end loop;
  -- The value (at cost) is visible only with payables.view, on the claim.
  insert into supplier_claims (tenant_id, supplier_id, kind, reference_type, reference_id, claimed_amount, notes, created_by)
  values (tid, (p ->> 'supplier_id')::uuid, 'expired_return', 'purchase_return', rid, value, p ->> 'reason', uid);
  return jsonb_build_object('purchase_return_id', rid, 'return_number', num, 'duplicate', false);
end $$;

-- The supplier's credit note arrived (it may be for less than claimed), or they refused.
create or replace function public.settle_purchase_return(p_return uuid, p_credit_note text, p_amount bigint) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('payables.pay');
  r purchase_returns;
  cl supplier_claims;
  eid uuid;
begin
  select * into r from purchase_returns where id = p_return and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Return not found' using errcode = 'P0002'; end if;
  if r.status not in ('sent', 'accepted') then raise exception 'This return is already %', r.status using errcode = 'P0001'; end if;
  select * into cl from supplier_claims where reference_type = 'purchase_return' and reference_id = r.id;
  if p_amount is null or p_amount < 0 then raise exception 'The credit cannot be negative' using errcode = '22023'; end if;
  if p_amount > 0 then
    insert into ledger_entries (tenant_id, branch_id, party_type, supplier_id, entry_type, debit, entry_date, reference_type,
                                reference_id, memo, occurred_at, created_by)
    values (r.tenant_id, r.branch_id, 'supplier', r.supplier_id, 'purchase_return', p_amount, app.business_date(r.branch_id),
            'purchase_return', r.id, 'Credit note ' || coalesce(p_credit_note, ''), now(), uid)
    returning id into eid;
  end if;
  update purchase_returns set status = case when p_amount > 0 then 'credited' else 'rejected' end, credit_note_number = p_credit_note
  where id = r.id;
  update supplier_claims set settled_amount = least(p_amount, claimed_amount),
         status = case when p_amount >= claimed_amount then 'settled' when p_amount = 0 then 'written_off' else 'partially_settled' end
  where id = cl.id;
  return eid;
end $$;

-- ---- Paying suppliers -------------------------------------------------------------
-- p: id?, supplier_id, amount, method, drawer_session_id | bank_account_id | cheque{number,date,bank_account_id},
--    allocations [{entry_id, amount}] (which invoices; default oldest first), memo, branch_id
create or replace function public.pay_supplier(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('payables.pay');
  eid uuid;
begin
  if (p ->> 'id') is not null and exists (select 1 from ledger_entries where id = (p ->> 'id')::uuid) then
    return jsonb_build_object('entry_id', (p ->> 'id')::uuid, 'duplicate', true);
  end if;
  if not exists (select 1 from suppliers where id = (p ->> 'supplier_id')::uuid and tenant_id = app.tenant_id()) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  eid := app.post_payment(p, 'supplier', (p ->> 'supplier_id')::uuid, uid, (p ->> 'branch_id')::uuid);
  return jsonb_build_object('entry_id', eid, 'duplicate', false);
end $$;

-- ---- Cheques ------------------------------------------------------------------------
-- pending → deposited → cleared | bounced, or cancelled before it clears.
-- Cleared: the money reaches the bank account. Bounced: the amount is owed again.
-- Cancelled: the payment is reversed.
create or replace function public.set_cheque_status(p_cheque uuid, p_status text, p_bank_account uuid default null,
                                                    p_note text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('cheques.manage');
  c cheques;
  pay ledger_entries;
  is_cust boolean;
  bounce uuid;
begin
  select * into c from cheques where id = p_cheque and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Cheque not found' using errcode = 'P0002'; end if;
  is_cust := c.party_type = 'customer_account';
  select * into pay from ledger_entries where id = c.ledger_entry_id;
  if not (   (c.status = 'pending' and p_status in ('deposited', 'cleared', 'bounced', 'cancelled'))
          or (c.status = 'deposited' and p_status in ('cleared', 'bounced'))) then
    raise exception 'A % cheque cannot become %', c.status, p_status using errcode = 'P0001';
  end if;
  if p_status in ('deposited', 'cleared') and coalesce(p_bank_account, c.bank_account_id) is null then
    raise exception 'Choose the bank account' using errcode = '22023';
  end if;
  if p_status = 'cleared' then
    insert into cash_movements (tenant_id, branch_id, bank_account_id, movement_type, amount, reference_type, reference_id, memo,
                                occurred_at, created_by)
    values (c.tenant_id, pay.branch_id, coalesce(p_bank_account, c.bank_account_id),
            case when is_cust then 'udhaar_collection' else 'supplier_payment' end,
            case when is_cust then c.amount else -c.amount end, 'cheque', c.id, 'Cheque ' || c.cheque_number, now(), uid);
  elsif p_status = 'bounced' then
    insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, supplier_id, entry_type, debit, credit,
                                entry_date, due_date, reference_type, reference_id, memo, occurred_at, created_by)
    values (c.tenant_id, pay.branch_id, c.party_type, c.customer_account_id, c.supplier_id, 'cheque_bounce',
            case when is_cust then c.amount else 0 end, case when is_cust then 0 else c.amount end,
            current_date, current_date, 'cheque', c.id, concat_ws(' — ', 'Cheque ' || c.cheque_number || ' bounced', p_note), now(), uid)
    returning id into bounce;
  elsif p_status = 'cancelled' then
    insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, supplier_id, entry_type, debit, credit,
                                entry_date, reference_type, reference_id, reverses_entry_id, memo, occurred_at, created_by)
    values (c.tenant_id, pay.branch_id, c.party_type, c.customer_account_id, c.supplier_id, 'reversal', pay.credit, pay.debit,
            current_date, 'cheque', c.id, pay.id, concat_ws(' — ', 'Cheque ' || c.cheque_number || ' cancelled', p_note), now(), uid);
  end if;
  update cheques set status = p_status, status_changed_at = now(), bank_account_id = coalesce(p_bank_account, bank_account_id),
                     bounce_entry_id = coalesce(bounce, bounce_entry_id)
  where id = c.id;
  perform app.log_event('cheque_' || p_status, 'cheques', c.id, jsonb_build_object('note', p_note), pay.branch_id);
end $$;

-- ---- What is owed, and since when -----------------------------------------------------
create or replace function public.open_bills(p_party_type text, p_party uuid)
returns table (entry_id uuid, entry_type text, entry_date date, due_date date, reference text, amount bigint, open_amount bigint,
               days_overdue int)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_perm(case p_party_type when 'supplier' then 'payables.view' else 'udhaar.view_balance' end);
  if not app.party_exists(p_party_type, p_party) then raise exception 'Account not found' using errcode = 'P0002'; end if;
  return query
  select o.entry_id, o.entry_type, o.entry_date, o.due_date, app.entry_reference(o.reference_type, o.reference_id),
         o.amount, o.open_amount, greatest(current_date - coalesce(o.due_date, o.entry_date), 0)
  from app.open_items(p_party_type, p_party) o where o.open_amount > 0
  order by coalesce(o.due_date, o.entry_date);
end $$;

-- Who owes what, by how late (or what we owe suppliers). Buckets by days past the due date.
create or replace function public.party_ageing(p_party_type text, p_as_of date default current_date)
returns table (party_id uuid, name text, balance bigint, not_due bigint, days_1_30 bigint, days_31_60 bigint,
               days_61_90 bigint, days_over_90 bigint, oldest_due date)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare
  pb record;
  o record;
begin
  perform app.require_perm(case p_party_type when 'supplier' then 'payables.view' else 'udhaar.view_balance' end);
  for pb in select b.party_id, b.balance from party_balances b
            where b.tenant_id = app.tenant_id() and b.party_type = p_party_type and b.balance <> 0
            order by b.balance desc loop
    party_id := pb.party_id; name := app.party_name(p_party_type, pb.party_id); balance := pb.balance;
    not_due := 0; days_1_30 := 0; days_31_60 := 0; days_61_90 := 0; days_over_90 := 0; oldest_due := null;
    for o in select * from app.open_items(p_party_type, pb.party_id) x where x.open_amount > 0 loop
      case
        when p_as_of - coalesce(o.due_date, o.entry_date) <= 0 then not_due := not_due + o.open_amount;
        when p_as_of - coalesce(o.due_date, o.entry_date) <= 30 then days_1_30 := days_1_30 + o.open_amount;
        when p_as_of - coalesce(o.due_date, o.entry_date) <= 60 then days_31_60 := days_31_60 + o.open_amount;
        when p_as_of - coalesce(o.due_date, o.entry_date) <= 90 then days_61_90 := days_61_90 + o.open_amount;
        else days_over_90 := days_over_90 + o.open_amount;
      end case;
      oldest_due := least(oldest_due, coalesce(o.due_date, o.entry_date));
    end loop;
    return next;
  end loop;
end $$;

-- A readable reference for a ledger line: the bill number, the supplier's invoice number, ...
create or replace function app.entry_reference(p_type text, p_id uuid) returns text
language sql stable security definer set search_path = public, app as $$
  select case p_type
    when 'sale' then (select invoice_number from sales where id = p_id)
    when 'sale_void' then (select 'Void ' || invoice_number from sales where id = p_id)
    when 'sale_return' then (select return_number from sale_returns where id = p_id)
    when 'purchase_invoice' then (select 'Invoice ' || supplier_invoice_number from purchase_invoices where id = p_id)
    when 'purchase_return' then (select 'Return ' || return_number from purchase_returns where id = p_id)
    when 'cheque' then (select 'Cheque ' || cheque_number from cheques where id = p_id)
    else null end
$$;

-- ---- Statements ----------------------------------------------------------------------
-- The ledger for a period: opening balance, every entry with a running balance, closing balance.
-- Positive = the customer owes us / we owe the supplier.
create or replace function public.party_statement(p_party_type text, p_party uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  is_cust boolean := p_party_type = 'customer_account';
  opening bigint;
  entries jsonb;
  closing bigint;
  tid uuid := app.tenant_id();
begin
  perform app.require_perm(case p_party_type when 'supplier' then 'payables.view' else 'udhaar.view_balance' end);
  if not app.party_exists(p_party_type, p_party) then raise exception 'Account not found' using errcode = 'P0002'; end if;
  select coalesce(sum(case when is_cust then debit - credit else credit - debit end), 0) into opening
  from ledger_entries where party_type = p_party_type and (customer_account_id = p_party or supplier_id = p_party)
    and entry_date < p_from;
  select coalesce(jsonb_agg(x.r order by x.n), '[]') into entries from (
    select row_number() over w as n,
           jsonb_build_object('date', e.entry_date, 'type', e.entry_type,
             'reference', coalesce(app.entry_reference(e.reference_type, e.reference_id), e.memo),
             'method', e.payment_method, 'memo', e.memo, 'debit', e.debit, 'credit', e.credit, 'due_date', e.due_date,
             'balance', opening + sum(case when is_cust then e.debit - e.credit else e.credit - e.debit end) over w) as r
    from ledger_entries e
    where e.party_type = p_party_type and (e.customer_account_id = p_party or e.supplier_id = p_party)
      and e.entry_date between p_from and p_to
    window w as (order by e.entry_date, e.occurred_at, e.created_at, e.id rows between unbounded preceding and current row)
  ) x;
  select opening + coalesce(sum(case when is_cust then debit - credit else credit - debit end), 0) into closing
  from ledger_entries where party_type = p_party_type and (customer_account_id = p_party or supplier_id = p_party)
    and entry_date between p_from and p_to;
  return jsonb_build_object(
    'party_type', p_party_type, 'party_id', p_party, 'name', app.party_name(p_party_type, p_party),
    'pharmacy', (select name from tenants where id = tid), 'from', p_from, 'to', p_to,
    'opening_balance', opening, 'entries', entries, 'closing_balance', closing,
    'total_debit', (select coalesce(sum(debit), 0) from ledger_entries where party_type = p_party_type
                    and (customer_account_id = p_party or supplier_id = p_party) and entry_date between p_from and p_to),
    'total_credit', (select coalesce(sum(credit), 0) from ledger_entries where party_type = p_party_type
                     and (customer_account_id = p_party or supplier_id = p_party) and entry_date between p_from and p_to));
end $$;

-- ---- Matching a supplier's statement ----------------------------------------------------
-- p: supplier_id, statement_date, period_from, period_to, statement_balance,
--    lines [{ref, date, amount}]  (amount > 0 = an invoice they billed, < 0 = a payment or credit they received)
-- Invoices match by their invoice number, everything else by amount within 7 days. What is in our
-- books and not on theirs is listed too.
create or replace function public.reconcile_supplier_statement(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('payables.view');
  tid uuid := app.tenant_id();
  sup uuid := (p ->> 'supplier_id')::uuid;
  rid uuid;
  l jsonb;
  e ledger_entries;
  amt bigint;
  ours bigint;
  used uuid[] := '{}';
  status text;
  result jsonb;
begin
  if not exists (select 1 from suppliers where id = sup and tenant_id = tid) then raise exception 'Supplier not found' using errcode = 'P0002'; end if;
  insert into supplier_reconciliations (tenant_id, supplier_id, statement_date, period_from, period_to, statement_balance, created_by)
  values (tid, sup, (p ->> 'statement_date')::date, (p ->> 'period_from')::date, (p ->> 'period_to')::date,
          (p ->> 'statement_balance')::bigint, uid)
  returning id into rid;
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]')) loop
    amt := (l ->> 'amount')::bigint;
    e := null;
    if amt > 0 then
      select le.* into e from ledger_entries le join purchase_invoices pi on pi.id = le.reference_id
      where le.supplier_id = sup and le.entry_type = 'purchase_invoice' and le.id <> all (used)
        and lower(pi.supplier_invoice_number) = lower(trim(l ->> 'ref'))
      limit 1;
    end if;
    if e.id is null then
      select le.* into e from ledger_entries le
      where le.supplier_id = sup and le.id <> all (used) and (le.credit - le.debit) = amt
        and abs(le.entry_date - coalesce((l ->> 'date')::date, le.entry_date)) <= 7
      order by abs(le.entry_date - coalesce((l ->> 'date')::date, le.entry_date)), le.entry_date
      limit 1;
    end if;
    if e.id is null then status := 'missing_in_ours';
    elsif (e.credit - e.debit) = amt then status := 'matched';
    else status := 'difference';
    end if;
    if e.id is not null then used := used || e.id; end if;
    insert into supplier_reconciliation_lines (tenant_id, reconciliation_id, statement_ref, statement_date, statement_amount,
                                               ledger_entry_id, match_status, note, created_by)
    values (tid, rid, l ->> 'ref', (l ->> 'date')::date, amt, e.id, status,
            case when status = 'difference' then 'Ours: Rs ' || to_char((e.credit - e.debit) / 100.0, 'FM999,999,999,990.00') end, uid);
  end loop;
  insert into supplier_reconciliation_lines (tenant_id, reconciliation_id, statement_ref, statement_date, statement_amount,
                                             ledger_entry_id, match_status, created_by)
  select tid, rid, coalesce(app.entry_reference(le.reference_type, le.reference_id), le.memo), le.entry_date, null, le.id,
         'missing_in_theirs', uid
  from ledger_entries le
  where le.supplier_id = sup and le.id <> all (used)
    and le.entry_date between (p ->> 'period_from')::date and (p ->> 'period_to')::date;
  select coalesce(sum(credit - debit), 0) into ours from ledger_entries
  where supplier_id = sup and entry_date <= (p ->> 'period_to')::date;
  select jsonb_build_object(
    'reconciliation_id', rid, 'our_balance', ours, 'their_balance', (p ->> 'statement_balance')::bigint,
    'difference', (p ->> 'statement_balance')::bigint - ours,
    'lines', (select jsonb_agg(jsonb_build_object('ref', statement_ref, 'date', statement_date, 'amount', statement_amount,
                                                  'status', match_status, 'note', note) order by created_at, id)
              from supplier_reconciliation_lines where reconciliation_id = rid))
  into result;
  update supplier_reconciliations set status = case when (result ->> 'difference')::bigint = 0
    and not exists (select 1 from supplier_reconciliation_lines where reconciliation_id = rid and match_status <> 'matched')
    then 'completed' else 'open' end where id = rid;
  return result;
end $$;

-- ---- Udhaar reminders -------------------------------------------------------------------
-- Accounts with something overdue whose member agreed to reminders, not reminded in the last
-- N days (setting udhaar.reminder_interval_days, default 7). The message is in Urdu and English.
create or replace function public.udhaar_reminders_due(p_min_days_overdue int default 1)
returns table (account_id uuid, account_name text, phone text, balance bigint, overdue bigint, oldest_due date,
               last_reminded_at timestamptz, message text)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare
  tid uuid := app.tenant_id();
  interval_days int;
  pharmacy text;
  a record;
begin
  perform app.require_perm('udhaar.reminders');
  interval_days := coalesce((app.setting(tid, null, 'udhaar.reminder_interval_days') #>> '{}')::int, 7);
  select name into pharmacy from tenants where id = tid;
  for a in
    select ag.party_id, ag.name, ag.balance, ag.days_1_30 + ag.days_31_60 + ag.days_61_90 + ag.days_over_90 as late, ag.oldest_due
    from public.party_ageing('customer_account') ag
  loop
    continue when a.late <= 0 or a.balance <= 0 or current_date - a.oldest_due < p_min_days_overdue;
    account_id := a.party_id; account_name := a.name; balance := a.balance; overdue := a.late; oldest_due := a.oldest_due;
    select c.phone into phone from customers c
    where c.account_id = a.party_id and c.reminders_opt_in and c.phone is not null and c.archived_at is null
    order by c.created_at limit 1;
    continue when phone is null;
    select max(created_at) into last_reminded_at from reminders_log where customer_account_id = a.party_id;
    continue when last_reminded_at is not null and last_reminded_at > now() - make_interval(days => interval_days);
    message := format(E'السلام علیکم، %s کے کھاتے میں Rs %s باقی ہیں۔ مہربانی فرما کر ادائیگی کر دیں۔ — %s\n'
                      'Assalam-o-alaikum. Rs %s is due on the %s account. Please clear it at your convenience. — %s',
                      a.name, to_char(a.balance / 100.0, 'FM999,999,999,990.00'), pharmacy,
                      to_char(a.balance / 100.0, 'FM999,999,999,990.00'), a.name, pharmacy);
    return next;
  end loop;
end $$;

-- Puts reminders in the WhatsApp queue (sent by the messaging worker, Phase 6) and logs them.
create or replace function public.queue_udhaar_reminders(p_accounts uuid[]) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('udhaar.reminders');
  r record;
  mid uuid;
  n int := 0;
begin
  for r in select * from public.udhaar_reminders_due(0) d where d.account_id = any (p_accounts) loop
    insert into outbound_messages (tenant_id, channel, provider, to_phone, body_rendered, related_type, related_id, created_by)
    values (app.tenant_id(), 'whatsapp', 'pending', r.phone, r.message, 'customer_account', r.account_id, uid)
    returning id into mid;
    insert into reminders_log (tenant_id, customer_account_id, outbound_message_id, balance_at_send, created_by)
    values (app.tenant_id(), r.account_id, mid, r.balance, uid);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---- Self-check ------------------------------------------------------------------------
-- Cached balances against the ledger (should always be empty).
create or replace function app.party_balance_mismatches(p_tenant uuid default null)
returns table (party_type text, party_id uuid, cached bigint, ledger bigint)
language sql stable security definer set search_path = public, app as $$
  with l as (
    select e.tenant_id, e.party_type, coalesce(e.customer_account_id, e.supplier_id) as party_id,
           sum(case e.party_type when 'customer_account' then e.debit - e.credit else e.credit - e.debit end)::bigint as bal
    from ledger_entries e where p_tenant is null or e.tenant_id = p_tenant
    group by 1, 2, 3)
  select coalesce(l.party_type, pb.party_type), coalesce(l.party_id, pb.party_id), pb.balance, l.bal
  from l full join (select * from party_balances where p_tenant is null or tenant_id = p_tenant) pb
    on pb.party_type = l.party_type and pb.party_id = l.party_id
  where coalesce(pb.balance, 0) <> coalesce(l.bal, 0)
$$;

-- ---- Grants -------------------------------------------------------------------------------
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon', f);
  end loop;
end $$;
revoke all on all functions in schema app from public;
grant execute on function
  public.create_customer(jsonb, uuid), public.update_customer(uuid, jsonb, uuid),
  public.record_opening_balance(text, uuid, bigint, date), public.set_credit_limit(uuid, bigint, text),
  public.set_udhaar_block(uuid, boolean, text), public.receive_udhaar_payment(jsonb, uuid),
  public.write_off_udhaar(uuid, bigint, text, uuid), public.save_supplier(jsonb),
  public.create_purchase_order(jsonb), public.send_purchase_order(uuid, text), public.cancel_purchase_order(uuid, text),
  public.post_grn(jsonb, uuid), public.post_purchase_invoice(jsonb, uuid), public.post_purchase_return(jsonb, uuid),
  public.settle_purchase_return(uuid, text, bigint), public.pay_supplier(jsonb),
  public.set_cheque_status(uuid, text, uuid, text), public.open_bills(text, uuid), public.party_ageing(text, date),
  public.party_statement(text, uuid, date, date), public.reconcile_supplier_statement(jsonb),
  public.udhaar_reminders_due(int), public.queue_udhaar_reminders(uuid[])
  to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
