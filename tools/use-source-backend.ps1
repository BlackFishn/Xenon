[CmdletBinding()]
param(
  [ValidateSet('Enable', 'Restart', 'Restore')]
  [string]$Mode = 'Enable',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Xenon'),
  [string]$TaskName = 'Xenon Edge Widget'
)

$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceServer = Join-Path $repoRoot 'server'
$sourceRunner = Join-Path $sourceServer 'start-hidden.vbs'
$sourceData = Join-Path $sourceServer 'data'
$installRootFull = [IO.Path]::GetFullPath($InstallRoot)
$expectedParent = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$stateDir = Join-Path $env:LOCALAPPDATA 'Xenon\source-backend'
$statePath = Join-Path $stateDir 'state.json'

function Assert-SafeInstallRoot {
  $parent = [IO.Path]::GetFullPath((Split-Path -Parent $installRootFull))
  if ($parent -ne $expectedParent -or (Split-Path -Leaf $installRootFull) -ne 'Xenon') {
    throw "Refusing to modify unexpected install root: $installRootFull"
  }
}

function Copy-DirectoryContents([string]$From, [string]$To) {
  if (-not (Test-Path -LiteralPath $From)) { return }
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  Get-ChildItem -LiteralPath $From -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $To -Recurse -Force
  }
}

function Start-XenonTask {
  try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  } catch {
    & (Join-Path $env:WINDIR 'System32\schtasks.exe') /Run /TN $TaskName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not start scheduled task '$TaskName'." }
  }
}

function Write-SourceLauncher([string]$Path) {
  $wscript = (Join-Path $env:WINDIR 'System32\wscript.exe').Replace('"', '""')
  $runner = $sourceRunner.Replace('"', '""')
  $launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """$wscript"" ""$runner""", 0, False
"@
  [IO.File]::WriteAllText($Path, $launcher, [Text.UTF8Encoding]::new($false))
}

function Wait-ForSourceBackend {
  $deadline = (Get-Date).AddSeconds(25)
  do {
    Start-Sleep -Milliseconds 500
    try {
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3030/update/self-status' -TimeoutSec 2
      if ($status.reason -eq 'git_checkout') { return $true }
    } catch { }
  } while ((Get-Date) -lt $deadline)
  return $false
}

Assert-SafeInstallRoot

if ($Mode -eq 'Restart') {
  if (-not (Test-Path -LiteralPath $statePath)) { throw 'Source backend is not enabled.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ([string]$state.repoRoot -ne $repoRoot) {
    throw "Source mode is owned by another checkout: $($state.repoRoot)"
  }
  Start-XenonTask
  if (-not (Wait-ForSourceBackend)) { throw 'Source backend failed to restart.' }
  Write-Host "Source backend restarted: $repoRoot"
  exit 0
}

if ($Mode -eq 'Restore') {
  if (-not (Test-Path -LiteralPath $statePath)) { throw 'No source-mode state was found.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $releaseTree = [IO.Path]::GetFullPath([string]$state.releaseTree)
  $backupBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Xenon\backups'))
  if (-not $releaseTree.StartsWith($backupBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to restore from unexpected path: $releaseTree"
  }
  if (-not (Test-Path -LiteralPath $releaseTree)) { throw "Backup is missing: $releaseTree" }

  Copy-DirectoryContents $sourceData (Join-Path $releaseTree 'server\data')
  if (Test-Path -LiteralPath $installRootFull) {
    Remove-Item -LiteralPath $installRootFull -Recurse -Force
  }
  Move-Item -LiteralPath $releaseTree -Destination $installRootFull
  Start-XenonTask
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host "Restored release backend: $installRootFull"
  exit 0
}

if (Test-Path -LiteralPath $statePath) {
  $existingState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ([string]$existingState.repoRoot -eq $repoRoot) {
    Write-Host "Source backend is already enabled: $repoRoot"
    Write-Host "Release backup: $($existingState.releaseTree)"
    exit 0
  }
  throw "Source mode is already owned by another checkout: $($existingState.repoRoot)"
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
  throw "Source backend must be a Git checkout: $repoRoot"
}
if (-not (Test-Path -LiteralPath $sourceRunner)) { throw "Missing source runner: $sourceRunner" }
if (-not (Test-Path -LiteralPath (Join-Path $sourceServer 'server.js'))) {
  throw "Missing source server: $sourceServer\server.js"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
  throw "Dependencies are missing. Run npm.cmd install in $repoRoot first."
}
if (-not (Test-Path -LiteralPath $installRootFull)) {
  throw "Installed release backend was not found: $installRootFull"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $env:LOCALAPPDATA "Xenon\backups\source-mode-$stamp"
$releaseTree = Join-Path $backupRoot 'release-tree'
$installedData = Join-Path $installRootFull 'server\data'
$installedRunner = Join-Path $installRootFull 'server\start-hidden.vbs'
$savedRunner = Join-Path $backupRoot 'start-hidden.vbs'

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-DirectoryContents $sourceData (Join-Path $backupRoot 'source-data-before')
Copy-DirectoryContents $installedData (Join-Path $backupRoot 'installed-data')
Copy-DirectoryContents $installedData $sourceData
Copy-Item -LiteralPath $installedRunner -Destination $savedRunner -Force

try {
  # The existing task is already trusted to run this path. Point that small
  # launcher at the checkout first; once the old process exits, its working
  # directory no longer prevents the release tree from being moved aside.
  Write-SourceLauncher $installedRunner
  Start-XenonTask
  if (-not (Wait-ForSourceBackend)) { throw 'Source backend did not report git_checkout within 25 seconds.' }

  # Keep the retired release complete and independently restorable.
  Copy-Item -LiteralPath $savedRunner -Destination $installedRunner -Force
  Move-Item -LiteralPath $installRootFull -Destination $releaseTree
  New-Item -ItemType Directory -Path (Join-Path $installRootFull 'server') -Force | Out-Null
  Write-SourceLauncher (Join-Path $installRootFull 'server\start-hidden.vbs')

  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $state = [ordered]@{
    enabledAt = (Get-Date).ToString('o')
    repoRoot = $repoRoot
    installRoot = $installRootFull
    releaseTree = $releaseTree
    taskName = $TaskName
  }
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} catch {
  $failure = $_
  if (Test-Path -LiteralPath $releaseTree) {
    if (Test-Path -LiteralPath $installRootFull) {
      Remove-Item -LiteralPath $installRootFull -Recurse -Force
    }
    Move-Item -LiteralPath $releaseTree -Destination $installRootFull
  } elseif (Test-Path -LiteralPath $savedRunner) {
    Copy-Item -LiteralPath $savedRunner -Destination $installedRunner -Force
  } elseif (Test-Path -LiteralPath $installRootFull) {
    Remove-Item -LiteralPath $installRootFull -Recurse -Force
  }
  try { Start-XenonTask } catch { }
  throw "Source-mode switch failed and the release backend was restored: $failure"
}

Write-Host "Source backend enabled: $repoRoot"
Write-Host "Release backup: $releaseTree"
Write-Host "Restore command: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode Restore"
