# Dauntless Reforged Revival Launcher

The Windows launcher for Dauntless Reforged Revival: paste an invite from a host, pick a name, point
it at your own Dauntless 1.14.7 and press PLAY. It is a modified version of the
[Dauntless Revived](https://github.com/mixutin/dauntless-revived) launcher (same look, same way of
joining servers) adapted to Dauntless 1.14.7 and the [Mystic Paradox](https://github.com/pranav158/Mystic-Paradox)
runtime. The interface is in English and Brazilian Portuguese.

Players: see [docs/players.md](../docs/players.md). Hosts: see [docs/hosting.md](../docs/hosting.md).

## What it does

1. **Join**: parses a `reforged-revival://join?...` invite (v1 private over Tailscale, v2 public
   over TLS pinned to the certificate fingerprint in the invite) and checks the server's
   `/reforged/api/ServerStatus`.
2. **Register**: `POST /reforged/api/Register` with the invite code; the account key (`RRK_...`) is
   stored with Electron `safeStorage`, never shown, never logged, and only sent to that server.
3. **Game**: finds Dauntless 1.14.7 (Legendary, Heroic, the Epic Games Launcher, or a folder you
   choose) and checks the executable's SHA-256 against the 1.14.7 build (CL 647472). The game is
   never downloaded.
4. **Runtime**: the server's content server lists the host-built `MysticParadox.dll` and `winmm.dll`
   with their sizes and SHA-256. The player is asked once per set of files; the files are checked
   before they replace anything and again before every launch.
5. **Play**: starts a local relay on `127.0.0.1:61100` that carries the game's traffic to the
   server (pinned TLS in public mode, plain HTTP inside the tailnet in private mode) and answers
   the game's QoS ping, writes Engine.ini's chat section, and starts the game with the 1.14.7
   command line (`-AUTH_TYPE=exchangecode -AUTH_PASSWORD=<key> ...`) and
   `REFORGED_BACKEND_URL=http://127.0.0.1:61100` for the runtime.

The **Host** page (Settings > Advanced > Host tools) walks a host through generating the SDK with
Dumper-7, building the runtime, preparing the game data and publishing the runtime. See
[docs/sdk-and-game-data.md](../docs/sdk-and-game-data.md).

## Development

Node.js 20.19 or newer.

    npm ci
    npm run typecheck
    npm test                 # unit and flow tests (fake servers on 127.0.0.1)
    npm run preview          # the page in a browser with a fake main process
    npm start                # the real app (Windows; Electron)
    npm run make             # Squirrel installer and ZIP (Windows)

`npm run preview` serves http://127.0.0.1:5199/ — add `?scene=` (`join`, `register`, `locate`,
`trust`, `noruntime`, `installing`, `ready`, `running`, ...), `&lang=pt-BR`, `&view=host` and so on;
the list is at the top of `scripts/preview.mjs`.

## Layout

| Path | What |
| --- | --- |
| `src/main.ts` | Electron main process: window, IPC with validation, dialogs, deep links |
| `src/preload.ts` | the typed bridge (the page's only way out) |
| `src/main/controller.ts` | the state machine: everything the page shows comes from its Snapshot |
| `src/main/relay.ts`, `pinned.ts`, `http.ts` | the local relay and the pinned TLS connections |
| `src/main/hostapi.ts`, `runtime-files.ts` | server API calls and the runtime install |
| `src/main/game-folder.ts`, `launch.ts`, `engineini.ts` | finding, configuring and starting the game |
| `src/main/hostkit.ts`, `injector.ts` | the Host page's checks and actions |
| `src/shared/` | code shared with the page: types, invite parser, text (`i18n.ts`), UI model |
| `src/renderer/` | the page: plain TypeScript and CSS, Dauntless Revived's design |
| `test/` | node:test tests |
| `preview/` | the fake bridge for `npm run preview` |

## Translations

All text is in `src/shared/i18n.ts`: an English table and a Brazilian Portuguese table with the
same keys and placeholders (a test checks both). Credits are in `src/shared/credits.ts`.

## License

AGPL-3.0-only, like Dauntless Revived and Undaunted. Third-party software and its licenses:
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
