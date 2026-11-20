# Nuskha Local: put back a backup. Right-click > "Run with PowerShell".
# The current data is moved aside (C:\Nuskha\data-before-restore-...), never deleted.
param([string]$File = '', [string]$Key = '')
$ErrorActionPreference = 'Stop'
$home_ = Split-Path -Parent $MyInvocation.MyCommand.Path
$backups = Join-Path $home_ 'backups'
if (-not $File) {
  $list = Get-ChildItem $backups -Filter 'medflow-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.tar\.gz(\.enc)?$' } | Sort-Object LastWriteTime -Descending
  if (-not $list) { Write-Host "No backups in $backups"; Read-Host 'Press Enter'; exit 1 }
  Write-Host ''
  for ($i = 0; $i -lt [Math]::Min(15, $list.Count); $i++) { Write-Host ("  {0,2}. {1}   {2:N1} MB" -f ($i + 1), $list[$i].Name, ($list[$i].Length / 1MB)) }
  Write-Host ''
  $n = Read-Host '  Which backup? (number, or a full file path)'
  if ($n -match '^\d+$') { $File = $list[[int]$n - 1].FullName } else { $File = $n }
}
if (-not (Test-Path $File)) { Write-Host "Not found: $File"; Read-Host 'Press Enter'; exit 1 }
# Encrypted backups (.enc) need their backup key. On the same PC it is in backup-key.txt; on a new PC
# type the key from the old PC (Settings > Backup key, or ask Nuskha: HQ keeps a copy).
if ($File -like '*.enc' -and -not $Key) {
  Write-Host '  This backup is encrypted.'
  $Key = Read-Host '  Backup key MFBK-... (press Enter if this is the same PC that made it)'
}
$yes = Read-Host "  Replace today's Nuskha data with $(Split-Path -Leaf $File)? Type YES"
if ($yes -ne 'YES') { exit 0 }

Get-ScheduledTask -TaskName 'Nuskha Local' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*medflow-server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | Where-Object { $_.CommandLine -like '*MedFlow-Server.cmd*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

$node = Join-Path $home_ 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
if ($Key) { & $node (Join-Path $home_ 'medflow-server.mjs') --restore $File --key $Key }
else { & $node (Join-Path $home_ 'medflow-server.mjs') --restore $File }
if ($LASTEXITCODE -ne 0) { Write-Host 'Restore failed (see above).' -ForegroundColor Red; Read-Host 'Press Enter'; exit 1 }
Start-ScheduledTask -TaskName 'Nuskha Local' -ErrorAction SilentlyContinue
Write-Host '  Done. Nuskha is starting with the restored data.' -ForegroundColor Green
Read-Host '  Press Enter to close'
