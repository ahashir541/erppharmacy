-- 0038: Owner live view for Nuskha Local (hybrid).
-- The shop PC keeps working offline. Whenever it has internet it sends a read-only copy of the
-- owner's screens (dashboard, sales, stock, udhaar...) here; the owner's laptop reads it with a
-- view code. Two secrets: the push key never leaves the shop PC; the view code is what the owner
-- types. Only their SHA-256 is stored. Changing the view code locks out old laptops.

create table if not exists app.owner_mirrors (
  push_hash   text primary key,
  view_hash   text not null unique,
  meta        jsonb not null default '{}',
  parts       jsonb not null default '{}',
  pushed_at   timestamptz,
  created_at  timestamptz not null default now()
);
alter table app.owner_mirrors enable row level security;   -- no policies: only the functions below

create or replace function app.sha(p text) returns text
language sql immutable set search_path = public, app as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- From the shop PC. p_parts holds only the screens that changed; they replace the old ones.
create or replace function public.mirror_push(p_push_key text, p_view_hash text, p_meta jsonb, p_parts jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare ph text;
begin
  if length(coalesce(p_push_key, '')) < 32 or coalesce(p_view_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Bad mirror key' using errcode = '22023';
  end if;
  if pg_column_size(p_parts) > 6 * 1024 * 1024 or pg_column_size(p_meta) > 64 * 1024 then
    raise exception 'Too much data in one push' using errcode = '22023';
  end if;
  ph := app.sha(p_push_key);
  insert into app.owner_mirrors as m (push_hash, view_hash, meta, parts, pushed_at)
  values (ph, p_view_hash, coalesce(p_meta, '{}'), coalesce(p_parts, '{}'), now())
  on conflict (push_hash) do update
    set view_hash = excluded.view_hash, meta = excluded.meta, parts = m.parts || excluded.parts, pushed_at = now();
  return jsonb_build_object('ok', true, 'pushed_at', now());
end $$;

-- The shop PC stops sharing: its copy is deleted.
create or replace function public.mirror_forget(p_push_key text) returns boolean
language sql security definer set search_path = public, app as $$
  with d as (delete from app.owner_mirrors where push_hash = app.sha(p_push_key) returning 1) select exists (select 1 from d)
$$;

-- From the owner's laptop.
create or replace function public.mirror_read(p_view_code text) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare m app.owner_mirrors;
begin
  select * into m from app.owner_mirrors where view_hash = app.sha(upper(trim(coalesce(p_view_code, ''))));
  if not found then raise exception 'This view code is not right, or the shop turned sharing off' using errcode = '42501'; end if;
  return jsonb_build_object('meta', m.meta, 'parts', m.parts, 'pushed_at', m.pushed_at, 'now', now());
end $$;

revoke all on function public.mirror_push(text, text, jsonb, jsonb) from public;
revoke all on function public.mirror_forget(text) from public;
revoke all on function public.mirror_read(text) from public;
grant execute on function public.mirror_push(text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.mirror_forget(text) to anon, authenticated;
grant execute on function public.mirror_read(text) to anon, authenticated;
