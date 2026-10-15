# Hosting a Dauntless Reforged Revival server

The server runs on **one Windows 10 or 11 PC** (x64) that also has Dauntless 1.14.7: the
Director starts the game servers (Ramsgate, the Training Grounds and the hunts) from the same game
build the players use. You can play on that PC too.

Two kinds of server, as in Dauntless Revived:

| | Private | Public |
|---|---|---|
| Who can join | people you share your PC with on [Tailscale](https://tailscale.com) | anyone with an invite |
| Invite | `v=1`, your Tailscale IP, port 61000 | `v=2`, your public IP or name, port 443, the certificate fingerprint |
| Network | nothing to open on your router | TCP 443 and UDP 8770-8777 forwarded to the PC |
| Encryption | Tailscale | TLS pinned to your self-signed certificate |
| Game ports | open to your tailnet | opened per player who logged in (firewall allowlist) |

Start private: it needs no router changes and nothing is exposed to the internet.

## What you need

- Windows 10/11 x64, about 20 GB free for the game plus a few GB for the tools.
- Dauntless 1.14.7, installed as in [players.md](players.md#1-install-dauntless-1147).
- [Node.js](https://nodejs.org) 20.19 or newer, [Git](https://git-scm.com).
- [MongoDB Community Server](https://www.mongodb.com/try/download/community) 7 or newer. The host kit
  starts it itself, as a one-member replica set: in the installer, untick **Install MongoD as a
  Service** (an installed service holds port 27017; stop it with `Stop-Service MongoDB` and
  `Set-Service MongoDB -StartupType Disabled` as administrator).
- To build the runtime: [Visual Studio](https://visualstudio.microsoft.com/downloads/) 2022 or newer
  with the **Desktop development with C++** workload, and [Rust](https://www.rust-lang.org/tools/install).
- [Dumper-7](https://github.com/Encryqed/Dumper-7), built from source (to generate the SDK).
- Private mode: [Tailscale](https://tailscale.com/download) on this PC.
- The Dauntless Reforged Revival Launcher, for its Host tools page (optional but easier).

## 1. Get the project

```powershell
git clone https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival D:\Reforged
cd D:\Reforged\ReforgedHost
npm install
```

## 2. Set up the server

Private (finds your Tailscale IP itself):

```powershell
npm run setup -- --mode private --name "Friday Hunts" --game "D:\Games\Dauntless"
```

Public:

```powershell
npm run setup -- --mode public --host 203.0.113.7 --name "Friday Hunts" --game "D:\Games\Dauntless"
# with a DNS name, also say which public IPv4 the game servers announce:
npm run setup -- --mode public --host hunts.example.net --game-address 203.0.113.7 --name "Friday Hunts" --game "D:\Games\Dauntless"
```

Setup downloads Mystic Paradox at the pinned commit into `.workspace\Mystic-Paradox`, applies the
Reforged patches, installs and builds the services, makes the secrets and writes the
configuration in `.workspace\config\` (see [ReforgedHost/README.md](../ReforgedHost/README.md)).
In public mode it also makes the gateway certificate and prints its fingerprint.

Then, once, in PowerShell **as administrator**, add the firewall rules it wrote:

```powershell
powershell -ExecutionPolicy Bypass -File D:\Reforged\.workspace\config\firewall.ps1
```

Public mode: forward **TCP 443** and **UDP 8770-8777** on your router to this PC. Ports 61000-61005
and MongoDB stay on loopback and must never be forwarded.

## 3. The SDK, the runtime and the game data

These come from your own game and are never shared. Follow
[sdk-and-game-data.md](sdk-and-game-data.md). The short version, with the launcher's Host tools
page (Settings > Launcher > Advanced > Host tools), choosing `D:\Reforged` as the workspace:

1. Dump the SDK with Dumper-7, then **Import SDK**.
2. **Build** MysticParadox.dll, winmm.dll and CatalogExporter.dll.
3. Game data: **Use example data** for a first start-up test only; for a playable server, play on
   your own server, inject CatalogExporter, copy the export, then `npm run gamedata`. Save the result
   with `npm run gamedata -- --export`; on your next setup, `npm run gamedata -- --import <pack>`
   (or **Import game data pack**) replaces this step. When the project carries a server preset
   (`preset/`, `npm run preset -- --create`), `npm run setup` already fills the game data from it.
4. `npm run publish-runtime`: the runtime for players, and next to the server's game executable.

## 4. Start it

```powershell
npm run start          # public mode: in a terminal opened as administrator
```

It starts MongoDB (and initiates its replica set the first time), the backend, the Director (which
starts Ramsgate and the Training Grounds), the content server, the allowlist helper (public) and the
gateway, and restarts any that stop. Logs are in `.workspace\logs\`. **Ctrl+C** stops everything,
the game servers included. `npm run doctor` checks every part and tells you what is missing.

## 5. Invite your friends

In a second terminal:

```powershell
npm run invite -- --for "Alex"
```

Send the whole line it prints, one invite per friend (each code works once; `--uses 5` or
`--unlimited` for more). Private server: also share this PC with them in Tailscale
(<https://login.tailscale.com/admin/machines> > your PC > Share), and they accept the share. With
`npm run setup -- --share <share link>` the link goes into every invite and the launcher shows a
button for it.

## Running it

- **Bans**: from this PC only, `POST http://127.0.0.1:61000/reforged/api/SetAccountStatus` with the
  header `x-reforged-admin-key` (from `.workspace\config\secrets.env`) and
  `{"Username": "...", "Status": "banned", "Reason": "..."}` (`active` lifts it). The player sees
  the reason in the launcher.
- **Registration**: `--registration OPEN` lets anyone who can reach the server register without a
  code; `NONE` closes registration.
- **News and art**: `.workspace\config\news.json` (`{"items": [{"date", "title", "body"}]}`) and
  images in `.workspace\branding\` show in the launcher; see [ReforgedContent/README.md](../ReforgedContent/README.md).
- **Backups**: back up MongoDB (`mongodump`), and keep `.workspace\config\` (secrets) and
  `.workspace\tls\` (public: the certificate) safe and private.
- **Updating**: `git pull` in `D:\Reforged`, then `npm run setup` (keeps your SDK, game data and
  secrets), rebuild the runtime if the patches or the upstream pin changed, and `npm run publish-runtime`.
  Players are asked to accept a new runtime.
- **A new certificate** (public) changes the fingerprint: send new invites. Players keep their
  accounts; the launcher asks them to confirm the new certificate first.

## Known limits

- First version: the server side was tested end to end, but not yet with the real 1.14.7 client
  and real game servers. Expect to look at logs on the first evenings.
- Lady Luck's Store and the platinum store's rank skips, passes and captured prices come from captures
  of the live store service, which `npm run gamedata` downloads (see
  [sdk-and-game-data.md](sdk-and-game-data.md#the-store-captures)). Without them, Lady Luck has no
  offers and the platinum store only reconstructed ones.
- The progression config is built from the game's own progression tables (see
  [sdk-and-game-data.md](sdk-and-game-data.md#the-progression-config)); the Hunt Pass has ranks but
  no rewards.
- A 1.14.7 hub (Ramsgate, the Training Grounds) never asks for the progression config on its own,
  and every player then drops after a minute ("Loading PlayerData Failed" in its log). `npm run start`
  therefore creates `CALL_HUNTPASS_QUERY.flag` beside the game executable, one of Mystic Paradox's
  runtime switches: it makes the hub query the Hunt Pass season, which fetches the config. It acts on
  game servers only, not on your own game client. Delete the file to turn it off.
- One PC for everything: the services, the database and the game servers. Each hunt is a whole game
  process (about 1 GB of RAM); `--max-hunts` caps them (default 3).
- Windows only for the server and the launcher, like the game and the runtime.

## Ports

| Port | What | Reachable from |
|---|---|---|
| 443/TCP (public) or 61000/TCP on the Tailscale IP (private) | gateway | players |
| 8770-8775/UDP | hunts | players (public mode: only after they logged in) |
| 8776/UDP | Training Grounds | players (public mode: only after they logged in) |
| 8777/UDP | Ramsgate | players (public mode: only after they logged in) |
| 61000/TCP on 127.0.0.1 | backend | this PC |
| 61001/TCP | Director | this PC |
| 61002/TCP | content server | this PC |
| 61005/TCP | allowlist helper (public) | this PC |
| 27017/TCP | MongoDB | this PC |
| 61100/TCP | the launcher's relay | the PC running the launcher |
