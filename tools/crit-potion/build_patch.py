#!/usr/bin/env python3
"""Build a reversible Crit Potion overlay from an installed 1.14.7 (647472) game.

Requires Python 3.10+ and repak. No game assets are distributed by this script.
The hashes bind every byte offset below to the exact supported cooked packages.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile


ASSETS = (
    {
        "pak": "Archon_0-WindowsClient.pak",
        "path": "Archon/Content/Blueprints/InventoryItems/QuickItems/QuickItem_11A_Crit_Potion",
        "uasset": "7dde4db6ce2c77aae795be6d74125bf2c8d3ae1ea8d2b07902569002f5cc8bd0",
        "uexp": "97421b076944b4af374df3979e18be0912b2ff9e11c915994a7dabaa4656a843",
        # Default__QuickItem_11A_Crit_Potion_C.MaxStackSize (IntProperty).
        "offset": 134, "before": "03000000", "after": "07000000",
        "property": "MaxStackSize", "old_value": 3, "new_value": 7,
    },
    {
        "pak": "Archon_24-WindowsClient.pak",
        "path": "Archon/Content/Gameplay/Backend/Catalogs/quick_item_catalog",
        "uasset": "319dc263e031ca55f3a44c008dfd8ae8bcfd1c3a2dd24ccafface7d287ba3dd3",
        "uexp": "54788fc3ce10922c05c9cbb6945840c0d3f71071ba8744fbc43d70f71f3feb42",
        # QI_11A_CRIT_POTION.ExpiryEventId (FName: name index, instance number).
        "offset": 101741, "before": "3a01000000000000", "after": "e600000000000000",
        "property": "ExpiryEventId", "old_value": "Season_11A_StoryMissions", "new_value": "None",
    },
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(data, expected):
    if digest(data) != expected:
        raise ValueError("Unsupported or modified source asset; refusing to patch")


def patch_bytes(data, expected_hash, offset, before, after):
    verify(data, expected_hash)
    if not before or len(before) != len(after):
        raise ValueError("Replacement must preserve the property's byte length")
    if offset < 0 or offset + len(before) > len(data):
        raise ValueError("Property offset outside the source asset")
    if data[offset:offset + len(before)] != before:
        raise ValueError("Original property value does not match")
    result = data[:offset] + after + data[offset + len(before):]
    if len(result) != len(data):
        raise ValueError("Asset length changed")
    return result


def build(repak, paks, output):
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Output already exists: {output}; choose a new filename")
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {"game": "1.14.7 (647472)", "item": "QI_11A_CRIT_POTION", "changes": []}
    with tempfile.TemporaryDirectory(prefix="crit-potion-") as temp:
        source = Path(temp) / "overlay"
        source.mkdir()
        expected_entries = {}
        for asset in ASSETS:
            original = {}
            for ext in ("uasset", "uexp"):
                entry = asset["path"] + "." + ext
                data = subprocess.check_output([str(repak), "get", str(paks / asset["pak"]), entry])
                verify(data, asset[ext])
                original[ext] = data
            before, after = bytes.fromhex(asset["before"]), bytes.fromhex(asset["after"])
            patched = patch_bytes(original["uexp"], asset["uexp"], asset["offset"], before, after)
            for ext, data in (("uasset", original["uasset"]), ("uexp", patched)):
                entry = asset["path"] + "." + ext
                target = source / entry
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                expected_entries[entry] = data
            report["changes"].append({
                "path": asset["path"], "property": asset["property"],
                "before": asset["old_value"], "after": asset["new_value"],
                "offset": asset["offset"], "original_sha256": asset["uexp"],
                "patched_sha256": digest(patched),
                "changed_bytes": sum(a != b for a, b in zip(original["uexp"], patched)),
            })
        # Pack to a temporary output first; publish only after read-back verification.
        packed = Path(temp) / "CritPotion_SeasonFix_P.pak"
        subprocess.run([str(repak), "pack", str(source), str(packed), "--version", "V8B"], check=True)
        entries = subprocess.check_output([str(repak), "list", str(packed)], text=True).splitlines()
        if set(entries) != set(expected_entries):
            raise ValueError("Unexpected entries in generated overlay")
        for entry, expected in expected_entries.items():
            actual = subprocess.check_output([str(repak), "get", str(packed), entry])
            if actual != expected:
                raise ValueError(f"Read-back mismatch: {entry}")
        data = packed.read_bytes()
        with output.open("xb") as f:
            f.write(data)
    report["pak_sha256"] = digest(data)
    report["entries"] = sorted(expected_entries)
    output.with_suffix(".validation.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repak", required=True, type=Path)
    parser.add_argument("--paks", required=True, type=Path, help="Original Archon/Content/Paks folder")
    parser.add_argument("--output", required=True, type=Path, help="New output file, named CritPotion_SeasonFix_P.pak when installed")
    args = parser.parse_args()
    print(json.dumps(build(args.repak.resolve(), args.paks.resolve(), args.output), indent=2))


if __name__ == "__main__":
    main()
