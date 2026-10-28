-- 0002: platform admins, plans, features and tenants.
-- Platform tables have no tenant_id (or a nullable one) and are readable only
-- by platform admins; prices and limits live here as data, never in code.

create table platform_admins (
  id            uuid primary key default app.uuid_v7(),
  auth_user_id  uuid not null unique references auth.users (id),
  full_name     text not null,
  email         text not null unique,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Catalogue of switchable modules / limits (seeded by migration, not by UI).
create table features (
  code         text primary key,                 -- e.g. 'fbr', 'approvals', 'max_counters'
  module       text not null,
  name         text not null,
  description  text not null default '',
  kind         text not null check (kind in ('boolean', 'limit')),
  created_at   timestamptz not null default now()
);

create table plans (
  id              uuid primary key default app.uuid_v7(),
  code            text not null unique,          -- 'basic', 'pro', 'enterprise'
  name            text not null,
  currency        char(3) not null default 'PKR',
  price_monthly   bigint not null default 0 check (price_monthly >= 0),
  price_yearly    bigint not null default 0 check (price_yearly >= 0),
  trial_days      int not null default 14 check (trial_days >= 0),
  is_public       boolean not null default true,
  sort_order      int not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table plan_features (
  plan_id       uuid not null references plans (id),
  feature_code  text not null references features (code),
  enabled       boolean not null default true,
  limit_value   bigint,                          -- null = unlimited for 'limit' features
  primary key (plan_id, feature_code)
);

create table tenants (
  id                    uuid primary key default app.uuid_v7(),
  name                  text not null,
  legal_name            text not null default '',
  owner_name            text not null,
  owner_phone           text not null,
  owner_email           text not null,
  city                  text not null default '',
  country_code          char(2) not null default 'PK',
  currency              char(3) not null default 'PKR',
  currency_minor_units  smallint not null default 2 check (currency_minor_units between 0 and 3),
  default_language      text not null default 'en' check (default_language in ('en', 'ur')),
  time_zone             text not null default 'Asia/Karachi',
  number_format         text not null default 'lakh' check (number_format in ('lakh', 'international')),
  status                text not null default 'trial'
                        check (status in ('trial', 'active', 'grace', 'read_only', 'suspended', 'cancelled')),
  plan_id               uuid not null references plans (id),
  trial_ends_at         timestamptz,
  grace_ends_at         timestamptz,
  read_only_from        timestamptz,          -- applied at branch closing time, never mid-day
  cancelled_at          timestamptz,
  purge_after           timestamptz,          -- cancelled_at + 90 days
  release_channel       text not null default 'stable' check (release_channel in ('internal', 'beta', 'stable')),
  offline_licence_days  int not null default 7 check (offline_licence_days between 1 and 60),
  white_label           jsonb not null default '{}'::jsonb,   -- Enterprise: logo, colours, bill header
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger trg_touch before update on tenants for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on tenants for each row execute function app.forbid_delete();

create table tenant_feature_overrides (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  feature_code  text not null references features (code),
  enabled       boolean not null,
  limit_value   bigint,
  reason        text not null default '',
  expires_at    timestamptz,
  created_by    uuid references platform_admins (id),
  created_at    timestamptz not null default now(),
  unique (tenant_id, feature_code)
);

-- Global switches and percentage rollouts. Resolution order (most specific
-- wins): tenant override > rollout targeting the tenant's plan > global rollout > plan_features.
create table feature_rollouts (
  id            uuid primary key default app.uuid_v7(),
  feature_code  text not null references features (code),
  scope         text not null check (scope in ('global', 'plan', 'percentage')),
  plan_id       uuid references plans (id),
  percentage    smallint check (percentage between 0 and 100),
  enabled       boolean not null,
  created_by    uuid references platform_admins (id),
  created_at    timestamptz not null default now(),
  check ((scope = 'plan') = (plan_id is not null)),
  check ((scope = 'percentage') = (percentage is not null))
);

-- Platform-wide key/value (e.g. min_app_version.desktop).
create table platform_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references platform_admins (id),
  updated_at  timestamptz not null default now()
);

-- Admin actions: append-only, separate from tenant audit_log.
create table platform_audit_log (
  id           uuid primary key default app.uuid_v7(),
  admin_id     uuid references platform_admins (id),
  tenant_id    uuid references tenants (id),
  action       text not null,
  details      jsonb not null default '{}'::jsonb,
  ip           inet,
  occurred_at  timestamptz not null default now()
);
create index on platform_audit_log (tenant_id, occurred_at desc);
select app.standardize('platform_audit_log', 'ledger');
