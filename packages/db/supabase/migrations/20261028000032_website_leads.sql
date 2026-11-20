-- 0032: "Request a Demo" from the Nuskha website. Visitors can only ADD a request (no reading,
-- changing or deleting); the platform owner reads them in Supabase (Table editor → leads) or with
-- the service role. Lengths are capped so the form cannot be used to store junk.
create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  name              text not null check (length(trim(name)) between 2 and 80),
  pharmacy          text not null check (length(trim(pharmacy)) between 2 and 120),
  city              text not null check (length(trim(city)) between 2 and 60),
  phone             text not null check (phone ~ '^[0-9+() -]{7,20}$'),
  email             text check (email is null or (length(email) <= 120 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  branches          int check (branches is null or branches between 1 and 500),
  current_software  text check (current_software is null or length(current_software) <= 80),
  message           text check (message is null or length(message) <= 1000),
  status            text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost'))
);
alter table public.leads enable row level security;
revoke all on public.leads from anon, authenticated;
grant insert (name, pharmacy, city, phone, email, branches, current_software, message) on public.leads to anon, authenticated;
drop policy if exists website_can_add on public.leads;
create policy website_can_add on public.leads for insert to anon, authenticated with check (status = 'new');
