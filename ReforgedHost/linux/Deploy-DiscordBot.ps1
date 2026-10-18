<#
.SYNOPSIS
    Installs (or updates) a Discord bot from this Windows PC on the Linux VPS that runs the
    Dauntless Reforged Revival server, and keeps it running there (systemd).

.DESCRIPTION
    Uses the OpenSSH client and tar that come with Windows. In order:
      1. checks the bot's folder: Node.js (package.json) or Python (requirements.txt, pyproject.toml, .py)
      2. sets up an SSH key, so the VPS password is asked only once
      3. packs the folder, without node_modules, .git, virtual environments and logs
      4. sends it with setup-discord-bot.sh, which on the VPS makes a user for the bot (discordbot),
         installs its dependencies, and runs it as the systemd service reforged-discord-bot:
         restarted when it stops, started at every boot
    The bot's .env (its token) goes along. Run it again after changing the bot: it updates the files,
    keeps what the bot saved on the VPS, and restarts it.

.PARAMETER Server
    The VPS's public IPv4 address or DNS name.

.PARAMETER Bot
    The bot's folder on this PC: the one with package.json (or the Python files) inside.

.PARAMETER Start
    How to start the bot, only when it is not found on its own (npm start, package.json's main,
    index.js, bot.py, main.py...): "node dist/index.js", for example.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Deploy-DiscordBot.ps1 -Server 203.0.113.7
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$Bot = 'C:\Users\Administrator\Documents\Codex\2026-10-18\crie-um-bot-para-o-discord-11\outputs\reforged-discord-bot',
    [string]$Name = 'reforged-discord-bot',
    [string]$Start = '',
    [string]$User = 'root',
    [int]$Port = 22,
    [string]$Branch = 'main',
    [switch]$NoKey
)

$ErrorActionPreference = 'Stop'
$ScriptUrl = "https://raw.githubusercontent.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/$Branch/ReforgedHost/linux/setup-discord-bot.sh"
# Never sent: dependencies and environments are installed again on the VPS, for Linux.
$Excluded = @('node_modules', '.git', '.venv', 'venv', '__pycache__', '*.log', '.DS_Store', 'Thumbs.db')

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Stop-Deploy([string]$Text) {
    Write-Host ''
    Write-Host "Error: $Text" -ForegroundColor Red
    exit 1
}

# One word for the server's shell: single-quoted. Never a double quote in what goes to ssh (Windows
# PowerShell 5.1 does not escape those on a native command line).
function ConvertTo-ShWord([string]$Text) {
    return "'" + $Text.Replace("'", "'\''") + "'"
}

# ------------------------------------------------------------------ checks

if ($Server -notmatch '^[A-Za-z0-9.:-]{1,253}$') { Stop-Deploy "-Server must be an IP address or a DNS name (got $Server)" }
if ($User -cnotmatch '^[a-z_][a-z0-9_-]{0,31}$') { Stop-Deploy "-User must be a plain user name like root (got $User)" }
if ($Name -cnotmatch '^[a-z0-9][a-z0-9-]{0,47}$') { Stop-Deploy "-Name must be lowercase letters, digits and dashes (got $Name)" }
if ($Branch -notmatch '^[A-Za-z0-9._/-]{1,100}$') { Stop-Deploy "-Branch must be a branch name (got $Branch)" }
if ($Start -match '["\r\n]') { Stop-Deploy '-Start must be one line without double quotes' }
foreach ($Tool in @('ssh', 'scp', 'ssh-keygen')) {
    if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) {
        Stop-Deploy "$Tool was not found: turn on Windows' OpenSSH Client (Settings > System > Optional features > Add a feature > OpenSSH Client), then open a new PowerShell"
    }
}
# Windows' own tar (bsdtar). Another one first on PATH (Git's) reads C:\... as a remote host.
$Tar = $null
if ($env:SystemRoot) {
    $Candidate = [IO.Path]::Combine($env:SystemRoot, 'System32', 'tar.exe')
    if (Test-Path -LiteralPath $Candidate) { $Tar = $Candidate }
}
if (-not $Tar) {
    $Found = Get-Command tar -ErrorAction SilentlyContinue
    if (-not $Found) { Stop-Deploy 'tar was not found (Windows 10 1803 and later have it in C:\Windows\System32)' }
    $Tar = $Found.Source
}

Write-Step 'The bot'
if (-not (Test-Path -LiteralPath $Bot -PathType Container)) { Stop-Deploy "-Bot ${Bot}: no such folder" }
$BotDir = (Resolve-Path -LiteralPath $Bot).Path.TrimEnd('\')
Write-Host "folder: $BotDir"
$Has = { param([string]$Leaf) Test-Path -LiteralPath ([IO.Path]::Combine($BotDir, $Leaf)) }
if (& $Has 'package.json') {
    Write-Host 'kind: Node.js (package.json)'
} elseif ((& $Has 'requirements.txt') -or (& $Has 'pyproject.toml') -or @(Get-ChildItem -LiteralPath $BotDir -Filter '*.py' -File).Count -gt 0) {
    Write-Host 'kind: Python'
} elseif ($Start) {
    Write-Host "kind: started with -Start $Start"
} else {
    Stop-Deploy "no package.json, requirements.txt, pyproject.toml or .py file in ${BotDir}: is it the bot's folder? (or pass -Start)"
}
if (& $Has '.env') {
    Write-Host '.env: found (the token goes to the VPS with it, over SSH)'
} elseif (& $Has '.env.example') {
    Write-Host '.env: none here. The VPS keeps the one it already has; on a first install it makes one from .env.example for you to fill in.' -ForegroundColor Yellow
} else {
    Write-Host '.env: none (fine if the bot keeps its settings elsewhere)' -ForegroundColor Yellow
}

$Target = "$User@$Server"
$Sudo = ''
if ($User -ne 'root') { $Sudo = 'sudo ' }
$SshOptions = @('-p', "$Port", '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=10')
$ScpOptions = @('-P', "$Port", '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=10')

# A command on the server; stops here when it fails. -Tty for one that asks something (sudo).
function Invoke-Remote([string]$Command, [switch]$Tty) {
    $Arguments = @() + $SshOptions
    if ($Tty) { $Arguments += '-t' }
    $Arguments += @($Target, $Command)
    & ssh @Arguments
    if ($LASTEXITCODE -ne 0) { Stop-Deploy "the command on the server failed (exit $LASTEXITCODE)" }
}

# A command's output, or $null when it fails. Never asks anything.
function Get-RemoteOutput([string]$Command) {
    $Previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Out = & ssh @SshOptions -o BatchMode=yes -o ConnectTimeout=20 $Target $Command 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($Out -join "`n").Trim()
    } finally {
        $ErrorActionPreference = $Previous
    }
}

# Sends one file. From its parent folder, by name: scp could read C:\... as a host called C.
function Send-Item([string]$Source, [string]$Destination) {
    $Arguments = @() + $ScpOptions + @((Split-Path -Leaf $Source), "${Target}:$Destination")
    Push-Location -LiteralPath (Split-Path -Parent $Source)
    try { & scp @Arguments }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Stop-Deploy "sending $Source failed (exit $LASTEXITCODE)" }
}

# ------------------------------------------------------------------ can this PC reach the VPS?

Write-Step "Reaching $Server on port $Port (SSH)"
$Reached = $false
$Client = New-Object Net.Sockets.TcpClient
try {
    $Attempt = $Client.BeginConnect($Server, $Port, $null, $null)
    if ($Attempt.AsyncWaitHandle.WaitOne(15000) -and $Client.Connected) { $Reached = $true }
} catch {
    $Reached = $false
} finally {
    $Client.Close()
}
if (-not $Reached) {
    Write-Host "no answer from ${Server}:$Port within 15 seconds: the VPS firewall (hPanel > VPS > Firewall) must accept TCP $Port, and the VPS must be running." -ForegroundColor Yellow
    Stop-Deploy "cannot reach ${Server}:$Port"
}
Write-Host 'the VPS answers'

# ------------------------------------------------------------------ SSH key

if (-not $NoKey) {
    Write-Step "Signing in to $Target"
    if ($null -ne (Get-RemoteOutput 'true')) {
        Write-Host 'your SSH key works: no password needed'
    } else {
        $KeyFile = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
        if (-not (Test-Path -LiteralPath "$KeyFile.pub")) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeyFile) | Out-Null
            # One string, passed as is: an empty passphrase survives every PowerShell version.
            Start-Process -FilePath 'ssh-keygen' -ArgumentList "-q -t ed25519 -N `"`" -f `"$KeyFile`"" -NoNewWindow -Wait
            if (-not (Test-Path -LiteralPath "$KeyFile.pub")) { Stop-Deploy 'could not make an SSH key (ssh-keygen)' }
            Write-Host "made an SSH key for this PC: $KeyFile"
        }
        $Fields = (Get-Content -Raw -LiteralPath "$KeyFile.pub").Trim() -split '\s+'
        $KeyLine = ConvertTo-ShWord ("{0} {1}" -f $Fields[0], $Fields[1])
        Write-Host "type the VPS password for $User once, to add this PC's key:"
        Invoke-Remote "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF $KeyLine ~/.ssh/authorized_keys || echo $KeyLine >> ~/.ssh/authorized_keys"
        if ($null -eq (Get-RemoteOutput 'true')) { Write-Host 'the key did not work: you will be asked for the password at each step' -ForegroundColor Yellow }
        else { Write-Host 'key added: no more passwords' }
    }
}

# ------------------------------------------------------------------ pack, send, install

Write-Step 'Packing the bot'
$Work = [IO.Path]::Combine($env:TEMP, 'reforged-discord-bot-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Upload = 'discord-bot-upload'
try {
    $Archive = [IO.Path]::Combine($Work, 'bot.tar.gz')
    $TarArguments = @('-czf', 'bot.tar.gz')
    foreach ($Pattern in $Excluded) { $TarArguments += "--exclude=$Pattern" }
    $TarArguments += @('-C', (Split-Path -Parent $BotDir), (Split-Path -Leaf $BotDir))
    # The archive by a relative name, from its own folder.
    Push-Location -LiteralPath $Work
    try { & $Tar @TarArguments }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Archive)) { Stop-Deploy "tar could not pack $BotDir (exit $LASTEXITCODE)" }
    $Size = (Get-Item -LiteralPath $Archive).Length
    Write-Host ("{0:N1} MB (without {1})" -f ($Size / 1MB), ($Excluded -join ', '))
    if ($Size -gt 200MB) { Write-Host 'that is large for a bot: is something big in its folder (videos, backups, a dist of another project)?' -ForegroundColor Yellow }

    $Script = [IO.Path]::Combine($Work, 'setup-discord-bot.sh')
    $Local = Join-Path $PSScriptRoot 'setup-discord-bot.sh'
    if (Test-Path -LiteralPath $Local) {
        $Text = [IO.File]::ReadAllText($Local)
    } else {
        Write-Host "downloading $ScriptUrl"
        $Text = (Invoke-WebRequest -UseBasicParsing -Uri $ScriptUrl).Content
    }
    # LF only: a CRLF checkout would break the shell script.
    [IO.File]::WriteAllText($Script, $Text.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))

    Write-Step "Sending it to $Server"
    Invoke-Remote "umask 077; rm -rf ~/$Upload; mkdir -p ~/$Upload"
    Send-Item $Archive "$Upload/bot.tar.gz"
    Send-Item $Script "$Upload/setup-discord-bot.sh"
} finally {
    # The archive holds the bot's token: not left in TEMP.
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step 'Installing it on the VPS'
$Options = "--archive ~/$Upload/bot.tar.gz --name $(ConvertTo-ShWord $Name)"
if ($Start) { $Options += " --start $(ConvertTo-ShWord $Start)" }
$Previous = $ErrorActionPreference
try {
    Invoke-Remote "${Sudo}sh ~/$Upload/setup-discord-bot.sh $Options" -Tty
} finally {
    $ErrorActionPreference = 'Continue'
    & ssh @SshOptions $Target "rm -rf ~/$Upload" 2>$null | Out-Null
    $ErrorActionPreference = $Previous
}

Write-Step 'Done'
Write-Host "The bot runs on the VPS as the service $Name. There (as root):"
Write-Host "  journalctl -u $Name -f        its log, live (Ctrl+C leaves)"
Write-Host "  systemctl restart $Name       restart it"
Write-Host "  systemctl stop $Name          stop it"
Write-Host 'After changing the bot on this PC, run this script again.'
