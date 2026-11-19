# MedFlow Incident Response Plan

What to do, in order, when something goes wrong. Keep a printed copy next to the HQ computer.

## Who
| Role | Person | Contact |
|---|---|---|
| Incident lead (decides, talks to pharmacies) | [Owner] | [phone] |
| Technical | [Owner / developer] | [phone] |
| Legal advice (data breach) | [Lawyer] | [phone] |

## Severity
- **P1:** pharmacies cannot sell; data lost or exposed; HQ signing key (`hq-keys`) stolen.
- **P2:** one pharmacy down; wrong money figures; HQ down for more than 4 hours.
- **P3:** anything else.

## The six steps (every incident)
1. **Write it down.** Start a log: time, who reported it, what they see. Every action after this gets a line.
2. **Contain.** Stop it getting worse (see playbooks below). Do not delete anything; you will need it.
3. **Tell the affected pharmacies** within [2] hours for P1: what happened, what they should do, when you will update them. HQ → Announcements works for many at once.
4. **Fix** the cause; test on a scratch copy first (`pnpm --filter ./apps/server e2e`).
5. **Recover** data from backups if needed (playbook C).
6. **Review** within a week: what happened, why, what changes so it cannot happen again. Add it to `docs/CHANGELOG.md`.

## Playbooks

### A. A pharmacy cannot sell
1. Ask: does MedFlow open? What does the screen say? (screenshot)
2. "Starting…" for more than 3 minutes → restart the PC.
3. "Licence" message → HQ → that pharmacy → check status and invoices; press "Check now" on their side.
4. Database error → do not reinstall. Collect `C:\MedFlow\logs\medflow.log` and go to playbook C.

### B. HQ is down (link does not open)
1. Is the HQ PC on? Is the **Tailscale** icon connected? (Most common: Tailscale app not running.)
2. `http://localhost:5299` on the HQ PC works but the link does not → Tailscale (admin PowerShell: `Restart-Service Tailscale`, then start the Tailscale app).
3. Pharmacies keep selling for 15 days, so this is P2, not P1.

### C. Restore a pharmacy from a backup
1. Stop MedFlow on that PC (close it; end `node.exe` in Task Manager).
2. Find the newest backup: `C:\MedFlow\backups\medflow-…tar.gz.enc` (or their USB/Drive copy).
3. The backup key is in `C:\MedFlow\backup-key.txt`, in their Settings, or in HQ → that pharmacy → PCs → Backup key. **Give the key only to the owner.**
4. In `C:\MedFlow`: `node\node.exe medflow-server.mjs --restore "<backup file>" --key MFBK-…`
   The current data is moved aside, never deleted. Start MedFlow and check the last sales.

### D. Data breach (someone saw data they should not)
1. Contain: change the affected PINs/passwords; in HQ block the PC (PCs → Block) or set the pharmacy to Suspended; reissue its licence key.
2. Work out what data, how many people, since when (audit log, server logs).
3. Talk to the lawyer the same day about who must be told (pharmacy, patients, authorities) and by when.
4. Tell the pharmacy in writing.

### E. HQ signing key (`C:\MedFlowHQ\hq-keys`) lost or stolen
- **Lost** (PC dead): restore `hq-keys` and `hq-data` from the off-PC copy to a new PC; nothing else changes.
- **Stolen:** P1. Someone could sign fake licences/updates. Make a new key, ship a MedFlow Local update with the new public key **signed with the old key** while you still control HQ, and move HQ (see `HQ_HOSTING.md`).
- **Prevent:** keep an encrypted copy of `hq-keys` off the PC and nowhere public.

### F. A bad update reached pharmacies
HQ → Updates → **Roll back** that release. Pharmacies that installed it roll back by themselves if
it fails to start; for others, publish the previous version again as a newer number.
