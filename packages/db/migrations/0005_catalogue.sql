-- 0005: tenant catalogue — generics, manufacturers, categories, tax
-- categories, units, products, pack conversions, barcodes, price history.

create table tax_categories (
  id            uuid primary key default app.uuid_v7(),
  tenant_id     uuid not null references tenants (id),
  code          text not null,                 -- 'exempt_medicine', 'standard', 'reduced'
  name          text not null,
  is_exempt     boolean not null default false,
  provider_item_code text,                     -- PCT / HS code sent to FBR
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references users (id),
  device_id     uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
select app.standardize('tax_categories', 'master');

-- Rate history per authority; the rate in force on the sale date applies.
create table tax_category_rates (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  tax_category_id  uuid not null,
  authority        text not null check (authority in ('FBR', 'SRB', 'PRA', 'KPRA', 'BRA', 'OTHER')),
  rate_bp          int not null check (rate_bp between 0 and 10000),
  effective_from   date not null,
  created_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  unique (tax_category_id, authority, effective_from),
  foreign key (tenant_id, tax_category_id) references tax_categories (tenant_id, id)
);
select app.standardize('tax_category_rates', 'ledger');

create table generics (
  id                 uuid primary key default app.uuid_v7(),
  tenant_id          uuid not null references tenants (id),
  global_generic_id  uuid references global_generics (id),
  name               text not null,
  name_ur            text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid references users (id),
  device_id          uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
select app.standardize('generics', 'master');

create table manufacturers (
  id                      uuid primary key default app.uuid_v7(),
  tenant_id               uuid not null references tenants (id),
  global_manufacturer_id  uuid references global_manufacturers (id),
  name                    text not null,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references users (id),
  device_id               uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
select app.standardize('manufacturers', 'master');

create table categories (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  parent_id        uuid,
  name             text not null,
  name_ur          text,
  tax_category_id  uuid,                       -- default for products in this category
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references categories (tenant_id, id),
  foreign key (tenant_id, tax_category_id) references tax_categories (tenant_id, id)
);
select app.standardize('categories', 'master');

create table units (
  id          uuid primary key default app.uuid_v7(),
  tenant_id   uuid not null references tenants (id),
  code        text not null,           -- 'tablet', 'strip', 'box', 'bottle', 'tube', 'piece'
  name        text not null,
  name_ur     text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references users (id),
  device_id   uuid references devices (id),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
select app.standardize('units', 'master');

create table products (
  id                   uuid primary key default app.uuid_v7(),
  tenant_id            uuid not null references tenants (id),
  global_catalogue_id  uuid references global_catalogue (id),
  brand_name           text not null,
  brand_name_ur        text,                -- Urdu alias for search
  generic_id           uuid,
  strength             text,                -- '500 mg', '120 mg/5 ml'
  dosage_form          text,
  manufacturer_id      uuid,
  category_id          uuid,
  tax_category_id      uuid,
  base_unit_id         uuid not null,       -- all quantities are counted in this unit
  drug_schedule        text,                -- provincial schedule label, free text
  is_controlled        boolean not null default false,
  rx_required          boolean not null default false,
  max_qty_per_sale     bigint,              -- owner-set limit (base units) for controlled/Rx
  rack_location        text,
  min_stock            bigint check (min_stock >= 0),
  max_stock            bigint check (max_stock >= 0),
  reorder_level        bigint check (reorder_level >= 0),
  lead_time_days       int check (lead_time_days >= 0),
  is_active            boolean not null default true,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references users (id),
  device_id            uuid references devices (id),
  unique (tenant_id, id),
  foreign key (tenant_id, generic_id) references generics (tenant_id, id),
  foreign key (tenant_id, manufacturer_id) references manufacturers (tenant_id, id),
  foreign key (tenant_id, category_id) references categories (tenant_id, id),
  foreign key (tenant_id, tax_category_id) references tax_categories (tenant_id, id),
  foreign key (tenant_id, base_unit_id) references units (tenant_id, id)
);
create index on products (tenant_id, generic_id, strength);         -- substitute lookup
create index on products using gin (brand_name gin_trgm_ops);
select app.standardize('products', 'master');

-- Pack ladder: 1 box = 10 strips = 100 tablets -> factors 100, 10, 1.
create table product_units (
  id              uuid primary key default app.uuid_v7(),
  tenant_id       uuid not null references tenants (id),
  product_id      uuid not null,
  unit_id         uuid not null,
  factor_to_base  bigint not null check (factor_to_base > 0),
  is_sellable     boolean not null default true,
  is_purchasable  boolean not null default true,
  sort_order      int not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references users (id),
  device_id       uuid references devices (id),
  unique (tenant_id, id),
  unique (product_id, unit_id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
select app.standardize('product_units', 'master');

create table barcodes (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  product_id       uuid not null,
  product_unit_id  uuid,                 -- which pack size this barcode scans as
  code             text not null,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, product_unit_id) references product_units (tenant_id, id)
);
create unique index barcodes_live_code on barcodes (tenant_id, code) where archived_at is null;
select app.standardize('barcodes', 'master');

-- Price history (append-only). Current price = latest effective_from <= now
-- for the most specific branch. 'trade' prices are cost-like and hidden by RLS.
create table product_prices (
  id               uuid primary key default app.uuid_v7(),
  tenant_id        uuid not null references tenants (id),
  product_id       uuid not null,
  product_unit_id  uuid not null,        -- price is per this pack size
  branch_id        uuid,                 -- null = all branches
  price_kind       text not null check (price_kind in ('retail', 'min_sale', 'trade')),
  amount           bigint not null check (amount >= 0),
  effective_from   timestamptz not null default now(),
  reason           text not null default '',      -- 'bulk +5% manufacturer X'
  bulk_change_id   uuid,                          -- groups rows from one bulk update
  created_at       timestamptz not null default now(),
  created_by       uuid references users (id),
  device_id        uuid references devices (id),
  foreign key (tenant_id, product_id) references products (tenant_id, id),
  foreign key (tenant_id, product_unit_id) references product_units (tenant_id, id),
  foreign key (tenant_id, branch_id) references branches (tenant_id, id)
);
create index on product_prices (tenant_id, product_id, product_unit_id, price_kind, effective_from desc);
select app.standardize('product_prices', 'ledger');
