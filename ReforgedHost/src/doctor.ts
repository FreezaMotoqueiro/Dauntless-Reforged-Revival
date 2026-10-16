// `npm run doctor`: everything the server needs, checked from the files on this PC and the services
// that answer. Each check says what to do when it fails.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { gameDataState, BACKEND_GAME_DATA, DIRECTOR_GAME_DATA } from "./gamedata";
import { readHostConfig, readEnvFile, SECRET_FILE, type HostConfig } from "./hostconfig";
import { certificateFingerprint } from "./invite";
import { ensureReplicaSet } from "./mongo";
import { GAME_EXE_RELATIVE, GAME_VERSION_TEXT, PINNED_EXE_SHA256, PORTS, RUNTIME_FILE_NAMES, type Paths } from "./paths";
import { sha256File } from "./publish";
import { capture } from "./run";
import { readPin, upstreamState } from "./upstream";
import { waitForHttp } from "./services";

export type Level = "ok" | "warn" | "fail" | "info";

export interface Check {
    area: string;
    level: Level;
    text: string;
    fix?: string;
}

function nodeVersionOk(version: string): boolean {
    const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
    return major > 20 || (major === 20 && minor >= 19);
}

export function countFunctionFiles(sdkDir: string): number {
    try {
        return fs.readdirSync(sdkDir).filter((n) => n.endsWith("_functions.cpp")).length;
    } catch {
        return 0;
    }
}

export function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        socket.setTimeout(800);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => resolve(false));
    });
}

export function tailscaleIPv4(): string | null {
    const out = capture("tailscale", ["ip", "-4"]);
    const first = out?.split(/\r?\n/)[0]?.trim() ?? "";
    return net.isIPv4(first) ? first : null;
}

export function gameChecks(gameDir: string | null, opts: { hashExe: boolean }): Check[] {
    if (!gameDir) return [{ area: "game", level: "fail", text: "no game folder for the dedicated game servers", fix: "npm run setup -- --game \"D:\\Games\\Dauntless\"" }];
    const exe = path.join(gameDir, GAME_EXE_RELATIVE);
    if (!fs.existsSync(exe)) return [{ area: "game", level: "fail", text: `no game executable at ${exe}`, fix: "point --game at the Dauntless folder (the one with Archon inside)" }];
    const out: Check[] = [];
    let versionText = "";
    try {
        versionText = fs.readFileSync(path.join(gameDir, "Version.txt"), "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/)[0] ?? "";
    } catch {
        /* none */
    }
    out.push(versionText === GAME_VERSION_TEXT
        ? { area: "game", level: "ok", text: `Version.txt: ${versionText}` }
        : { area: "game", level: "warn", text: `Version.txt says ${JSON.stringify(versionText || "nothing")}, not ${GAME_VERSION_TEXT}` });
    if (opts.hashExe) {
        const hash = sha256File(exe);
        out.push(hash === PINNED_EXE_SHA256
            ? { area: "game", level: "ok", text: "the executable is the Dauntless 1.14.7 build (SHA-256 matches)" }
            : { area: "game", level: "fail", text: `the executable is another build (SHA-256 ${hash.slice(0, 16)}…)`, fix: "install 1.14.7 with Legendary (docs/players.md) for the server too" });
    }
    return out;
}

export async function runDoctor(p: Paths, opts: { hashExe?: boolean } = {}): Promise<Check[]> {
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);

    // ---- tools
    add(nodeVersionOk(process.version) ? { area: "tools", level: "ok", text: `Node.js ${process.version}` } : { area: "tools", level: "fail", text: `Node.js ${process.version} is too old`, fix: "install Node.js 20.19 or newer (https://nodejs.org)" });
    const gitVersion = capture("git", ["--version"]);
    add(gitVersion ? { area: "tools", level: "ok", text: gitVersion } : { area: "tools", level: "fail", text: "git is not installed", fix: "install Git for Windows (https://git-scm.com)" });

    // ---- upstream
    let pinCommit = "?";
    try {
        const pin = readPin(p.upstreamPin);
        pinCommit = pin.commit.slice(0, 12);
        const state = upstreamState(p.upstream, p.marker, pin, p.patchesDir);
        const text: Record<typeof state, Check> = {
            ready: { area: "upstream", level: "ok", text: `Mystic Paradox ${pinCommit} with the Reforged patches` },
            missing: { area: "upstream", level: "fail", text: "Mystic Paradox is not downloaded yet", fix: "npm run setup" },
            not_git: { area: "upstream", level: "fail", text: `${p.upstream} is not a git checkout`, fix: "move it away (keep its SDK and game-data files) and run npm run setup" },
            unpatched: { area: "upstream", level: "fail", text: "the Reforged patches are not applied", fix: "npm run setup" },
            outdated: { area: "upstream", level: "warn", text: `the upstream source is not the pinned ${pinCommit} with the current patches`, fix: "npm run setup (it keeps the SDK, game data and exports)" },
        };
        add(text[state]);
    } catch (e) {
        add({ area: "upstream", level: "fail", text: e instanceof Error ? e.message : String(e) });
    }
    const built: [string, string][] = [
        ["backend", path.join(p.backendDir, "build", "server.js")],
        ["Director", path.join(p.directorDir, "dist", "server.js")],
        ["gateway", path.join(p.gatewayDir, "dist", "server.js")],
        ["content server", path.join(p.contentDir, "dist", "server.js")],
    ];
    for (const [name, file] of built) add(fs.existsSync(file) ? { area: "services", level: "ok", text: `${name} built` } : { area: "services", level: "fail", text: `${name} is not built`, fix: "npm run setup" });

    // ---- configuration
    let config: HostConfig | null = null;
    try {
        config = readHostConfig(p.hostJson);
    } catch (e) {
        add({ area: "config", level: "fail", text: `host.json: ${e instanceof Error ? e.message : String(e)}`, fix: "npm run setup -- --mode ... --host ..." });
    }
    if (config) {
        add({ area: "config", level: "ok", text: `${config.mode} server "${config.name}" at ${config.host}, game servers on ${config.gameAddress}` });
        const missingEnv = ["backend", "director", "content", "gateway", ...(config.mode === "public" ? ["allowlist"] : [])].filter((n) => !fs.existsSync(path.join(p.config, `${n}.env`)));
        add(missingEnv.length === 0 && fs.existsSync(path.join(p.config, SECRET_FILE))
            ? { area: "config", level: "ok", text: "env files and secrets written" }
            : { area: "config", level: "fail", text: `missing ${[...missingEnv.map((n) => `${n}.env`), ...(fs.existsSync(path.join(p.config, SECRET_FILE)) ? [] : [SECRET_FILE])].join(", ")}`, fix: "npm run setup" });
        for (const c of gameChecks(config.gameDir, { hashExe: opts.hashExe !== false })) add(c);
        if (config.mode === "private") {
            const ip = tailscaleIPv4();
            add(ip === null
                ? { area: "network", level: "fail", text: "Tailscale is not running on this PC", fix: "install and sign in to Tailscale (https://tailscale.com/download)" }
                : ip === config.gameAddress
                    ? { area: "network", level: "ok", text: `Tailscale ${ip}` }
                    : { area: "network", level: "fail", text: `this PC's Tailscale address is ${ip}, host.json says ${config.gameAddress}`, fix: `npm run setup -- --host ${ip}` });
        } else {
            if (fs.existsSync(p.certFile)) {
                add({ area: "network", level: "ok", text: `gateway certificate ${certificateFingerprint(p.certFile)}` });
            } else add({ area: "network", level: "fail", text: "no gateway certificate", fix: "npm run setup" });
            add({ area: "network", level: "info", text: `open inbound TCP ${PORTS.publicGateway} and UDP ${PORTS.gameFirst}-${PORTS.gameLast} (run .workspace\\config\\firewall.ps1 as administrator); forward them on your router if this PC is behind NAT` });
        }
    }

    // ---- SDK, builds, runtime
    const functions = countFunctionFiles(p.sdkDir);
    add(fs.existsSync(p.sdkHeader) && functions > 0
        ? { area: "sdk", level: "ok", text: `Dumper-7 SDK imported (${functions} *_functions.cpp files)` }
        : { area: "sdk", level: "fail", text: "no SDK in ParadoxRuntime yet", fix: "dump it with Dumper-7 from your own 1.14.7 game (launcher > Settings > Host tools, or docs/sdk-and-game-data.md)" });
    add(fs.existsSync(p.runtimeDll) ? { area: "runtime", level: "ok", text: "MysticParadox.dll built" } : { area: "runtime", level: "fail", text: "MysticParadox.dll is not built", fix: "build ParadoxRuntime (Host tools page, or ParadoxRuntime\\_build.bat)" });
    add(fs.existsSync(p.loaderDll) ? { area: "runtime", level: "ok", text: "winmm.dll built" } : { area: "runtime", level: "fail", text: "winmm.dll is not built", fix: "cargo build --release in tools\\RuntimeLoader (Host tools page)" });
    const published = RUNTIME_FILE_NAMES.every((n) => fs.existsSync(path.join(p.runtimePublish, n))) && fs.existsSync(path.join(p.runtimePublish, "runtime.json"));
    add(published ? { area: "runtime", level: "ok", text: "runtime published for players" } : { area: "runtime", level: "fail", text: "no runtime published for players", fix: "npm run publish-runtime" });
    if (published && config?.gameDir) {
        const win64 = path.dirname(path.join(config.gameDir, GAME_EXE_RELATIVE));
        const same = RUNTIME_FILE_NAMES.every((n) => fs.existsSync(path.join(win64, n)) && sha256File(path.join(win64, n)) === sha256File(path.join(p.runtimePublish, n)));
        add(same ? { area: "runtime", level: "ok", text: "the game servers use the published runtime" } : { area: "runtime", level: "fail", text: "the server's game folder does not have the published runtime", fix: "npm run publish-runtime, then restart the server" });
    }

    // ---- game data
    for (const [label, dir, files] of [["backend", p.backendGameData, BACKEND_GAME_DATA], ["Director", p.directorGameData, DIRECTOR_GAME_DATA]] as const) {
        const g = gameDataState(dir, files);
        add(g.state === "real"
            ? { area: "game data", level: "ok", text: `${label}: real data` }
            : g.state === "synthetic"
                ? { area: "game data", level: "warn", text: `${label}: example data in ${g.synthetic.join(", ")} (start-up tests only, not playable)`, fix: "export from your game and npm run gamedata (docs/sdk-and-game-data.md)" }
                : { area: "game data", level: "fail", text: `${label}: missing ${g.missing.join(", ")}`, fix: "npm run gamedata, or npm run gamedata -- --examples for a first start-up test" });
    }

    // ---- database and running services
    if (config) {
        const backendEnv = readEnvFile(path.join(p.config, "backend.env"));
        const uri = backendEnv.MONGODB_URI ?? config.mongo.uri;
        const mongo = await ensureReplicaSet(p.backendDir, uri, { initiate: false, timeoutMs: 2500 });
        if (mongo.ok) add(mongo.primary ? { area: "database", level: "ok", text: `MongoDB replica set ${mongo.setName}, primary` } : { area: "database", level: "warn", text: `MongoDB replica set ${mongo.setName}, but no primary yet` });
        else if (mongo.reason === "unreachable") add({ area: "database", level: config.mongo.manage ? "info" : "fail", text: `MongoDB is not answering at ${uri}`, fix: config.mongo.manage ? "npm run start starts it" : "start your MongoDB, with replication.replSetName: rs0" });
        else add({ area: "database", level: "fail", text: mongo.detail });
    }
    const up: [string, number, string][] = [["backend", PORTS.backend, "/dauntless-status"], ["Director", PORTS.director, "/api/instances"], ["content server", PORTS.content, "/content/v1/news"]];
    for (const [name, port, urlPath] of up) {
        const answering = (await portInUse(port)) && (await waitForHttp(port, urlPath, 1500));
        add({ area: "running", level: "info", text: `${name} ${answering ? "is running" : "is not running"} (127.0.0.1:${port})` });
    }
    return checks;
}

export function printChecks(checks: Check[], print: (line: string) => void = console.log): { fails: number; warns: number } {
    const mark: Record<Level, string> = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]", info: "[info]" };
    let area = "";
    for (const c of checks) {
        if (c.area !== area) {
            area = c.area;
            print(`\n${area}`);
        }
        print(`  ${mark[c.level]} ${c.text}`);
        if (c.fix && c.level !== "ok") print(`         -> ${c.fix}`);
    }
    return { fails: checks.filter((c) => c.level === "fail").length, warns: checks.filter((c) => c.level === "warn").length };
}
