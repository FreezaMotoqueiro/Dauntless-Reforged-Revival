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

### 0005: XP and objectives reported by the game server are stored

`ParadoxBackend`, `src/routes/progression.ts` and `src/controllers/progression.ts`. The 1.14.7 game
server sends its XP grants (`POST /progression/<user>/<track>/<amount>`: Slayer level, weapon, Hunt
Pass after a kill, a hunt or a collectible) without a grant id, so every grant was refused with 400
("missing or invalid authoritative grant id") and no XP was ever stored. For an authenticated game
server that sends no id, the backend now mints one, so each grant is applied once through the same
transactional ledger; an id that is present but invalid is still refused, and a player's own bearer
still cannot grant XP. Objective reports (`POST /progression/<user>`: daily collectibles, mastery and
achievement objectives) from a game server are now stored with the repository's max-guard
(`setObjectiveIfGreater`), so a stale report never lowers one; a player's own reports stay
diagnostics-only. The backend log shows `mode=gameserver authoritativeMutation=<n>` for them.

### 0006: a client no longer crashes travelling out of a hunt

`ParadoxRuntime/dllmain.cpp`, client only. Leaving a hunt (back to Ramsgate, or into a second hunt) crashed
the player's game in `UEngine::LoadMap` (`0x04271370`, at `0x04272D28`): "EXCEPTION_ACCESS_VIOLATION reading
address 0x20" in `0x0285E6F0`, the new world's `PersistentLevel` read through `GetOutermost` while it is null.
The fix is ported from Mystic Paradox's own (10 October 2026, upstream commit `c7869b6`): a map's previous
`UWorld` survives the trip because one pending-kill input component keeps the GUObjectArray `Async` item flag,
a garbage-collection keep flag, and with it its whole world. GC destroys the level but not the world, and when
the client travels to that map again `LoadMap` finds the world in memory and reuses it. A hook on `LoadMap`'s
entry now clears that stale `Async` bit on the pending-kill objects inside leftover worlds (pending-kill
`UWorld`s other than `GWorld`; never RootSet or AsyncLoading objects), before `LoadMap`'s own full purge, so the
purge frees them and the map loads fresh. The game's log says `[ZombieWorld] LoadMap: ...` when it does.
`KEEP_STUCK_ASYNC_FLAGS.flag` beside the game executable turns it into a report only.

### 0007: XP and reward multipliers for private test servers

`ParadoxBackend`, `src/testMultipliers.ts` (with `testMultipliers.test.ts`), `src/routes/progression.ts`,
`src/routes/inventory.ts` and a start-up log line in `src/server.ts`. A private server can multiply what its game
servers grant, so a tester reaches late-game content in a few hunts. `npm run multipliers -- --xp 5 --rewards 5`
(or setup's `--xp-multiplier` and `--reward-multiplier`) writes `REFORGED_XP_MULTIPLIER` and
`REFORGED_REWARD_MULTIPLIER` (1 to 100) into `backend.env`; the host kit refuses them in public mode, and the
backend uses them only when `REFORGED_SERVER_MODE=private` and `REFORGED_SERVER_HOST` is a Tailscale address
(100.64.0.0/10 or `*.ts.net`). Its log says `[TestMultiplier] ON: XP x5, rewards x5` or `[TestMultiplier] off (why)`.

- XP: every game-server grant on `POST /progression/<user>/<track>/<amount>` (Slayer level, weapons, Hunt Pass),
  capped at the route's maximum of 100000 per grant.
- Rewards: in a dedicated game server's `POST /inventory` whose `source` is `PlayerLoot`, `MISC` (part breaks),
  `patrol_chest`, `quest` or `BUNDLE_GATHER_*`, the stacked items added that are `CURRENCY_NOTES`,
  `CURRENCY_PJM_*`, `BREAK_*` or `GATHER_*`. Unlock tokens, cosmetics, equipment, prestige-gated rewards,
  challenge-funded season coins and anything a craft or a purchase removes keep their quantities. The game's own
  reward screen still shows the original numbers; the inventory and the levels hold the multiplied ones.

### 0008: players no longer wait a minute on the loading screen of a hunt

`ParadoxRuntime/dllmain.cpp`, server only. Joining a hunt or the Training Grounds kept every player on the
loading screen for about 60 seconds. With `CALL_HUNTPASS_QUERY.flag` the runtime issues the progression
configuration query (`GET /progression/config`) at the second "is the configuration loaded?" check. A hub
makes two such checks at boot, so its configuration is cached before anyone joins. A hunt or the Training
Grounds makes only one at boot, so the second was the first real player's own load: their progression
component started waiting, the configuration arrived a few milliseconds later, and nothing checked again
until the game's 60-second player-data timeout fired and its retry completed the load (the runtime log shows
`[HuntPassQuery] calling` at the join and `[LoadFailedDiag] fire #1` exactly 60 s later). On the server the
query is now issued at the first check, at boot, as a hub already does. The client keeps the original
timing.

### 0009: mastery XP is stored, and stored objectives are served as completed

`ParadoxBackend`, `src/controllers/progression.ts` and the progression repository (with a test in
`progressionHardening.gamedata.test.ts`). Mastery never gained XP:

- The 1.14.7 game server sends no grant for a `MasteryTrack_*`. When a mastery objective is completed it
  reports the points in its objective report (`POST /progression/<user>`) as `progress_tracks` deltas:
  +1 on the weapon's or the behemoth track and +1 on `MasteryTrack_PlayerLevel` per objective (captured from
  real hunts). Those were only logged. From a game server they are now added to the tracks, and a track
  gains at most the number of objectives this report completes for the first time (`completed_count` above
  the stored one), so a repeated report adds nothing. The log says `[MasteryXp] user=... MasteryTrack_...+1=<total>`.
- `GET /progression/objectives/<user>` answered `{objective_id, value, completed_count}`. The live service's
  row (Progression/GetObjectiveProgression.md in the endpoint captures) holds the count in `progress`, so the
  game server read every stored objective as not started and completed the same mastery objectives again in
  each hunt. The rows now carry `progress` (and `phx_account_id`, `created_date`, `last_modified_date`) as
  the capture does; `value` stays.

Mastery XP earned before this patch was never stored and is not restored; the objectives completed since
patch 0005 are stored and count as done.

### 0010: claiming a completed bounty works

`ParadoxBackend`, `src/bountyState.ts` (with `bountyState.test.ts`), `src/controllers/bounty.ts` and
`src/routes/system.ts`. Claiming a completed bounty on the board (U) makes the game server ask the backend to
delete it (`POST /bounty/delete/<user>`), and only a 200 lets it grant the reward and take the bounty off the
board. Upstream has no such route, so every claim got a 404, the game server logged
`UBountyComponent::OnClaimBountyComplete() - invalid http response` and the bounty stayed on the board, complete
and unclaimable. The new route (POST, and DELETE) removes the named bounties from the stored state, reading
`bounty_ids` (the field name in the 1.14.7 executable; no capture of the live body exists), `bounties` and
`delete_claimed_bounties`, and answers with the state like a save does. Season challenges are never deleted, so a
claimed challenge still cannot be re-seeded and pay its Cache Coins twice. Each call logs a
`[DraftMon] BOUNTY-DELETE` line with what was deleted and the raw body; a body that names nothing gets a 400.
The number skips 0009, which another pending change uses.

### 0011: a hunt client no longer crashes when its loading takes more than 3 seconds

`ParadoxRuntime/dllmain.cpp`, the client side of the `HasFinishedLoading` compatibility override. On a client
the override forces the local player controller's readiness to true as soon as the possession chain has been
stable since `ClientRestart` for 3 seconds. A hunt client is normally ready on its own about 1.5 seconds after
`ClientRestart`, so the override never fired; when the client was slower (a busy machine), it fired at 3 seconds,
the whole map ran `ReceiveGameplayStart` at once, including the adventure HUD, and the game crashed 20 ms later
with `EXCEPTION_ACCESS_VIOLATION reading address 0x248` at `Dauntless-Win64-Shipping.exe+0x1F6D6BE`
(`[ReadinessCompat] FORCE_TRUE scope=local-controller` right before `[ExceptionTrace]` in the client's
`mysticparadox_dll_port0.log`). The override now waits 20 seconds after `ClientRestart`, so a slow load finishes
on its own and only a load that is really stuck is forced.

### 0012: a hunt no longer spawns the player before their data has loaded

`ParadoxRuntime/dllmain.cpp`, both sides. 0011 did not stop the crash: in the next report the client's
readiness stayed false for the whole 20 seconds and the crash followed the forced `true` again. The load was not
slow, it was missing something:

- The client: the player controller's own readiness (`+0x1CB1360`) waits for the character's weapon
  (`AArchonCharacter` `+0x5F0`) and armour slots. The HUD it releases reads that weapon without a null check
  (`UHUDLegendaryAbilityWidget::NativeConstruct` `+0x1F7AA00` → `HandleWeaponEquipped` `+0x1F6D4F0`, which
  reads `weapon+0x248` at `+0x1F6D6BE`), so forcing readiness without a weapon always crashed. The override now
  also requires the weapon, and otherwise leaves the loading screen up.
- The server: the runtime answers `GameModeBase.PlayerCanRestart` with `true` for every controller, so any
  restart request spawns the pawn at once. In the three crashed hunts (16 Oct, all Snow Jen) the player was
  restarted about 1.5 seconds after joining, right after another progression component finished loading
  (`[ProgDiag] CompleteLoadInternal RUNS`), long before the player's own data had loaded, so the character
  reached the client without its weapon. In every other hunt the restart comes from `OnPlayerDataLoadComplete`
  (which calls `ServerRestartPlayer`), including the ones whose load needs the 60-second retry. In a hunt the
  runtime now answers `false` for a connected player until `OnPlayerDataLoadComplete` has run for that
  controller (`[RestartDataGate] holding restart ...` in the server log), and after 90 seconds it falls back to
  the old answer. The city and the Training Grounds keep the old behaviour; `DISABLE_RESTART_DATA_GATE.flag`
  turns the gate off. The same early restart happened before 0008, 20 to 30 seconds after joining; with the
  progression configuration available at boot (0008) it comes about 1.5 seconds after joining. 0008 stays.

### 0013: the log shows where a hunt's missing weapon got stuck

`ParadoxRuntime/dllmain.cpp`, client side, logging only. With 0012 the hunt no longer crashes, but on 16 Oct
every hunt with the newly crafted hammer (`ihammer_rock_00`) equipped stayed on the loading screen until the
server's 120-second "Loading timeout", while hunts with the war pike or the repeaters loaded. The server logs of
both kinds of hunt match line for line, so the weapon is lost on the client: `AArchonCharacter::Weapon`
(`+0x5F0`) is not replicated, and the client never sets it. While 0012's check holds the loading screen for a
missing weapon, the runtime now writes `[WeaponGap]` lines 3, 10, 30, 60 and 100 seconds after `ClientRestart`:
the character's equipment pointers, every weapon the client has (owner, network role, item id, the four
`AArchonEquipment` equip flags, and the weapon's replicated level, slot and parts, power table and meshes),
the other equipment the character owns, and the local loadout's active slot. It changes nothing in the game.

## Store captures

[`store-captures.json`](store-captures.json) pins a second source, read by Mystic Paradox's store
generators and not copied here either: five captures of the live store service from
[EisigesEis/DauntlessEndpointDocumentation](https://github.com/EisigesEis/DauntlessEndpointDocumentation)
(Lady Luck's rotation, the platinum webstore and dyes, the Hunt Pass rank skips and passes), with the
commit and each file's SHA-256. `npm run gamedata` fetches that commit into `.workspace/captures/` and
writes the files to `.workspace/Mystic-Paradox/DauntlessEndpointDocumentation/`, where
`scripts/enrich_ladyluck_store.ts` and `scripts/generate_platinum_store.ts` look for them. A file whose
bytes do not match its pinned hash is refused.

## Updating the pin

1. Pick the new upstream commit and read its changes (the 1.14.7 runtime, the backend routes the
   game calls, the Director's command line).
2. Clone it, apply each patch with `git apply --3way`, fix what no longer applies, and write the
   patches again with `git diff <commit> -- <paths>`.
3. Change `commit` and `archive` in `mystic-paradox.json`, run `ReforgedHost`'s tests and a full
   `npm run setup` on a clean workspace, and play a hunt before publishing.

Hosts then run `npm run setup` again; it replaces `.workspace/Mystic-Paradox/` but keeps the SDK,
the game data and the builds it finds there (see `ReforgedHost/README.md`).
