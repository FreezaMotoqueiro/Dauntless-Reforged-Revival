# Hosting on a Linux server (Debian 13)

A public Dauntless Reforged Revival server on a Linux VPS, for example a Hostinger KVM VPS with
Debian 13. Nothing to install on players' PCs beyond the usual launcher: they join with an invite as
for any public server ([players.md](players.md)).

> [!WARNING]
> **Experimental.** The Linux port is adapted from
> [Dauntless Revived's Linux port](https://github.com/mixutin/dauntless-revived/tree/main/deploy/linux-server).
> What was tested on Linux: the services, the real Director starting Ramsgate and the Training
> Grounds through the Wine launcher and stopping them cleanly, a Windows GUI program run the way a
> game server is run (Mystic Paradox's `winmm.dll` loaded, the arguments, the environment and the
> readiness line all coming through Wine), and the nftables allowlist changing a real firewall.
> **The real Dauntless 1.14.7 has not yet been run under Wine.** Expect to read logs on the first
> evenings, and report what you find.

## The quick way: one command from your Windows PC

Steps 2 to 7 below, done for you from the Windows PC that has your game, with the SSH client that comes
with Windows. You need the VPS's public IPv4 address and its `root` password (Hostinger: hPanel > VPS >
Overview), and step 1 (the provider's firewall) done.

1. Download [`Deploy-FromWindows.ps1`](../ReforgedHost/linux/Deploy-FromWindows.ps1) (on GitHub:
   **Download raw file**), for example into `Downloads`.
2. In PowerShell:

   ```powershell
   cd $HOME\Downloads
   powershell -ExecutionPolicy Bypass -File .\Deploy-FromWindows.ps1 -Server <VPS IPv4> -Name "Friday Hunts" -Game C:\Dauntless
   ```

It checks that `C:\Dauntless` is Dauntless 1.14.7 (the folder with `Archon` inside, or the folder
holding it), asks the VPS password once (it adds an SSH key for this PC), installs everything on the
VPS with [`setup-vps.sh`](../ReforgedHost/linux/setup-vps.sh), sends the game (about 15 GB: keep the
window open; a second run skips it when the VPS already has the same files), sends the runtime and the
newest game data pack when this PC has a Reforged project (`C:\Reforged`, or `-Runtime <folder>` and
`-GameData <pack>`), starts the server and prints your first invite. Run it again whenever you like:
every step keeps what is already done.

**A Hostinger Game Panel plan** (or any VPS with a web panel) already serves its panel on port 443.
Give the server another port with `-PublicPort 4443` (and allow TCP 4443 instead of 443 in the
firewall): it goes into the invites, and the launcher connects to it. Without it, players' launchers
reach the panel and refuse its certificate ("the security certificate does not match").

Without a runtime yet, players can join but not play: send it later with
`-Runtime <folder> -SkipGame` (step 6 says where it comes from).

On the VPS itself, without Windows: as root, `sh setup-vps.sh --name "Friday Hunts"` (the script is
in `ReforgedHost/linux/`), copy the game to `/home/reforged/games/Dauntless`, then
`sh /home/reforged/Reforged/ReforgedHost/linux/setup-vps.sh --finish [--runtime <folder>] [--gamedata <pack>]`.

The rest of this page is the same thing by hand, and what to do when something goes wrong.

## How it differs from a Windows server

The services (backend, Director, content server, gateway, MongoDB) run natively. The game servers
are still `Dauntless-Win64-Shipping.exe`, a Windows program: the Director starts
`.workspace/bin/reforged-gameserver`, which runs it through **Wine** on a virtual display
(**Xvfb**), because the game opens a window even as a dedicated server.

| | Windows | Linux |
|---|---|---|
| Game servers | the game executable | the same executable through Wine (or Proton) on `xvfb-run` |
| Game-port allowlist | one Windows Firewall rule | one nftables table, `reforged_revival` |
| Privileges | the terminal runs as administrator | two systemd units, each with only the privilege it needs (no root) |
| Starts at boot | no (`npm run start`) | yes (systemd) |
| SDK, runtime, game data | made on this PC | made **once on a Windows PC** with your game, then copied over |

The two systemd units run as an ordinary user:

- `reforged-allowlist.service`: the allowlist helper, with `CAP_NET_ADMIN` only (it changes nftables).
- `reforged.service`: `npm run start` (MongoDB, backend, Director and its game servers, content
  server, gateway), with `CAP_NET_BIND_SERVICE` only (the gateway listens on port 443).

## What you need

- A VPS with **Debian 13** (x86-64). Each game server is a whole game process under Wine (about
  1-1.5 GB of RAM); Ramsgate and the Training Grounds always run, plus one per hunt (`--max-hunts`,
  3 by default). **16 GB of RAM** is comfortable (Hostinger KVM 4); 8 GB (KVM 2) only with
  `--max-hunts 1` or 2. About 30 GB of free disk.
- The VPS's **public IPv4 address** (Hostinger: hPanel > VPS > Overview).
- Your own **Dauntless 1.14.7** (from your Epic library, installed with Legendary: see
  [players.md](players.md#1-install-dauntless-1147)).
- **Once, a Windows PC** with your 1.14.7, to build the game runtime (`MysticParadox.dll`,
  `winmm.dll`) and the game data. They are made from your own game and are never shared; see
  [sdk-and-game-data.md](sdk-and-game-data.md).

## 1. The provider's firewall

Allow inbound **TCP 443** (the gateway) and **UDP 8770-8777** (the game servers), and keep SSH
(TCP 22). On Hostinger: the VPS's **Firewall** page in hPanel; make a rule set with those three
and activate it for the VPS. Never open 61000-61005 or 27017: they listen on 127.0.0.1 only.

The game ports stay closed to everyone who has not logged in: the allowlist's own nftables table
opens them per player, whatever the provider's firewall allows.

## 2. Packages (as root)

Sign in to the VPS over SSH (Hostinger gives you `root`), then:

```sh
apt update && apt upgrade -y
apt install -y git nodejs npm wine wine64 xvfb xauth nftables sudo curl gnupg
node --version      # 20.19 or newer
wine --version
```

**MongoDB** 7 or newer, from MongoDB's own repository. Only the server program (`mongod`) is needed:

```sh
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main" > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt update && apt install -y mongodb-org-server
systemctl disable --now mongod     # the host kit starts its own MongoDB, as a replica set
```

MongoDB names the Debian releases it supports on
[its install page](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-debian/): use
the newest one listed there (above, `bookworm`) if Debian 13 (`trixie`) is not listed yet, or is listed without `mongodb-org-server` (`apt` then says "Unable to locate package").

## 3. A user for the server

The server never runs as root (it faces the internet, and Wine refuses a folder another user
owns). Make a user, let it use `sudo` for the two install scripts, and sign in as that user:

```sh
adduser reforged
usermod -aG sudo reforged
sudo -iu reforged
```

Everything below runs as `reforged`.

## 4. Dauntless 1.14.7 on the VPS

Either copy the `Dauntless` folder from your Windows PC (about 15 GB), for example with `scp -r`
from PowerShell to `reforged@<VPS IP>:~/games/`, or install it on the VPS with
[Legendary](https://github.com/legendary-gl/legendary):

```sh
sudo apt install -y pipx && pipx install legendary-gl && export PATH="$HOME/.local/bin:$PATH"
legendary auth          # prints a link: sign in to Epic in your browser and paste the code back
legendary install Jackal --manifest "https://api.mysticfox.dev/v2/Dauntless_1.14.7.647472.manifest" --base-url "https://egs-cloudfront-chunks.epicgamescdn.com/Builds/Org/o-krlzxj88qrtb69fredeuaf887bl5az/Jackal/default" --base-path ~/games --skip-sdl
legendary verify Jackal
```

The game is then in `/home/reforged/games/Dauntless` (the folder with `Archon` inside). Never run
`legendary update Jackal`: it would turn it into 2.1.1.

## 5. Get the project and set up the server

```sh
git clone https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival ~/Reforged
cd ~/Reforged/ReforgedHost
npm install
ip -br addr             # the network interface with the public IP, usually eth0
npm run setup -- --mode public --host <VPS public IPv4> --name "Friday Hunts" --game /home/reforged/games/Dauntless --firewall-interface eth0
```

With a DNS name, add `--game-address <VPS public IPv4>` (the game servers announce an address).
Setup downloads Mystic Paradox, applies the patches, builds the services, writes the configuration
and the gateway certificate (it prints the fingerprint that goes into every invite), writes the
Wine launcher and the systemd units, and makes the Wine prefix. The server preset in `preset/` fills
most of the game data.

Linux options (each is kept in `host.json` until you change it):

| Option | What |
|---|---|
| `--firewall-interface eth0` | the allowlist filters the game ports on this interface only (`--no-firewall-interface`: on every interface but loopback) |
| `--wine /usr/bin/wine64` | a particular Wine (default: the first `wine` on `PATH`) |
| `--proton <path to proton>` | Proton or GE-Proton instead of Wine (`--no-proton` goes back) |
| `--no-xvfb` | no virtual display (only if the VPS has a real X display in `DISPLAY`) |
| `--max-hunts 1-6` | at most this many hunts at once (default 3) |
| `--public-port 4443` | the port players connect to, when 443 is taken (a Hostinger Game Panel plan serves its panel there); `--public-port 443` goes back |

## 6. The runtime and the game data, from your Windows PC

On the Windows PC with your 1.14.7, follow [hosting.md](hosting.md) up to a server that plays
(the launcher's Host tools page does most of it), then:

1. **Runtime.** After `npm run publish-runtime` there, `D:\Reforged\.workspace\runtime\` holds
   `MysticParadox.dll` and `winmm.dll`. Copy that folder to the VPS, for example
   `scp -r D:\Reforged\.workspace\runtime reforged@<VPS IP>:~/runtime`.
2. **Game data.** `npm run gamedata -- --export` there writes a game data pack
   (`.workspace\gamedata-packs\reforged-gamedata-1.14.7-<date>.json.gz`). Copy it to the VPS too.

On the VPS:

```sh
cd ~/Reforged/ReforgedHost
npm run publish-runtime -- --from ~/runtime
npm run gamedata -- --import ~/reforged-gamedata-1.14.7-<date>.json.gz
```

The pack carries what the preset cannot (Lady Luck's Store and the platinum store, built from your
CatalogExporter export). For a first start-up test without it, `npm run gamedata -- --examples`
fills the two store files with examples: the server starts, but those stores are empty.

## 7. Firewall, services, invites

```sh
sudo sh ~/Reforged/.workspace/config/firewall.sh            # opens 443 and the game ports in ufw, if ufw is active
sudo sh ~/Reforged/.workspace/config/systemd/install.sh     # installs and starts both units; they start at boot from now on
journalctl -u reforged -f                                   # the server's output (Ctrl+C leaves it running)
npm run doctor                                              # checks every part
npm run invite -- --for "Alex"                              # one invite per friend
```

The first game servers take longer than on Windows (Wine loads the game): the Director waits up to
90 seconds for each one.

## Running it

- **Stop / start / restart:** `sudo systemctl stop reforged` (every game server stops with it),
  `sudo systemctl start reforged`, `sudo systemctl restart reforged` (after changing the runtime,
  the game data or the multipliers).
- **Logs:** `journalctl -u reforged -f`, `journalctl -u reforged-allowlist -f`, and
  `~/Reforged/.workspace/logs/` (one file per service; the game servers in `gameservers/`).
- **Updating:** `npm run update`, then `sudo sh ~/Reforged/.workspace/config/systemd/install.sh`
  (it installs the units again and restarts the server). When the update says the runtime changed,
  build it again on the Windows PC and publish it with `--from`.
- **Bans, registration, news, backups:** as on Windows ([hosting.md](hosting.md#running-it)).
  Back up MongoDB with `mongodump`, and keep `.workspace/config/` and `.workspace/tls/` private.
- **The allowlist table:** `sudo nft list table inet reforged_revival` shows who can reach the
  game ports right now.

## When something goes wrong

| What you see | What to do |
|---|---|
| `do not run the server as root` | sign in as the server's user (`sudo -iu reforged`) and run it there |
| `port 443 ... needs a privilege` / `the allowlist changes the firewall` | run it through the systemd units (step 7), not `npm run start` in a terminal |
| a game server never becomes ready | its log in `.workspace/logs/gameservers/`; `.workspace/logs/wine.log`; for Wine's own messages, `sudo systemctl edit reforged` and add `Environment=WINEDEBUG=err+all`, then restart |
| `wine: ... is not owned by you` | the Wine prefix belongs to another user: `sudo chown -R reforged: ~/Reforged/.workspace/wine` |
| `xvfb-run was not found` / `Wine was not found` | `sudo apt install xvfb xauth wine wine64`, then `npm run setup` |
| players log in but cannot reach Ramsgate | UDP 8770-8777 in the provider's firewall (step 1), and `--firewall-interface` naming the right interface (`ip -br addr`) |
| the launcher says the certificate does not match | another program holds the gateway's port (a hosting panel on 443): `npm run doctor` names it; give the server another port with `npm run setup -- --public-port 4443` (or `Deploy-FromWindows.ps1 -PublicPort 4443 -SkipGame`), allow TCP 4443 in the provider's firewall, restart, and send new invites |
| `port 27017 is already taken` | MongoDB's own service: `sudo systemctl disable --now mongod` |

The Director passes the game-server key on each game server's command line, as on Windows; on a
VPS that only the server's user signs in to, nobody else can read it.

## Resumo em português

**O jeito rápido (um comando no Windows):** libere TCP 443 e UDP 8770-8777 no firewall da VPS na
Hostinger, baixe o [`Deploy-FromWindows.ps1`](../ReforgedHost/linux/Deploy-FromWindows.ps1) e rode no
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-FromWindows.ps1 -Server <IP da VPS> -Name "Seu Servidor" -Game C:\Dauntless
```

Ele confere o jogo, pede a senha do root da VPS uma vez, instala tudo, envia o jogo (cerca de 15 GB),
liga o servidor e mostra o primeiro convite. Pode rodar de novo quando quiser: o que já está feito é
mantido, e o jogo não é reenviado se já estiver lá.

**Plano Game Panel da Hostinger:** o painel já usa a porta 443. Rode o script com `-PublicPort 4443`
e libere TCP 4443 (no lugar da 443) no firewall da VPS. Sem isso, o launcher chega no painel e recusa o
certificado dele ("o certificado de segurança não confere").

**Passo a passo à mão:**

1. **Firewall da Hostinger:** libere TCP 443 e UDP 8770-8777 (e mantenha o SSH, TCP 22).
2. **Pacotes, como root:** `apt install -y git nodejs npm wine wine64 xvfb xauth nftables sudo curl gnupg`
   e o MongoDB (passo 2 acima).
3. **Usuário:** `adduser reforged`, `usermod -aG sudo reforged`, `sudo -iu reforged`. O servidor
   nunca roda como root.
4. **Jogo 1.14.7:** copie a pasta `Dauntless` do seu PC ou instale com o Legendary em `~/games`.
5. **Projeto:** `git clone` em `~/Reforged`, `cd ReforgedHost`, `npm install` e
   `npm run setup -- --mode public --host <IP da VPS> --name "Seu Servidor" --game /home/reforged/games/Dauntless --firewall-interface eth0`.
6. **No PC com Windows (uma vez):** gere o runtime e os dados do jogo, copie a pasta
   `.workspace\runtime` e o pacote de dados para a VPS, e rode
   `npm run publish-runtime -- --from ~/runtime` e `npm run gamedata -- --import <pacote>`.
7. **Ligar:** `sudo sh ~/Reforged/.workspace/config/firewall.sh` e
   `sudo sh ~/Reforged/.workspace/config/systemd/install.sh`. Depois, `npm run invite -- --for "Nome"`.

É experimental: o jogo 1.14.7 de verdade ainda não foi rodado no Wine. Se algo falhar, veja
`journalctl -u reforged -f` e `npm run doctor`.
