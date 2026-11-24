# SPDX-License-Identifier: AGPL-3.0-or-later
# The orchestrator server as a process of its own: it belongs to no terminal, editor or desktop app,
# so it runs until it is stopped here (or the computer is shut down or signed out).
#   tools\server.ps1 start | stop | restart | status
#   tools\server.ps1 autostart | no-autostart   (start it at each Windows sign-in: a shortcut in your Startup folder)
# It listens where config/orchestrator.json says (127.0.0.1). If it crashes it is started again after
# 5 seconds; after 5 crashes within 10 minutes it stays down. Output: data/server.log.
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'restart', 'status', 'autostart', 'no-autostart', 'run')][string]$Command = 'status')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$self = $PSCommandPath
$pidFile = Join-Path $root 'data\server.pid'
$log = Join-Path $root 'data\server.log'
$config = Join-Path $root 'config\orchestrator.json'
$port = [int](Get-Content -Raw $config | ConvertFrom-Json).port
$url = "http://127.0.0.1:$port"
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'decomp-orchestrator server.lnk'

# The keeper process of this checkout (the one that restarts the server), or nothing.
function Get-Keeper {
  if (-not (Test-Path $pidFile)) { return }
  $id = [int](Get-Content $pidFile -TotalCount 1)
  Get-CimInstance Win32_Process -Filter "ProcessId = $id" | Where-Object { $_.CommandLine -like "*$self*run*" }
}
function Get-PortOwner { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess }
function Test-Up { try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$url/api/runs"; $true } catch { $false } }

function Show-Status {
  $k = Get-Keeper
  if ($k) { "running since $($k.CreationDate.ToString('yyyy-MM-dd HH:mm')) on ${url}$(if (-not (Test-Up)) { ' (not answering)' })" }
  elseif ($o = Get-PortOwner) { "not started from here, but process $o listens on port $port" }
  else { 'stopped' }
}
function Start-Server {
  if (Get-Keeper) { Show-Status; return }
  if ($o = Get-PortOwner) { throw "port $port is in use by process $o; stop that one first" }
  $shell = (Get-Process -Id $PID).Path
  # Created by Windows itself, not as a child of this shell: closing the shell or the app that runs it leaves it alone.
  $si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = "`"$shell`" -NoProfile -ExecutionPolicy Bypass -File `"$self`" run"; CurrentDirectory = $root; ProcessStartupInformation = $si
  }
  if ($r.ReturnValue -ne 0) { throw "could not start the server process (code $($r.ReturnValue))" }
  Set-Content $pidFile $r.ProcessId
  for ($i = 0; $i -lt 60 -and -not (Test-Up); $i++) { Start-Sleep 1 }
  if (-not (Test-Up)) { Get-Content $log -Tail 15; throw "the server does not answer on $url; see $log" }
  Show-Status
}
function Stop-Server {
  $k = Get-Keeper
  if (-not $k) { Show-Status; return }
  $null = & taskkill.exe /PID $k.ProcessId /T /F
  Remove-Item $pidFile
  for ($i = 0; $i -lt 20 -and (Get-PortOwner); $i++) { Start-Sleep -Milliseconds 500 }
  Show-Status
}
function Enable-Autostart {
  $l = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  $l.TargetPath = (Get-Process -Id $PID).Path
  $l.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" start"
  $l.WorkingDirectory = $root
  $l.WindowStyle = 7
  $l.Description = 'Starts the decomp-orchestrator server'
  $l.Save()
  "starts at sign-in ($shortcut)"
}
function Disable-Autostart { if (Test-Path $shortcut) { Remove-Item $shortcut }; 'does not start at sign-in' }
function Invoke-Keeper {
  $env:ORCH_CONFIG = 'config/orchestrator.json'
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  Set-Location (Join-Path $root 'apps\server')
  $crashes = @()
  while ($true) {
    "--- started $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8
    & cmd.exe /c "node --import tsx src/index.ts >> `"$log`" 2>&1"
    $code = $LASTEXITCODE
    "--- ended $(Get-Date -Format s) with code $code" | Out-File $log -Append -Encoding utf8
    if ($code -eq 0) { break }
    $now = Get-Date
    $crashes = @($crashes | Where-Object { ($now - $_).TotalMinutes -lt 10 }) + $now
    if ($crashes.Count -ge 5) { '--- 5 crashes within 10 minutes: staying down' | Out-File $log -Append -Encoding utf8; break }
    Start-Sleep 5
  }
}

switch ($Command) {
  'start' { Start-Server }
  'stop' { Stop-Server }
  'restart' { Stop-Server; Start-Server }
  'status' { Show-Status }
  'autostart' { Enable-Autostart }
  'no-autostart' { Disable-Autostart }
  'run' { Invoke-Keeper }
}
