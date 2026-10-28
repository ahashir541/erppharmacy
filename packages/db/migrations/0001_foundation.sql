-- MedFlow schema — REVIEW DRAFT (Phase 0). Not applied anywhere yet.
-- 0001: extensions, helper schema, UUIDv7, and the generic triggers every
-- other migration attaches (updated_at, no hard delete, append-only, audit).
--
-- Conventions used in every migration:
--   * Primary keys are UUIDv7. Devices generate them; app.uuid_v7() is only
--     the server-side default.
--   * Money is bigint in the tenant currency's minor unit (paisa for PKR).
--   * Quantities are bigint in the product's base unit (e.g. tablet).
--   * Percentages are integer basis points (1700 = 17.00%).
--   * Status/type columns are text + CHECK (not Postgres enums) so new values
--     can be added in a backward-compatible migration.
--   * Every tenant table has unique (tenant_id, id) so child tables use
--     composite foreign keys and can never point at another tenant's row.
--   * Clients never write tables directly. Reads go through RLS (0012);
--     writes go through SECURITY DEFINER RPCs / the PowerSync upload handler,
--     which set app.device_id / app.user_id for the audit trigger.

create extension if not exists pg_trgm;   -- product name search (web app)

create schema if not exists app;      -- helper functions, never exposed by the API
create schema if not exists private;  -- secrets (recovery codes, API key hashes)

revoke all on schema app, private from public;

-- UUIDv7: 48-bit Unix ms timestamp + version/variant bits + random.
create or replace function app.uuid_v7() returns uuid
language plpgsql volatile as $$
declare
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  b  bytea  := uuid_send(gen_random_uuid());
begin
  b := set_byte(b, 0, ((ms >> 40) & 255)::int);
  b := set_byte(b, 1, ((ms >> 32) & 255)::int);
  b := set_byte(b, 2, ((ms >> 24) & 255)::int);
  b := set_byte(b, 3, ((ms >> 16) & 255)::int);
  b := set_byte(b, 4, ((ms >> 8) & 255)::int);
  b := set_byte(b, 5, (ms & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- RFC 4122 variant
  return encode(b, 'hex')::uuid;
end $$;

-- Context set by RPCs / the sync upload handler for the current transaction.
create or replace function app.ctx_device_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.device_id', true), '')::uuid $$;

create or replace function app.ctx_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Only the platform purge job (cancelled tenant, 90 days later) sets this.
create or replace function app.purge_allowed() returns boolean
language sql stable as $$ select coalesce(current_setting('app.purge', true), '') = 'on' $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Business data is archived/voided, never deleted.
create or replace function app.forbid_delete() returns trigger
language plpgsql as $$
begin
  if app.purge_allowed() then return old; end if;
  raise exception 'Hard delete is not allowed on %; archive or void the row instead', tg_table_name
    using errcode = 'P0001';
end $$;

-- Ledgers and logs: insert only. Corrections are reversing rows.
create or replace function app.append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and app.purge_allowed() then return old; end if;
  raise exception '% is append-only; post a reversing entry instead', tg_table_name
    using errcode = 'P0001';
end $$;

-- Generic audit trigger (table audit_log is created in 0003).
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  old_j jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_j jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  rec   jsonb := coalesce(new_j, old_j);
begin
  if tg_op = 'UPDATE' and old_j - 'updated_at' = new_j - 'updated_at' then
    return new;  -- no real change
  end if;
  insert into audit_log (tenant_id, branch_id, user_id, device_id, action,
                         table_name, record_id, old_data, new_data)
  values ((rec ->> 'tenant_id')::uuid,
          (rec ->> 'branch_id')::uuid,
          coalesce(app.ctx_user_id(), (rec ->> 'created_by')::uuid),
          coalesce(app.ctx_device_id(), (rec ->> 'device_id')::uuid),
          lower(tg_op),
          tg_table_name,
          (rec ->> 'id')::uuid,
          old_j,
          new_j);
  return coalesce(new, old);
end $$;

-- Attach the standard trigger set.
--   'master'   : last-write-wins master data — updated_at, audit, no delete
--   'document' : sales, GRNs, etc. — updated_at, audit, no delete
--   'ledger'   : append-only rows (no updated_at); the ledger is its own audit
create or replace function app.standardize(tbl regclass, kind text) returns void
language plpgsql as $$
begin
  if kind in ('master', 'document') then
    execute format('create trigger trg_touch before update on %s for each row execute function app.touch_updated_at()', tbl);
    execute format('create trigger trg_audit after insert or update on %s for each row execute function app.audit_row()', tbl);
    execute format('create trigger trg_no_delete before delete on %s for each row execute function app.forbid_delete()', tbl);
  elsif kind = 'ledger' then
    execute format('create trigger trg_append_only before update or delete on %s for each row execute function app.append_only()', tbl);
  else
    raise exception 'unknown standardize kind %', kind;
  end if;
end $$;
