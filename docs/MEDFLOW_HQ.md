# MedFlow HQ: running MedFlow as a business

MedFlow runs on each pharmacy's own PC (MedFlow Local). **MedFlow HQ** is yours: one server and
console where you add pharmacies, set plans and prices, switch features, bill, and see who is
running which version. Pharmacies never send their sales, stock or customers to HQ, only counts
(medicines, counters, staff, bills in 30 days) for the health page.

```
 Pharmacy PC (MedFlow Local)                         Your HQ (MedFlow HQ)
 ┌─────────────────────────┐   daily check-in    ┌──────────────────────────────┐
 │ data stays here         │ ─── licence key ──▶ │ pharmacies, plans, invoices  │
 │ follows the licence:    │ ◀── signed licence ─│ signs with its private key   │
 │ trial / active / grace  │   (status, plan,    │ console: you, with password  │
 │ read-only / suspended   │    limits, news,    └──────────────────────────────┘
 │ works offline 15 days   │    invoices)
 └─────────────────────────┘
```

## What you control from HQ

| Screen | What it does |
|---|---|
| Overview | Monthly income (MRR), paying and trial pharmacies, overdue money, payments to check, pharmacies not seen for 3+ days |
| Pharmacies | Add a pharmacy and get its licence key (copy or send on WhatsApp). Per pharmacy: status, plan and price, invoices, payments, PCs running MedFlow (block a stolen PC), features and limits just for them, history |
| Payments | Pharmacies send the transaction ID from MedFlow; you check your bank/JazzCash and press "Money received". Your payment details shown to pharmacies |
| Plans & prices | Price per month and year, trial days, limits (branches, counters, staff), included features. Reaches every pharmacy at its next check-in |
| Announcements | A message to every pharmacy, one plan, or one pharmacy, in English and Urdu |

## The rules a pharmacy follows

- **New pharmacy:** you add it in HQ, it gets a key, the trial starts (the plan's trial days).
- **No key yet:** MedFlow Local works for 7 days, then becomes read-only until a key is entered.
- **Trial ends without payment:** 7 days' grace (still sells, sees a "payment late" bar), then
  read-only **at closing time**, never in the middle of the day.
- **Read-only:** they can see and export everything, but not sell or change anything. Paying (you
  press "Money received") makes them active again at their next check-in.
- **Offline:** a licence is valid for 15 days (per pharmacy, changeable). The pharmacy's server
  checks in at start-up, every 6 hours, and on "Check now". After 15 days without reaching HQ it
  becomes read-only until it connects again.
- **Tampering:** every licence is signed by HQ's private key (Ed25519). An edited licence, or one
  from a fake HQ, is rejected. A key used by another pharmacy's PC is refused.

## Run HQ (now, for free)

1. Build: `node apps/server/build-hq.mjs` → `apps/server/release/MedFlowHQ`.
2. Start it: double-click `HQ-Server.cmd`. Open <http://localhost:5299> and create your admin
   sign-in (only possible on the HQ computer itself).
3. **Keep `hq-keys` private and backed up.** It holds the signing key. If it is lost, every
   pharmacy needs a new MedFlow build before its licence can renew.
4. Run `node apps/server/build-hq.mjs --url https://<your HQ address>` again: this writes
   `apps/server/hq.json` (address + public key). Every MedFlow Local built after that is tied to
   your HQ (`node apps/server/build.mjs --zip`).

### Making HQ reachable from pharmacies (choose one)

| Option | Cost | Notes |
|---|---|---|
| Your own PC + **Cloudflare Tunnel** | Free | A public `https://…` address for your PC without opening ports. Your PC should be on most days; pharmacies keep working 15 days offline anyway |
| A small cloud VM (Oracle Cloud "Always Free", Google Cloud e2-micro) | Free tier | Always on. Needs one-time setup of the VM |
| A paid VPS | ~Rs 1,500/month | Easiest always-on option |

Supabase (the cloud build) can host the same database functions; an Edge Function for the
check-in is the remaining piece if you choose it later.

## Updates (how to ship a new version)

1. Raise `"version"` in `apps/server/package.json` (e.g. 0.2.0 → 0.3.0).
2. `node apps/server/build.mjs --update` → `apps/server/release/medflow-local-0.3.0.tar.gz`.
3. HQ console → **Updates** → choose the file → publish on **beta** first (set a few pharmacies to
   "First (beta)" on their page), then publish the same file on **stable** for everyone.
4. Each pharmacy sees the offer at its next check-in and installs it **between 1 and 5 at night**,
   or at once when the owner presses **Install now** (Settings). Before installing it checks HQ's
   signature and the file's SHA-256, backs up the data, keeps a copy of the current version, then
   restarts on the new one (new database migrations run by themselves).
5. If the new version does not start three times, it **goes back by itself** to the previous one,
   does not try that version again, and HQ shows "update failed" on that PC.
6. A bad version: **Pull** it in Updates. PCs that have not installed it stay put; PCs that have it
   get the last good version.

Rules for new versions: database changes are always new migration files (an installed pharmacy
only runs migrations it has not run), and the data, backups, config and Node are never replaced.

## Still to build

- Optional cloud backup of a pharmacy's data to HQ (a paid add-on).
- Two-factor sign-in for the HQ console (it has a password, sign-in limits and 12-hour sessions now).
