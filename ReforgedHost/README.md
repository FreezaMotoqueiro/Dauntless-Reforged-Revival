# ReforgedHost: the host kit

Everything a host runs from a terminal, in the `ReforgedHost/` folder. It plays the part of
Dauntless Revived's server kit for Dauntless 1.14.7: it sets up
[Mystic Paradox](https://github.com/pranav158/Mystic-Paradox) at the pinned commit with the
Reforged patches, writes the whole server configuration (secrets included), runs every service,
and makes invites. No dependencies of its own: Node.js 20.19+ and Git.

Read [docs/hosting.md](../docs/hosting.md) first; it walks through a whole setup in order. The
SDK, the runtime build and the game data are in [docs/sdk-and-game-data.md](../docs/sdk-and-game-data.md).

## Commands

Run them in this folder (`cd ReforgedHost`, then `npm install` once).

| Command | What it does |
|---|---|
| `npm run setup -- --mode private --name "Friday Hunts" --game "D:\Games\Dauntless"` | Private server, for friends over Tailscale. The host address is this PC's Tailscale IP (found automatically, or `--host 100.x.y.z`) |
| `npm run setup -- --mode public --host 203.0.113.7 --name "Friday Hunts" --game "D:\Games\Dauntless"` | Public server on the internet. A DNS name works too, with `--game-address <public IPv4>` |
| `npm run start` | Starts everything (MongoDB if managed, backend, Director, content server, allowlist helper in public mode, gateway). Ctrl+C stops it all, the game servers included |
| `npm run invite -- --for "Alex"` | A one-use invite link (the server must be running). `--uses 5`, `--unlimited`, `--list` |
| `npm run publish-runtime` | Publishes the built `MysticParadox.dll` and `winmm.dll` for players, and installs them next to the server's game executable |
| `npm run gamedata` | Generates the game data from your CatalogExporter export (the progression config from the progression export; `-- --example-sources` uses the examples for the files no export produced; `-- --progression` rebuilds only the progression config; `-- --examples` copies every example, for a start-up test only) |
| `npm run doctor` | Checks everything and says what to do next (`-- --no-hash` skips hashing the game executable) |

Other `setup` options: `--registration INVITECODE|OPEN|NONE` (default invite codes only),
`--share <Tailscale share link>` (private: put it in every invite), `--mongo-uri <uri>` with
`--no-manage-mongo` (your own MongoDB, which must be a replica set), `--mongod <path>`,
`--max-hunts 1-6` (default 3; each hunt is a whole game process), `--skip-install`,
`--force-upstream`. Running `setup` again with other options changes only those.

## What setup does

1. **Mystic Paradox** at the commit in [`../upstream/mystic-paradox.json`](../upstream/mystic-paradox.json),
   fetched with Git into `.workspace/Mystic-Paradox/`, with the patches in
   [`../upstream/patches/`](../upstream/patches) applied (`git apply --index`). Running it again
   after the pin changes resets the tracked files and applies the patches again; your SDK, game data,
   exports and builds (all files upstream ignores) stay where they are.
2. `npm ci` and `npm run build` in ParadoxBackend, ParadoxDirector, ReforgedGateway and ReforgedContent.
3. **Configuration** in `.workspace/config/`:
   - `host.json`: what you chose.
   - `secrets.env`: made once and never changed (the backend's token signing key, the API-key HMAC
     secret, the game-server key, the admin key, the gateway and allowlist secrets, the metrics token).
     **Never share it.** Changing it logs everyone out or breaks the invites already sent.
   - `backend.env`, `director.env`, `content.env`, `gateway.env`, `allowlist.env` (public mode):
     written from the two files above every time setup runs.
   - `firewall.ps1`: the Windows Firewall rules to add once, as administrator.
4. **Public mode**: the gateway's self-signed certificate in `.workspace/tls/` (made once; a new one
   changes the fingerprint in every invite). The fingerprint is printed.

## How the server is laid out

```
 player's launcher ─ relay 127.0.0.1:61100 ─► gateway ─► backend   127.0.0.1:61000  (Mystic Paradox, AUTH_MODE=APIKEY)
                                              │        └► content   127.0.0.1:61002  (the runtime, news, art)
                                              └ public: 0.0.0.0:443 TLS   private: <Tailscale IP>:61000 HTTP
 Director 127.0.0.1:61001 ─► game servers on UDP 8770-8777 (Ramsgate 8777, Training Grounds 8776, hunts 8770-8775)
 MongoDB 127.0.0.1:27017 (replica set rs0)
```

- The backend runs with `NODE_ENV=production`, plain HTTP on loopback behind the gateway
  (`REFORGED_HTTP_ONLY=true`), and `AUTH_MODE=APIKEY`: the account key from an invite is the game's
  login. Production mode needs a MongoDB **replica set**; `start` starts `mongod --replSet rs0` and
  initiates the one-member set the first time. With your own MongoDB, enable
  `replication.replSetName: rs0` in its `mongod.cfg` and run `rs.initiate()` once.
- The Director's game servers inherit `REFORGED_BACKEND_URL=http://127.0.0.1:61000`, so the same
  runtime build talks to the backend directly. They run from the game folder you gave `--game`
  and announce `--game-address` (`MY_IP`).
- The launcher answers the game's QoS ping itself (`QOS_TARGET_URL=http://127.0.0.1:61100/QoS`).
- Logs: `.workspace/logs/` (one per service, the game servers in `gameservers/`).

## Tests

```
npm test    # env files, host.json, secrets, the env files of both modes, the pinned upstream with
            # a real local Git repository, invites (parsed with the launcher's own parser), runtime
            # publishing (read back with the content server's own parser), game data, the supervisor
```

## License

AGPL-3.0-only.
