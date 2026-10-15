# Brand

The Dauntless Reforged Revival emblem: a shield with a sword driven into an anvil, its edge still
glowing from the forge, in the colours of the launcher (deep greens, yellow and steel, with an ember
accent). It was made for this project; it is not Dauntless Revived's or Mystic Paradox's logo, and
not Phoenix Labs' artwork.

| File | What |
|---|---|
| `emblem.svg` | the emblem (vector, the source of everything else) |
| `palette.json` | the colours |
| `build.mjs` | renders the icons below from the SVG (needs `playwright-core` and a Chromium) |
| `launcher/icon.ico` | Windows icon, 16 to 256 px |
| `launcher/icon.png`, `icon-512.png`, `icon-1024.png` | PNG renders |

`npm run icon` in `ReforgedLauncher/` copies `launcher/icon.ico`, `icon.png` and `emblem.svg` into
the launcher. Same license as the repository (AGPL-3.0-only).
