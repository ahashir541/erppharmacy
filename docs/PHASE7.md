# Phase 7 — Compliance (server side)

**No tax, no FBR.** By the owner's decision (D55), MedFlow has no sales tax and no connection to FBR or any other tax authority:
- Bills never charge tax.
- Receipts and reports show no tax.
- There are no tax settings or tax permissions.

The tax queue and FBR adapter built earlier in this phase were removed.

## What was built, in simple words

- **Prescriptions** (`save_prescription`, `confirm_prescription`, or sent together with the bill).
  - They record the patient, the doctor, photos and the pharmacist.
  - A controlled or Rx medicine is refused without one. A controlled medicine also needs a real pharmacist's confirmation: a salesman doesn't count.
- **Controlled drugs register** (`controlled_register`).
  - Per medicine: the balance before the period, every receipt and sale (with the supplier, or the patient and prescriber), the running balance, and the closing balance.
  - It is built from the stock ledger, so nobody types it and it can't disagree with the stock.
  - Records are never deleted (no hard deletes anywhere).
- **Licences** (`save_branch_licence`, `licences_due`): the licence number, the qualified person and the expiry date per branch. A reminder comes 30 days before (a setting).
- **Recalls** (`platform_issue_recall`, `platform_lift_recall`).
  - You, as the platform owner, push a banned batch to every pharmacy. Matching stock is frozen instantly and the owners are told.
  - A batch with that number that arrives later is frozen as it arrives.
  - A pharmacy can't lift a recall itself.
- **Scheduled checks** (`run_scheduled_checks`, every 15 minutes) tell the owner about:
  - licences to renew;
  - PCs offline for more than 24 hours;
  - batches expiring within 90 days;
  - low stock.

  They also expire old approvals. Each alert is sent at most once in its quiet period.
- **Receipts** can only be reprinted for bills the counter may look up (its branch, the last 7 days). Each reprint from a counter is logged in the owner's activity feed.

## How to test

```bash
pnpm check
```

[12_compliance](../packages/db/supabase/tests/database/12_compliance.test.sql) covers:
- no item ever taxed, and no tax permissions;
- prescriptions and the pharmacist rule;
- the controlled drugs register;
- licences, scheduled checks and recalls.

## "Done when" — status

| Brief | Status |
|---|---|
| Invoices reach the tax API in order | **Dropped**: no tax authority link (D55) |
| Controlled drugs register, prescriptions, licences, recalls | **Done** on the server |
