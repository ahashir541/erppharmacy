MedFlow Local: the pharmacy's own MedFlow, free, on the shop's main PC
========================================================================

INSTALL (once, on the main PC)
  1. Copy this MedFlow folder to the PC (USB is fine).
  2. Right-click Install-MedFlow.ps1 > "Run with PowerShell".
     For more than one counter PC, choose "Run as administrator" (opens the shop-network port).
  3. MedFlow opens. Choose "Set up my pharmacy": pharmacy name, owner, bill prefix, owner PIN.
     (Or "Try the demo pharmacy" to practise first.)
  Done. From now on MedFlow starts by itself when the PC is switched on.
  Desktop icon: MedFlow.

MORE COUNTER PCs (same shop network / Wi-Fi)
  On the other PC open Chrome or Edge at the address shown in MedFlow > Settings > "This PC"
  (for example http://192.168.1.10:5199), choose "Link this PC", type a name and the owner's PIN.
  The main PC must be on for the other counters to work.

BACKUPS (automatic)
  Every night at 11 pm, and at start-up if the last one is older than a day.
  Kept in C:\MedFlow\backups (the newest 30). Desktop icon: MedFlow Backups.
  For a second copy away from this PC (a dead disk or theft), set "copyTo" in C:\MedFlow\config.json
  to a Google Drive or USB folder, e.g.  "copyTo": "G:\\My Drive\\MedFlow Backups"
  Owner can also press "Back up now" in MedFlow > Settings.

PUT BACK A BACKUP
  Right-click Restore-Backup.ps1 > "Run with PowerShell", choose the backup, type YES.
  Today's data is kept aside in C:\MedFlow\data-before-restore-..., never deleted.

UPDATE
  Copy the new MedFlow folder anywhere and run its Install-MedFlow.ps1. Data, backups and
  settings stay as they are; the database is updated by itself.

MOVE TO A NEW PC
  Install on the new PC, then Restore-Backup.ps1 with the latest backup from the old one.

PROBLEMS
  The log is C:\MedFlow\logs\medflow.log. To see MedFlow working in a window, double-click
  MedFlow-Server.cmd (close any running copy first via Task Manager > node.exe).

------------------------------------------------------------------------
اردو خلاصہ
  انسٹال: Install-MedFlow.ps1 پر رائٹ کلک > Run with PowerShell۔ پھر فارمیسی کا نام، مالک اور PIN۔
  کمپیوٹر آن ہوتے ہی MedFlow خود چل پڑے گا۔ بیک اپ ہر رات خود بنتا ہے (C:\MedFlow\backups)۔
  دوسرا کاؤنٹر: اسی وائی فائی پر براؤزر میں Settings میں دیا گیا پتہ کھولیں اور مالک کا PIN ڈالیں۔
