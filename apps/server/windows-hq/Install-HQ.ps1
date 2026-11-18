# MedFlow HQ: install (or update) on YOUR computer. Never give this to a pharmacy.
# Right-click > "Run with PowerShell". Updating keeps the data, the signing key and the backups.
#  - copies HQ to C:\MedFlowHQ (data in hq-data, signing key in hq-keys, backups in hq-backups)
#  - starts HQ by itself when you sign in to Windows (hidden, restarts itself if it stops)
#  - desktop icon "MedFlow HQ" opens your console
param([string]$Target = 'C:\MedFlowHQ')
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ''
Write-Host '  MedFlow HQ - installing' -ForegroundColor Cyan

# 1. Stop a running HQ (an update)
Get-ScheduledTask -TaskName 'MedFlow HQ' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*HQ-Server.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*medflow-hq.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 2. Copy the program (never the data, the key or the backups)
New-Item -ItemType Directory -Force -Path $Target | Out-Null
if ((Resolve-Path $src).Path -ne (Resolve-Path $Target).Path) {
  foreach ($item in Get-ChildItem -LiteralPath $src -Force) {
    if ($item.Name -in @('hq-data', 'hq-keys', 'hq-backups', 'hq-releases', 'logs')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force
  }
}
Write-Host "  Installed in $Target"

# 3. Start with Windows
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Target\hq-start-hidden.vbs`"" -WorkingDirectory $Target
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'MedFlow HQ' -Action $action -Trigger $trigger -Settings $settings -Description 'MedFlow HQ server' -Force | Out-Null
Write-Host '  MedFlow HQ will start by itself when you sign in to Windows'

# 4. Desktop icon
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $desktop 'MedFlow HQ.lnk'))
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$Target\MedFlowHQ.vbs`""
$lnk.WorkingDirectory = $Target
$lnk.IconLocation = "$Target\MedFlowHQ.ico,0"
$lnk.Description = 'MedFlow HQ console'
$lnk.Save()
Write-Host '  Desktop icon: MedFlow HQ'

# 5. Start now
Start-ScheduledTask -TaskName 'MedFlow HQ'
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 5299); $c.Close(); $ok = $true; break } catch { }
}
if ($ok) {
  Write-Host '  MedFlow HQ is running: http://localhost:5299' -ForegroundColor Green
  Write-Host "  KEEP $Target\hq-keys SAFE: copy it to a USB or Google Drive once. Never share it." -ForegroundColor Yellow
} else {
  Write-Host "  MedFlow HQ did not start. See $Target\logs\medflow-hq.log" -ForegroundColor Red
}
