# Phase 7 — Compliance (server side)

## What was built, in simple words

- **The tax queue.**
  - When a pharmacy switches on FBR (`save_tax_profile`), every bill and every return made at a counter joins a queue for FBR, at once and offline too.
  - The bill shows "pending FBR" until FBR answers.
  - Each counter's documents go out **strictly in the order they were made**. The next one is sent only after the one before it has FBR's answer.
  - When FBR can't be reached, it is retried after 1, 2, 4 … minutes, at most an hour apart.
  - When FBR refuses a document (say, a missing tax code), the owner is told why. They can fix it and send it again (`retry_tax_submission`).
  - When FBR accepts, FBR's invoice number goes on the bill and on the receipt.
  - If anything has been waiting more than 6 hours (a setting), the owner is told. It still keeps being sent.
- **One `TaxProvider` interface** (`packages/tax`).
  - **FBR:** the FBR POS adapter turns MedFlow's invoice into FBR's format, in rupees, with the POS ID and the token, and reads FBR's answer.
  - **Other countries:** a new authority (or a country such as UAE or Saudi) is a new adapter, and nothing else changes.
  - **Mock provider:** a pretend authority for tests and training.
- **The sender** (Edge Function `tax-worker`, every minute).
  - It takes the next documents from the queue, sends them, and records the answers.
  - The authority's token is kept in Supabase Vault and never appears anywhere else.
- **Bills already reported can't be voided.** They are corrected with a return, which also goes to FBR as a refund.
- **Prescriptions** (`save_prescription`, `confirm_prescription`, or sent together with the bill).
  - They record the patient, the doctor, photos and the pharmacist.
  - A controlled or Rx medicine is refused without one. A controlled medicine also needs a real pharmacist's confirmation: a salesman doesn't count.
- **Controlled drugs register** (`controlled_register`).
  - Per medicine: the balance before the period, every receipt and sale (with the supplier, or the patient and prescriber), the running balance, and the closing balance.
  - It is built from the stock ledger, so nobody types it and it can't disagree with the stock.
  - Records are never deleted (no hard deletes anywhere), so they are kept for well beyond the legal 5 years.
- **Licences** (`save_branch_licence`, `licences_due`): the licence number, the qualified person and the expiry date per branch. A reminder comes 30 days before (a setting).
- **Recalls** (`platform_issue_recall`, `platform_lift_recall`).
  - You, as the platform owner, push a banned batch to every pharmacy. Matching stock is frozen instantly and the owners are told.
  - A batch with that number that arrives later is frozen as it arrives.
  - A pharmacy can't lift a recall itself.
- **Scheduled checks** (`run_scheduled_checks`, every 15 minutes) tell the owner about:
  - a stuck tax queue;
  - licences to renew;
  - PCs offline for more than 24 hours;
  - batches expiring within 90 days;
  - low stock.

  They also expire old approvals. Each alert is sent at most once in its quiet period, not every 15 minutes.
- **Receipts** can only be reprinted for bills the counter may look up (its branch, the last 7 days). Each reprint from a counter is logged in the owner's activity feed.

## How to test

```bash
pnpm check
```

- **Acceptance** (`tax: offline invoices reach the authority in order` in `packages/db/scripts/test-db.mjs`):
  - **the setup:** a counter sells 25 bills and takes 2 returns offline, then uploads in three pieces. The pretend FBR is unreachable on every 4th try.
  - **the result:** all 27 documents are accepted exactly once, in the counter's order. Nothing is sent before the one ahead of it has its answer, and every bill carries its FBR number.
- [12_compliance](../packages/db/supabase/tests/database/12_compliance.test.sql) (45 checks) covers the queue, refusal and retry, voids, prescriptions, the register, licences, scheduled checks and recalls.
- `packages/tax/tests`: the FBR field mapping and reading FBR's answers.

## "Done when" — status

| Brief | Status |
|---|---|
| Invoices sent offline reach the tax API in order after reconnecting | **Done** (tested against the pretend authority) |
| Tax provider interface, FBR adapter, offline queue | **Done**; SRB / PRA adapters wait for their specifications |
| Controlled drugs register, prescriptions, licences, recalls | **Done** on the server |

## Before going live (needs you)

- **FBR:** confirm the current POS integration specification (URLs, fields, codes) and the tax treatment of each medicine category with a tax adviser. All of it is in `packages/tax/src/fbr.ts`.
- **Registration:** register the pharmacy's POS with FBR to get its POS ID and token.
- **SRB / PRA:** these can't be switched on yet. Their adapters will be added once their specifications are confirmed.
