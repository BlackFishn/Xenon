param([string]$verb, [string]$value)
# Allowlisted Windows power-plan + process-stats helper for Performance Mode.
#   get               -> { ok, guid }   active power scheme GUID
#   list              -> { ok, guid, plans }  every installed scheme + active flag
#   set high|ultimate -> { ok, guid }   switch to a known high-performance plan
#   set <guid>        -> { ok, guid }   restore a previously-saved plan by GUID
#   stats             -> { ok, totalMB, freeMB, apps }  per-process RAM + CPU%
# Only these verbs/values are accepted; everything else is rejected. Switching
# power plans is fully reversible - the caller saves the prior GUID and restores
# it on exit. We never create, delete, or tweak individual plan settings here.
# `stats` and `list` are read-only: they feed the optimization sheet / AI planner
# and the power-plan picker with real data instead of guesses.
$ErrorActionPreference = 'Stop'

# Native commands (powercfg) must speak UTF-8 like the rest of the app, or a
# localized plan name comes back mojibake through the UTF-8 stdout pipe.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# Well-known scheme GUIDs shipped with Windows.
$HIGH     = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'  # High performance
$ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61'  # Ultimate performance (may be absent)

function Get-ActiveGuid {
  $out = powercfg /getactivescheme 2>$null
  if ($out -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
    return $Matches[1].ToLower()
  }
  return ''
}

try {
  switch ($verb) {
    'get' {
      $g = Get-ActiveGuid
      if (-not $g) { throw 'could not read active scheme' }
      Write-Output ('{"ok":true,"guid":"' + $g + '"}')
    }
    'list' {
      # Every visible scheme, with the active one flagged. `powercfg /list` lines
      # look like: Power Scheme GUID: <guid>  (<name>) [*]. The header text is
      # localized, so key off the GUID + trailing asterisk instead of the words.
      $plans = @()
      $active = ''
      foreach ($line in @(powercfg /list 2>$null)) {
        if ($line -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
          $guid = $Matches[1].ToLower()
          $name = ''
          if ($line -match '\(([^)]+)\)') { $name = $Matches[1].Trim() }
          $isActive = $line.TrimEnd().EndsWith('*')
          if ($isActive) { $active = $guid }
          $plans += [pscustomobject]@{ guid = $guid; name = $name; active = $isActive }
        }
      }
      if (-not $plans.Count) { throw 'could not read power schemes' }
      @{ ok = $true; guid = $active; plans = @($plans) } | ConvertTo-Json -Depth 3 -Compress
    }
    'set' {
      $target = ''
      switch ($value) {
        'high'     { $target = $HIGH }
        'ultimate' { $target = $ULTIMATE }
        default {
          if ($value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            $target = $value.ToLower()
          } else {
            Write-Output '{"ok":false,"error":"bad_value"}'; exit
          }
        }
      }
      # Ultimate performance is hidden on many SKUs; surface it before activating.
      if ($value -eq 'ultimate') { powercfg /duplicatescheme $ULTIMATE 2>$null | Out-Null }
      powercfg /setactive $target 2>&1 | Out-Null
      $now = Get-ActiveGuid
      if ($now -ne $target) { throw 'scheme not applied' }
      Write-Output ('{"ok":true,"guid":"' + $now + '"}')
    }
    'stats' {
      # System memory pressure + the top processes by RAM, with a CPU% estimate
      # from two TotalProcessorTime samples ~350ms apart. Aggregated per process
      # name (one row per app, like the optimization sheet shows them).
      $os = Get-CimInstance Win32_OperatingSystem
      $totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
      $freeMB  = [math]::Round($os.FreePhysicalMemory / 1024)
      $cores   = [Environment]::ProcessorCount

      $t0 = @{}
      foreach ($p in (Get-Process | Where-Object { $_.Id -gt 4 })) {
        try { $t0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {}
      }
      Start-Sleep -Milliseconds 350

      $apps = @()
      $groups = Get-Process | Where-Object { $_.Id -gt 4 } | Group-Object -Property ProcessName
      foreach ($g in $groups) {
        $mem = [long]0; $cpuMs = [double]0
        foreach ($p in $g.Group) {
          $mem += $p.WorkingSet64
          try {
            if ($t0.ContainsKey($p.Id)) {
              # 0.0, not 0: an integer literal binds [math]::Max(int,int) and rounds
            # the double on the way in, so every per-process delta was truncated to
            # a whole millisecond before being summed over a 350ms window.
            $cpuMs += [math]::Max(0.0, $p.TotalProcessorTime.TotalMilliseconds - $t0[$p.Id])
            }
          } catch {}
        }
        $apps += [pscustomobject]@{
          proc   = $g.Name.ToLower()
          memMB  = [math]::Round($mem / 1MB)
          cpuPct = [math]::Round(($cpuMs / 350.0) * 100.0 / [math]::Max(1, $cores), 1)
        }
      }
      $apps = @($apps | Sort-Object memMB -Descending | Select-Object -First 40)
      @{ ok = $true; totalMB = $totalMB; freeMB = $freeMB; apps = $apps } | ConvertTo-Json -Depth 3 -Compress
    }
    default {
      Write-Output '{"ok":false,"error":"bad_verb"}'
    }
  }
} catch {
  $msg = ($_.Exception.Message -replace '\\', '\\' -replace '"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
}
