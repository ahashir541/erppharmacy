-- 0008: prescriptions, sales, lines, payments, returns, held bills, server
-- re-validation flags, and the tax-authority submission queue.

create table prescriptions (
  id                    uuid primary key default app.uuid_v7(),
  tenant_id             uuid not null references tenants (id),
  branch_id             uuid not null,
  customer_id           uuid,
  patient_name          text not null,
  patient_age_years     int check (patient_age_years between 0 and 130),
  doctor_id             uuid,
  doctor_name           text,               -- when the doctor is not in the list
  prescribed_on         date,
  photo_paths           text[] not null default '{}',   -- Supabase Storage paths
  notes                 text,
  pharmacist_confirmed_by  uuid references users (id),
  pharmacist_confirmed_at  timestamptz,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid references users (id),
  device_id             uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, doctor_id) references doctors (tenant_id, id),
  check (doctor_id is not null or doctor_name is not null)
);
select app.standardize('prescriptions', 'document');

-- Invoice number = devices.invoice_prefix || '-' || lpad(local_seq, 6, '0').
-- Totals are stored as printed on the bill; the server re-checks them.
create table sales (
  id                     uuid primary key default app.uuid_v7(),
  tenant_id              uuid not null references tenants (id),
  branch_id              uuid not null,
  device_id              uuid not null references devices (id),
  local_seq              bigint not null check (local_seq > 0),
  invoice_number         text not null,
  status                 text not null default 'completed' check (status in ('completed', 'voided')),
  customer_id            uuid,
  customer_account_id    uuid,
  doctor_id              uuid,
  prescription_id        uuid,
  subtotal               bigint not null check (subtotal >= 0),
  discount_total         bigint not null default 0 check (discount_total >= 0),
  tax_total              bigint not null default 0 check (tax_total >= 0),
  rounding_adjustment    bigint not null default 0,
  grand_total            bigint not null check (grand_total >= 0),
  paid_total             bigint not null default 0 check (paid_total >= 0),   -- excludes udhaar
  udhaar_amount          bigint not null default 0 check (udhaar_amount >= 0),
  change_given           bigint not null default 0 check (change_given >= 0),
  sold_at                timestamptz not null,     -- device clock (UTC)
  business_date          date not null,            -- in branch time zone
  tax_status             text not null default 'not_applicable'
                         check (tax_status in ('not_applicable', 'pending', 'reported', 'failed')),
  authority_invoice_number text,                   -- FBR/SRB number printed on the bill
  validation_status      text not null default 'unchecked'
                         check (validation_status in ('unchecked', 'ok', 'flagged')),
  voided_at              timestamptz,
  voided_by              uuid references users (id),
  void_reason            text,
  void_approval_id       uuid,
  notes                  text,
  created_at             timestamptz not null default now(),   -- server receive time
  updated_at             timestamptz not null default now(),
  created_by             uuid not null references users (id),  -- salesman
  unique (tenant_id, id),
  unique (tenant_id, invoice_number),
  unique (device_id, local_seq),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, customer_account_id) references customer_accounts (tenant_id, id),
  foreign key (tenant_id, doctor_id) references doctors (tenant_id, id),
  foreign key (tenant_id, prescription_id) references prescriptions (tenant_id, id),
  foreign key (tenant_id, void_approval_id) references approval_requests (tenant_id, id),
  check (grand_total = subtotal - discount_total + tax_total + rounding_adjustment),
  check (udhaar_amount = 0 or customer_account_id is not null),
  check ((status = 'voided') = (voided_at is not null and void_reason is not null))
);
create index on sales (tenant_id, branch_id, business_date);
create index on sales (tenant_id, customer_account_id, sold_at);
select app.standardize('sales', 'document');

-- One line per batch: FEFO may split one scanned item over two batches.
create table sale_lines (
  id                uuid primary key default app.uuid_v7(),
  tenant_id         uuid not null references tenants (id),
  sale_id           uuid not null,
  line_no           int not null,
  product_id        uuid not null,
  product_unit_id   uuid not null,
  batch_id          uuid not null,
  qty               bigint not null check (qty > 0),       -- in product_unit
  qty_base          bigint not null check (qty_base > 0),
  list_unit_price   bigint not null check (list_unit_price >= 0),  -- price before override
  unit_price        bigint not null check (unit_price >= 0),
  discount_amount   bigint not null default 0 check (discount_amount >= 0),
  tax_category_id   uuid,
  tax_rate_bp       int not null default 0 check (tax_rate_bp between 0 and 10000),
  tax_amount        bigint not null default 0 check (tax_amount >= 0),
  line_total        bigint not null check (line_total >= 0),
  approval_id       uuid,                                   -- discount / price override approval
  created_at        timestamptz not null default now(),
  created_by        uuid references users (id),
  device_id         uuid references devices (id),
  unique (tenant_id, id),
  unique (sale_id, line_no),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, product_unit_id) references product_units (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id),
  foreign key (tenant_id, tax_category_id) references tax_categories (tenant_id, id),
  foreign key (tenant_id, approval_id) references approval_requests (tenant_id, id)
);
select app.standardize('sale_lines', 'ledger');

-- Cost of goods per line, written by the server only (counter devices never
-- see cost). Profit = line_total - tax_amount - cogs.
create table sale_line_costs (
  sale_line_id  uuid primary key,
  tenant_id     uuid not null references tenants (id),
  cogs          bigint not null check (cogs >= 0),
  computed_at   timestamptz not null default now(),
  foreign key (tenant_id, sale_line_id) references sale_lines (tenant_id, id)
);

create table sale_payments (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  sale_id            uuid not null,
  method             text not null check (method in ('cash', 'card', 'jazzcash', 'easypaisa', 'bank_transfer', 'loyalty')),
  amount             bigint not null check (amount > 0),
  tendered           bigint check (tendered >= amount),     -- cash handed over
  reference          text,
  bank_account_id    uuid,                                    -- FK added in 0010
  drawer_session_id  uuid,                                    -- FK added in 0010
  created_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  check (method <> 'cash' or drawer_session_id is not null)
);
select app.standardize('sale_payments', 'ledger');
-- Udhaar is not a payment row: it is sales.udhaar_amount plus a ledger entry.

create table sale_returns (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  branch_id            uuid not null,
  device_id            uuid not null references devices (id),
  local_seq            bigint not null check (local_seq > 0),
  return_number        text not null,
  original_sale_id     uuid not null,
  customer_account_id  uuid,
  refund_method        text not null check (refund_method in ('cash', 'udhaar_credit', 'exchange', 'jazzcash', 'easypaisa', 'bank_transfer', 'card')),
  refund_total         bigint not null check (refund_total >= 0),
  reason               text not null,
  approval_id          uuid,
  drawer_session_id    uuid,
  returned_at          timestamptz not null,
  status               text not null default 'completed' check (status in ('completed', 'voided')),
  voided_at            timestamptz,
  voided_by            uuid references users (id),
  void_reason          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid not null references users (id),
  unique (tenant_id, id),
  unique (tenant_id, return_number),
  unique (device_id, local_seq),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, original_sale_id) references sales (tenant_id, id),
  foreign key (tenant_id, customer_account_id) references customer_accounts (tenant_id, id),
  foreign key (tenant_id, approval_id) references approval_requests (tenant_id, id)
);
select app.standardize('sale_returns', 'document');

-- Restocked to the original batch unless the item is damaged.
create table return_lines (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  sale_return_id  uuid not null,
  sale_line_id    uuid not null,
  batch_id        uuid not null,
  qty_base        bigint not null check (qty_base > 0),
  refund_amount   bigint not null check (refund_amount >= 0),
  restock         boolean not null default true,
  condition       text not null default 'sealed' check (condition in ('sealed', 'opened', 'damaged')),
  created_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  device_id       uuid references devices (id),
  foreign key (tenant_id, sale_return_id) references sale_returns (tenant_id, id),
  foreign key (tenant_id, sale_line_id) references sale_lines (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
select app.standardize('return_lines', 'ledger');

-- Parked carts. Device-local by default; synced so a held bill survives a
-- crash and can be resumed on another counter in the same branch.
create table held_bills (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  branch_id     uuid not null,
  label         text not null,
  cart          jsonb not null,
  customer_id   uuid,
  held_at       timestamptz not null,
  resumed_at    timestamptz,
  resumed_sale_id uuid,
  discarded_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users (id),
  device_id     uuid references devices (id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
select app.standardize('held_bills', 'document');

-- Raised by server re-validation of offline uploads; never rejects the sale.
create table sync_flags (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  branch_id        uuid,
  device_id        uuid references devices (id),
  kind             text not null check (kind in (
                     'negative_stock', 'below_min_price', 'expired_batch', 'blocked_batch',
                     'over_credit_limit', 'udhaar_blocked', 'total_mismatch', 'permission_exceeded',
                     'controlled_without_prescription', 'clock_skew', 'licence_expired')),
  reference_type   text not null,
  reference_id     uuid not null,
  details          jsonb not null default '{}'::jsonb,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  resolved_by      uuid references users (id),
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
create index on sync_flags (tenant_id, status, created_at desc);
select app.standardize('sync_flags', 'document');

-- FBR / provincial registration per tenant or branch. Credentials are kept
-- in Supabase Vault; only the secret's id is stored here.
create table tax_profiles (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  branch_id           uuid,
  provider            text not null check (provider in ('fbr', 'srb', 'pra', 'kpra', 'bra')),
  ntn                 text,
  strn                text,
  pos_id              text,
  registration_no     text,
  environment         text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  vault_secret_id     uuid,
  is_enabled          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique nulls not distinct (tenant_id, branch_id, provider),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('tax_profiles', 'master');

-- Ordered submission queue: per device, documents go out in device_seq order.
create table tax_submissions (
  id                        uuid primary key default app.uuid_v7(),
  tenant_id                 uuid not null references tenants (id),
  branch_id                 uuid not null,
  device_id                 uuid not null references devices (id),
  device_seq                bigint not null,
  provider                  text not null check (provider in ('fbr', 'srb', 'pra', 'kpra', 'bra')),
  document_type             text not null check (document_type in ('sale', 'return')),
  sale_id                   uuid,
  sale_return_id            uuid,
  status                    text not null default 'queued'
                            check (status in ('queued', 'sending', 'accepted', 'rejected', 'retrying', 'stuck')),
  attempts                  int not null default 0,
  next_attempt_at           timestamptz,
  last_error                text,
  request_payload           jsonb,
  response_payload          jsonb,
  authority_invoice_number  text,
  qr_payload                text,
  queued_at                 timestamptz not null,
  accepted_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (device_id, provider, device_seq),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, sale_id) references sales (tenant_id, id),
  foreign key (tenant_id, sale_return_id) references sale_returns (tenant_id, id),
  check ((document_type = 'sale') = (sale_id is not null)),
  check ((document_type = 'return') = (sale_return_id is not null))
);
create index on tax_submissions (status, next_attempt_at) where status in ('queued', 'retrying');
select app.standardize('tax_submissions', 'document');
