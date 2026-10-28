-- 0007: batches, cost layers, blocks (expiry/recall/owner), the append-only
-- stock movement ledger with its cached balances, counts and transfers.

-- One row per (product, batch number, expiry) for the whole tenant. Stock per
-- branch lives in stock_balances. Selling price is visible to the counter;
-- cost and trade price live in batch_cost_layers (owner-only by RLS).
create table batches (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  product_id           uuid not null,
  batch_number         text not null,
  expiry_date          date not null,
  manufacture_date     date,
  price_unit_id        uuid,             -- product_unit the prices below are quoted in
  mrp                  bigint check (mrp >= 0),
  retail_price         bigint check (retail_price >= 0),   -- null = use product_prices
  first_supplier_id    uuid,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, product_id, batch_number, expiry_date),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, price_unit_id) references product_units (tenant_id, id),
  foreign key (tenant_id, first_supplier_id) references suppliers (tenant_id, id)
);
create index batches_fefo on batches (tenant_id, product_id, expiry_date);
select app.standardize('batches', 'master');

-- Each receipt of a batch adds a cost layer: exact integer totals, so bonus
-- stock ("10 + 1") never needs a fractional unit cost. Cost of a batch is
-- derived from its layers — the method is an open question (Q4).
create table batch_cost_layers (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  batch_id         uuid not null,
  grn_line_id      uuid,                 -- FK added in 0009
  source           text not null check (source in ('grn', 'opening', 'transfer_in', 'adjustment')),
  qty_base         bigint not null check (qty_base > 0),   -- paid + bonus quantity
  total_cost       bigint not null check (total_cost >= 0), -- net landed cost for qty_base
  trade_price      bigint check (trade_price >= 0),        -- per batches.price_unit_id
  occurred_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
create index on batch_cost_layers (batch_id);
select app.standardize('batch_cost_layers', 'ledger');

-- A batch is unsellable while it has an open block. Expired batches are
-- blocked by rule at the counter (expiry_date < today) without a row here.
create table batch_blocks (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  batch_id           uuid not null,
  branch_id          uuid,                 -- null = every branch
  source             text not null check (source in ('global_recall', 'owner', 'quarantine')),
  global_recall_id   uuid references global_recalls (id),
  reason             text not null,
  blocked_at         timestamptz not null default now(),
  lifted_at          timestamptz,
  lifted_by          uuid references users (id),
  lift_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  check ((lifted_at is null) = (lifted_by is null))
);
create index on batch_blocks (batch_id) where lifted_at is null;
select app.standardize('batch_blocks', 'document');

-- The stock ledger. qty_base is signed: + in, - out. Never updated.
create table stock_movements (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  branch_id          uuid not null,
  product_id         uuid not null,
  batch_id           uuid not null,
  movement_type      text not null check (movement_type in (
                       'opening', 'purchase', 'sale', 'sale_return', 'purchase_return',
                       'transfer_out', 'transfer_in', 'adjust', 'count_variance', 'expire', 'dispose')),
  qty_base           bigint not null check (qty_base <> 0),
  reference_type     text,                 -- 'sale', 'grn', 'transfer', 'stock_count', ...
  reference_id       uuid,
  reference_line_id  uuid,
  reason             text,
  occurred_at        timestamptz not null,           -- device clock (UTC)
  created_at         timestamptz not null default now(),  -- server receive time
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id),
  check (case movement_type
           when 'opening' then qty_base > 0
           when 'purchase' then qty_base > 0
           when 'sale_return' then qty_base > 0
           when 'transfer_in' then qty_base > 0
           when 'sale' then qty_base < 0
           when 'purchase_return' then qty_base < 0
           when 'transfer_out' then qty_base < 0
           when 'expire' then qty_base < 0
           when 'dispose' then qty_base < 0
           else true end)
);
create index on stock_movements (tenant_id, branch_id, product_id, occurred_at);
create index on stock_movements (tenant_id, reference_type, reference_id);
select app.standardize('stock_movements', 'ledger');

-- Cache maintained only by trigger; may go negative (offline sales), which
-- raises a sync flag rather than rejecting the sale.
create table stock_balances (
  tenant_id         uuid not null references tenants (id),
  branch_id         uuid not null,
  batch_id          uuid not null,
  product_id        uuid not null,
  qty_base          bigint not null default 0,
  last_movement_at  timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (branch_id, batch_id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
create index on stock_balances (tenant_id, branch_id, product_id);

create or replace function app.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into stock_balances as sb (tenant_id, branch_id, batch_id, product_id, qty_base, last_movement_at)
  values (new.tenant_id, new.branch_id, new.batch_id, new.product_id, new.qty_base, new.occurred_at)
  on conflict (branch_id, batch_id) do update
    set qty_base = sb.qty_base + excluded.qty_base,
        last_movement_at = greatest(sb.last_movement_at, excluded.last_movement_at),
        updated_at = now();
  return null;
end $$;
create trigger trg_apply_stock after insert on stock_movements
  for each row execute function app.apply_stock_movement();

-- Recall matching: new recall -> block matching batches in every tenant;
-- new batch -> block if it matches a live recall.
create or replace function app.block_recalled_batches() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if tg_table_name = 'global_recalls' then
    if new.action <> 'freeze' then return null; end if;
    insert into batch_blocks (tenant_id, batch_id, source, global_recall_id, reason)
    select b.tenant_id, b.id, 'global_recall', new.id, new.reason
    from batches b
    join products p on p.id = b.product_id
    where lower(b.batch_number) = lower(new.batch_number)
      and (p.global_catalogue_id = new.global_catalogue_id
           or lower(p.brand_name) = lower(new.brand_name));
  else
    insert into batch_blocks (tenant_id, batch_id, source, global_recall_id, reason)
    select new.tenant_id, new.id, 'global_recall', r.id, r.reason
    from global_recalls r
    join products p on p.id = new.product_id
    where r.lifted_at is null and r.action = 'freeze'
      and lower(r.batch_number) = lower(new.batch_number)
      and (p.global_catalogue_id = r.global_catalogue_id
           or lower(p.brand_name) = lower(r.brand_name));
  end if;
  return null;
end $$;
create trigger trg_recall_blocks after insert on global_recalls
  for each row execute function app.block_recalled_batches();
create trigger trg_recall_blocks after insert on batches
  for each row execute function app.block_recalled_batches();

-- Full or cycle (by rack) counts. Counters enter quantities blind; expected
-- quantity and variance are stored separately and visible only to the owner.
create table stock_counts (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  branch_id     uuid not null,
  kind          text not null check (kind in ('full', 'cycle')),
  rack_filter   text,
  status        text not null default 'open' check (status in ('open', 'submitted', 'approved', 'cancelled')),
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  approved_by   uuid references users (id),
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users (id),
  device_id     uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
select app.standardize('stock_counts', 'document');

create table stock_count_lines (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  stock_count_id  uuid not null,
  product_id      uuid not null,
  batch_id        uuid not null,
  counted_qty     bigint not null check (counted_qty >= 0),
  counted_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  device_id       uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, stock_count_id) references stock_counts (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
select app.standardize('stock_count_lines', 'document');

create table stock_count_results (
  stock_count_line_id  uuid primary key,
  tenant_id            uuid not null references tenants (id),
  expected_qty         bigint not null,
  variance_qty         bigint not null,
  computed_at          timestamptz not null default now(),
  foreign key (tenant_id, stock_count_line_id) references stock_count_lines (tenant_id, id)
);

create table transfers (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  transfer_number  text not null,
  from_branch_id   uuid not null,
  to_branch_id     uuid not null,
  status           text not null default 'draft'
                   check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled')),
  sent_by          uuid references users (id),
  sent_at          timestamptz,
  received_by      uuid references users (id),
  received_at      timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, transfer_number),
  foreign key (tenant_id, from_branch_id) references branches (tenant_id, id),
  foreign key (tenant_id, to_branch_id) references branches (tenant_id, id),
  check (from_branch_id <> to_branch_id)
);
select app.standardize('transfers', 'document');

create table transfer_lines (
  id                  uuid primary key default app.uuid_v7(),
  tenant_id           uuid not null references tenants (id),
  transfer_id         uuid not null,
  product_id          uuid not null,
  batch_id            uuid not null,
  qty_sent            bigint not null check (qty_sent > 0),
  qty_received        bigint check (qty_received >= 0),
  discrepancy_reason  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references users (id),
  device_id           uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, transfer_id) references transfers (tenant_id, id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, batch_id) references batches (tenant_id, id)
);
select app.standardize('transfer_lines', 'document');
