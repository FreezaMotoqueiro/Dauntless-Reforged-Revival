# Server preset

The game data every server set up from this project starts from, like the `vendor/*.json` files of
[Dauntless Revived](https://github.com/mixutin/dauntless-revived)'s metagame and deploy server.

`npm run setup` (in `ReforgedHost/`) copies these files into the server's game data wherever a file is
missing or still the shipped example. A host's own generated game data always takes precedence: the
preset never replaces it unless the host asks (`npm run preset -- --apply --force`, which keeps the old
file as `.bak`).

| File | What |
|---|---|
| `preset.json` | the manifest: the preset's name, the Dauntless build, the SHA-256 of the game executable the data was read from, the tools, and the SHA-256 of every file (a file that no longer matches is refused) |
| `backend/*.json` | the backend's game data (progression config, Slayer's Path, stores, storage policy) |
| `backend/raw/*.json` | the sources the backend's generators read (the progression config's, a Lady Luck capture) |
| `director/*.json` | the Director's hunt and matchmaker tables |

Only this README is here until a preset is made. Make or refresh one from your own game:

1. Play on your own server, inject CatalogExporter in Ramsgate and **Copy export** (launcher, Host page).
2. `cd ReforgedHost` and `npm run preset -- --create --generate` (the generators run on the export, then
   the result is written here). `npm run preset` shows what is in it.

Do not edit the files by hand: their hashes are in `preset.json`.

## What it holds, and publishing it

The files hold identifiers and tuning values read from an installed Dauntless 1.14.7 client for
interoperability (the item catalogue, stores, progression and hunt tables) and no game assets. They are
still data from Phoenix Labs' game: Mystic Paradox keeps its own copies out of its repository for that
reason, while Dauntless Revived ships comparable files with a provenance note in each. Committing a
preset to a public repository publishes it; keep it in a private repository, or as a game data pack
(`npm run gamedata -- --export`) in your own backups, if you would rather not.
