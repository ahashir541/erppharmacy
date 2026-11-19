# MedFlow security testing

## 1. What runs automatically
`pnpm --filter ./apps/server e2e` (after `node build.mjs`) starts the built MedFlow Local on a scratch
folder and drives Microsoft Edge through it. It ends with these probes against the running server:

| Probe | Expected | Result (19 Nov 2026) |
|---|---|---|
| API call with no token | Refused | PASS |
| API call with a forged token | Refused | PASS |
| Owner function with only a counter token | Refused (403) | PASS |
| Unknown function (`pg_sleep`) and an HQ admin function | Refused (400) | PASS |
| SQL injection text in medicine search | Treated as text; products intact | PASS |
| Path traversal to `backup-key.txt` / `config.json` (4 encodings) | Not served | PASS |
| 30 MB request | Refused (413), connection closed, server keeps running | PASS |
| Backups list / backup key without the owner | Refused (403) | PASS |
| Security headers on pages and API answers | Present | PASS |
| Browser console during the whole run | No errors (no CSP violations) | PASS |

Load at the same time: 200 searches from 5 counters at shop pace (median 66 ms, 95% under 276 ms);
30 sales from 10 counters at once (all saved, 95% under 1.4 s). Stress, 10 counters searching nonstop:
median 560 ms (the database serves one request at a time, so requests queue).

Database rules have their own tests (`pnpm check`): permissions, tenant isolation, append-only
money records, and the HQ functions.

Found and fixed by these tests: an oversized request left its unread body on the connection and
garbled the next request (now: 413 and the connection is closed).

## 2. Penetration test by an outside firm (still to do)
A real penetration test must be done by an independent tester. Do it before larger customers or the
cloud version. Give them this scope:

**In scope**
- MedFlow HQ at its public address: sign-in (Google, password lockout), session handling, every
  `/hq/` route, licence check-in and payment submission by licence key, update downloads, security.txt.
- MedFlow Local on a test PC on a test shop network: counter linking, PIN sign-in and lockout,
  `/api/call` permission boundaries (staff vs owner), backups and restore, the update installer
  (signature and hash checks), what another device on the shop Wi-Fi can reach.
- The Windows install: file permissions on `C:\MedFlow`, the backup key file, start-up scripts.

**Out of scope:** Google's and Tailscale's own systems; denial-of-service floods; real pharmacies' data.

**Rules:** test copies only (a scratch HQ and a scratch pharmacy); report privately; give us time to
fix before anything is published. Ask for a retest after fixes.

**Known limits to tell the tester up front:** counters talk to the main PC over plain HTTP inside the
shop network; data at rest relies on Windows BitLocker; MedFlow HQ currently runs on a PC behind
Tailscale Funnel.
