param(
    [Parameter(Mandatory=$true)][string]$Candidate,
    [Parameter(Mandatory=$true)][string]$Probe,
    [Parameter(Mandatory=$true)][string]$SoundVolumeView,
    [int]$IdleSeconds = 32
)
$ErrorActionPreference = 'Stop'

function Start-AudioProcess([string]$File, [string]$Arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $File; $info.Arguments = $Arguments
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $null = $process.Handle # retain CPU accounting after exit
    return $process
}
function Invoke-Legacy([string]$Arguments) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-AudioProcess $SoundVolumeView $Arguments
    try {
        if (-not $process.WaitForExit(6000)) { $process.Kill(); throw 'SoundVolumeView timed out' }
        $watch.Stop()
        if ($process.ExitCode -ne 0) { throw 'SoundVolumeView failed' }
        return @{ wallMs = $watch.Elapsed.TotalMilliseconds; cpuMs = $process.TotalProcessorTime.TotalMilliseconds }
    } finally { $process.Dispose() }
}
$script:reader = $null; $script:lastRows = @(); $script:events = 0; $script:sequence = 0
function Read-AudioMessage([int]$Timeout = 5000) {
    if (-not $script:reader) { $script:reader = $native.StandardOutput.ReadLineAsync() }
    if (-not $script:reader.Wait($Timeout)) { throw 'Native event/response timeout' }
    $line = $script:reader.Result; $script:reader = $null
    if (-not $line) { throw ('Native host exited: ' + $native.StandardError.ReadToEnd()) }
    $message = $line | ConvertFrom-Json
    if ($message.event -eq 'unavailable') { throw $message.error }
    if ($message.event -eq 'audio') { $script:lastRows = $message.rows; $script:events++ }
    return $message
}
function Request-Audio([string]$Action, [string[]]$Arguments = @()) {
    $script:sequence++; $id = $script:sequence
    $native.StandardInput.WriteLine((@{ id = $id; action = $Action; args = $Arguments } | ConvertTo-Json -Compress))
    do { $message = Read-AudioMessage } while ($message.id -ne $id)
    if (-not $message.ok) { throw $message.error }
    return $message
}
function Wait-Probe([bool]$Present) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        $null = Read-AudioMessage
        $found = @($script:lastRows | Where-Object { $_[19] -like '*xenon-audio-probe*' -and $_[7] -eq 'Active' }).Count -gt 0
        if ($found -eq $Present) { return }
    } while ($watch.Elapsed.TotalSeconds -lt 8)
    throw "Probe presence did not become $Present"
}
function Verify-Probe([int]$Level) {
    $snapshot = Request-Audio 'snapshot'
    $row = @($snapshot.rows | Where-Object { $_[19] -like '*xenon-audio-probe*' -and $_[7] -eq 'Active' })[0]
    if (-not $row -or [int]$row[10] -ne $Level) { throw 'Volume readback mismatch' }
}
$native = $null; $probeProcess = $null
$csv = Join-Path ([IO.Path]::GetTempPath()) ('xenon-audio-bench-' + [Guid]::NewGuid().ToString('N') + '.csv')
$report = @{ idleSeconds = $IdleSeconds; legacy = @{}; native = @{} }
try {
    $startup = [Diagnostics.Stopwatch]::StartNew()
    $native = Start-AudioProcess $Candidate 'audio-control-serve'
    $null = Read-AudioMessage
    $report.native.startupMs = $startup.Elapsed.TotalMilliseconds
    $native.Refresh(); $report.native.startupCpuMs = $native.TotalProcessorTime.TotalMilliseconds
    Write-Output 'Measuring events and writes with a silent test stream...'
    $open = [Diagnostics.Stopwatch]::StartNew()
    $probeProcess = Start-AudioProcess $Probe ''
    $ready = $probeProcess.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(5000) -or $ready.Result -ne 'ready') { throw 'Silent probe failed' }
    Wait-Probe $true
    $report.native.appOpenMsIncludingProbeStartup = $open.Elapsed.TotalMilliseconds
    $legacyWrites = @(); $nativeWrites = @()
    foreach ($level in @(20, 40, 60, 80, 35, 55, 75, 25, 45, 65)) {
        $a = Invoke-Legacy ('/SetVolume xenon-audio-probe.exe ' + $level)
        $b = Invoke-Legacy '/Unmute xenon-audio-probe.exe'
        $legacyWrites += @{ wallMs = $a.wallMs + $b.wallMs; cpuMs = $a.cpuMs + $b.cpuMs }
        Verify-Probe $level
    }
    $native.Refresh(); $writeCpuBefore = $native.TotalProcessorTime.TotalMilliseconds
    foreach ($level in @(20, 40, 60, 80, 35, 55, 75, 25, 45, 65)) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $null = Request-Audio 'command' @('/SetVolume', 'xenon-audio-probe.exe', [string]$level)
        $null = Request-Audio 'command' @('/Unmute', 'xenon-audio-probe.exe')
        $watch.Stop(); $nativeWrites += $watch.Elapsed.TotalMilliseconds
        Verify-Probe $level
    }
    $native.Refresh()
    $report.native.tenWritesCpuMsIncludingVerification = $native.TotalProcessorTime.TotalMilliseconds - $writeCpuBefore
    $report.native.writeMs = $nativeWrites
    $report.legacy.writeMs = @($legacyWrites | ForEach-Object { $_.wallMs })
    $report.legacy.tenWritesCpuMs = ($legacyWrites | ForEach-Object { $_.cpuMs } | Measure-Object -Sum).Sum
    foreach ($pair in @(@('/Mute', 'Yes'), @('/Unmute', 'No'))) {
        $null = Request-Audio 'command' @($pair[0], 'xenon-audio-probe.exe')
        $snapshot = Request-Audio 'snapshot'
        $row = @($snapshot.rows | Where-Object { $_[19] -like '*xenon-audio-probe*' -and $_[7] -eq 'Active' })[0]
        if ($row[8] -ne $pair[1]) { throw 'Mute readback mismatch' }
    }
    $report.native.muteVerified = $true
    $null = Request-Audio 'snapshot'
    $close = [Diagnostics.Stopwatch]::StartNew()
    $probeProcess.StandardInput.WriteLine('exit')
    Wait-Probe $false
    $report.native.appCloseMs = $close.Elapsed.TotalMilliseconds
    if (-not $probeProcess.WaitForExit(3000)) { throw 'Probe failed to close' }
    Write-Output "Measuring native idle CPU for $IdleSeconds seconds..."
    Start-Sleep -Milliseconds 500
    $null = Request-Audio 'snapshot'
    $native.Refresh(); $idleBefore = $native.TotalProcessorTime.TotalMilliseconds; $idleEvents = $script:events
    Start-Sleep -Seconds $IdleSeconds
    $null = Request-Audio 'snapshot'
    $native.Refresh()
    $report.native.idleCpuMs = $native.TotalProcessorTime.TotalMilliseconds - $idleBefore
    $report.native.idleEvents = $script:events - $idleEvents
    $report.native.workingSetMB = $native.WorkingSet64 / 1MB
    Write-Output "Measuring legacy 8-second cadence for $IdleSeconds seconds..."
    $baseline = [Diagnostics.Stopwatch]::StartNew(); $pollCpu = 0.0; $polls = 0
    for ($second = 0; $second -lt $IdleSeconds; $second += 8) {
        $wait = $second * 1000 - $baseline.Elapsed.TotalMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
        $sample = Invoke-Legacy ('/scomma "' + $csv + '" /AvoidPrompts')
        $pollCpu += $sample.cpuMs; $polls++
    }
    $wait = $IdleSeconds * 1000 - $baseline.Elapsed.TotalMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
    $report.legacy.idleCpuMs = $pollCpu; $report.legacy.polls = $polls
    $report.notes = 'Native idle includes boundary snapshots. Legacy CPU sums exited SVV processes. Legacy write latency excludes the former 120ms UI debounce. Tests change only the silent probe. Node/server CPU measured separately.'
    $report | ConvertTo-Json -Depth 6
} finally {
    if ($probeProcess) { if (-not $probeProcess.HasExited) { $probeProcess.StandardInput.Close(); if (-not $probeProcess.WaitForExit(2000)) { $probeProcess.Kill() } }; $probeProcess.Dispose() }
    if ($native) { if (-not $native.HasExited) { $native.StandardInput.Close(); if (-not $native.WaitForExit(2000)) { $native.Kill() } }; $native.Dispose() }
    if (Test-Path -LiteralPath $csv) { Remove-Item -LiteralPath $csv }
}
