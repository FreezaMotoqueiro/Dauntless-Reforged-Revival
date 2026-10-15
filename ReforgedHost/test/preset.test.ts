import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { paths } from "../src/paths";
import { applyPreset, createPreset, readPresetManifest } from "../src/preset";
import { tempDir, write } from "./helpers";

function host(name: string) {
    const p = paths(tempDir(name));
    write(path.join(p.backendGameData, "ladyluck_store.example.json"), "[]\n");
    write(path.join(p.backendGameData, "progression_config.example.json"), "{\"example\":true}\n");
    return p;
}

describe("the server preset", () => {
    it("is extracted from the generated game data with its provenance, and fills a new setup", () => {
        const from = host("preset-from");
        write(path.join(from.backendGameData, "progression_config.json"), "{\"paths\":1}\n");
        write(path.join(from.backendGameData, "ladyluck_store.json"), "[]\n"); // the example: not in the preset
        write(path.join(from.directorGameData, "player_hunts_table.json"), "{\"hunts\":2}\n");
        const exe = path.join(tempDir("preset-game"), "Dauntless-Win64-Shipping.exe");
        write(exe, "not really a game");
        write(path.join(from.preset, "backend", "stale.json"), "{}\n"); // left from an older preset
        write(path.join(from.preset, "README.md"), "# preset\n");

        const { manifest, left } = createPreset(from, { name: "Friday Hunts", executable: exe, now: new Date("2026-10-15T00:00:00Z") });
        assert.deepEqual(manifest.files.map((f) => f.path), ["backend/progression_config.json", "director/player_hunts_table.json"]);
        assert.ok(left.includes("backend/ladyluck_store.json"));
        assert.equal(manifest.executableSha256, "d787d550340c5880ee32ca9e3fc7ffe14d25bae533e0c3f37e88b9026dbc1370", "the executable it was read from");
        assert.match(manifest._comment.join(" "), /interoperability/);
        assert.ok(!fs.existsSync(path.join(from.preset, "backend", "stale.json")), "the folder is exactly the manifest");
        assert.ok(fs.existsSync(path.join(from.preset, "README.md")), "its README stays");
        assert.equal(readPresetManifest(from)?.name, "Friday Hunts");

        // Another checkout of the project with the same preset/ (a new setup): the examples are replaced,
        // a host's own data is kept unless --force.
        const to = host("preset-to");
        fs.cpSync(from.preset, to.preset, { recursive: true });
        write(path.join(to.backendGameData, "progression_config.json"), "{\"example\":true}\n"); // still the example
        write(path.join(to.directorGameData, "player_hunts_table.json"), "{\"mine\":true}\n"); // the host's own
        const applied = applyPreset(to)!;
        assert.deepEqual(applied.written, ["backend/progression_config.json"]);
        assert.deepEqual(applied.kept, ["director/player_hunts_table.json"]);
        assert.equal(fs.readFileSync(path.join(to.backendGameData, "progression_config.json"), "utf8"), "{\"paths\":1}\n");
        assert.equal(fs.readFileSync(path.join(to.directorGameData, "player_hunts_table.json"), "utf8"), "{\"mine\":true}\n");

        const forced = applyPreset(to, { force: true })!;
        assert.deepEqual(forced.written, ["director/player_hunts_table.json"]);
        assert.equal(forced.backups.length, 1);
        assert.equal(fs.readFileSync(forced.backups[0], "utf8"), "{\"mine\":true}\n");
        assert.equal(applyPreset(to)!.unchanged.length, 2);
    });

    it("is not applied when a file was edited by hand, and is simply absent when there is none", () => {
        const p = host("preset-edited");
        assert.equal(applyPreset(p), null);
        write(path.join(p.backendGameData, "progression_config.json"), "{\"paths\":1}\n");
        createPreset(p, { name: "x", executable: null });
        write(path.join(p.preset, "backend", "progression_config.json"), "{\"paths\":2}\n");
        assert.throws(() => applyPreset(p), /does not match its hash/);
        assert.throws(() => createPreset(host("preset-empty"), { name: "x", executable: null }), /npm run gamedata first/);
    });
});
