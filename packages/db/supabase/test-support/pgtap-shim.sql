-- Local only (PGlite has no pgTAP): the small subset of pgTAP our tests use,
-- with the same names and arguments. Each assertion returns 'ok N - ...' and
-- a failed assertion raises immediately. CI uses the real pgTAP extension.

create or replace function _tap_next() returns int language plpgsql as $$
declare n int := coalesce(nullif(current_setting('tap.count', true), ''), '0')::int + 1;
begin
  perform set_config('tap.count', n::text, true);
  return n;
end $$;

create or replace function no_plan() returns setof boolean language plpgsql as $$
begin
  perform set_config('tap.plan', '', true);
  perform set_config('tap.count', '0', true);
  return;
end $$;

create or replace function plan(n int) returns text language plpgsql as $$
begin
  perform set_config('tap.plan', n::text, true);
  perform set_config('tap.count', '0', true);
  return '1..' || n;
end $$;

create or replace function ok(passed boolean, description text default '') returns text
language plpgsql as $$
declare n int := _tap_next();
begin
  if passed is not true then
    raise exception 'not ok % - %', n, description;
  end if;
  return 'ok ' || n || ' - ' || description;
end $$;

create or replace function is(have anyelement, want anyelement, description text default '') returns text
language plpgsql as $$
begin
  if have is distinct from want then
    return ok(false, format('%s (have: %s, want: %s)', description, have, want));
  end if;
  return ok(true, description);
end $$;

create or replace function isnt(have anyelement, want anyelement, description text default '') returns text
language plpgsql as $$
begin
  if have is not distinct from want then
    return ok(false, format('%s (both: %s)', description, have));
  end if;
  return ok(true, description);
end $$;

create or replace function throws_ok(query text, errcode text, errmsg text, description text) returns text
language plpgsql as $$
declare
  caught boolean := false;
  st text;
  msg text;
begin
  begin
    execute query;
  exception when others then
    caught := true;
    st := sqlstate;
    msg := sqlerrm;
  end;
  if not caught then
    return ok(false, description || ' (no error raised)');
  end if;
  if (errcode is not null and st <> errcode) or (errmsg is not null and msg <> errmsg) then
    return ok(false, format('%s (got %s: %s)', description, st, msg));
  end if;
  return ok(true, description);
end $$;

create or replace function lives_ok(query text, description text) returns text
language plpgsql as $$
begin
  begin
    execute query;
  exception when others then
    return ok(false, format('%s (died: %s %s)', description, sqlstate, sqlerrm));
  end;
  return ok(true, description);
end $$;

create or replace function finish() returns setof text language plpgsql as $$
declare
  planned text := current_setting('tap.plan', true);
  ran int := coalesce(nullif(current_setting('tap.count', true), ''), '0')::int;
begin
  if coalesce(planned, '') <> '' and planned::int <> ran then
    raise exception 'planned % tests but ran %', planned, ran;
  end if;
  return next '# ran ' || ran;
end $$;
