# Phase 4 — Offline sync (server side and counter outbox)

## What was built, in simple words

- **The counter keeps working without internet.** Every action at the counter — a PIN sign-in, opening
  the drawer, a sale, a return, a held bill, closing the drawer — is written as a **command** into the
  PC's own **outbox** (`packages/sync/src/outbox.ts`). Each command has an ID made on the PC and the
  PC's own running number, so nothing depends on the internet to get a number.
- **The bill is worked out on the PC** with the same maths as the server (`packages/core`), so the
  printed total is the total the server records.
- **When the internet comes back**, the outbox is uploaded. The server replays the commands one by one,
  in the PC's order (`public.apply_device_commands`):
  - a command it has already received is recognised and skipped (a retry never sells twice);
  - a sale that broke a rule offline is **kept and flagged for the owner**, because the medicine has
    already been handed over;
  - a command that cannot be applied at all (an app bug, or a newer app version) is **kept with its
    error**, never thrown away, and the owner is told;
  - one bad command never blocks the rest.
- **Two counters never overwrite each other.** Stock, cash and udhaar are ledgers: each sale adds
  its own lines, so two PCs selling the same medicine offline both count.
- **What a counter PC downloads** is listed in `packages/db/powersync/sync-rules.yaml`: the
  catalogue, retail and minimum prices, stock at its own branch, its own branch's recent bills, PIN
  hashes of staff who work at that branch, and its own drawers. **Never** cost, trade price, profit,
  cash totals, udhaar balances, ledgers or the activity log. A test reads this file on every run and
  fails if a money table or column ever appears, or if a column name is wrong.
- **The corner of the counter screen** always shows one of: *Synced*, *Syncing 3…*,
  *Offline · 12 waiting*, or *Needs attention* (`packages/sync/src/status.ts`).
- **Staff disabled while a PC was offline**: their offline sign-in still arrives, flagged to the owner.

## How to run and test

```bash
pnpm install
pnpm check
```

- [09_sync](../packages/db/supabase/tests/database/09_sync.test.sql): order, retries, rejected and
  unknown commands kept, reused numbers, disabled staff, isolation between pharmacies.
- `offline: two counters, one hour, reconnect` in `packages/db/scripts/test-db.mjs`: two PCs at the
  same branch each make 60 sales over an hour offline, then upload in pieces, all at once and again
  in reverse. Checked: 120 sales, exact stock, both drawers balance to the paisa, nothing lost or
  flagged.
- `packages/sync/tests`: the outbox and the status label.

## "Done when" — status

| Brief | Status |
|---|---|
| Two counters offline for an hour, reconnect, stock and cash exact, no sale lost | **Done** (server and outbox, tested) |
| The counter never receives money data | **Done** (sync rules, checked on every test run) |
| Visible sync status | **Done** (logic); the screen is built with the counter app |

## Not done yet (needs you or later phases)

- Connecting PowerSync for real needs the Supabase project and a PowerSync account (only you can
  create them). The sync rules and upload function are ready for it.
- The counter app screens (Tauri) come later; Rust isn't installed on this PC yet.
- Voids stay online only, because they need a manager's approval (D32).
