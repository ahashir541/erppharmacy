-- 0004: subscriptions and billing, releases, announcements, global data
-- pushed to all tenants (catalogue, recalls), support, backups.

create table subscriptions (
  id                    uuid primary key default app.uuid_v7(),
  tenant_id             uuid not null references tenants (id),
  plan_id               uuid not null references plans (id),
  billing_cycle         text not null check (billing_cycle in ('monthly', 'yearly')),
  price                 bigint not null check (price >= 0),   -- agreed price; may differ from list
  currency              char(3) not null,
  status                text not null check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  current_period_start  timestamptz not null,
  current_period_end    timestamptz not null,
  cancel_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
create unique index subscriptions_one_live on subscriptions (tenant_id) where status <> 'cancelled';
create trigger trg_touch before update on subscriptions for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on subscriptions for each row execute function app.forbid_delete();

create table platform_invoices (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  subscription_id  uuid references subscriptions (id),
  invoice_number   text not null unique,
  amount           bigint not null check (amount >= 0),
  currency         char(3) not null,
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  due_at           timestamptz not null,
  status           text not null default 'due' check (status in ('draft', 'due', 'submitted', 'paid', 'overdue', 'void')),
  paid_at          timestamptz,
  void_reason      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on platform_invoices (tenant_id, created_at desc);
create trigger trg_touch before update on platform_invoices for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on platform_invoices for each row execute function app.forbid_delete();

-- Payment references submitted by the pharmacy, verified by the platform owner
-- (carries over today's manual JazzCash/Easypaisa/bank flow).
create table platform_payments (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  invoice_id      uuid not null references platform_invoices (id),
  method          text not null check (method in ('bank_transfer', 'jazzcash', 'easypaisa', 'card', 'cash', 'other')),
  amount          bigint not null check (amount > 0),
  reference       text not null,
  submitted_by    uuid references users (id),
  submitted_at    timestamptz not null default now(),
  status          text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  reviewed_by     uuid references platform_admins (id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger trg_touch before update on platform_payments for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on platform_payments for each row execute function app.forbid_delete();

create table app_releases (
  id              uuid primary key default app.uuid_v7(),
  app             text not null check (app in ('desktop', 'web', 'admin', 'mobile')),
  version         text not null,
  channel         text not null check (channel in ('internal', 'beta', 'stable')),
  notes           text not null default '',
  artifact_url    text,
  signature       text,                 -- Tauri updater signature
  published_at    timestamptz,
  rolled_back_at  timestamptz,
  created_by      uuid references platform_admins (id),
  created_at      timestamptz not null default now(),
  unique (app, version, channel)
);

create table announcements (
  id          uuid primary key default app.uuid_v7(),
  title       text not null,
  title_ur    text,
  body        text not null,
  body_ur     text,
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  audience    text not null check (audience in ('all', 'plan', 'tenant')),
  plan_id     uuid references plans (id),
  tenant_id   uuid references tenants (id),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  created_by  uuid references platform_admins (id),
  created_at  timestamptz not null default now(),
  check ((audience = 'plan') = (plan_id is not null)),
  check ((audience = 'tenant') = (tenant_id is not null))
);

-- Global medicine catalogue maintained by the platform owner and offered to
-- tenants on import. Tenants copy rows into their own products table.
create table global_generics (
  id          uuid primary key default app.uuid_v7(),
  name        text not null unique,
  name_ur     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table global_manufacturers (
  id          uuid primary key default app.uuid_v7(),
  name        text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table global_catalogue (
  id                  uuid primary key default app.uuid_v7(),
  brand_name          text not null,
  brand_name_ur       text,
  generic_id          uuid references global_generics (id),
  strength            text,
  dosage_form         text,               -- tablet, capsule, syrup, injection, ...
  manufacturer_id     uuid references global_manufacturers (id),
  pack_description    text,               -- '10 x 10 tablets'
  pack_units          jsonb,              -- suggested unit ladder: [{"unit":"box","factor":100},...]
  barcodes            text[] not null default '{}',
  registration_no     text,               -- DRAP registration number
  is_controlled       boolean not null default false,
  rx_required         boolean not null default false,
  catalogue_version   int not null default 1,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on global_catalogue using gin (brand_name gin_trgm_ops);

-- Banned / recalled batches pushed to every tenant; matching batches are
-- frozen by trigger in 0006 (batch_blocks).
create table global_recalls (
  id                   uuid primary key default app.uuid_v7(),
  global_catalogue_id  uuid references global_catalogue (id),
  brand_name           text not null,
  manufacturer_name    text,
  batch_number         text not null,
  reason               text not null,
  authority_reference  text,
  action               text not null default 'freeze' check (action in ('freeze', 'warn')),
  issued_at            timestamptz not null default now(),
  lifted_at            timestamptz,
  created_by           uuid references platform_admins (id),
  created_at           timestamptz not null default now()
);
create index on global_recalls (lower(batch_number));

create table support_tickets (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  opened_by        uuid references users (id),
  device_id        uuid references devices (id),
  subject          text not null,
  body             text not null,
  status           text not null default 'open' check (status in ('open', 'waiting_on_customer', 'resolved', 'closed')),
  priority         text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  device_log_path  text,                 -- Supabase Storage path
  assigned_to      uuid references platform_admins (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz
);
create trigger trg_touch before update on support_tickets for each row execute function app.touch_updated_at();

create table support_ticket_messages (
  id           uuid primary key default app.uuid_v7(),
  ticket_id    uuid not null references support_tickets (id),
  author_user  uuid references users (id),
  author_admin uuid references platform_admins (id),
  body         text not null,
  created_at   timestamptz not null default now(),
  check ((author_user is null) <> (author_admin is null))
);
select app.standardize('support_ticket_messages', 'ledger');

-- Time-limited consent from the pharmacy owner. Without an active
-- 'financial' grant, support can never read money data.
create table support_access_grants (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  admin_id    uuid not null references platform_admins (id),
  scope       text not null check (scope in ('technical', 'financial', 'impersonate')),
  reason      text not null,
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  granted_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  check (expires_at > starts_at and expires_at <= starts_at + interval '7 days')
);

-- Nightly per-tenant encrypted exports and restore tests.
create table tenant_backups (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  kind               text not null check (kind in ('nightly', 'manual', 'pre_purge')),
  storage_path       text not null,
  size_bytes         bigint,
  sha256             text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz,
  restore_tested_at  timestamptz,
  restore_test_ok    boolean
);
