# Changelog

## Unreleased

### Phase 2 — Catalogue and stock (2026-10-28)

- Product import (10,000 rows per call, idempotent, per-row errors, wrong
  barcodes refused), CSV parsing and column mapping in `packages/core`.
- Product edits, pack sizes, price history, bulk price change.
- Opening stock, adjustments with daily limits and one-time approvals,
  write-offs, batch blocks, blind stock counts.
- Views: current prices, product stock with nearest expiry, expiry dashboard.
- Balance self-check and repair. PC actions run as the signed-in staff
  member (`app.rpc_actor`).
- D16 revised (blank limit = no limit, 0 = always ask).

### Phase 1 — Foundation (2026-10-28)

- Monorepo: pnpm workspaces + Turborepo; `packages/core`, `packages/db`,
  `packages/config`.
- Old FastAPI/React/Streamlit code moved to `legacy/`. Committed `egg-info`
  build output deleted.
- Schema moved into the Supabase CLI layout (`packages/db/supabase`), with
  hardened auth settings: invitation-only sign-up, TOTP 2FA, 12+ character
  passwords, custom access token hook.
- Cloud sign-in is limited to owners with 2FA. Staff work only on registered
  pharmacy PCs with a PIN (D11).
- Permissions engine in SQL and TypeScript, with a parity test (5,280
  combinations).
- Server functions for onboarding, staff, roles, permission overrides, PINs,
  devices, staff sessions, PIN lockout, settings and activity logging. Plan
  limits are enforced.
- Edge Functions `invite-owner` and `register-device` (not yet run).
- Tests: 5 pgTAP files (131 assertions) run locally in PGlite and in CI on
  real Supabase. 28 Vitest tests for core.
- New CI workflow for the monorepo and Supabase pgTAP.
- Docs: `PHASE1.md`, decisions D11–D25.

### Phase 0 — review draft (2026-10-28)

- Project brief, review document, draft schema and smoke test.
