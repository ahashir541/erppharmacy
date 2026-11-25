-- 0039: Owner works from home (hybrid, two-way). The owner's laptop leaves a request here (with the
-- view code); the shop PC, which holds the only copy of the records, picks it up within seconds,
-- runs it exactly as if the owner had signed in at the shop (owner PIN first), and leaves the
-- answer. Nothing is changed in the cloud copy itself, so there is never a conflict. Requests and
-- answers are deleted once read, and after 10 minutes at most.

alter table app.owner_mirrors add column if not exists owner_seen_at timestamptz;

create table if not exists app.owner_requests (
  id          uuid primary key,
  push_hash   text not null references app.owner_mirrors (push_hash) on delete cascade,
  body        jsonb not null,            -- {kind: 'login'|'call'|'table', fn, args, token, pin}
  status      text not null default 'waiting' check (status in ('waiting', 'taken', 'done')),
  ok          boolean,
  result      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists owner_requests_waiting on app.owner_requests (push_hash, status, created_at);
alter table app.owner_requests enable row level security;   -- only the functions below

-- mirror_read now also tells the shop PC that the owner is looking (it then checks every few seconds).
create or replace function public.mirror_read(p_view_code text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare m app.owner_mirrors;
begin
  update app.owner_mirrors set owner_seen_at = now() where view_hash = app.sha(upper(trim(coalesce(p_view_code, '')))) returning * into m;
  if not found then raise exception 'This view code is not right, or the shop turned sharing off' using errcode = '42501'; end if;
  return jsonb_build_object('meta', m.meta, 'parts', m.parts, 'pushed_at', m.pushed_at, 'now', now());
end $$;

-- Owner's laptop: ask the shop.
create or replace function public.relay_ask(p_view_code text, p_id uuid, p_body jsonb) returns boolean
language plpgsql security definer set search_path = public, app as $$
declare m app.owner_mirrors;
begin
  update app.owner_mirrors set owner_seen_at = now() where view_hash = app.sha(upper(trim(coalesce(p_view_code, '')))) returning * into m;
  if not found then raise exception 'This view code is not right, or the shop turned sharing off' using errcode = '42501'; end if;
  if pg_column_size(p_body) > 2 * 1024 * 1024 then raise exception 'Too much data in one request' using errcode = '22023'; end if;
  if (select count(*) from app.owner_requests where push_hash = m.push_hash and status <> 'done') >= 40 then
    raise exception 'The shop has not answered yet. Is the shop PC on and online?' using errcode = 'P0001';
  end if;
  insert into app.owner_requests (id, push_hash, body) values (p_id, m.push_hash, p_body) on conflict (id) do nothing;
  return true;
end $$;

-- Owner's laptop: the answer, once (it is deleted when read).
create or replace function public.relay_answer(p_view_code text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare r app.owner_requests;
begin
  select q.* into r from app.owner_requests q join app.owner_mirrors m on m.push_hash = q.push_hash
  where q.id = p_id and m.view_hash = app.sha(upper(trim(coalesce(p_view_code, ''))));
  if not found then return jsonb_build_object('status', 'gone'); end if;
  if r.status <> 'done' then return jsonb_build_object('status', r.status); end if;
  delete from app.owner_requests where id = r.id;
  return jsonb_build_object('status', 'done', 'ok', r.ok, 'result', r.result);
end $$;

-- Shop PC: what is waiting, and whether the owner is looking right now.
create or replace function public.relay_take(p_push_key text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare ph text := app.sha(coalesce(p_push_key, '')); m app.owner_mirrors; out jsonb;
begin
  select * into m from app.owner_mirrors where push_hash = ph;
  if not found then return jsonb_build_object('requests', '[]'::jsonb, 'owner_active', false); end if;
  delete from app.owner_requests where push_hash = ph and created_at < now() - interval '10 minutes';
  with t as (
    update app.owner_requests set status = 'taken'
    where id in (select id from app.owner_requests where push_hash = ph and status = 'waiting' order by created_at limit 20)
    returning id, body, created_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'body', body) order by created_at), '[]') into out from t;
  -- The PIN has done its job once it is with the shop PC: do not keep it here.
  update app.owner_requests set body = body - 'pin' where push_hash = ph and status = 'taken' and body ? 'pin';
  return jsonb_build_object('requests', out, 'owner_active', coalesce(m.owner_seen_at > now() - interval '5 minutes', false));
end $$;

-- Shop PC: the answer.
create or replace function public.relay_reply(p_push_key text, p_id uuid, p_ok boolean, p_result jsonb) returns boolean
language plpgsql security definer set search_path = public, app as $$
begin
  if pg_column_size(p_result) > 6 * 1024 * 1024 then
    p_ok := false; p_result := to_jsonb('The answer is too big to send; open it at the shop'::text);
  end if;
  update app.owner_requests set status = 'done', ok = p_ok, result = p_result
  where id = p_id and push_hash = app.sha(coalesce(p_push_key, ''));
  return found;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.relay_ask(text, uuid, jsonb)', 'public.relay_answer(text, uuid)', 'public.relay_take(text)',
                           'public.relay_reply(text, uuid, boolean, jsonb)', 'public.mirror_read(text)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
