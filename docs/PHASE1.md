# Phase 1 — Foundation

## What was built, in simple words

Think of Phase 1 as the **locks and the ledger book**. Nothing for the
counter or the owner's screens is built yet. What exists now decides who
may see and do what, and makes sure no record is ever lost or quietly
changed.

1. **One project for every app (the monorepo).** `packages/core` holds the
   business rules. `packages/db` holds the database. The web, counter and
   admin apps will be added in `apps/` from Phase 2, and all of them will use
   the same rules.
2. **The database design** (14 migration files). Stock, udhaar and cash are
   ledgers: every change is a new row, and balances are worked out from the
   rows. Rows are never deleted. Money is stored in whole paisa.
3. **Each pharmacy is sealed off.** Pharmacy A can never read pharmacy B. Not
   by changing its login token, not by mistake.
4. **Who signs in where (your decision).**
   - **You (platform owner):** the admin console, from anywhere, with 2FA.
   - **Pharmacy owners:** email + password + 2FA (an authenticator app),
     from anywhere: shop, home or phone.
   - **Staff:** no internet login at all. They can only work on a pharmacy PC
     that the owner has registered, unlocked with their own 4–6 digit PIN.
     The PIN works offline. Five wrong tries lock it for 15 minutes.
5. **Money stays with the owner.** A pharmacy PC never downloads cost
   prices, profit, cash totals, udhaar balances or the audit log. The owner
   sees these on their own login.
6. **Permissions engine.** 88 switches, the brief's 6 default roles, limits
   ("discount up to 10%") and "needs approval". There are per-person
   exceptions per branch, and the primary owner can never be locked out. The
   same rules run on the counter (offline) and on the server, and a test
   proves they always agree.
7. **Audit log.** Every change to master data is recorded with who, which
   PC, when, the old value and the new value. Logins, PIN failures and PIN
   changes are recorded too (the PIN itself never is). Nobody can edit or
   delete the log, not even the database owner.
8. **Owner tools (server side).** Onboard a pharmacy (you), invite its owner,
   add staff, give roles, set PINs, change permissions, register a PC,
   disable a person or a PC instantly, sign someone out remotely, and change
   settings. Plan limits (branches, counters, staff) are enforced.

## How to run it

```bash
pnpm install
pnpm check
```

You should see `28 passed` (core) and `5411 assertions passed, 0 file(s)
failed` (database).

## How to test it by hand

There are no screens yet, so "by hand" means reading and running the tests:

- [01_tenant_isolation](../packages/db/supabase/tests/database/01_tenant_isolation.test.sql):
  pharmacy A vs B in every table, a forged token, no 2FA, the platform admin,
  anonymous visitors.
- [02_money_hidden](../packages/db/supabase/tests/database/02_money_hidden.test.sql):
  what a pharmacy PC can and cannot see.
- [05_auth_rpcs](../packages/db/supabase/tests/database/05_auth_rpcs.test.sql):
  onboarding, staff, PINs, plan limits, PC sign-in, disabling.

To see a test catch a mistake, open
`packages/db/supabase/migrations/20261028000012_security.sql` and change
`('batch_cost_layers', 'perm', 'product.view_cost')` to
`('batch_cost_layers', 'any', null)`. Run `pnpm test:db`: it fails with
"counter cannot see cost layers". Undo the change.

## Phase 1 "done when" — status

| Brief's test | Status |
|---|---|
| pgTAP tests prove tenant A cannot read tenant B | **Passes locally** (PGlite + pgTAP stand-in) |
| a salesman cannot read cost columns | **Passes locally** |
| the same tests on real Supabase with real pgTAP | **Passes in CI** (131 tests, real pgTAP) |

## Not done in Phase 1 (on purpose, or blocked)

- **Sign-in screens** (owner email + 2FA, counter PIN pad) come with the web
  app (Phase 2) and the counter app (Phase 3). The server side is ready.
- **Edge Functions** `invite-owner` and `register-device` are written but have
  never run. They need a real Supabase project, and Deno is not installed on
  this PC.
- **Real Supabase project:** you need to create it (the agent cannot create
  accounts). Steps are in [packages/db/README.md](../packages/db/README.md).
- **Streamlit demo:** if it is still live on Streamlit Community Cloud, delete
  the app in its dashboard. The code is now in `legacy/`.
- **Rust is not installed on this PC.** The counter app (Tauri) needs it from
  Phase 3.
