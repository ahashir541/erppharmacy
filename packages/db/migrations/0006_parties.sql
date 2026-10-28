-- 0006: customers and their udhaar accounts, doctors, suppliers.
-- Balances are NOT stored here — see ledger_entries / party_balances (0010).

-- Every customer belongs to an account. A walk-in regular gets a personal
-- account automatically; a family, clinic or factory account has many members.
create table customer_accounts (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  account_number     text not null,
  name               text not null,
  kind               text not null default 'individual' check (kind in ('individual', 'family', 'company')),
  default_due_days   int check (default_due_days >= 0),
  udhaar_blocked     boolean not null default false,
  blocked_reason     text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, account_number),
  check (not udhaar_blocked or blocked_reason is not null)
);
select app.standardize('customer_accounts', 'master');

create table customers (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  account_id           uuid not null,
  name                 text not null,
  name_ur              text,
  phone                text,
  cnic                 text,
  address              text,
  photo_path           text,
  guarantor_name       text,
  guarantor_phone      text,
  can_buy_on_account   boolean not null default true,   -- member allowed to use the account's udhaar
  reminders_opt_in     boolean not null default false,
  marketing_opt_in     boolean not null default false,
  notes                text,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, account_id) references customer_accounts (tenant_id, id)
);
create index on customers (tenant_id, phone);
create index on customers using gin (name gin_trgm_ops);
select app.standardize('customers', 'master');

-- Credit limit history (append-only); the latest row is in force.
create table credit_limits (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  account_id      uuid not null,
  limit_amount    bigint not null check (limit_amount >= 0),
  effective_from  timestamptz not null default now(),
  reason          text not null default '',
  created_at      timestamptz not null default now(),
  created_by      uuid not null references users (id),
  device_id       uuid references devices (id),
  foreign key (tenant_id, account_id) references customer_accounts (tenant_id, id)
);
create index on credit_limits (account_id, effective_from desc);
select app.standardize('credit_limits', 'ledger');

create table doctors (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  name          text not null,
  name_ur       text,
  pmdc_number   text,
  specialty     text,
  clinic        text,
  phone         text,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users (id),
  device_id     uuid references devices (id),
  unique (tenant_id, id)
);
select app.standardize('doctors', 'master');

create table suppliers (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  name                text not null,
  contact_name        text,
  phone               text,
  whatsapp            text,
  email               text,
  address             text,
  city                text,
  ntn                 text,
  strn                text,
  payment_terms_days  int check (payment_terms_days >= 0),
  credit_limit        bigint check (credit_limit >= 0),
  lead_time_days      int check (lead_time_days >= 0),
  is_active           boolean not null default true,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
select app.standardize('suppliers', 'master');

-- Companies a distributor supplies (used by reorder suggestions).
create table supplier_manufacturers (
  tenant_id        uuid not null references tenants (id),
  supplier_id      uuid not null,
  manufacturer_id  uuid not null,
  created_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  primary key (supplier_id, manufacturer_id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, manufacturer_id) references manufacturers (tenant_id, id)
);
