# Playing on a Dauntless Reforged Revival server

You need three things: **Dauntless 1.14.7** on your Windows PC, the **Dauntless Reforged Revival
Launcher**, and an **invite** from the server's host. The launcher can be switched between English
and Português (Brasil) at the bottom of its left rail.

## 1. Install Dauntless 1.14.7

The launcher never downloads the game: it uses your own copy. Today Epic serves only the last
version of Dauntless (2.1.1), so 1.14.7 is installed with [Legendary](https://github.com/legendary-gl/legendary)
and the 1.14.7 *manifest*. This only works if Dauntless is in your Epic library (added before the
game left the store in May 2025).

The full guide, with every check and fix, is Mystic Paradox's
[Installing Dauntless 1.14.7](https://github.com/pranav158/Mystic-Paradox/blob/main/docs/INSTALLING_DAUNTLESS.md).
In short, in PowerShell in the folder with `legendary.exe`:

```powershell
.\legendary.exe auth
.\legendary.exe info Jackal
.\legendary.exe install Jackal --manifest "https://api.mysticfox.dev/v2/Dauntless_1.14.7.647472.manifest" --base-url "https://egs-cloudfront-chunks.epicgamescdn.com/Builds/Org/o-krlzxj88qrtb69fredeuaf887bl5az/Jackal/default" --base-path "D:\Games" --skip-sdl
.\legendary.exe verify Jackal
```

That puts the game in `D:\Games\Dauntless` (about 15 GB). The manifest (SHA-1
`AA70748E4C0A776A991F2BAC10AD342ADAA31476`) was preserved by the
[Dauntless Manifest Archive](https://github.com/addison2k/DauntlessManifestArchive) and is served
by Mystic Paradox; the game itself comes from Epic's servers to your account. Legendary and the
manifest are third-party: use them at your own risk.

**Keep it on 1.14.7:** never run `legendary update Jackal`, and never let the Epic Games Launcher
or Heroic update or repair Dauntless; they would turn it into 2.1.1. If that happens, run the
install command again.

## 2. Install the launcher

Download `ReforgedRevivalLauncher-Setup.exe` from the project's
[releases](https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/releases) and run it (or
build it yourself, see [ReforgedLauncher/README.md](../ReforgedLauncher/README.md)). It updates
itself from the releases afterwards.

## 3. Join with your invite

1. **Join.** Paste the whole invite your host sent you (it starts with `reforged-revival://`), or
   click it once the launcher is installed, and press **JOIN**.
   - A **private** server is reached over [Tailscale](https://tailscale.com/download): install it,
     sign in with your own account, and accept the host's share invite. The launcher tells you
     what is missing.
   - A **public** server is reached over the internet, encrypted. The launcher only talks to the
     server whose certificate is in your invite: if another server answers, it stops before sending
     anything and asks you for a new invite.
2. **Register.** Pick a name (3 to 16 letters, numbers and `_`) and press **REGISTER**. Your account
   lives in a secret key that the launcher keeps encrypted on this PC; a copy is kept in
   `Documents\Dauntless Reforged Revival\Account Keys` too. Save a backup when the launcher offers
   it: without the key you cannot get the account back.
3. **Game.** The launcher looks for Dauntless (Legendary, Heroic, Epic). If it does not find it,
   press **CHOOSE FOLDER** and pick the `Dauntless` folder (the one with `Archon` inside), or paste
   its path. It checks that the executable is exactly the 1.14.7 build.
4. **Runtime.** The server sends a *game runtime*: `MysticParadox.dll` and `winmm.dll`, which the
   launcher puts next to the game so it can talk to the private server. They are native code that
   runs inside the game, so the launcher shows you their names, sizes and SHA-256 first. Allow
   them only for a host you know. They are checked again before every launch, and you are asked
   again if the host publishes different ones.
5. **PLAY.** Keep the launcher open while you play: it carries the game's connection to the server.

## Settings

- **Game**: the game folder, the executable check, and the game's own language.
- **Graphics**: a quality preset applied on every launch (or leave it to the in-game menu), and the
  safe 1280×720 window.
- **Account**: your key's backup, logging out, and the other servers you have joined (switch with
  one click, no invite needed).
- **Launcher**: the language, streamer mode (hides addresses, fingerprints, folders and other
  players' names), the logs, and **Advanced** options for hosts.

## Troubleshooting

| The launcher says | What to do |
|---|---|
| Install Tailscale first / Can't reach the server | Private server: Tailscale running and signed in, the host's share accepted, the host's server on. |
| This is not your friend's server | The certificate did not match the invite: ask the host for a new invite. |
| This isn't Dauntless 1.14.7 | Install 1.14.7 as in step 1 (or run the install command again to repair an updated copy). |
| The game runtime isn't ready yet | The host has not built and published the runtime yet. |
| Your saved key no longer works | The server does not know your key any more: register again, or load your backup. |
| You are banned from this server | Talk to the host. |
| Port 61100 is already in use | Another launcher or server on this PC: close it. |

The launcher's logs (Settings > Launcher > Logs) help the host when something goes wrong. They
never contain your key.
