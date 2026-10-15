// Publishing the runtime: the built MysticParadox.dll and winmm.dll go to .workspace/runtime/ with
// runtime.json (what the content server lists and the launcher checks), and next to the server's
// own game executable (the Director's game servers load the same runtime).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GAME_CHANGELIST, RUNTIME_FILE_NAMES, type Paths } from "./paths";

export interface PublishedRuntime {
    version: string;
    build: { changelist: number };
    files: { name: string; size: number; sha256: string }[];
}

export function sha256File(file: string): string {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyAtomically(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, `${to}.tmp`);
    fs.renameSync(`${to}.tmp`, to);
}

export function publishRuntime(p: Paths, now: Date = new Date(), sources: Record<string, string> = { "MysticParadox.dll": p.runtimeDll, "winmm.dll": p.loaderDll }): PublishedRuntime {
    for (const name of RUNTIME_FILE_NAMES) {
        if (!fs.existsSync(sources[name])) throw new Error(`${name} is not built yet (${sources[name]})`);
    }
    fs.mkdirSync(p.runtimePublish, { recursive: true });
    const files: PublishedRuntime["files"] = [];
    for (const name of RUNTIME_FILE_NAMES) {
        const target = path.join(p.runtimePublish, name);
        copyAtomically(sources[name], target);
        files.push({ name, size: fs.statSync(target).size, sha256: sha256File(target) });
    }
    const id = createHash("sha256").update(files.map((f) => f.sha256).join(":")).digest("hex").slice(0, 8);
    const runtime: PublishedRuntime = { version: `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${id}`, build: { changelist: GAME_CHANGELIST }, files };
    // runtime.json last: the content server never sees a list whose files are not in place yet.
    fs.writeFileSync(path.join(p.runtimePublish, "runtime.json.tmp"), JSON.stringify(runtime, null, 2) + "\n");
    fs.renameSync(path.join(p.runtimePublish, "runtime.json.tmp"), path.join(p.runtimePublish, "runtime.json"));
    return runtime;
}

// Copies the published runtime next to the server's game executable. Windows refuses to replace a
// DLL a running game server has loaded; that is reported per file.
export function installServerRuntime(p: Paths, win64Dir: string): { installed: string[]; unchanged: string[]; failed: { name: string; error: string }[] } {
    const out = { installed: [] as string[], unchanged: [] as string[], failed: [] as { name: string; error: string }[] };
    for (const name of RUNTIME_FILE_NAMES) {
        const from = path.join(p.runtimePublish, name);
        const to = path.join(win64Dir, name);
        try {
            if (fs.existsSync(to) && sha256File(to) === sha256File(from)) {
                out.unchanged.push(name);
                continue;
            }
            copyAtomically(from, to);
            out.installed.push(name);
        } catch (e) {
            out.failed.push({ name, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}
