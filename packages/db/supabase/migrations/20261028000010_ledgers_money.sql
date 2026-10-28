-- 0010: udhaar ledger (customers and suppliers), cheques, reconciliation,
-- cash drawers and bank/wallet accounts, expenses, payroll, general ledger.

-- One ledger for both kinds of party.
--   customer_account: debit = they owe us more, credit = they paid/returned.
--   supplier:         credit = we owe them more, debit = we paid/returned.
create table ledger_entries (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  branch_id            uuid,
  party_type           text not null check (party_type in ('customer_account', 'supplier')),
  customer_account_id  uuid,
  supplier_id          uuid,
  entry_type           text not null check (entry_type in (
                         'opening', 'credit_sale', 'payment', 'sale_return', 'purchase_invoice',
                         'purchase_return', 'scheme_claim', 'discount', 'adjustment', 'write_off',
                         'cheque_bounce', 'reversal')),
  debit                bigint not null default 0 check (debit >= 0),
  credit               bigint not null default 0 check (credit >= 0),
  entry_date           date not null,            -- branch-local business date
  due_date             date,                     -- drives ageing and the payables calendar
  reference_type       text,                     -- 'sale', 'sale_return', 'purchase_invoice', 'cheque', ...
  reference_id         uuid,
  reverses_entry_id    uuid,
  payment_method       text check (payment_method in ('cash', 'jazzcash', 'easypaisa', 'bank_transfer', 'cheque', 'card')),
  memo                 text,
  approval_id          uuid,
  occurred_at          timestamptz not null,
  created_at           timestamptz not null default now(),
  created_by           uuid not null references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, customer_account_id) references customer_accounts (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, reverses_entry_id) references ledger_entries (tenant_id, id),
  foreign key (tenant_id, approval_id) references approval_requests (tenant_id, id),
  check ((debit > 0) <> (credit > 0)),
  check ((party_type = 'customer_account') = (customer_account_id is not null)),
  check ((party_type = 'supplier') = (supplier_id is not null)),
  check ((entry_type = 'reversal') = (reverses_entry_id is not null))
);
create index on ledger_entries (tenant_id, customer_account_id, entry_date);
create index on ledger_entries (tenant_id, supplier_id, entry_date);
select app.standardize('ledger_entries', 'ledger');

-- Which payment settles which bill (oldest-first or a chosen bill).
create table ledger_allocations (
  id                uuid primary key default app.uuid_v7(),
  tenant_id         uuid not null references tenants (id),
  payment_entry_id  uuid not null,
  charge_entry_id   uuid not null,
  amount            bigint not null check (amount > 0),
  created_at        timestamptz not null default now(),
  created_by        uuid references users (id),
  device_id         uuid references devices (id),
  foreign key (tenant_id, payment_entry_id) references ledger_entries (tenant_id, id),
  foreign key (tenant_id, charge_entry_id) references ledger_entries (tenant_id, id),
  check (payment_entry_id <> charge_entry_id)
);
select app.standardize('ledger_allocations', 'ledger');

-- Cached balance per party (positive = customer owes us / we owe supplier).
create table party_balances (
  tenant_id      uuid not null references tenants (id),
  party_type     text not null,
  party_id       uuid not null,
  balance        bigint not null default 0,
  last_entry_at  timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (party_type, party_id)
);
create index on party_balances (tenant_id, party_type);

-- What a counter may see about a customer account: allowed or not, and how
-- much more udhaar it can take (see Question 3 — this value is debatable).
create table customer_credit_status (
  account_id        uuid primary key,
  tenant_id         uuid not null references tenants (id),
  status            text not null check (status in ('allowed', 'blocked', 'over_limit', 'no_limit_set')),
  available_credit  bigint,
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, account_id) references customer_accounts (tenant_id, id)
);

create or replace function app.refresh_credit_status(p_account uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  acct     customer_accounts%rowtype;
  lim      bigint;
  bal      bigint;
  st       text;
  avail    bigint;
begin
  select * into acct from customer_accounts where id = p_account;
  select limit_amount into lim from credit_limits
    where account_id = p_account order by effective_from desc, created_at desc limit 1;
  select coalesce(balance, 0) into bal from party_balances
    where party_type = 'customer_account' and party_id = p_account;
  bal := coalesce(bal, 0);
  if acct.udhaar_blocked then st := 'blocked'; avail := 0;
  elsif lim is null then st := 'no_limit_set'; avail := null;
  elsif bal >= lim then st := 'over_limit'; avail := 0;
  else st := 'allowed'; avail := lim - bal;
  end if;
  insert into customer_credit_status (account_id, tenant_id, status, available_credit)
  values (p_account, acct.tenant_id, st, avail)
  on conflict (account_id) do update
    set status = excluded.status, available_credit = excluded.available_credit, updated_at = now();
end $$;

create or replace function app.apply_ledger_entry() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  pid   uuid := coalesce(new.customer_account_id, new.supplier_id);
  delta bigint := case new.party_type when 'customer_account' then new.debit - new.credit
                                      else new.credit - new.debit end;
begin
  insert into party_balances as pb (tenant_id, party_type, party_id, balance, last_entry_at)
  values (new.tenant_id, new.party_type, pid, delta, new.occurred_at)
  on conflict (party_type, party_id) do update
    set balance = pb.balance + excluded.balance,
        last_entry_at = greatest(pb.last_entry_at, excluded.last_entry_at),
        updated_at = now();
  if new.party_type = 'customer_account' then
    perform app.refresh_credit_status(pid);
  end if;
  return null;
end $$;
create trigger trg_apply_ledger after insert on ledger_entries
  for each row execute function app.apply_ledger_entry();

create or replace function app.credit_status_from_account() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.refresh_credit_status(new.account_id);
  return null;
end $$;
create trigger trg_credit_status after insert on credit_limits
  for each row execute function app.credit_status_from_account();

create or replace function app.credit_status_from_block() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.refresh_credit_status(new.id);
  return null;
end $$;
create trigger trg_credit_status after insert or update of udhaar_blocked on customer_accounts
  for each row execute function app.credit_status_from_block();

create table bank_accounts (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  branch_id          uuid,                 -- null = shared by all branches
  kind               text not null check (kind in ('bank', 'jazzcash', 'easypaisa', 'card_settlement', 'other')),
  name               text not null,        -- shown at the counter: 'Meezan current', 'Shop JazzCash'
  bank_name          text,
  account_title      text,
  account_reference  text,                 -- masked number / IBAN tail
  gl_account_id      uuid,                 -- FK below
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('bank_accounts', 'master');

create table cheques (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  direction            text not null check (direction in ('received', 'issued')),
  party_type           text not null check (party_type in ('customer_account', 'supplier')),
  customer_account_id  uuid,
  supplier_id          uuid,
  bank_account_id      uuid,
  cheque_number        text not null,
  drawer_bank          text,
  cheque_date          date not null,
  amount               bigint not null check (amount > 0),
  status               text not null default 'pending'
                       check (status in ('pending', 'deposited', 'cleared', 'bounced', 'cancelled')),
  status_changed_at    timestamptz,
  ledger_entry_id      uuid,
  bounce_entry_id      uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_account_id) references customer_accounts (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id),
  foreign key (tenant_id, ledger_entry_id) references ledger_entries (tenant_id, id),
  foreign key (tenant_id, bounce_entry_id) references ledger_entries (tenant_id, id),
  check ((party_type = 'customer_account') = (customer_account_id is not null)),
  check ((party_type = 'supplier') = (supplier_id is not null))
);
select app.standardize('cheques', 'document');

-- Match a supplier's statement line by line against our ledger.
create table supplier_reconciliations (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  supplier_id        uuid not null,
  statement_date     date not null,
  period_from        date not null,
  period_to          date not null,
  statement_balance  bigint not null,
  status             text not null default 'open' check (status in ('open', 'completed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id)
);
select app.standardize('supplier_reconciliations', 'document');

create table supplier_reconciliation_lines (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  reconciliation_id  uuid not null,
  statement_ref      text,
  statement_date     date,
  statement_amount   bigint,
  ledger_entry_id    uuid,
  match_status       text not null check (match_status in ('matched', 'difference', 'missing_in_ours', 'missing_in_theirs')),
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  foreign key (tenant_id, reconciliation_id) references supplier_reconciliations (tenant_id, id),
  foreign key (tenant_id, ledger_entry_id) references ledger_entries (tenant_id, id)
);
select app.standardize('supplier_reconciliation_lines', 'document');

create table cash_drawers (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  branch_id      uuid not null,
  device_id      uuid references devices (id),     -- the counter it sits under
  name           text not null,
  gl_account_id  uuid,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('cash_drawers', 'master');

-- Blind closing: the salesman enters counted_cash; expected and variance are
-- in drawer_session_reconciliations, which only the owner can read.
create table drawer_sessions (
  id                     uuid primary key default app.uuid_v7(),
  tenant_id              uuid not null references tenants (id),
  branch_id              uuid not null,
  cash_drawer_id         uuid not null,
  opened_by              uuid not null references users (id),
  opened_at              timestamptz not null,
  opening_float          bigint not null check (opening_float >= 0),
  closed_by              uuid references users (id),
  closed_at              timestamptz,
  counted_cash           bigint check (counted_cash >= 0),
  counted_denominations  jsonb,               -- {"5000":2,"1000":7,...}
  status                 text not null default 'open' check (status in ('open', 'closed')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references users (id),
  device_id              uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, cash_drawer_id) references cash_drawers (tenant_id, id),
  check ((status = 'closed') = (closed_at is not null and counted_cash is not null))
);
create unique index drawer_one_open_session on drawer_sessions (cash_drawer_id) where status = 'open';
select app.standardize('drawer_sessions', 'document');

create table drawer_session_reconciliations (
  drawer_session_id  uuid primary key,
  tenant_id          uuid not null references tenants (id),
  expected_cash      bigint not null,
  variance           bigint not null,     -- counted - expected: + over, - short
  computed_at        timestamptz not null default now(),
  reviewed_by        uuid references users (id),
  reviewed_at        timestamptz,
  review_note        text,
  foreign key (tenant_id, drawer_session_id) references drawer_sessions (tenant_id, id)
);

-- Every rupee in or out of a drawer or a bank/wallet account. Signed amount.
create table cash_movements (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  branch_id          uuid,
  drawer_session_id  uuid,
  bank_account_id    uuid,
  movement_type      text not null check (movement_type in (
                       'opening_float', 'cash_sale', 'sale_refund', 'udhaar_collection', 'supplier_payment',
                       'expense', 'salary', 'staff_advance', 'payout', 'cash_in', 'cash_out',
                       'bank_deposit', 'account_transfer', 'closing_withdrawal', 'reversal')),
  amount             bigint not null check (amount <> 0),
  reference_type     text,
  reference_id       uuid,
  reverses_movement_id uuid,
  memo               text,
  occurred_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  created_by         uuid not null references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, drawer_session_id) references drawer_sessions (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id),
  foreign key (tenant_id, reverses_movement_id) references cash_movements (tenant_id, id),
  check ((drawer_session_id is null) <> (bank_account_id is null))
);
create index on cash_movements (tenant_id, drawer_session_id);
create index on cash_movements (tenant_id, bank_account_id, occurred_at);
select app.standardize('cash_movements', 'ledger');

create table money_balances (
  tenant_id     uuid not null references tenants (id),
  account_kind  text not null check (account_kind in ('drawer_session', 'bank_account')),
  account_id    uuid not null,
  balance       bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (account_kind, account_id)
);

create or replace function app.apply_cash_movement() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into money_balances as mb (tenant_id, account_kind, account_id, balance)
  values (new.tenant_id,
          case when new.drawer_session_id is not null then 'drawer_session' else 'bank_account' end,
          coalesce(new.drawer_session_id, new.bank_account_id),
          new.amount)
  on conflict (account_kind, account_id) do update
    set balance = mb.balance + excluded.balance, updated_at = now();
  return null;
end $$;
create trigger trg_apply_cash after insert on cash_movements
  for each row execute function app.apply_cash_movement();

alter table sale_payments
  add foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id),
  add foreign key (tenant_id, drawer_session_id) references drawer_sessions (tenant_id, id);
alter table sale_returns
  add foreign key (tenant_id, drawer_session_id) references drawer_sessions (tenant_id, id);

create table expense_categories (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  name           text not null,
  name_ur        text,
  gl_account_id  uuid,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users (id),
  device_id      uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
select app.standardize('expense_categories', 'master');

create table recurring_expenses (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  branch_id     uuid,
  category_id   uuid not null,
  description   text not null,
  amount        bigint not null check (amount > 0),
  frequency     text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  next_due_on   date not null,
  paused_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users (id),
  device_id     uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, category_id) references expense_categories (tenant_id, id)
);
select app.standardize('recurring_expenses', 'master');

create table expenses (
  id                    uuid primary key default app.uuid_v7(),
  tenant_id             uuid not null references tenants (id),
  branch_id             uuid not null,
  category_id           uuid not null,
  recurring_expense_id  uuid,
  description           text not null,
  amount                bigint not null check (amount > 0),
  expense_date          date not null,
  paid_from             text not null check (paid_from in ('drawer', 'bank_account', 'unpaid')),
  drawer_session_id     uuid,
  bank_account_id       uuid,
  receipt_paths         text[] not null default '{}',
  status                text not null default 'posted' check (status in ('posted', 'voided')),
  voided_at             timestamptz,
  void_reason           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users (id),
  device_id             uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, category_id) references expense_categories (tenant_id, id),
  foreign key (tenant_id, recurring_expense_id) references recurring_expenses (tenant_id, id),
  foreign key (tenant_id, drawer_session_id) references drawer_sessions (tenant_id, id),
  foreign key (tenant_id, bank_account_id) references bank_accounts (tenant_id, id),
  check ((paid_from = 'drawer') = (drawer_session_id is not null)),
  check ((paid_from = 'bank_account') = (bank_account_id is not null))
);
select app.standardize('expenses', 'document');

-- Salary rate history and monthly salary slips.
create table salary_rates (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  user_id         uuid not null,
  monthly_amount  bigint not null check (monthly_amount >= 0),
  effective_from  date not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  unique (user_id, effective_from),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
select app.standardize('salary_rates', 'ledger');

create table staff_advances (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  user_id             uuid not null,
  amount              bigint not null check (amount > 0),
  given_on            date not null,
  recovery_per_month  bigint check (recovery_per_month > 0),
  status              text not null default 'open' check (status in ('open', 'recovered', 'written_off')),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
select app.standardize('staff_advances', 'document');

create table salaries (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  user_id            uuid not null,
  period_month       date not null check (extract(day from period_month) = 1),
  gross_amount       bigint not null check (gross_amount >= 0),
  other_deductions   bigint not null default 0 check (other_deductions >= 0),
  advance_recovery   bigint not null default 0 check (advance_recovery >= 0),
  net_amount         bigint not null check (net_amount >= 0),
  status             text not null default 'draft' check (status in ('draft', 'paid', 'voided')),
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  unique (user_id, period_month),
  foreign key (tenant_id, user_id) references users (tenant_id, id),
  check (net_amount = gross_amount - other_deductions - advance_recovery)
);
select app.standardize('salaries', 'document');

create table salary_advance_recoveries (
  id                uuid primary key default app.uuid_v7(),
  tenant_id         uuid not null references tenants (id),
  salary_id         uuid not null,
  staff_advance_id  uuid not null,
  amount            bigint not null check (amount > 0),
  created_at        timestamptz not null default now(),
  created_by        uuid references users (id),
  foreign key (tenant_id, salary_id) references salaries (tenant_id, id),
  foreign key (tenant_id, staff_advance_id) references staff_advances (tenant_id, id)
);
select app.standardize('salary_advance_recoveries', 'ledger');

-- General ledger underneath everything. Journals are posted by server-side
-- functions from business documents; owners never type journal lines unless
-- they choose to (manual journal, accountant only).
create table gl_accounts (
  id           uuid primary key default app.uuid_v7(),
  tenant_id    uuid not null references tenants (id),
  code         text not null,
  name         text not null,
  type         text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  system_code  text,       -- 'cash', 'bank', 'inventory', 'receivables', 'payables', 'sales', 'cogs', 'tax_payable', ...
  parent_id    uuid,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references users (id),
  device_id    uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, parent_id) references gl_accounts (tenant_id, id)
);
create unique index gl_accounts_system_code on gl_accounts (tenant_id, system_code) where system_code is not null;
select app.standardize('gl_accounts', 'master');

alter table bank_accounts      add foreign key (tenant_id, gl_account_id) references gl_accounts (tenant_id, id);
alter table cash_drawers       add foreign key (tenant_id, gl_account_id) references gl_accounts (tenant_id, id);
alter table expense_categories add foreign key (tenant_id, gl_account_id) references gl_accounts (tenant_id, id);

create table gl_journals (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  branch_id            uuid,
  journal_date         date not null,
  source_type          text not null,       -- 'sale', 'sale_return', 'grn', 'expense', 'manual', ...
  source_id            uuid,
  memo                 text,
  reverses_journal_id  uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, reverses_journal_id) references gl_journals (tenant_id, id)
);
create index on gl_journals (tenant_id, source_type, source_id);
select app.standardize('gl_journals', 'ledger');

create table gl_entries (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  journal_id     uuid not null,
  gl_account_id  uuid not null,
  branch_id      uuid,
  debit          bigint not null default 0 check (debit >= 0),
  credit         bigint not null default 0 check (credit >= 0),
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, journal_id) references gl_journals (tenant_id, id),
  foreign key (tenant_id, gl_account_id) references gl_accounts (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  check ((debit > 0) <> (credit > 0))
);
create index on gl_entries (tenant_id, gl_account_id);
select app.standardize('gl_entries', 'ledger');

-- Every journal must balance by commit time.
create or replace function app.check_journal_balanced() returns trigger
language plpgsql as $$
declare
  diff bigint;
begin
  select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) into diff
  from gl_entries where journal_id = new.journal_id;
  if diff <> 0 then
    raise exception 'GL journal % is unbalanced by %', new.journal_id, diff using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger trg_journal_balanced after insert on gl_entries
  deferrable initially deferred for each row execute function app.check_journal_balanced();
