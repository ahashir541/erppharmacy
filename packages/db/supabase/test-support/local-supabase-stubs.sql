-- Local only (PGlite): the parts of a Supabase database our migrations and
-- tests rely on. Never applied to a real Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_auth_admin nologin;

create schema auth;
create table auth.users (
  id    uuid primary key,
  email text
);

-- Same behaviour as Supabase: claims come from request.jwt.claims.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;

-- Supabase's default privileges: the API roles get table access by default
-- (our migration 0012 then revokes anon/authenticated writes); service_role
-- keeps full access, as on a real project.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
