// The project's server preset: game data kept with the project (preset/ at the repository root), which
// every server set up from it starts from. The idea is Dauntless Revived's: its metagame and deploy server
// ship their data as vendor/*.json in the repository, each file saying where it comes from in a
// "_comment", and a host's own files (PROGRESSION_CONFIG_DIR there) take precedence over the bundled ones.
//
// Here:
// - `npm run preset -- --create` extracts a preset from the game data generated from the host's own game
//   (CatalogExporter's export and Mystic Paradox's generators; `--generate` runs the generators first).
//   preset/preset.json records the provenance: the Dauntless build, the SHA-256 of the game executable it
//   was read from, the tools, and the SHA-256 of every file.
// - `npm run setup` applies it, and so does `npm run preset -- --apply`: a game-data file that is missing,
//   or still the shipped example, is taken from the preset. A host's own generated data is never replaced
//   (that is the override, as in Dauntless Revived) unless `--force`, which keeps the old file as .bak.
// The files are the same set a game data pack holds (gamepack.ts).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PACK_GAME, packEntries } from "./gamepack";
import type { Paths } from "./paths";

export const PRESET_FORMAT = "dauntless-reforged-revival-preset";
export const PRESET_MANIFEST = "preset.json";

export interface PresetManifest {
    _comment: string[];
    format: string;
    version: number;
    name: string;
    game: string;
    executableSha256: string | null;
    created: string;
    sources: string[];
    files: { path: string; sha256: string; bytes: number }[];
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function isExample(file: string, data: string): boolean {
    const example = file.replace(/\.json$/, ".example.json");
    return fs.existsSync(example) && fs.readFileSync(example, "utf8") === data;
}

export function readPresetManifest(p: Paths): PresetManifest | null {
    const file = path.join(p.preset, PRESET_MANIFEST);
    if (!fs.existsSync(file)) return null;
    const m = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as PresetManifest;
    if (m?.format !== PRESET_FORMAT || m.version !== 1 || !Array.isArray(m.files)) throw new Error(`${file} is not a server preset of this version`);
    return m;
}

// Writes preset/ from the workspace's generated game data (the examples are left out). Files of an older
// preset that the new one does not hold are removed, so the folder is exactly the manifest.
export function createPreset(p: Paths, opts: { name: string; executable: string | null; now?: Date }): { manifest: PresetManifest; left: string[] } {
    const now = opts.now ?? new Date();
    const files: PresetManifest["files"] = [];
    const left: string[] = [];
    const contents = new Map<string, string>();
    for (const [packPath, file] of packEntries(p)) {
        if (!fs.existsSync(file)) {
            left.push(packPath);
            continue;
        }
        const data = fs.readFileSync(file, "utf8");
        if (isExample(file, data)) {
            left.push(packPath);
            continue;
        }
        JSON.parse(data); // a preset only holds JSON the services can read
        files.push({ path: packPath, sha256: sha256(data), bytes: Buffer.byteLength(data) });
        contents.set(packPath, data);
    }
    if (files.length === 0) throw new Error("no generated game data to make a preset from yet (npm run gamedata first, or pass --generate)");
    const executableSha256 = opts.executable && fs.existsSync(opts.executable) ? sha256(fs.readFileSync(opts.executable)) : null;
    const manifest: PresetManifest = {
        _comment: [
            `Server preset "${opts.name}": the game data every server set up from this project starts from (ReforgedHost/src/preset.ts).`,
            `Read from an installed Dauntless ${PACK_GAME} client for interoperability: identifiers and tuning values (item catalogue, store, progression and hunt tables), no game assets.`,
            "Sources: CatalogExporter's export from the running game, converted by Mystic Paradox's game-data generators and the host kit (npm run gamedata).",
            executableSha256 ? `Game executable SHA-256 ${executableSha256}.` : "Game executable SHA-256 not recorded (no game folder in host.json).",
            "A host's own generated game data takes precedence over this preset. Regenerate it with npm run preset -- --create; do not edit the files by hand.",
        ],
        format: PRESET_FORMAT,
        version: 1,
        name: opts.name,
        game: PACK_GAME,
        executableSha256,
        created: now.toISOString(),
        sources: ["CatalogExporter (tools/CatalogExporter in Mystic Paradox)", "Mystic Paradox game-data generators", "Dauntless Reforged Revival host kit"],
        files,
    };
    const keep = new Set([PRESET_MANIFEST, "README.md", ...files.map((f) => f.path)]);
    if (fs.existsSync(p.preset)) {
        for (const old of walk(p.preset)) {
            const rel = path.relative(p.preset, old).split(path.sep).join("/");
            if (!keep.has(rel)) fs.rmSync(old);
        }
    }
    for (const f of files) {
        const target = path.join(p.preset, ...f.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents.get(f.path)!);
    }
    fs.mkdirSync(p.preset, { recursive: true });
    fs.writeFileSync(path.join(p.preset, PRESET_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    return { manifest, left };
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

export interface PresetApplied {
    name: string;
    written: string[];
    kept: string[]; // the host's own data, which the preset does not replace
    unchanged: string[];
    backups: string[];
}

// Applies the preset to the workspace. Checks every file against the manifest before writing anything.
export function applyPreset(p: Paths, opts: { force?: boolean; now?: Date } = {}): PresetApplied | null {
    const manifest = readPresetManifest(p);
    if (!manifest) return null;
    if (manifest.game !== PACK_GAME) throw new Error(`the preset is for Dauntless ${manifest.game}; this server runs ${PACK_GAME}`);
    const entries = packEntries(p);
    const data = new Map<string, string>();
    for (const f of manifest.files) {
        if (!entries.has(f.path)) throw new Error(`the preset lists an unknown file: ${f.path}`);
        const file = path.join(p.preset, ...f.path.split("/"));
        if (!fs.existsSync(file)) throw new Error(`the preset is incomplete: ${f.path} is missing`);
        const text = fs.readFileSync(file, "utf8");
        if (sha256(text) !== f.sha256) throw new Error(`the preset's ${f.path} does not match its hash in preset.json (edited by hand? run npm run preset -- --create again)`);
        data.set(f.path, text);
    }
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const out: PresetApplied = { name: manifest.name, written: [], kept: [], unchanged: [], backups: [] };
    for (const f of manifest.files) {
        const target = entries.get(f.path)!;
        const text = data.get(f.path)!;
        if (fs.existsSync(target)) {
            const current = fs.readFileSync(target, "utf8");
            if (current === text) {
                out.unchanged.push(f.path);
                continue;
            }
            if (!isExample(target, current) && !opts.force) {
                out.kept.push(f.path);
                continue;
            }
            const backup = `${target}.${stamp}.bak`;
            fs.renameSync(target, backup);
            out.backups.push(backup);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
        out.written.push(f.path);
    }
    return out;
}
