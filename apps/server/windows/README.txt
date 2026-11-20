Nuskha Local: the pharmacy's own Nuskha, free, on the shop's main PC
========================================================================

INSTALL (once, on the main PC)
  1. Copy this Nuskha folder to the PC (USB is fine).
  2. Right-click Install-Nuskha.ps1 > "Run with PowerShell".
     For more than one counter PC, choose "Run as administrator" (opens the shop-network port).
  3. Nuskha opens. Choose "Set up my pharmacy": pharmacy name, owner, bill prefix, owner PIN.
     (Or "Try the demo pharmacy" to practise first.)
  Done. From now on Nuskha starts by itself when the PC is switched on.
  Desktop icon: Nuskha.

MORE COUNTER PCs (same shop network / Wi-Fi)
  On the other PC open Chrome or Edge at the address shown in Nuskha > Settings > "This PC"
  (for example http://192.168.1.10:5199), choose "Link this PC", type a name and the owner's PIN.
  The main PC must be on for the other counters to work.

BACKUPS (automatic)
  Every night at 11 pm, and at start-up if the last one is older than a day.
  Kept in C:\Nuskha\backups (the newest 30). Desktop icon: Nuskha Backups.
  For a second copy away from this PC (a dead disk or theft), set "copyTo" in C:\Nuskha\config.json
  to a Google Drive or USB folder, e.g.  "copyTo": "G:\\My Drive\\Nuskha Backups"
  Owner can also press "Back up now" in Nuskha > Settings.

PUT BACK A BACKUP
  Right-click Restore-Backup.ps1 > "Run with PowerShell", choose the backup, type YES.
  Today's data is kept aside in C:\Nuskha\data-before-restore-..., never deleted.

UPDATE
  Copy the new Nuskha folder anywhere and run its Install-Nuskha.ps1. Data, backups and
  settings stay as they are; the database is updated by itself.

MOVE TO A NEW PC
  Install on the new PC, then Restore-Backup.ps1 with the latest backup from the old one.

PROBLEMS
  The log is C:\Nuskha\logs\medflow.log. To see Nuskha working in a window, double-click
  MedFlow-Server.cmd (close any running copy first via Task Manager > node.exe).

------------------------------------------------------------------------
اردو خلاصہ
  انسٹال: Install-Nuskha.ps1 پر رائٹ کلک > Run with PowerShell۔ پھر فارمیسی کا نام، مالک اور PIN۔
  کمپیوٹر آن ہوتے ہی Nuskha خود چل پڑے گا۔ بیک اپ ہر رات خود بنتا ہے (C:\Nuskha\backups)۔
  دوسرا کاؤنٹر: اسی وائی فائی پر براؤزر میں Settings میں دیا گیا پتہ کھولیں اور مالک کا PIN ڈالیں۔
