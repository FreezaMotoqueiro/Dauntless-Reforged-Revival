# The SDK, the runtime and the game data

A Dauntless 1.14.7 server needs three things made from **your own copy of the game**. None of
them is in this repository or shared by anyone: they are made on the host's PC and stay in the
git-ignored `.workspace\` folder.

| What | Made with | Used by |
|---|---|---|
| The **SDK**: C++ headers and sources describing the game's classes | Dumper-7, injected into your running game | building the runtime and CatalogExporter |
| The **runtime**: `MysticParadox.dll` and its loader `winmm.dll` | Visual Studio (C++) and Rust | every player's game, and the server's game servers |
| The **game data**: item catalog, stores, Slayer's Path, hunt tables | CatalogExporter, injected into your running game, and Mystic Paradox's generators | the backend and the Director |

The steps below are those of Mystic Paradox's own guides
([GENERATING_SDK.md](https://github.com/pranav158/Mystic-Paradox/blob/main/docs/GENERATING_SDK.md),
[GENERATING_GAME_DATA.md](https://github.com/pranav158/Mystic-Paradox/blob/main/docs/GENERATING_GAME_DATA.md)),
with the Reforged tools doing the file handling. The launcher's **Host tools** page
(Settings > Launcher > Advanced > Host tools, then choose your Dauntless Reforged Revival folder
as the workspace) shows each step's state and has a button for most of them. Run
`npm run setup` (see [hosting.md](hosting.md)) first: it creates the workspace.

## 1. The SDK (Dumper-7)

The SDK must come from exactly the 1.14.7 build (`rel-1.14.7-Archon`, CL 647472, UE 4.26.2); the
launcher refuses to dump a game it found to be another build.

1. Build [Dumper-7](https://github.com/Encryqed/Dumper-7) (Visual Studio, Release x64) and note
   where its DLL is.
2. Host tools page, step 2: **Choose Dumper-7 DLL…**, then **Start game and dump**. The launcher
   sets the runtime loader aside (so the game starts unmodified), starts Dauntless, waits for its
   window and loads Dumper-7 into it. Wait in the main menu until `C:\Dumper-7\<game>\CppSDK\`
   appears and is complete (a minute or two), then close the game; the loader is put back.
3. **Import SDK** copies the newest dump into `.workspace\Mystic-Paradox\ParadoxRuntime\`:
   `SDK.hpp`, `SDK\` (with the `*_functions.cpp` files), `Assertions.inl`, `NameCollisions.inl`,
   `PropertyFixup.hpp`, `UnrealContainers.hpp`, `UtfN.hpp`.

By hand: inject Dumper-7 into your running 1.14.7 game with any injector, and copy the whole
`CppSDK` folder's contents into `ParadoxRuntime\`. A header-only or partial copy is not enough.

## 2. The runtime

Host tools page, step 3, or by hand from `.workspace\Mystic-Paradox`:

```powershell
cd ParadoxRuntime; .\_build.bat                     # -> ParadoxRuntime\x64\Release\MysticParadox.dll
cd ..\tools\RuntimeLoader; cargo build --release   # -> tools\RuntimeLoader\target\release\winmm.dll
cd ..\CatalogExporter; .\_build.bat                 # -> tools\CatalogExporter\x64\Release\CatalogExporter.dll
```

- The projects ask for the v145 toolset (Visual Studio 2026). The Host tools page passes v143 to
  MSBuild on Visual Studio 2022; by hand, add `/p:PlatformToolset=v143` or retarget the projects.
- No `deployment_config.generated.h` is needed: with the Reforged patch the runtime gets the
  backend address from the launcher (`REFORGED_BACKEND_URL`) and, on the server, from the Director.
  One build works for every server.
- One DLL serves the player's game and the dedicated servers (it detects `-server`).
- Delete any old `MystPaxInternalServer.dll` next to the game: the loader still prefers it when it
  is newer.

Then publish it:

```powershell
cd D:\Reforged\ReforgedHost
npm run publish-runtime
```

This copies both files to `.workspace\runtime\` with `runtime.json` (names, sizes, SHA-256),
which the content server offers to players, and next to the server's game executable for the game
servers (stop the server first if it is running: Windows will not replace a loaded DLL). The
launcher's **Publish** button does the first half.

## 3. The game data

The backend reads seven files from `ParadoxBackend\game-data\` and the Director seven from
`ParadoxDirector\game-data\`. Without them the services do not start.

### For a first start-up test: the examples

```powershell
npm run gamedata -- --examples
```

copies Mystic Paradox's `*.example.json` files where a file is missing. The services start and you
can test joining, but **it is not playable**: no real items, hunts or stores. The launcher warns
players that the server runs on example data.

### For a playable server: export from your game

1. Build CatalogExporter (step 2).
2. Start the server (`npm run start`), make yourself an invite, join it with the launcher and
   press PLAY: the exporter needs the running 1.14.7 game.
3. Host tools page, step 4: **Inject CatalogExporter**. The launcher writes `export_flags.txt` next
   to the game (catalog, Slayer's Path, hunts, the store's runtime data and the progression tables)
   and loads the exporter. While it runs (up to two minutes), go where each export needs you to be:
   - the catalog and the progression tables: the main menu or Ramsgate;
   - the Slayer's Path: open the Slayer's Path screen;
   - the hunts: in Ramsgate, open the Hunt/Map screen;
   - the store: in Ramsgate, Journal > Challenges > Reward Cache.
   The exporter writes `Items_Analysis\` next to the game; check its `export_manifest_1_14_7.json`
   and `catalog_export_status.txt`. Flags are read once per injection: inject again for a missing part.
4. **Copy the export** puts `Items_Analysis\` into `.workspace\Mystic-Paradox\`, where the
   generators read it.
5. Generate:

   ```powershell
   npm run gamedata
   ```

   This runs, in order: the Director's hunt tables, the Slayer's Path graph and definitions, the
   Reward Cache store, the progression config (from the progression export, below), the Lady Luck
   store (when you supply its source, below), and the Platinum store with the storage policy. Each step that cannot run yet
   says why. The output is in `.workspace\logs\gamedata.log`.

### The progression config

`progression_config.json` holds the progression tracks: the player and weapon levels
(`ExperienceTrack_*`), the mastery and prestige tracks, and the Hunt Pass. The 1.14.7 client needs
them to load a player: with the example file, Ramsgate never finishes loading your character and
drops you after a minute ("Loading PlayerData Failed" in its log, "the game server could not be
reached" in the game).

Mystic Paradox builds it from a captured server response. Without one, `npm run gamedata` builds the
source from the progression tables of your own game, which CatalogExporter exports into
`Items_Analysis\progression_1_14_7\`: every track with its per-rank XP costs and rewards, plus the
active Hunt Pass (`season43`). The game's Hunt Pass rows hold no tiers, so the pass gets 50 ranks of
100 XP and no rewards. A captured response in `ParadoxBackend\game-data\raw\progression_config.source.json`
(a progression-config response with `payload.paths`) is always used instead.

### The file you supply

`ladyluck_store.json` (the Lady Luck offers) is not in the game client, so no export can produce it.
Mystic Paradox generates it from a captured server response that you put in
`ParadoxBackend\game-data\raw\ladyluck_store.source.json` (an array of store entries). Without it,
`npm run gamedata -- --example-sources` uses the example for that file (and for the progression
config, when there is no progression export yet), so everything else is real.

### Check

```powershell
npm run doctor
```

shows the state of both folders (real, example or missing). Restart the server after generating:
the services read the data at start-up.

## Keep it to yourself

The SDK, the exports and the game data are derived from Phoenix Labs' game. Do not commit, upload
or share them; this repository's `.gitignore` and Mystic Paradox's keep them out of Git. Share only
your server, through invites.
