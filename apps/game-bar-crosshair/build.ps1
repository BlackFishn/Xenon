param([ValidateSet("Debug", "Release")][string]$Configuration = "Debug", [switch]$Register)
$ErrorActionPreference = 'Stop'
$xenonVswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$xenonVs = & $xenonVswhere -latest -products '*' -requires Microsoft.VisualStudio.ComponentGroup.UWP.BuildTools -property installationPath
if (!$xenonVs) { throw 'Install the Universal Windows Platform build prerequisites in Visual Studio Build Tools.' }
$xenonMsbuild = Join-Path $xenonVs 'MSBuild\Current\Bin\MSBuild.exe'
Add-Type -AssemblyName System.Drawing
foreach ($xenonDir in @('Assets', 'GameBar')) { New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot $xenonDir) | Out-Null }
foreach ($xenonAsset in @(@('Assets\StoreLogo.png',50,50), @('Assets\Logo.png',150,150), @('Assets\SmallLogo.png',44,44), @('Assets\SplashScreen.png',620,300), @('GameBar\icon.png',44,44))) {
    $xenonBitmap = [System.Drawing.Bitmap]::new([int]$xenonAsset[1], [int]$xenonAsset[2])
    $xenonGraphics = [System.Drawing.Graphics]::FromImage($xenonBitmap)
    $xenonBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#65F5BA'))
    try {
        $xenonGraphics.Clear([System.Drawing.Color]::Transparent)
        $xenonSpan = [int]([Math]::Min($xenonBitmap.Width, $xenonBitmap.Height) * 0.55)
        $xenonStroke = [Math]::Max(2, [int]($xenonSpan / 9))
        $xenonX = [int]($xenonBitmap.Width / 2); $xenonY = [int]($xenonBitmap.Height / 2)
        $xenonGraphics.FillRectangle($xenonBrush, [int]($xenonX-$xenonSpan/2), [int]($xenonY-$xenonStroke/2), $xenonSpan, $xenonStroke)
        $xenonGraphics.FillRectangle($xenonBrush, [int]($xenonX-$xenonStroke/2), [int]($xenonY-$xenonSpan/2), $xenonStroke, $xenonSpan)
        $xenonBitmap.Save((Join-Path $PSScriptRoot $xenonAsset[0]), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $xenonBrush.Dispose(); $xenonGraphics.Dispose(); $xenonBitmap.Dispose() }
}
& $xenonMsbuild (Join-Path $PSScriptRoot 'Xenon.Crosshair.csproj') /restore /t:Build /m:2 /nologo /v:minimal "/p:Configuration=$Configuration" /p:Platform=x64 /p:GenerateAppxPackageOnBuild=true
if ($LASTEXITCODE -ne 0) { throw ('Crosshair build failed: ' + $LASTEXITCODE) }
if ($Register) {
    $xenonPackageRoot = Join-Path $PSScriptRoot 'AppPackages'
    $xenonSuffix = if ($Configuration -eq 'Debug') { '_x64_Debug.msix' } else { '_x64.msix' }
    $xenonPackage = Get-ChildItem -LiteralPath $xenonPackageRoot -Filter '*.msix' -File -Recurse | Where-Object { $_.Name.EndsWith($xenonSuffix) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$xenonPackage) { throw 'Built MSIX package was not found.' }
    $xenonDeps = Join-Path $xenonPackage.DirectoryName 'Dependencies\x64'
    if (Test-Path -LiteralPath $xenonDeps) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        Get-ChildItem -LiteralPath $xenonDeps -Filter '*.appx' -File | ForEach-Object {
            $xenonArchive = [IO.Compression.ZipFile]::OpenRead($_.FullName)
            $xenonReader = [IO.StreamReader]::new($xenonArchive.GetEntry('AppxManifest.xml').Open())
            try { $xenonIdentity = ([xml]$xenonReader.ReadToEnd()).Package.Identity }
            finally { $xenonReader.Dispose(); $xenonArchive.Dispose() }
            $xenonInstalled = Get-AppxPackage -Name $xenonIdentity.Name | Where-Object {
                [string]$_.Architecture -ieq [string]$xenonIdentity.ProcessorArchitecture -and [version]$_.Version -ge [version]$xenonIdentity.Version
            }
            if (!$xenonInstalled) { Add-AppxPackage -Path $_.FullName }
        }
    }
    $xenonHash = (Get-FileHash -LiteralPath $xenonPackage.FullName -Algorithm SHA256).Hash.Substring(0,12).ToLowerInvariant()
    $xenonInstall = Join-Path $env:LOCALAPPDATA ('Xenon\GameBarCrosshair\' + $xenonHash)
    $xenonMakeAppx = "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.19041.0\x64\makeappx.exe"
    if (!(Test-Path -LiteralPath $xenonInstall)) {
        & $xenonMakeAppx unpack /p $xenonPackage.FullName /d $xenonInstall
        if ($LASTEXITCODE -ne 0) { throw 'Package unpack failed.' }
    }
    Add-AppxPackage -Register (Join-Path $xenonInstall 'AppxManifest.xml') -ForceApplicationShutdown
    $xenonRegistered = Get-AppxPackage -Name 'Xenon.Crosshair'
    if ($xenonRegistered.InstallLocation -ne $xenonInstall) {
        throw 'Windows retained an older package. Increment Package.appxmanifest Identity Version before rebuilding an update.'
    }
    $xenonRegistered | Select-Object Name,PackageFamilyName,Version,Status
}
