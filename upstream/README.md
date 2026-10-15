# Upstream: Mystic Paradox

Dauntless Reforged Revival does not fork or copy Mystic Paradox. It uses
[Mystic Paradox](https://github.com/pranav158/Mystic-Paradox) by Pranav Karande at one pinned
commit and applies a small set of patches on top. `ReforgedHost`'s `npm run setup` downloads that
commit into `.workspace/Mystic-Paradox/`, applies the patches below and records them in
`.workspace/Mystic-Paradox/.reforged-patches.json`.

| | |
| --- | --- |
| Repository | https://github.com/pranav158/Mystic-Paradox |
| Commit | `00d3be8aa812e334aaa26e5149d2607acb744360` (docs: installing Dauntless 1.14.7 from Epic with Legendary) |
| Game build | Dauntless `rel-1.14.7-Archon`, changelist 647472, Unreal Engine 4.26.2 |
| License | AGPL-3.0-only, with the attribution terms in Mystic Paradox's `ADDITIONAL_TERMS.md` |

The pin is in [`mystic-paradox.json`](mystic-paradox.json). The patches are plain `git diff` output
against that commit (`git apply` them from the repository root).

## Patches

### 0001: the runtime reads its backend address from the environment

`ParadoxRuntime/dllmain.cpp`. Upstream compiles one backend address into the DLL
(`kMpApiBase`, from a generated deployment header) and rewrites every official Dauntless URL to
it. With the patch the runtime reads `REFORGED_BACKEND_URL` (for example
`http://127.0.0.1:61100`) once at start-up:

- `http` or `https`, a host of letters, digits, dots and dashes, an optional port, nothing else;
  anything else is ignored and logged.
- Without it the compiled address is used, as upstream does (`MP_PUBLIC_HOST`, default
  `reforged.invalid` when no deployment header exists, so a build without one fails closed).
- The XMPP chat address follows it (`ws://` or `wss://`, the same host and port, `bUseSSL`
  matching), so chat also goes through the launcher's relay.

One runtime build therefore serves every server: the launcher points it at its local relay, and
the Director's game servers inherit `REFORGED_BACKEND_URL=http://127.0.0.1:61000` from the host kit.

### 0002: the backend speaks the launcher API

`ParadoxBackend`. New routes under `/reforged/api` modelled on Dauntless Revived's
`/undaunted/api` (see `src/routes/reforgedApi.ts` for the full contract):

- `POST Register` (username + invite code, in one MongoDB transaction) returns an account key
  `RRK_<48 hex>`; only its HMAC is stored, like every other API key.
- `GET GetUserInfo` (`x-reforged-user-api-key`), `GET ServerStatus` (players and instances for a
  registered player, a limited view otherwise; game build and game-data state for everyone),
  `GET RegistrationStatus`, `GET /dauntless-status`.
- Admin routes, accepted only from this machine with `x-reforged-admin-key` and never through the
  gateway: `CreateInvite`, `InviteCodes`, `InviteCode/:code`, `SetAccountStatus`.
- `AUTH_MODE=APIKEY`: the game's `client_credentials` grant without an exchange code gets the
  service token, and an ineligible (banned, disabled) account is refused with 403.
- `src/server.ts`: `BIND_HOST`, `REFORGED_HTTP_ONLY=true` (plain HTTP behind the gateway, which
  terminates TLS), `QOS_PORT=0` turns off the backend's own QoS listener (the launcher answers QoS).
- `src/reforgedApiRules.ts` holds the pure rules with their tests (`reforgedApiRules.test.ts`).

### 0003: the Director binds to one address and lists its instances

`ParadoxDirector`. `BIND_HOST` (default `127.0.0.1`, so only the backend on the same machine can
ask it for game servers) and `GET /api/instances` (the running hubs and hunts, for ServerStatus).

### 0004: a hub stays up when its phantom player's data cannot load

`ParadoxRuntime/dllmain.cpp`, the player-data `LoadFailed` hook. A 1.14.7 hub boots in listen-server
mode and spawns a local "phantom" player whose PlayerState has no net id, so its progression component
never loads ("the player state does not have a valid ID"). After the 60-second timeout and one retry the
game's terminal handler reloads the hub's map ("LoadMap: failed to Listen"), which disconnects every real
player about two minutes after each hub start, although their own loads all completed. On the server, a
load failure whose owner has no net id is now logged (`[PhantomLoadFailure]`) and dropped; real players
always carry one. `KEEP_PHANTOM_LOAD_FAILURE.flag` beside the game executable restores the original
handling.

## Updating the pin

1. Pick the new upstream commit and read its changes (the 1.14.7 runtime, the backend routes the
   game calls, the Director's command line).
2. Clone it, apply each patch with `git apply --3way`, fix what no longer applies, and write the
   patches again with `git diff <commit> -- <paths>`.
3. Change `commit` and `archive` in `mystic-paradox.json`, run `ReforgedHost`'s tests and a full
   `npm run setup` on a clean workspace, and play a hunt before publishing.

Hosts then run `npm run setup` again; it replaces `.workspace/Mystic-Paradox/` but keeps the SDK,
the game data and the builds it finds there (see `ReforgedHost/README.md`).
