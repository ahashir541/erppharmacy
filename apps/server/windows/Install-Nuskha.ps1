# Nuskha Local: install (or update) on the pharmacy's main PC.
# Right-click this file > "Run with PowerShell". Updating keeps the data, backups and settings.
#  - copies Nuskha to C:\Nuskha (data in C:\Nuskha\data, backups in C:\Nuskha\backups)
#  - starts Nuskha by itself whenever this PC is switched on and someone signs in to Windows
#  - lets other counter PCs on the shop network reach it (needs "Run as administrator" once)
#  - puts a Nuskha icon on the desktop
param([string]$Target = 'C:\Nuskha', [int]$Port = 5199)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ''
Write-Host '  Nuskha Local - installing' -ForegroundColor Cyan
Write-Host ''

# 1. Stop a running Nuskha (an update). Earlier versions were called MedFlow (task 'MedFlow Local').
foreach ($old in @('MedFlow Local')) {
  Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue | ForEach-Object { Stop-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue }
}
Get-ScheduledTask -TaskName 'Nuskha Local' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*MedFlow-Server.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*medflow-server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# 2. Copy the program (never the data)
# Moving from the old MedFlow folder: bring this pharmacy's data, backups, settings and backup key along
# (the old folder is left in place, never deleted).
$legacy = 'C:\MedFlow'
if ((Resolve-Path $legacy -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $legacy 'data')) -and -not (Test-Path (Join-Path $Target 'data'))) {
  Write-Host "  Moving your records from $legacy to $Target"
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($keep in @('data', 'backups', 'config.json', 'backup-key.txt')) {
    if (Test-Path (Join-Path $legacy $keep)) { Copy-Item -LiteralPath (Join-Path $legacy $keep) -Destination $Target -Recurse -Force }
  }
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null
if ((Resolve-Path $src).Path -ne (Resolve-Path $Target).Path) {
  foreach ($item in Get-ChildItem -LiteralPath $src -Force) {
    # Never overwrite what belongs to this pharmacy: its data, backups, settings and backup key.
    if ($item.Name -in @('data', 'backups', 'logs', 'config.json', 'backup-key.txt', 'updates') -or $item.Name -like 'data-*') { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $Target -Recurse -Force
  }
}
$cfg = Join-Path $Target 'config.json'
if (-not (Test-Path $cfg)) {
  @{ port = $Port; data = 'data'; backups = 'backups'; copyTo = $null; backupHour = 23 } | ConvertTo-Json | Set-Content -Encoding UTF8 $cfg
}
Write-Host "  Installed in $Target"

# 3. Start with Windows (hidden, restarts itself if it ever stops)
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Target\start-hidden.vbs`"" -WorkingDirectory $Target
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'Nuskha Local' -Action $action -Trigger $trigger -Settings $settings -Description 'Nuskha pharmacy server' -Force | Out-Null
Write-Host '  Nuskha will start by itself when this PC starts'

# 4. Other counters on the shop network (administrator only)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  Get-NetFirewallRule -DisplayName 'Nuskha Local' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'Nuskha Local' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
  Write-Host "  Other counter PCs on the shop network can connect (port $Port)"
} else {
  Write-Host '  Only this PC can use Nuskha for now. For more counter PCs, run this installer once with' -ForegroundColor Yellow
  Write-Host '  right-click > "Run as administrator".' -ForegroundColor Yellow
}

# 5. Desktop icon: Nuskha in its own window (Edge app mode), or the default browser
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
Remove-Item (Join-Path $desktop 'MedFlow.lnk'), (Join-Path $desktop 'MedFlow Backups.lnk') -ErrorAction SilentlyContinue
$lnk = $shell.CreateShortcut((Join-Path $desktop 'Nuskha.lnk'))
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = "`"$Target\MedFlow.vbs`""
$lnk.WorkingDirectory = $Target
$lnk.IconLocation = "$Target\MedFlow.ico,0"
$lnk.Description = 'Nuskha pharmacy'
$lnk.Save()
$b = $shell.CreateShortcut((Join-Path $desktop 'Nuskha Backups.lnk'))
$b.TargetPath = (Join-Path $Target 'backups'); $b.Save()
New-Item -ItemType Directory -Force -Path (Join-Path $Target 'backups') | Out-Null
Write-Host '  Desktop icons: Nuskha, Nuskha Backups'

# 6. Start now and open
Start-ScheduledTask -TaskName 'Nuskha Local'
Write-Host '  Starting Nuskha...'
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); $ok = $true; break } catch { }
}
if ($ok) {
  Write-Host ''
  Write-Host '  Nuskha is running.' -ForegroundColor Green
  Start-Process (Join-Path $desktop 'Nuskha.lnk')
} else {
  Write-Host "  Nuskha did not start. See $Target\logs\medflow.log" -ForegroundColor Red
}
Write-Host ''
Read-Host '  Press Enter to close'
