-- 0003: staff, branches, devices, settings, roles/permissions, approvals,
-- sessions and the append-only audit log.

-- A user is one person's membership in one tenant. Owners sign in with
-- Supabase Auth (email + TOTP 2FA) from anywhere. All other staff have no
-- cloud account and unlock a registered pharmacy PC with a PIN (D11).
create table users (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  auth_user_id        uuid references auth.users (id),
  kind                text not null default 'staff' check (kind in ('owner', 'staff')),
  is_primary_owner    boolean not null default false,
  full_name           text not null,
  full_name_ur        text,
  phone               text,
  phone_verified_at   timestamptz,
  email               text,
  preferred_language  text not null default 'en' check (preferred_language in ('en', 'ur')),
  idle_lock_seconds   int not null default 300 check (idle_lock_seconds between 30 and 3600),
  allowed_hours       jsonb,          -- e.g. {"mon":["09:00","22:00"],...}; null = any time
  status              text not null default 'active' check (status in ('invited', 'active', 'disabled')),
  disabled_at         timestamptz,
  disabled_reason     text,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid,           -- FK added after devices
  unique (tenant_id, id),
  unique (tenant_id, auth_user_id),
  check (not is_primary_owner or kind = 'owner'),
  -- D11: only owners sign in to the cloud; other staff work on pharmacy PCs by PIN.
  check (auth_user_id is null or kind = 'owner')
);
-- Exactly one primary owner per tenant; they can never be disabled.
create unique index users_one_primary_owner on users (tenant_id) where is_primary_owner;
alter table users add constraint primary_owner_always_active
  check (not is_primary_owner or (status in ('invited', 'active') and archived_at is null));
select app.standardize('users', 'master');

-- PIN hashes are kept apart from users so they sync only to counter devices
-- the person may use (argon2id, per-user salt).
create table user_pins (
  user_id          uuid primary key,
  tenant_id        uuid not null references tenants (id),
  pin_hash         text not null,
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
create trigger trg_touch before update on user_pins for each row execute function app.touch_updated_at();

-- Owner 2FA recovery codes (Supabase MFA has TOTP but not recovery codes).
create table private.owner_recovery_codes (
  id         uuid primary key default app.uuid_v7(),
  user_id    uuid not null references users (id),
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- Shops and warehouses share one table; `warehouses` is a view (see below).
create table branches (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  code                text not null,               -- 'KHI1': first part of invoice numbers
  kind                text not null default 'shop' check (kind in ('shop', 'warehouse')),
  name                text not null,
  name_ur             text,
  address             text not null default '',
  city                text not null default '',
  phone               text,
  time_zone           text,                         -- null = tenant time zone
  closing_time        time,                         -- read-only mode / updates start after this
  provincial_tax_authority text check (provincial_tax_authority in ('SRB', 'PRA', 'KPRA', 'BRA')),
  is_active           boolean not null default true,
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid,
  unique (tenant_id, id),
  unique (tenant_id, code)
);
select app.standardize('branches', 'master');

create view warehouses with (security_invoker = true) as
  select * from branches where kind = 'warehouse';

-- A device is one installed app: a counter PC, the owner's phone, a browser.
create table devices (
  id                uuid primary key default app.uuid_v7(),
  tenant_id         uuid not null references tenants (id),
  branch_id         uuid,
  auth_user_id      uuid unique references auth.users (id),  -- device principal (Question 1)
  code              text not null,                 -- 'C2'
  invoice_prefix    text not null,                 -- 'KHI1-C2'; never reused
  name              text not null,
  kind              text not null check (kind in ('counter', 'owner_mobile', 'web')),
  platform          text,                          -- 'windows', 'android', 'browser'
  app_version       text,
  release_channel   text check (release_channel in ('internal', 'beta', 'stable')),
  is_branch_hub     boolean not null default false,
  status            text not null default 'active' check (status in ('pending', 'active', 'disabled')),
  last_seen_at      timestamptz,
  last_sync_at      timestamptz,
  pending_changes   int not null default 0,
  registered_at     timestamptz not null default now(),
  disabled_at       timestamptz,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references users (id),
  unique (tenant_id, id),
  unique (tenant_id, invoice_prefix),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  check (kind <> 'counter' or branch_id is not null)
);
select app.standardize('devices', 'master');

alter table users    add foreign key (device_id) references devices (id);
alter table branches add foreign key (device_id) references devices (id);

-- Signed offline licence tokens handed to counters (token itself is not stored).
create table device_licences (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  device_id     uuid not null,
  token_sha256  text not null,
  issued_at     timestamptz not null default now(),
  valid_until   timestamptz not null,
  revoked_at    timestamptz,
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);

create table user_allowed_devices (
  tenant_id  uuid not null references tenants (id),
  user_id    uuid not null,
  device_id  uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references users (id),
  primary key (user_id, device_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);

-- Key/value settings per tenant, optionally overridden per branch.
create table settings (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  branch_id   uuid,
  key         text not null,              -- e.g. 'pos.near_expiry_days', 'udhaar.otp_above'
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users (id),
  device_id   uuid references devices (id),
  unique nulls not distinct (tenant_id, branch_id, key),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('settings', 'master');

-- Global permission catalogue (~60 rows, seeded by migration).
create table permissions (
  code          text primary key,          -- 'sales.view_totals', 'product.view_cost', ...
  module        text not null,
  name          text not null,
  name_ur       text,
  description   text not null default '',
  limit_kind    text check (limit_kind in ('amount', 'percent_bp', 'count_per_day', 'amount_per_day')),
  is_sensitive  boolean not null default false,   -- money visibility; never granted to device principals
  counter_safe  boolean not null default false,   -- what a counter device principal may read
  sort_order    int not null default 0
);

-- The brief's default role matrix; copied into each tenant's roles at onboarding.
create table role_template_permissions (
  template_code    text not null check (template_code in ('owner', 'manager', 'pharmacist', 'salesman', 'storekeeper', 'accountant')),
  permission_code  text not null references permissions (code),
  allowed          boolean not null,        -- false = shown to the owner as "off by default"
  needs_approval   boolean not null default false,
  limit_value      bigint,
  primary key (template_code, permission_code)
);

create table roles (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  name           text not null,
  name_ur        text,
  template_code  text check (template_code in ('owner', 'manager', 'pharmacist', 'salesman', 'storekeeper', 'accountant')),
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users (id),
  device_id      uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
select app.standardize('roles', 'master');

create table role_permissions (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  role_id          uuid not null,
  permission_code  text not null references permissions (code),
  allowed          boolean not null default true,
  needs_approval   boolean not null default false,
  limit_value      bigint,        -- unit given by permissions.limit_kind
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique (role_id, permission_code),
  foreign key (tenant_id, role_id) references roles (tenant_id, id)
);
select app.standardize('role_permissions', 'master');

-- Role per branch (branch_id null = all branches).
create table user_roles (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  user_id     uuid not null,
  role_id     uuid not null,
  branch_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users (id),
  device_id   uuid references devices (id),
  unique nulls not distinct (user_id, role_id, branch_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id),
  foreign key (tenant_id, role_id) references roles (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('user_roles', 'master');

-- Per-person exceptions on top of roles ("permission by permission").
create table user_permission_overrides (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  user_id          uuid not null,
  branch_id        uuid,
  permission_code  text not null references permissions (code),
  allowed          boolean not null,
  needs_approval   boolean not null default false,
  limit_value      bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique nulls not distinct (user_id, branch_id, permission_code),
  foreign key (tenant_id, user_id) references users (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('user_permission_overrides', 'master');

create table approval_requests (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  branch_id        uuid not null,
  kind             text not null check (kind in ('discount', 'void', 'return', 'price_change', 'udhaar_over_limit',
                                                  'negative_stock', 'controlled_quantity', 'other')),
  permission_code  text references permissions (code),
  reference_type   text,
  reference_id     uuid,
  amount           bigint,
  details          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  decided_by       uuid references users (id),
  decided_at       timestamptz,
  decided_via      text check (decided_via in ('app', 'counter_pin')),
  decision_note    text,
  expires_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid not null references users (id),
  device_id        uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  check ((status in ('approved', 'rejected')) = (decided_by is not null))
);
create index on approval_requests (tenant_id, status, created_at desc);
select app.standardize('approval_requests', 'document');

-- Login/unlock sessions: remote logout and the attendance report.
create table user_sessions (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  user_id          uuid not null,
  branch_id        uuid,
  device_id        uuid references devices (id),
  auth_session_id  uuid,                 -- Supabase auth session, when there is one
  method           text not null check (method in ('password', 'pin', 'passkey')),
  started_at       timestamptz not null,
  last_active_at   timestamptz,
  ended_at         timestamptz,
  end_reason       text check (end_reason in ('logout', 'idle_lock', 'remote_revoke', 'expired', 'disabled')),
  revoked_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
create index on user_sessions (tenant_id, user_id, started_at desc);
create trigger trg_touch before update on user_sessions for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on user_sessions for each row execute function app.forbid_delete();

-- Append-only; no one (owner included) can edit or delete it.
-- Expected to be large: partition by month on occurred_at before launch.
create table audit_log (
  id           uuid primary key default app.uuid_v7(),
  tenant_id    uuid not null references tenants (id),
  branch_id    uuid,
  user_id      uuid,
  device_id    uuid,
  action       text not null,      -- insert/update/void/login/logout/export/permission_change/drawer_open_no_sale/...
  table_name   text,
  record_id    uuid,
  old_data     jsonb,
  new_data     jsonb,
  context      jsonb not null default '{}'::jsonb,   -- ip, app version, approval id
  occurred_at  timestamptz not null default now()
);
create index on audit_log (tenant_id, occurred_at desc);
create index on audit_log (tenant_id, table_name, record_id);
create index on audit_log (tenant_id, user_id, occurred_at desc);
select app.standardize('audit_log', 'ledger');

-- Enterprise public API keys (hash only).
create table api_keys (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  name          text not null,
  key_prefix    text not null unique,     -- shown in UI, e.g. 'mf_live_ab12'
  scopes        text[] not null default '{}',
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid not null references users (id)
);
create table private.api_key_secrets (
  api_key_id  uuid primary key references api_keys (id),
  key_sha256  text not null
);
