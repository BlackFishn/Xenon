param([switch]$Install)
$ErrorActionPreference = 'Stop'
$pluginName = 'com.custom.streamdock.xeneonedge.sdPlugin'
$pluginSource = Join-Path $PSScriptRoot $pluginName
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wsSource = Join-Path $PSScriptRoot '..\..\node_modules\ws'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is unavailable.' }
if (!(Test-Path -LiteralPath (Join-Path $wsSource 'LICENSE'))) { throw 'Run npm install at the Xenon repository root first.' }
$binary = Join-Path $pluginSource 'plugin\EdgePower.exe'
& $compiler /nologo /optimize+ /target:exe /platform:x64 /reference:System.Web.Extensions.dll "/out:$binary" (Join-Path $PSScriptRoot 'EdgePower.cs')
if ($LASTEXITCODE -ne 0) { throw 'EdgePower compilation failed.' }
$modules = Join-Path $pluginSource 'plugin\node_modules'
New-Item -ItemType Directory -Force -Path $modules | Out-Null
Copy-Item -LiteralPath $wsSource -Destination $modules -Recurse -Force
if ($Install) {
    $pluginRoot = Join-Path $env:APPDATA 'HotSpot\StreamDock\plugins'
    if (!(Test-Path -LiteralPath $pluginRoot)) { throw 'StreamDock plugins folder not found.' }
    $destination = Join-Path $pluginRoot $pluginName
    Copy-Item -LiteralPath $pluginSource -Destination $pluginRoot -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'EdgePower.cs') -Destination $destination -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $destination -Force
    Write-Output "Installed: $destination"
} else { Write-Output "Built: $pluginSource" }
