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
        if (-not $target.StartsWith($win64 + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
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
    $extract = Join-Path $work 'x'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $extract)

    if (-not (Test-Path -LiteralPath (Join-Path $extract 'dxgi.dll'))) { throw 'The package has no dxgi.dll (ReShade): not a Luma package.' }
    if (-not (Get-ChildItem -LiteralPath $extract -Filter 'Luma-*.addon*' -File)) { throw 'The package has no Luma add-on.' }

    $previous = @()
    if (Test-Path -LiteralPath $manifestPath) { $previous = @((Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).files) }

    # The package's files and where they go: dxgi.dll becomes ReShade64.dll, the rest keep their paths.
    $plan = @()
    foreach ($f in Get-ChildItem -LiteralPath $extract -Recurse -File) {
        $rel = $f.FullName.Substring($extract.Length + 1)
        if ($rel -ieq 'dxgi.dll') { $rel = 'ReShade64.dll' }
        $plan += [pscustomobject]@{ From = $f.FullName; Rel = $rel }
    }
    foreach ($item in $plan) {
        $target = Join-Path $win64 $item.Rel
        if ((Test-Path -LiteralPath $target) -and -not ($previous -contains $item.Rel)) {
            throw "'$($item.Rel)' already exists in $win64 and was not installed by this script. Remove it first (or move it aside)."
        }
    }
    if (Test-Path -LiteralPath (Join-Path $win64 'dxgi.dll')) {
        Write-Warning 'There is a dxgi.dll in the game folder (another ReShade or mod). Remove it, or ReShade loads twice.'
    }

    foreach ($item in $plan) {
        $target = Join-Path $win64 $item.Rel
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath $item.From -Destination $target -Force
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
