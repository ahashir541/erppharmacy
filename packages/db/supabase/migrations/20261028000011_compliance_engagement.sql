-- 0011: licences, controlled drugs register, loyalty, messaging and
-- reminders, owner alerts/notifications, receipt templates, data exports.

-- The brief lists both "branch_licences" and "licences"; they are one table.
create table branch_licences (
  id                       uuid primary key default app.uuid_v7(),
  tenant_id                uuid not null references tenants (id),
  branch_id                uuid not null,
  licence_type             text not null check (licence_type in ('drug_sale', 'controlled_drugs', 'trade', 'other')),
  licence_number           text not null,
  qualified_person_name    text,
  qualified_person_reg_no  text,
  issued_on                date,
  expires_on               date,
  remind_days_before       int not null default 30 check (remind_days_before >= 0),
  document_paths           text[] not null default '{}',
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references users (id),
  device_id                uuid references devices (id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('branch_licences', 'master');

-- Controlled drugs register: derived, never typed. Running balance per
-- branch and product, in movement order.
create view controlled_drug_register with (security_invoker = true) as
select
  m.tenant_id,
  m.branch_id,
  m.occurred_at,
  m.product_id,
  p.brand_name,
  p.strength,
  b.batch_number,
  m.movement_type,
  greatest(m.qty_base, 0)  as qty_in,
  greatest(-m.qty_base, 0) as qty_out,
  sum(m.qty_base) over (partition by m.branch_id, m.product_id
                        order by m.occurred_at, m.id) as running_balance,
  s.invoice_number,
  pr.patient_name,
  coalesce(d.name, pr.doctor_name) as prescriber,
  sup.name as supplier_name,
  g.supplier_invoice_number,
  m.created_by
from stock_movements m
join products p on p.id = m.product_id and p.is_controlled
join batches b on b.id = m.batch_id
left join sale_lines sl on m.reference_type = 'sale' and sl.id = m.reference_line_id
left join sales s on s.id = sl.sale_id
left join prescriptions pr on pr.id = s.prescription_id
left join doctors d on d.id = pr.doctor_id
left join grn_lines gl on m.reference_type = 'grn' and gl.id = m.reference_line_id
left join grns g on g.id = gl.grn_id
left join suppliers sup on sup.id = g.supplier_id;

create table loyalty_rules (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  name                text not null,
  spend_per_point     bigint not null check (spend_per_point > 0),   -- paisa spent to earn 1 point
  point_value         bigint not null check (point_value >= 0),      -- paisa one point is worth
  min_redeem_points   bigint not null default 0,
  points_expire_days  int,
  member_discount_bp  int not null default 0 check (member_discount_bp between 0 and 10000),
  effective_from      timestamptz not null default now(),
  archived_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique (tenant_id, id)
);
select app.standardize('loyalty_rules', 'master');

create table loyalty_points (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  customer_id     uuid not null,
  entry_type      text not null check (entry_type in ('earn', 'redeem', 'expire', 'adjust', 'reversal')),
  points          bigint not null check (points <> 0),
  sale_id         uuid,
  sale_return_id  uuid,
  rule_id         uuid,
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  device_id       uuid references devices (id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  foreign key (tenant_id, sale_return_id) references sale_returns (tenant_id, id),
  foreign key (tenant_id, rule_id) references loyalty_rules (tenant_id, id)
);
create index on loyalty_points (tenant_id, customer_id);
select app.standardize('loyalty_points', 'ledger');

-- tenant_id null = platform default template, copied/overridden per tenant.
create table message_templates (
  id                    uuid primary key default app.uuid_v7(),
  tenant_id             uuid references tenants (id),
  code                  text not null check (code in ('udhaar_reminder', 'refill_reminder', 'receipt',
                                                       'purchase_order', 'statement', 'otp')),
  channel               text not null check (channel in ('whatsapp', 'sms')),
  language              text not null check (language in ('en', 'ur')),
  body                  text not null,
  provider_template_id  text,         -- WhatsApp approved template name
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users (id),
  unique nulls not distinct (tenant_id, code, channel, language)
);
create trigger trg_touch before update on message_templates for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on message_templates for each row execute function app.forbid_delete();

create table outbound_messages (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  channel         text not null check (channel in ('whatsapp', 'sms')),
  provider        text not null,
  to_phone        text not null,
  template_id     uuid references message_templates (id),
  body_rendered   text not null,
  related_type    text,
  related_id      uuid,
  status          text not null default 'queued'
                  check (status in ('draft', 'queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  attempts        int not null default 0,
  last_error      text,
  provider_message_id text,
  queued_at       timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  device_id       uuid references devices (id),
  unique (tenant_id, id)
);
create index on outbound_messages (status, queued_at) where status = 'queued';
create trigger trg_touch before update on outbound_messages for each row execute function app.touch_updated_at();
create trigger trg_no_delete before delete on outbound_messages for each row execute function app.forbid_delete();

create table reminders_log (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  customer_account_id  uuid not null,
  outbound_message_id  uuid,
  balance_at_send      bigint not null,
  statement_url_path   text,
  created_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  foreign key (tenant_id, customer_account_id) references customer_accounts (tenant_id, id),
  foreign key (tenant_id, outbound_message_id) references outbound_messages (tenant_id, id)
);
select app.standardize('reminders_log', 'ledger');

-- Regular medicines for refill reminders (opt-in on customers).
create table customer_regular_medicines (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  customer_id    uuid not null,
  product_id     uuid not null,
  qty_base       bigint check (qty_base > 0),
  interval_days  int not null check (interval_days > 0),
  next_due_on    date,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users (id),
  device_id      uuid references devices (id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id)
);
select app.standardize('customer_regular_medicines', 'master');

-- Owner alert switches (low stock, big discount, cash short, device offline, ...).
create table alert_rules (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  kind        text not null check (kind in ('low_stock', 'expiring_batches', 'large_discount', 'void',
                                            'cash_short', 'udhaar_over_limit', 'device_offline',
                                            'controlled_sale', 'daily_summary', 'tax_queue_stuck',
                                            'licence_expiry', 'sync_flag')),
  enabled     boolean not null default true,
  threshold   bigint,          -- amount / hours / days depending on kind
  params      jsonb not null default '{}'::jsonb,
  recipients  uuid[] not null default '{}',   -- users; empty = all owners
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users (id),
  device_id   uuid references devices (id),
  unique (tenant_id, kind)
);
select app.standardize('alert_rules', 'master');

create table notifications (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  user_id         uuid not null,
  kind            text not null,
  title           text not null,
  body            text not null,
  reference_type  text,
  reference_id    uuid,
  pushed_at       timestamptz,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);
create index on notifications (user_id, created_at desc);

create table push_subscriptions (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  user_id     uuid not null,
  device_id   uuid references devices (id),
  endpoint    text not null unique,
  keys        jsonb not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);

create table receipt_templates (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  branch_id   uuid,
  name        text not null,
  paper       text not null check (paper in ('58mm', '80mm', 'a4')),
  layout      jsonb not null,     -- header, footer, logo path, visible fields
  is_default  boolean not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users (id),
  device_id   uuid references devices (id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('receipt_templates', 'master');

-- "Export all my data" requests (Excel + JSON) and audit of every export.
create table data_exports (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  kind          text not null check (kind in ('full', 'report')),
  params        jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  file_path     text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid not null references users (id),
  device_id     uuid references devices (id)
);
select app.standardize('data_exports', 'document');
