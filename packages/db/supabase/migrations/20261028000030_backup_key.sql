-- 0030: MedFlow HQ keeps each pharmacy PC's backup key (escrow). Backups are encrypted on the
-- pharmacy PC; if that PC dies, the owner can get the key from you and open a USB/Drive copy.
-- Visible only to platform admins (local_installs is readable by them alone).
alter table local_installs add column if not exists backup_key text;
