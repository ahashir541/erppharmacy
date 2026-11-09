-- 0017 (Phase 4): offline sync — the counter's outbox of commands.
--
-- A counter PC never edits shared tables while offline. It writes commands ("sale", "return",
-- "staff signed in", ...) to its local outbox, numbered by its own sequence. When the internet is
-- back, PowerSync uploads them and public.apply_device_commands replays them in order through the
-- same functions online sales use, in offline mode: the medicine has already left the shop, so
-- problems become owner flags instead of rejections (brief, sync rule 5). Every command has a fixed
-- id, so an upload repeated after a timeout changes nothing (idempotent). Nothing is ever lost:
-- a command that cannot be applied is kept with its error for the owner and support.

create table device_commands (
  id           uuid primary key,                 -- made on the PC (UUIDv7)
  tenant_id    uuid not null references tenants (id),
  device_id    uuid not null,
  device_seq   bigint not null check (device_seq > 0),
  -- Not limited by a check: an unknown kind from a newer app version is kept as 'rejected', never lost.
  -- Known kinds: staff_session_start, staff_session_end, pin_failure, drawer_open, drawer_close, sale,
  -- return, held_bill. Voids need a manager's approval and are online only (D32).
  kind         text not null,
  acting_user  uuid,                             -- the staff member signed in on the PC
  session_id   uuid,
  payload      jsonb not null,
  created_on_device_at timestamptz not null,
  status       text not null default 'applied' check (status in ('applied', 'flagged', 'rejected')),
  result       jsonb not null default '{}'::jsonb,
  error        text,
  received_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (device_id, device_seq),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);
create index on device_commands (tenant_id, status, received_at desc);
select app.standardize('device_commands', 'ledger');

-- Bill lines carry their branch, so a PC downloads only its own branch's lines (sync rules).
alter table sale_lines add column if not exists branch_id uuid;
update sale_lines sl set branch_id = s.branch_id from sales s where s.id = sl.sale_id and sl.branch_id is null;
create or replace function app.sale_line_branch() returns trigger
language plpgsql as $$
begin
  new.branch_id := (select branch_id from sales where id = new.sale_id);
  return new;
end $$;
create trigger trg_sale_line_branch before insert on sale_lines for each row execute function app.sale_line_branch();
create index on sale_lines (branch_id);

-- The PC's last upload (for "Synced / Offline with N pending / Needs attention" and the health page).
alter table devices add column if not exists last_command_seq bigint not null default 0;

-- Staff sign-in recorded offline: same checks as online, but kept (with a flag) if the person has
-- since been disabled, because the sales they made are real.
create or replace function app.apply_staff_session(p_device devices, p_cmd jsonb, p_kind text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  u users;
  sid uuid := (p_cmd ->> 'session_id')::uuid;
  at timestamptz := (p_cmd ->> 'created_on_device_at')::timestamptz;
begin
  select * into u from users where id = (p_cmd ->> 'acting_user')::uuid and tenant_id = p_device.tenant_id;
  if not found then raise exception 'Unknown staff member' using errcode = 'P0002'; end if;
  if p_kind = 'staff_session_start' then
    insert into user_sessions (id, tenant_id, user_id, branch_id, device_id, method, started_at, last_active_at)
    values (sid, p_device.tenant_id, u.id, p_device.branch_id, p_device.id, 'pin', at, at)
    on conflict (id) do nothing;
    perform app.log_event('login', 'user_sessions', sid, jsonb_build_object('method', 'pin', 'offline', true), p_device.branch_id);
    if u.status <> 'active' then
      insert into sync_flags (tenant_id, branch_id, device_id, kind, reference_type, reference_id, details)
      values (p_device.tenant_id, p_device.branch_id, p_device.id, 'permission_exceeded', 'user_session', sid,
              jsonb_build_object('message', u.full_name || ' signed in offline after being disabled', 'user_id', u.id));
      return jsonb_build_object('flags', app.problem('offline', 'permission_exceeded', u.full_name || ' signed in offline after being disabled', '{}'));
    end if;
  elsif p_kind = 'staff_session_end' then
    update user_sessions set ended_at = at, end_reason = coalesce(p_cmd -> 'payload' ->> 'reason', 'logout')
    where id = sid and device_id = p_device.id and ended_at is null;
    perform app.log_event('logout', 'user_sessions', sid, jsonb_build_object('offline', true), p_device.branch_id);
  else
    update user_pins
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then at + interval '15 minutes' else locked_until end
    where user_id = u.id;
    perform app.log_event('login_failed', 'users', u.id, jsonb_build_object('method', 'pin', 'offline', true), p_device.branch_id);
  end if;
  return jsonb_build_object('flags', '[]'::jsonb);
end $$;

-- Replays one PC's commands in device order. Returns one result per command.
create or replace function public.apply_device_commands(p_commands jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  dev devices;
  cmd jsonb;
  existing device_commands;
  res jsonb;
  flags jsonb;
  status text;
  out jsonb := '[]'::jsonb;
  ds drawer_sessions;
begin
  select * into dev from devices where id = app.current_device_id();
  if dev.id is null or not app.is_device() then
    raise exception 'Commands are uploaded by a registered pharmacy PC' using errcode = '42501';
  end if;
  -- Read-only / suspended pharmacies still receive what was sold: never lose a sale.
  perform set_config('app.device_id', dev.id::text, true);

  for cmd in select c from jsonb_array_elements(coalesce(p_commands, '[]')) c order by (c ->> 'device_seq')::bigint loop
    select * into existing from device_commands where id = (cmd ->> 'id')::uuid;
    if found then
      out := out || jsonb_build_object('id', existing.id, 'status', existing.status, 'duplicate', true);
      continue;
    end if;
    perform set_config('app.user_id', coalesce(cmd ->> 'acting_user', ''), true);
    begin
      res := case cmd ->> 'kind'
        when 'sale' then app.record_sale(cmd -> 'payload', (cmd ->> 'acting_user')::uuid, 'offline')
        when 'return' then app.record_return(cmd -> 'payload', (cmd ->> 'acting_user')::uuid, 'offline')
        when 'staff_session_start' then app.apply_staff_session(dev, cmd, 'staff_session_start')
        when 'staff_session_end' then app.apply_staff_session(dev, cmd, 'staff_session_end')
        when 'pin_failure' then app.apply_staff_session(dev, cmd, 'pin_failure')
        else null
      end;
      if cmd ->> 'kind' = 'drawer_open' then
        insert into drawer_sessions (id, tenant_id, branch_id, cash_drawer_id, opened_by, opened_at, opening_float, created_by, device_id)
        select (cmd -> 'payload' ->> 'drawer_session_id')::uuid, dev.tenant_id, dev.branch_id, c.id, (cmd ->> 'acting_user')::uuid,
               (cmd ->> 'created_on_device_at')::timestamptz, (cmd -> 'payload' ->> 'opening_float')::bigint, (cmd ->> 'acting_user')::uuid, dev.id
        from cash_drawers c where c.id = (cmd -> 'payload' ->> 'cash_drawer_id')::uuid and c.device_id = dev.id
        on conflict (id) do nothing;
        if (cmd -> 'payload' ->> 'opening_float')::bigint > 0 then
          insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, reference_type, reference_id, occurred_at, created_by, device_id)
          values (dev.tenant_id, dev.branch_id, (cmd -> 'payload' ->> 'drawer_session_id')::uuid, 'opening_float',
                  (cmd -> 'payload' ->> 'opening_float')::bigint, 'drawer_session', (cmd -> 'payload' ->> 'drawer_session_id')::uuid,
                  (cmd ->> 'created_on_device_at')::timestamptz, (cmd ->> 'acting_user')::uuid, dev.id);
        end if;
        res := jsonb_build_object('flags', '[]'::jsonb);
      elsif cmd ->> 'kind' = 'drawer_close' then
        select * into ds from drawer_sessions where id = (cmd -> 'payload' ->> 'drawer_session_id')::uuid and device_id = dev.id;
        if not found then raise exception 'Drawer session not found' using errcode = 'P0002'; end if;
        if ds.status = 'open' then
          update drawer_sessions set status = 'closed', closed_by = (cmd ->> 'acting_user')::uuid,
                 closed_at = (cmd ->> 'created_on_device_at')::timestamptz, counted_cash = (cmd -> 'payload' ->> 'counted')::bigint,
                 counted_denominations = cmd -> 'payload' -> 'denominations'
          where id = ds.id;
          insert into drawer_session_reconciliations (drawer_session_id, tenant_id, expected_cash, variance)
          select ds.id, ds.tenant_id, coalesce(sum(amount), 0), (cmd -> 'payload' ->> 'counted')::bigint - coalesce(sum(amount), 0)
          from cash_movements where drawer_session_id = ds.id
          on conflict (drawer_session_id) do update set expected_cash = excluded.expected_cash, variance = excluded.variance, computed_at = now();
        end if;
        res := jsonb_build_object('flags', '[]'::jsonb);
      elsif cmd ->> 'kind' = 'held_bill' then
        insert into held_bills (id, tenant_id, branch_id, label, cart, held_at, resumed_at, discarded_at, created_by, device_id)
        values ((cmd -> 'payload' ->> 'id')::uuid, dev.tenant_id, dev.branch_id, coalesce(cmd -> 'payload' ->> 'label', 'Held bill'),
                coalesce(cmd -> 'payload' -> 'cart', '{}'), (cmd ->> 'created_on_device_at')::timestamptz,
                (cmd -> 'payload' ->> 'resumed_at')::timestamptz, (cmd -> 'payload' ->> 'discarded_at')::timestamptz,
                (cmd ->> 'acting_user')::uuid, dev.id)
        on conflict (id) do update set cart = excluded.cart, resumed_at = excluded.resumed_at, discarded_at = excluded.discarded_at;
        res := jsonb_build_object('flags', '[]'::jsonb);
      elsif res is null then
        raise exception 'Unknown command %', cmd ->> 'kind' using errcode = '22023';
      end if;
      flags := coalesce(res -> 'flags', '[]'::jsonb);
      status := case when jsonb_array_length(flags) > 0 then 'flagged' else 'applied' end;
      insert into device_commands (id, tenant_id, device_id, device_seq, kind, acting_user, session_id, payload,
                                   created_on_device_at, status, result)
      values ((cmd ->> 'id')::uuid, dev.tenant_id, dev.id, (cmd ->> 'device_seq')::bigint, cmd ->> 'kind',
              (cmd ->> 'acting_user')::uuid, (cmd ->> 'session_id')::uuid, cmd -> 'payload',
              (cmd ->> 'created_on_device_at')::timestamptz, status, res);
    exception when others then
      -- Kept with its error (never lost). The owner sees it; support can replay it after a fix.
      status := 'rejected';
      res := jsonb_build_object('error', sqlerrm, 'code', sqlstate);
      insert into device_commands (id, tenant_id, device_id, device_seq, kind, acting_user, session_id, payload,
                                   created_on_device_at, status, result, error)
      values ((cmd ->> 'id')::uuid, dev.tenant_id, dev.id, (cmd ->> 'device_seq')::bigint, cmd ->> 'kind',
              (cmd ->> 'acting_user')::uuid, (cmd ->> 'session_id')::uuid, cmd -> 'payload',
              coalesce((cmd ->> 'created_on_device_at')::timestamptz, now()), 'rejected', res, sqlerrm)
      on conflict do nothing;
      insert into sync_flags (tenant_id, branch_id, device_id, kind, reference_type, reference_id, details)
      values (dev.tenant_id, dev.branch_id, dev.id, 'permission_exceeded', 'device_command', (cmd ->> 'id')::uuid,
              jsonb_build_object('message', 'A ' || (cmd ->> 'kind') || ' made offline could not be applied: ' || sqlerrm));
    end;
    out := out || jsonb_build_object('id', cmd ->> 'id', 'status', status, 'result', res);
  end loop;

  update devices set last_sync_at = now(), last_seen_at = now(),
         last_command_seq = greatest(last_command_seq, coalesce((select max((c ->> 'device_seq')::bigint) from jsonb_array_elements(p_commands) c), 0))
  where id = dev.id;
  return out;
end $$;

select app.apply_rls('device_commands', 'custom');
create policy read on device_commands for select to authenticated
  using (device_id = (select app.current_device_id()) or (select app.has_perm('flags.view')));
grant select on device_commands to authenticated;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon', f);
  end loop;
end $$;
revoke all on all functions in schema app from public;
grant execute on function public.apply_device_commands(jsonb) to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;

select app.assert_rls_everywhere();
