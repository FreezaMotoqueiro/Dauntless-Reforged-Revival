<#
.SYNOPSIS
    Installs (or removes) the optional DLSS / FSR upscaler for the Dauntless 1.14.7 client.

.DESCRIPTION
    The upscaler is the Luma Framework's Unreal Engine mod (https://github.com/Filoppi/Luma-Framework),
    a ReShade add-on that replaces the game's TAA pass with DLSS 4 or FSR 3.1. See docs/upscaling.md.

    Luma's package ships ReShade as dxgi.dll. This script installs it as ReShade64.dll instead: Windows
    never loads that name on its own, and the Reforged runtime (patch 0041) loads it on the player client
    only. Game servers started from the same folder never load it, and the runtime's own proxy (winmm.dll)
    is never touched.

    Every installed file is listed in reforged-upscaler.json beside the game executable, so -Uninstall
    removes exactly those files. A file that already exists and was not installed by this script is
    never overwritten.

.PARAMETER GameDir
    The Dauntless folder (the one that holds Archon\), or its Archon\Binaries\Win64 folder.

.PARAMETER ZipPath
    A Luma-Unreal_Engine.zip already downloaded. Without it the latest release is downloaded from GitHub.

.PARAMETER Uninstall
    Removes the files this script installed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File Install-Upscaler.ps1 -GameDir C:\Dauntless
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File Install-Upscaler.ps1 -GameDir C:\Dauntless -Uninstall
#>
param(
    [Parameter(Mandatory = $true)][string]$GameDir,
    [string]$ZipPath = "",
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Repo = 'Filoppi/Luma-Framework'
$AssetPattern = '^Luma-Unreal_Engine\.zip$'
$ManifestName = 'reforged-upscaler.json'
$ExeName = 'Dauntless-Win64-Shipping.exe'
$Sep = [string][IO.Path]::DirectorySeparatorChar

function Resolve-Win64([string]$dir) {
    $full = [IO.Path]::GetFullPath($dir)
    foreach ($candidate in @($full, (Join-Path $full 'Archon\Binaries\Win64'), (Join-Path $full 'Binaries\Win64'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate $ExeName)) { return $candidate }
    }
    throw "$ExeName not found under '$dir'. Pass the Dauntless folder (the one that holds Archon\)."
}

$win64 = Resolve-Win64 $GameDir
$manifestPath = Join-Path $win64 $ManifestName

if (Get-Process -Name 'Dauntless-Win64-Shipping' -ErrorAction SilentlyContinue) {
    throw 'Dauntless is running. Close the game (and any game server using this folder) first.'
}

if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Host 'The upscaler is not installed here (no reforged-upscaler.json).'; exit 0 }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $dirs = New-Object System.Collections.Generic.List[string]
    foreach ($rel in $manifest.files) {
        $target = [IO.Path]::GetFullPath((Join-Path $win64 $rel))
        if (-not $target.StartsWith($win64 + $Sep, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
        $dirs.Add((Split-Path $target -Parent))
    }
    # Empty folders the package created (deepest first), never Win64 itself.
    foreach ($d in ($dirs | Sort-Object -Property Length -Descending -Unique)) {
        while ($d.Length -gt $win64.Length -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
            Remove-Item -LiteralPath $d -Force
            $d = Split-Path $d -Parent
        }
    }
    foreach ($extra in @('ReShade.ini', 'ReShade.log', 'ReShade64.log')) {
        $p = Join-Path $win64 $extra
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    Remove-Item -LiteralPath $manifestPath -Force
    Write-Host "Upscaler removed from $win64."
    exit 0
}

$work = Join-Path $env:TEMP ('reforged-upscaler-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $source = 'local zip'
    if ([string]::IsNullOrEmpty($ZipPath)) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $headers = @{ 'User-Agent' = 'Dauntless-Reforged-Revival' }
        $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases/latest"
        $asset = $release.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
        if (-not $asset) { throw "The latest Luma release ($($release.tag_name)) has no Luma-Unreal_Engine.zip. Download it by hand and pass -ZipPath." }
        $ZipPath = Join-Path $work $asset.name
        Write-Host "Downloading $($asset.name) from $($release.tag_name)..."
        Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $ZipPath -UseBasicParsing
        $source = "$Repo $($release.tag_name)"
    }
    # Paths come from the zip's own entry names, never from folder paths: %TEMP% can be a short 8.3 path
    # (C:\Users\ADMINI~1\...) while a folder listing returns long names, which once cut every relative path wrong.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $plan = @()
        foreach ($entry in $zip.Entries) {
            if ([string]::IsNullOrEmpty($entry.Name)) { continue }   # a folder entry
            $rel = $entry.FullName.Replace('/', $Sep)
            if ([IO.Path]::IsPathRooted($rel) -or ($rel.Split($Sep) | Where-Object { $_ -eq '..' })) { throw "Unsafe path in the package: $($entry.FullName)" }
            if ($rel -ieq 'dxgi.dll') { $rel = 'ReShade64.dll' }   # never a proxy: the runtime loads it on the client only
            $plan += [pscustomobject]@{ Entry = $entry; Rel = $rel }
        }
        if (-not ($plan | Where-Object { $_.Rel -ieq 'ReShade64.dll' })) { throw 'The package has no dxgi.dll (ReShade) at its root: not a Luma package.' }
        if (-not ($plan | Where-Object { $_.Rel -match '^Luma-[^\\/]*\.addon(64)?$' })) { throw 'The package has no Luma add-on at its root.' }

        $previous = @()
        if (Test-Path -LiteralPath $manifestPath) { $previous = @((Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).files) }

        foreach ($item in $plan) {
            $target = Join-Path $win64 $item.Rel
            if ((Test-Path -LiteralPath $target) -and -not ($previous -contains $item.Rel)) {
                throw "'$($item.Rel)' already exists in $win64 and was not installed by this script. Remove it first (or move it aside)."
            }
        }
        if (Test-Path -LiteralPath (Join-Path $win64 'dxgi.dll')) {
            Write-Warning 'There is a dxgi.dll in the game folder (another ReShade or mod). Remove it, or ReShade loads twice.'
        }

        # Files of an earlier install that this package no longer has (or that an earlier version of this
        # script put in the wrong place) are removed, with the folders they leave empty.
        $newRels = @($plan | ForEach-Object { $_.Rel })
        foreach ($old in $previous) {
            if ($newRels -contains $old) { continue }
            $target = [IO.Path]::GetFullPath((Join-Path $win64 $old))
            if (-not $target.StartsWith($win64 + $Sep, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
            $d = Split-Path $target -Parent
            while ($d.Length -gt $win64.Length -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) {
                Remove-Item -LiteralPath $d -Force
                $d = Split-Path $d -Parent
            }
        }

        foreach ($item in $plan) {
            $target = Join-Path $win64 $item.Rel
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($item.Entry, $target, $true)
        }
    }
    finally {
        $zip.Dispose()
    }
    # ReShade loaded under any name other than a proxy (dxgi.dll, d3d11.dll, ...) refuses to start (its DllMain
    # returns FALSE) unless ReShade.ini already exists beside the game executable. Create it once; ReShade and
    # Luma add their own settings to it later.
    $ini = Join-Path $win64 'ReShade.ini'
    if (-not (Test-Path -LiteralPath $ini)) {
        Set-Content -LiteralPath $ini -Encoding ASCII -Value @('[INSTALL]', 'Logging=1')
    }

    $manifest = [ordered]@{ source = $source; installed = (Get-Date).ToString('s'); files = @($plan | ForEach-Object { $_.Rel }) }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host ''
    Write-Host "Upscaler installed in $win64 ($source)."
    Write-Host '- It needs the Reforged runtime with patch 0041 (it loads ReShade64.dll on the client).'
    Write-Host '- Start the game from the launcher (1.5.2 or later turns temporal upsampling on).'
    Write-Host '- In game press Home: ReShade and Luma menus. Pick DLSS or FSR under Super Resolution.'
    Write-Host '- Lower the in-game resolution scale (or sg.ResolutionQuality) for more FPS: 67 = Quality, 58 = Balanced, 50 = Performance.'
    Write-Host '- DISABLE_UPSCALER.flag in this folder turns it off; -Uninstall removes it.'
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
