# Granny's Heartbreaker / Crit Potion (1.14.7)

The native item is `QI_11A_CRIT_POTION`. It requires the stacked unlock token
`TOKEN_UNLOCK_QI_HP11A_00` (quantity 1) and the seasonal event
`Season_11A_StoryMissions`. Its original carry limit is **3**; this overlay raises
it to **7** and removes only this item's seasonal expiry on the game server.
The overall inventory quantity is a separate limit and is not changed.

The potion, its ability and its critical-damage effect already exist in 1.14.7.
Do not copy the 1.4.4 cooked packages into the newer game. The original 1.14.7
ability and effect remain unchanged. The player confirmed consumption and the
effect in gameplay on 2026-10-26; the existing server log independently recorded
`Ability_QuickItem_11A_Crit_Potion_C` with `activated=1`. That log does **not**
measure the damage multiplier. The new seven-charge limit still needs a gameplay
check after deployment.

## Backend

Patch 0044 is applied by the existing upstream setup/update process. Add to the
host's `.workspace/config/backend.env`:

```dotenv
SEASONAL_EVENTS=Season_11A_StoryMissions
```

Keep any other configured event IDs in this comma-separated list. Restart the
backend and check `/game_tuning/seasonal_event_schedule`; its
`payload.ScheduledItems` must contain this event, covering 2020 through 2099.

Grant the potion and its unlock token through the server's normal inventory
tools. If using the existing session-supplies feature, merge the following into
each intended account's entry, preserving its other supplies:

```json
{
  "QI_11A_CRIT_POTION": 30,
  "TOKEN_UNLOCK_QI_HP11A_00": 1
}
```

`REFORGED_SESSION_SUPPLIES_FILE` points to the configuration; it is read on login.
The token is not a potion and must remain quantity 1. No account IDs or host
credentials belong in the repository.

## Generate the overlay

Requires Python 3.10+, [repak](https://github.com/trumank/repak), and the host's own
unmodified Dauntless **1.14.7 (647472)** installation. The tool checks SHA-256 of
each source package before using any offset; another build is rejected.

```sh
python3 tools/crit-potion/build_patch.py \
  --repak /path/to/repak \
  --paks /path/to/Dauntless/Archon/Content/Paks \
  --output /path/to/staging/CritPotion_SeasonFix_P.pak
```

The generated PAK has four entries: the QuickItem `.uasset`/`.uexp` pair and the
quick-item catalog pair. Only three bytes change across the two `.uexp` files:

| Property | Before | After |
| --- | --- | --- |
| `Default__QuickItem_11A_Crit_Potion_C.MaxStackSize` | 3 | 7 |
| `QI_11A_CRIT_POTION.ExpiryEventId` | `Season_11A_StoryMissions` | `None` |

Both `.uasset` headers remain byte-identical. The generator reopens the PAK and
compares every entry byte-for-byte before publishing it. The adjacent validation
JSON records hashes, offsets and changes. Existing output files are refused.
Generated assets stay outside Git, in keeping with this project's asset policy.

Back up any previous overlay, then install the generated file as
`Archon/Content/Paks/CritPotion_SeasonFix_P.pak` on the **game server** and restart
its worlds. In the game log, check for `Mounting pak file` and this filename.
The `_P.pak` suffix gives it patch priority; original PAKs remain untouched.

For a client whose local UI or prediction still enforces three charges, install
the same generated overlay in that client's `Archon/Content/Paks` and fully
restart the game. The host kit's runtime publisher distributes DLLs, not this
PAK, so this step is not an automatic launcher update.

## Verification and rollback

```sh
python3 -m unittest discover -s tools/crit-potion -p 'test_*.py' -v
```

After deployment, log in again, unequip/re-equip the potion, enter a newly started
hunt and verify seven charges and consumption through charges 4-7. Check that the
effect remains active and expires normally. Asset validation alone cannot prove
live damage or the client HUD count.

To roll back only the carry increase, restore the previous three-charge overlay
and restart the worlds. To remove both changes, move the overlay outside `Paks`
and restart. Restore the previous `SEASONAL_EVENTS` configuration to undo the
backend activation. Neither rollback changes player inventory quantities.
