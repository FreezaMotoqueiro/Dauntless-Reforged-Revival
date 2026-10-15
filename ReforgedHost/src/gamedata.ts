// The game data the backend and the Director read, generated from the host's own 1.14.7 install
// with Mystic Paradox's tools (docs/GENERATING_GAME_DATA.md upstream). `npm run gamedata` runs the
// steps in order from the CatalogExporter export in .workspace/Mystic-Paradox/Items_Analysis/.

import fs from "node:fs";
import path from "node:path";
import { run } from "./run";
import type { Paths } from "./paths";

export const BACKEND_GAME_DATA = [
    "progression_config.json",
    "slayers_path.json",
    "slayers_path_definitions.json",
    "ladyluck_store.json",
    "platinum_store.json",
    "reward_cache_store.json",
    "inventory_storage_policy.json",
];

export const DIRECTOR_GAME_DATA = [
    "player_hunts_table.json",
    "matchmaker_hunts_table.json",
    "arena_easy_matchmaker_hunts.json",
    "arena_hard_matchmaker_hunts.json",
    "arena_elite_matchmaker_hunts.json",
    "arena_hard_matchmaker_hunts_new.json",
    "arena_elite_matchmaker_hunts_new.json",
];

// The two files no export can produce: a response the host supplies goes in game-data/raw/.
export const SUPPLIED_SOURCES: Record<string, string> = {
    "progression_config.json": "progression_config.source.json",
    "ladyluck_store.json": "ladyluck_store.source.json",
};

export type GameDataState = "real" | "synthetic" | "missing";

function exampleOf(name: string): string {
    return name.replace(/\.json$/, ".example.json");
}

function sameBytes(a: string, b: string): boolean {
    try {
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
        return false;
    }
}

// "real": every file there and none of them is its shipped example; "synthetic": all there, some
// are the examples (start-up tests only); "missing": at least one file is not there.
export function gameDataState(dir: string, files: readonly string[]): { state: GameDataState; missing: string[]; synthetic: string[] } {
    const missing = files.filter((f) => !fs.existsSync(path.join(dir, f)));
    const synthetic = files.filter((f) => !missing.includes(f) && sameBytes(path.join(dir, f), path.join(dir, exampleOf(f))));
    return { state: missing.length ? "missing" : synthetic.length ? "synthetic" : "real", missing, synthetic };
}

// Copies the shipped examples where a file is missing. Never overwrites a file.
export function useExamples(dir: string, files: readonly string[]): string[] {
    const copied: string[] = [];
    for (const f of files) {
        const target = path.join(dir, f);
        const example = path.join(dir, exampleOf(f));
        if (fs.existsSync(target) || !fs.existsSync(example)) continue;
        fs.copyFileSync(example, target);
        copied.push(f);
    }
    return copied;
}

export interface Step {
    title: string;
    cwd: "backend" | "director";
    command: "npm" | "node";
    args: string[];
    // Skip the step (with this reason) when it returns a string.
    skipIf?: () => string | null;
}

export function gameDataSteps(p: Paths, opts: { examplesForMissing: boolean }): Step[] {
    const has = (file: string) => fs.existsSync(file);
    const exportMissing = (sub: string) => (has(path.join(p.exports, sub)) ? null : `no ${sub} in ${p.exports} yet (run the CatalogExporter, then copy Items_Analysis)`);
    const raw = (target: string) => path.join(p.rawGameData, SUPPLIED_SOURCES[target]);
    return [
        { title: "Director hunt tables", cwd: "director", command: "npm", args: ["run", "generate:hunt-tables", "--", "--apply"], skipIf: () => exportMissing("hunts_1_14_7") },
        { title: "Slayer's Path graph", cwd: "backend", command: "npm", args: ["run", "generate:slayers-path", "--", "--apply"], skipIf: () => exportMissing(path.join("slayers_path_1_14_7", "player_journey_nodes.jsonl")) },
        { title: "Slayer's Path definitions", cwd: "backend", command: "node", args: ["scripts/generate_slayers_path_definitions.cjs", "--apply"], skipIf: () => exportMissing(path.join("slayers_path_1_14_7", "player_journey_nodes.jsonl")) },
        { title: "Reward Cache store", cwd: "backend", command: "npm", args: ["run", "reward-cache:generate"], skipIf: () => exportMissing("catalog_1_14_7.jsonl") },
        {
            title: "Progression config (from a response you supply)", cwd: "backend", command: "npm", args: ["run", "generate:progression-config", "--", "--apply"],
            skipIf: () => (has(raw("progression_config.json")) ? null : `no ${SUPPLIED_SOURCES["progression_config.json"]} in ${p.rawGameData}${opts.examplesForMissing ? " (the example is used)" : ""}`),
        },
        {
            title: "Lady Luck store (from a response you supply)", cwd: "backend", command: "npm", args: ["run", "generate:ladyluck-store", "--", "--apply"],
            skipIf: () => (has(raw("ladyluck_store.json")) ? null : `no ${SUPPLIED_SOURCES["ladyluck_store.json"]} in ${p.rawGameData}${opts.examplesForMissing ? " (the example is used)" : ""}`),
        },
        {
            title: "Platinum store and storage policy", cwd: "backend", command: "npm", args: ["run", "platinum:generate"],
            skipIf: () => exportMissing("store_item_images_1_14_7.jsonl") ?? (has(path.join(p.backendGameData, "ladyluck_store.json")) && has(path.join(p.backendGameData, "reward_cache_store.json")) ? null : "needs ladyluck_store.json and reward_cache_store.json first"),
        },
    ];
}

export async function generateGameData(p: Paths, opts: { examplesForMissing: boolean; logFile: string; print: (line: string) => void }): Promise<{ ok: boolean; failed: string | null }> {
    // The graph generator fills an existing slayers_path.json, so the example goes first.
    if (!fs.existsSync(path.join(p.backendGameData, "slayers_path.json")) && fs.existsSync(path.join(p.backendGameData, "slayers_path.example.json"))) {
        fs.copyFileSync(path.join(p.backendGameData, "slayers_path.example.json"), path.join(p.backendGameData, "slayers_path.json"));
    }
    if (opts.examplesForMissing) {
        for (const target of Object.keys(SUPPLIED_SOURCES)) {
            if (!fs.existsSync(path.join(p.rawGameData, SUPPLIED_SOURCES[target]))) useExamples(p.backendGameData, [target]);
        }
    }
    for (const step of gameDataSteps(p, opts)) {
        const skip = step.skipIf?.() ?? null;
        if (skip) {
            opts.print(`- ${step.title}: skipped, ${skip}`);
            continue;
        }
        opts.print(`- ${step.title}...`);
        const r = await run(step.command, step.args, { cwd: step.cwd === "backend" ? p.backendDir : p.directorDir, logFile: opts.logFile, quiet: true });
        if (r.code !== 0) {
            opts.print(`  failed: ${r.lastLine ?? `exit ${r.code}`} (full output in ${opts.logFile})`);
            return { ok: false, failed: step.title };
        }
        opts.print("  done");
    }
    return { ok: true, failed: null };
}
