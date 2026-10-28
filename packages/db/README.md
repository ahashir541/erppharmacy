# @medflow/db — database, security rules and server functions

Everything that lives in Supabase: the schema (`supabase/migrations`), the
security rules (Row Level Security), the server functions (RPCs and Edge
Functions) and their tests.

## Run the tests (no Docker needed)

```bash
pnpm install
pnpm test:db
```

This starts an embedded Postgres (PGlite) in memory and applies every
migration and `seed.sql`. It then runs every pgTAP file in
`supabase/tests/database`, plus a check that the counter's permission rules
(`packages/core`) and the server's give the same answer in every case. On
GitHub, CI runs the same pgTAP files again on a real Supabase database with
real pgTAP.

## Layout

| Path | What it is |
|---|---|
| `supabase/migrations/` | the schema, in order. Never edit a migration that has been applied to a real project; add a new one. |
| `supabase/tests/database/` | pgTAP tests (the Phase 1 acceptance tests are `01` and `02`) |
| `supabase/test-support/` | test fixtures, the local pgTAP stand-in, local Supabase stubs |
| `supabase/functions/` | Edge Functions: `invite-owner`, `register-device` |
| `supabase/seed.sql` | plans for local development (prices are set in the console, not here) |
| `scripts/test-db.mjs` | the local test runner |

## Rules for new migrations

- Add columns; never rename or drop in the same release (old counter apps
  must keep syncing).
- Every new table: `tenant_id`, composite foreign keys, `app.standardize()`,
  `app.apply_rls()`. End the migration with `select app.assert_rls_everywhere();`.
- Money is `bigint` minor units; quantities are `bigint` base units.
- Clients never write tables: add a `SECURITY DEFINER` function that starts
  with `app.rpc_begin('<permission>')`.

## Creating the real Supabase project (platform owner, one time)

The coding agent cannot create accounts, so these steps are yours:

1. Create a Supabase account and a project named `medflow` in the **Mumbai
   (ap-south-1)** region. Upgrade to **Pro** before real pharmacies use it,
   for 2FA (MFA), daily backups and point-in-time recovery.
2. In a terminal:
   ```bash
   supabase login
   supabase link --workdir packages/db --project-ref <your-project-ref>
   supabase db push --workdir packages/db
   supabase functions deploy invite-owner register-device --workdir packages/db
   ```
3. In the dashboard: **Authentication → Hooks**, enable *Customize Access
   Token* with `public.custom_access_token_hook`. **Authentication → Sign In
   / Providers**: turn off public sign-ups. **MFA**: enable TOTP.
4. Make yourself the platform admin. Create your login under **Authentication
   → Users** (with 2FA), then run this in the SQL editor:
   ```sql
   insert into platform_admins (auth_user_id, full_name, email)
   select id, 'Syed Hashir Ali', email from auth.users where email = '<your email>';
   ```
5. Set plan prices in the `plans` table (the admin console in Phase 8 will
   do this for you).
