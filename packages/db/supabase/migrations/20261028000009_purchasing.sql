-- 0009: purchase orders, goods received notes (with bonus), purchase
-- invoices, purchase returns, supplier claims and statement reconciliation.
-- A store keeper can receive goods without seeing cost: quantities live in
-- grn_lines, money in grn_line_costs.

create table purchase_orders (
  id             uuid primary key default app.uuid_v7(),
  tenant_id      uuid not null references tenants (id),
  branch_id      uuid not null,
  supplier_id    uuid not null,
  po_number      text not null,
  status         text not null default 'draft'
                 check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  order_date     date not null,
  expected_date  date,
  sent_via       text check (sent_via in ('whatsapp', 'pdf', 'email', 'phone')),
  sent_at        timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references users (id),
  device_id      uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, po_number),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id)
);
select app.standardize('purchase_orders', 'document');

create table po_lines (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  purchase_order_id    uuid not null,
  product_id           uuid not null,
  product_unit_id      uuid not null,
  qty                  bigint not null check (qty > 0),
  bonus_qty            bigint not null default 0 check (bonus_qty >= 0),
  expected_unit_cost   bigint check (expected_unit_cost >= 0),
  suggested_qty        bigint,           -- what the reorder engine proposed
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, product_unit_id) references product_units (tenant_id, id)
);
select app.standardize('po_lines', 'document');

create table grns (
  id                       uuid primary key default app.uuid_v7(),
  tenant_id                uuid not null references tenants (id),
  branch_id                uuid not null,
  supplier_id              uuid not null,
  purchase_order_id        uuid,
  grn_number               text not null,
  supplier_invoice_number  text,
  received_at              timestamptz not null,
  status                   text not null default 'draft' check (status in ('draft', 'posted', 'voided')),
  posted_at                timestamptz,
  voided_at                timestamptz,
  void_reason              text,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references users (id),
  device_id                uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, grn_number),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id)
);
select app.standardize('grns', 'document');

create table grn_lines (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  grn_id           uuid not null,
  po_line_id       uuid,
  product_id       uuid not null,
  product_unit_id  uuid not null,
  batch_id         uuid not null,
  qty              bigint not null check (qty >= 0),         -- paid quantity, in product_unit
  bonus_qty        bigint not null default 0 check (bonus_qty >= 0),   -- the "+1" in "10 + 1"
  qty_base         bigint not null check (qty_base >= 0),
  bonus_qty_base   bigint not null default 0 check (bonus_qty_base >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, grn_id) references grns (tenant_id, id),
  foreign key (tenant_id, po_line_id) references po_lines (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, product_unit_id) references product_units (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id),
  check (qty + bonus_qty > 0)
);
select app.standardize('grn_lines', 'document');

-- Money side of a GRN line, as printed on the supplier invoice.
create table grn_line_costs (
  grn_line_id        uuid primary key,
  tenant_id          uuid not null references tenants (id),
  unit_cost          bigint not null check (unit_cost >= 0),        -- gross, per product_unit
  trade_price        bigint check (trade_price >= 0),
  discount_amount    bigint not null default 0 check (discount_amount >= 0),
  scheme_discount    bigint not null default 0 check (scheme_discount >= 0),
  tax_amount         bigint not null default 0 check (tax_amount >= 0),
  line_net           bigint not null check (line_net >= 0),  -- what the line costs us
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  foreign key (tenant_id, grn_line_id) references grn_lines (tenant_id, id)
);
select app.standardize('grn_line_costs', 'document');

alter table batch_cost_layers
  add foreign key (tenant_id, grn_line_id) references grn_lines (tenant_id, id);

create table purchase_invoices (
  id                       uuid primary key default app.uuid_v7(),
  tenant_id                uuid not null references tenants (id),
  branch_id                uuid not null,
  supplier_id              uuid not null,
  grn_id                   uuid,
  supplier_invoice_number  text not null,
  invoice_date             date not null,
  due_date                 date,
  subtotal                 bigint not null check (subtotal >= 0),
  discount_total           bigint not null default 0 check (discount_total >= 0),
  tax_total                bigint not null default 0 check (tax_total >= 0),
  grand_total              bigint not null check (grand_total >= 0),
  paid_at_receipt          bigint not null default 0 check (paid_at_receipt >= 0),
  image_paths              text[] not null default '{}',
  extraction               jsonb,         -- v2: AI-read fields awaiting confirmation
  status                   text not null default 'draft' check (status in ('draft', 'posted', 'voided')),
  posted_at                timestamptz,
  voided_at                timestamptz,
  void_reason              text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references users (id),
  device_id                uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, supplier_id, supplier_invoice_number),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, grn_id) references grns (tenant_id, id),
  check (grand_total = subtotal - discount_total + tax_total),
  check (paid_at_receipt <= grand_total)
);
select app.standardize('purchase_invoices', 'document');

create table purchase_returns (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  branch_id           uuid not null,
  supplier_id         uuid not null,
  return_number       text not null,
  reason              text not null check (reason in ('expired', 'damaged', 'short_dated', 'wrong_item', 'recall', 'other')),
  status              text not null default 'draft'
                      check (status in ('draft', 'sent', 'accepted', 'credited', 'rejected', 'voided')),
  credit_note_number  text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, return_number),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id)
);
select app.standardize('purchase_returns', 'document');

create table purchase_return_lines (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  purchase_return_id  uuid not null,
  product_id          uuid not null,
  batch_id            uuid not null,
  qty_base            bigint not null check (qty_base > 0),
  credit_value        bigint check (credit_value >= 0),   -- cost-like: purchases.view_cost
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  foreign key (tenant_id, purchase_return_id) references purchase_returns (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
select app.standardize('purchase_return_lines', 'document');

create table supplier_claims (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  supplier_id      uuid not null,
  kind             text not null check (kind in ('expired_return', 'scheme', 'price_difference', 'short_supply')),
  reference_type   text,
  reference_id     uuid,
  claimed_amount   bigint not null check (claimed_amount >= 0),
  settled_amount   bigint not null default 0 check (settled_amount >= 0),
  status           text not null default 'open'
                   check (status in ('open', 'partially_settled', 'settled', 'written_off')),
  due_date         date,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  check (settled_amount <= claimed_amount)
);
select app.standardize('supplier_claims', 'document');
