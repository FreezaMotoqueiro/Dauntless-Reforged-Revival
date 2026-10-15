// ReforgedHost: the host's command line.
//
//   npm run setup -- --mode private [--host <Tailscale IP>] --name "Friday Hunts" --game "D:\Games\Dauntless"
//   npm run setup -- --mode public --host 203.0.113.7 --name "Friday Hunts" --game "D:\Games\Dauntless"
//   npm run start
//   npm run invite -- [--uses 1] [--for "Alex"] [--unlimited] [--list]
//   npm run doctor
//   npm run gamedata [-- --examples | --example-sources]
//   npm run publish-runtime

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { portInUse, printChecks, runDoctor, tailscaleIPv4 } from "./doctor";
import { BACKEND_GAME_DATA, DIRECTOR_GAME_DATA, gameDataState, generateGameData, useExamples } from "./gamedata";
import {
    DEFAULT_MONGO_URI,
    buildEnvFiles,
    isPublicIPv4,
    isTailscaleIPv4,
    loadOrCreateSecrets,
    readEnvFile,
    readHostConfig,
    writeEnvFiles,
    writeHostConfig,
    type HostConfig,
} from "./hostconfig";
import { certificateFingerprint, createInviteCode, inviteFor, listInviteCodes } from "./invite";
import { ensureReplicaSet, findMongod, mongodArgs } from "./mongo";
import { findRepoRoot, GAME_EXE_RELATIVE, paths, PORTS, type Paths } from "./paths";
import { ensureServerFlags, installServerRuntime, publishRuntime } from "./publish";
import { capture, run } from "./run";
import { Supervisor, type ServiceSpec } from "./services";
import { ensureUpstream, gitAvailable, readPin } from "./upstream";

type Args = { _: string[]; [k: string]: string | boolean | string[] };

export function parseArgs(argv: string[]): Args {
    const out: Args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            out._.push(a);
            continue;
        }
        const eq = a.indexOf("=");
        if (eq > 0) {
            out[a.slice(2, eq)] = a.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
            out[a.slice(2)] = next;
            i++;
        } else out[a.slice(2)] = true;
    }
    return out;
}

function str(args: Args, name: string): string | undefined {
    const v = args[name];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function say(line = ""): void {
    process.stdout.write(line + "\n");
}

function fail(message: string): never {
    process.stderr.write(`\nError: ${message}\n`);
    process.exit(1);
}

function isWindowsAdmin(): boolean {
    if (process.platform !== "win32") return true;
    return spawnSync("net", ["session"], { windowsHide: true, stdio: "ignore" }).status === 0;
}

// ------------------------------------------------------------------ setup

export function hostConfigFromArgs(args: Args, existing: HostConfig | null, detect: { tailscale: () => string | null; mongod: () => string | null }): HostConfig {
    const mode = (str(args, "mode") ?? existing?.mode) as HostConfig["mode"] | undefined;
    if (mode !== "private" && mode !== "public") throw new Error("say which kind of server: --mode private (friends over Tailscale) or --mode public (a server on the internet)");
    let host = str(args, "host") ?? (existing?.mode === mode ? existing.host : undefined);
    if (!host && mode === "private") {
        host = detect.tailscale() ?? undefined;
        if (!host) throw new Error("Tailscale is not running here, so this PC's Tailscale address is unknown. Start Tailscale, or pass --host <your Tailscale IP>");
    }
    if (!host) throw new Error("a public server needs --host <its public IPv4 address or DNS name>");
    let gameAddress = str(args, "game-address") ?? (existing?.mode === mode && existing.host === host ? existing.gameAddress : undefined);
    if (!gameAddress) {
        if (mode === "private") gameAddress = isTailscaleIPv4(host) ? host : detect.tailscale() ?? undefined;
        else gameAddress = isPublicIPv4(host) ? host : undefined;
    }
    if (!gameAddress) throw new Error(mode === "private" ? "pass --game-address <your Tailscale IPv4>" : "the host is a DNS name: pass --game-address <the server's public IPv4> as well (the game servers announce an address, not a name)");
    const mongoUri = str(args, "mongo-uri") ?? existing?.mongo.uri ?? DEFAULT_MONGO_URI;
    const manage = args["no-manage-mongo"] === true ? false : args["manage-mongo"] === true ? true : existing?.mongo.manage ?? mongoUri === DEFAULT_MONGO_URI;
    const registration = (str(args, "registration")?.toUpperCase() ?? existing?.registration ?? "INVITECODE") as HostConfig["registration"];
    const gameArg = str(args, "game");
    // A full path in Windows or POSIX form (tests run on Linux with Windows paths).
    if (gameArg !== undefined && !path.win32.isAbsolute(gameArg) && !path.posix.isAbsolute(gameArg)) {
        throw new Error(`--game needs the full path of the Dauntless 1.14.7 folder, like "D:\\Games\\Dauntless" (got ${gameArg})`);
    }
    const gameDir = gameArg ?? existing?.gameDir ?? null;
    return {
        version: 1,
        mode,
        host,
        gameAddress,
        name: str(args, "name") ?? existing?.name ?? "Dauntless Reforged Revival server",
        gameDir: gameDir ? path.resolve(gameDir) : null,
        registration,
        shareUrl: mode === "private" ? str(args, "share") ?? existing?.shareUrl ?? null : null,
        mongo: { uri: mongoUri, manage, mongod: str(args, "mongod") ?? existing?.mongo.mongod ?? (manage ? detect.mongod() : null) },
        maxHuntServers: Number(str(args, "max-hunts") ?? existing?.maxHuntServers ?? 3),
    };
}

export function firewallScript(c: HostConfig, nodeExe: string): string {
    const exe = c.gameDir ? path.join(c.gameDir, GAME_EXE_RELATIVE) : null;
    const lines = [
        "# Dauntless Reforged Revival: Windows Firewall rules for this server. Written by `npm run setup`.",
        "# Run once in PowerShell as administrator:  powershell -ExecutionPolicy Bypass -File firewall.ps1",
        "$ErrorActionPreference = 'Stop'",
        "function Add-Rule($Name, $Display, $Protocol, $Port, $Program, $Remote, $Enabled) {",
        "    if (Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue) { Write-Host \"$Display already exists\"; return }",
        "    $Params = @{ Name = $Name; DisplayName = $Display; Direction = 'Inbound'; Action = 'Allow'; Protocol = $Protocol; LocalPort = $Port; Profile = 'Any'; Enabled = $Enabled }",
        "    if ($Program) { $Params.Program = $Program }",
        "    if ($Remote) { $Params.RemoteAddress = $Remote }",
        "    New-NetFirewallRule @Params | Out-Null",
        "    Write-Host \"added $Display\"",
        "}",
    ];
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    if (c.mode === "public") {
        lines.push(
            `Add-Rule 'ReforgedRevival-Gateway' 'Dauntless Reforged Revival gateway (TCP ${PORTS.publicGateway})' 'TCP' '${PORTS.publicGateway}' ${q(nodeExe)} $null 'True'`,
            "# The game ports start closed: the allowlist helper opens them only for players who logged in.",
            `Add-Rule 'ReforgedRevival-GamePorts-Allowlist' 'Dauntless Reforged Revival game ports (allowlist)' 'UDP' '${PORTS.gameFirst}-${PORTS.gameLast}' ${exe ? q(exe) : "$null"} $null 'False'`,
        );
    } else {
        lines.push(
            "# Only from Tailscale addresses: nobody else can reach these.",
            `Add-Rule 'ReforgedRevival-Gateway-Tailnet' 'Dauntless Reforged Revival gateway (TCP ${PORTS.privateGateway}, Tailscale)' 'TCP' '${PORTS.privateGateway}' ${q(nodeExe)} '100.64.0.0/10' 'True'`,
            `Add-Rule 'ReforgedRevival-GamePorts-Tailnet' 'Dauntless Reforged Revival game ports (Tailscale)' 'UDP' '${PORTS.gameFirst}-${PORTS.gameLast}' ${exe ? q(exe) : "$null"} '100.64.0.0/10' 'True'`,
        );
    }
    return lines.join("\r\n") + "\r\n";
}

async function npmInstallAndBuild(dir: string, logFile: string, label: string): Promise<void> {
    say(`- ${label}: npm ci`);
    let r = await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, logFile, quiet: true });
    if (r.code !== 0) fail(`npm ci failed in ${dir}: ${r.lastLine ?? r.code} (full output in ${logFile})`);
    say(`- ${label}: npm run build`);
    r = await run("npm", ["run", "build"], { cwd: dir, logFile, quiet: true });
    if (r.code !== 0) fail(`npm run build failed in ${dir}: ${r.lastLine ?? r.code} (full output in ${logFile})`);
}

async function setup(p: Paths, args: Args): Promise<void> {
    if (!gitAvailable()) fail("git is needed (it downloads Mystic Paradox at the pinned commit): install Git for Windows from https://git-scm.com");
    // A value with spaces that was not quoted arrives in pieces (--game D:\Games\My, then Dauntless).
    if (args._.length > 1) fail(`unexpected "${args._.slice(1).join(" ")}": put a value with spaces in quotes, for example --game "D:\\Games\\Dauntless 1.14.7\\Dauntless"`);
    const logFile = path.join(p.logs, "setup.log");
    fs.mkdirSync(p.logs, { recursive: true });

    let existing: HostConfig | null = null;
    try {
        existing = readHostConfig(p.hostJson);
    } catch (e) {
        say(`(ignoring the old host.json: ${e instanceof Error ? e.message : String(e)})`);
    }
    let config: HostConfig;
    try {
        config = hostConfigFromArgs(args, existing, { tailscale: tailscaleIPv4, mongod: () => findMongod() });
        writeHostConfig(p.hostJson, config);
        config = readHostConfig(p.hostJson) as HostConfig;
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }
    say(`\n${config.mode === "public" ? "Public" : "Private"} server "${config.name}" at ${config.host} (game servers on ${config.gameAddress})`);

    say("\n1. Mystic Paradox at the pinned commit, with the Reforged patches");
    const pin = readPin(p.upstreamPin);
    try {
        const result = await ensureUpstream({ dir: p.upstream, markerFile: p.marker, pin, patchesRoot: p.patchesDir, logFile, force: args["force-upstream"] === true });
        say(`- ${result === "already_ready" ? "already in place" : result === "fetched" ? "downloaded and patched" : "updated and patched (your SDK, game data and exports were kept)"}: ${pin.commit.slice(0, 12)} in ${p.upstream}`);
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }

    if (args["skip-install"] !== true) {
        say("\n2. Installing and building the services (a few minutes the first time)");
        await npmInstallAndBuild(p.backendDir, logFile, "backend");
        await npmInstallAndBuild(p.directorDir, logFile, "Director");
        await npmInstallAndBuild(p.gatewayDir, logFile, "gateway");
        await npmInstallAndBuild(p.contentDir, logFile, "content server");
    } else say("\n2. Skipped installing and building (--skip-install)");

    say("\n3. Configuration");
    const { secrets, created } = loadOrCreateSecrets(p.config);
    say(`- secrets: ${created ? "made (kept from now on)" : "kept"} in ${path.join(p.config, "secrets.env")}`);
    for (const dir of [p.runtimePublish, p.branding, p.gameserverLogs, p.mongoData, p.rawGameData]) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(p.newsFile)) fs.writeFileSync(p.newsFile, JSON.stringify({ items: [] }, null, 2) + "\n");
    const sourceCommit = capture("git", ["rev-parse", "--short=12", "HEAD"], p.repo) ?? "";
    const written = writeEnvFiles(p, buildEnvFiles(config, secrets, p, { sourceCommit }));
    say(`- env files: ${written.map((f) => path.basename(f)).join(", ")} in ${p.config}`);
    fs.writeFileSync(path.join(p.config, "firewall.ps1"), firewallScript(config, process.execPath));
    say(`- firewall rules to add once (as administrator): ${path.join(p.config, "firewall.ps1")}`);

    if (config.mode === "public") {
        if (!fs.existsSync(p.certFile)) {
            const hosts = [...new Set([config.host, config.gameAddress])].flatMap((h) => ["--host", h]);
            const r = await run(process.execPath, [path.join(p.gatewayDir, "tools", "make-cert.js"), ...hosts, "--out", p.tls, "--json"], { cwd: p.gatewayDir, logFile, quiet: true });
            if (r.code !== 0) fail(`could not make the gateway certificate: ${r.lastLine}`);
            say(`- gateway certificate made in ${p.tls}`);
        } else say(`- gateway certificate kept (a new one would change every invite): ${p.certFile}`);
        say(`- certificate fingerprint (goes into every invite): ${certificateFingerprint(p.certFile)}`);
    }

    if (config.mongo.manage && !config.mongo.mongod) say("\n! MongoDB was not found. Install MongoDB Community Server (https://www.mongodb.com/try/download/community), then run setup again, or pass --mongod <path to mongod.exe>.");
    if (!config.gameDir) say("\n! No game folder yet: pass --game \"<your Dauntless 1.14.7 folder>\" (the game servers run from it).");
    else if (!fs.existsSync(path.join(config.gameDir, GAME_EXE_RELATIVE))) say(`\n! No ${GAME_EXE_RELATIVE} in ${config.gameDir}: pass --game "<the Dauntless folder that holds Archon>" (the game servers run from it).`);

    say("\nSetup done. Next:");
    say("  1. The SDK, the runtime and the game data, from your own game: docs/sdk-and-game-data.md");
    say("     (the launcher's Host tools page does most of it: Settings > Advanced > Host tools)");
    say("  2. npm run publish-runtime");
    say("  3. npm run start");
    say("  4. npm run invite -- --for \"Alex\"");
    say("  npm run doctor shows what is still missing.");
}

// ------------------------------------------------------------------ start

async function start(p: Paths): Promise<void> {
    let loaded: HostConfig | null;
    try {
        loaded = readHostConfig(p.hostJson);
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }
    if (!loaded) fail("not set up yet: run npm run setup first");
    const config: HostConfig = loaded;
    for (const name of ["backend", "director", "content", "gateway"]) {
        if (!fs.existsSync(path.join(p.config, `${name}.env`))) fail(`${name}.env is missing: run npm run setup`);
    }
    if (config.mode === "public" && !isWindowsAdmin()) {
        fail("a public server changes Windows Firewall rules (the allowlist helper) and listens on port 443: run this terminal as administrator");
    }
    const gd = [gameDataState(p.backendGameData, BACKEND_GAME_DATA), gameDataState(p.directorGameData, DIRECTOR_GAME_DATA)];
    if (gd.some((g) => g.state === "missing")) fail("game data is missing: npm run gamedata (or npm run gamedata -- --examples for a start-up test only)");
    if (gd.some((g) => g.state === "synthetic")) say("! This server runs on example game data: it starts, but it is not playable. The launcher tells players so.");
    if (!fs.existsSync(path.join(p.runtimePublish, "runtime.json"))) say("! No runtime published yet: players can join but not play. Build it and run npm run publish-runtime.");
    const win64 = config.gameDir ? path.dirname(path.join(config.gameDir, GAME_EXE_RELATIVE)) : null;
    if (win64 && fs.existsSync(win64)) {
        const flags = ensureServerFlags(win64);
        if (flags.length) say(`Turned on for the game servers: ${flags.join(", ")} (in ${win64})`);
    }

    const width = 9;
    const supervisor = new Supervisor(p.logs, (name, line) => process.stdout.write(`${name.padEnd(width)}| ${line}\n`));
    const node = process.execPath;

    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        say("\nStopping...");
        await supervisor.stopAll();
        if (config.mode === "public") {
            // A hard stop never lets the helper close the game ports itself (Dauntless Revived's README).
            await run(node, [path.join(p.gatewayDir, "dist", "allowlist", "server.js"), "--close-ports"], { cwd: p.gatewayDir, quiet: true, env: { ...process.env, ...readEnvForProcess(p, "allowlist") } });
        }
        say("Stopped.");
        process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    process.on("SIGBREAK", () => void stop());

    if (config.mongo.manage) {
        const mongod = config.mongo.mongod ?? findMongod();
        if (!mongod) fail("MongoDB (mongod) was not found: install MongoDB Community Server, or run setup with --mongod <path>");
        if (await portInUse(PORTS.mongo)) {
            // A mongod left running by an earlier start is a replica set and can be used. The Windows
            // service the MongoDB installer adds by default is not, and the backend needs one.
            const there = await ensureReplicaSet(p.backendDir, config.mongo.uri, { initiate: false, timeoutMs: 4000 });
            if (!there.ok) {
                fail(`port ${PORTS.mongo} is already taken${there.reason === "standalone" ? " by a MongoDB without a replica set, usually the MongoDB Windows service" : ""}. The host kit runs its own MongoDB: stop the other one first. For the Windows service, in PowerShell as administrator: Stop-Service MongoDB; Set-Service MongoDB -StartupType Disabled`);
            }
            say(`- MongoDB is already running on port ${PORTS.mongo} (replica set ${there.setName}): using it`);
        } else {
            fs.mkdirSync(p.mongoData, { recursive: true });
            await supervisor.start({ name: "mongod", cwd: p.workspace, command: mongod, args: mongodArgs(p.mongoData, path.join(p.logs, "mongod-server.log"), PORTS.mongo), envFile: null, ready: { port: PORTS.mongo, tcp: true } }, 60000);
        }
    }
    const backendEnv = readEnvForProcess(p, "backend");
    const mongo = await ensureReplicaSet(p.backendDir, backendEnv.MONGODB_URI ?? config.mongo.uri, { initiate: true, timeoutMs: 8000 });
    if (!mongo.ok) {
        await supervisor.stopAll();
        fail(`MongoDB: ${mongo.detail}`);
    }
    if (mongo.initiated) say(`mongod   | replica set ${mongo.setName} initiated`);

    const specs: ServiceSpec[] = [
        { name: "backend", cwd: p.backendDir, command: node, args: ["build/server.js"], envFile: path.join(p.config, "backend.env"), ready: { port: PORTS.backend, path: "/dauntless-status" } },
        { name: "director", cwd: p.directorDir, command: node, args: ["dist/server.js"], envFile: path.join(p.config, "director.env"), ready: { port: PORTS.director, path: "/api/instances" }, killTree: true },
        { name: "content", cwd: p.contentDir, command: node, args: ["dist/server.js"], envFile: path.join(p.config, "content.env"), ready: { port: PORTS.content, path: "/content/v1/news" } },
    ];
    if (config.mode === "public") {
        specs.push({ name: "allowlist", cwd: p.gatewayDir, command: node, args: ["dist/allowlist/server.js"], envFile: path.join(p.config, "allowlist.env"), ready: { port: PORTS.allowlist, path: "/status" } });
    }
    specs.push({
        name: "gateway",
        cwd: p.gatewayDir,
        command: node,
        args: ["dist/server.js"],
        envFile: path.join(p.config, "gateway.env"),
        ready: config.mode === "public" ? { port: PORTS.publicGateway, tcp: true } : { port: PORTS.privateGateway, host: config.gameAddress, tcp: true },
    });
    for (const spec of specs) {
        const ok = await supervisor.start(spec, spec.name === "backend" ? 120000 : 60000);
        if (!ok && (spec.name === "backend" || spec.name === "gateway")) {
            say(`\n${spec.name} did not come up. Its log: ${path.join(p.logs, `${spec.name}.log`)}`);
            await stop();
            return;
        }
    }
    say("");
    say(`Server "${config.name}" is up: ${config.mode === "public" ? `https://${config.host}:${PORTS.publicGateway} (pinned TLS)` : `http://${config.host}:${PORTS.privateGateway} inside your tailnet`}`);
    say("Make an invite in another terminal: npm run invite -- --for \"Alex\"");
    say("Ctrl+C stops everything.");
}

function readEnvForProcess(p: Paths, name: string): Record<string, string> {
    return readEnvFile(path.join(p.config, `${name}.env`));
}

// ------------------------------------------------------------------ invite, gamedata, runtime

async function invite(p: Paths, args: Args): Promise<void> {
    const config = readHostConfig(p.hostJson);
    if (!config) fail("not set up yet: run npm run setup first");
    const { secrets } = loadOrCreateSecrets(p.config);
    if (args.list === true) {
        say(JSON.stringify(await listInviteCodes(secrets.adminKey), null, 2));
        return;
    }
    const uses = Number(str(args, "uses") ?? "1");
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) fail("--uses must be a whole number from 1 to 1000");
    let code: string;
    try {
        code = await createInviteCode(secrets.adminKey, { uses, infinite: args.unlimited === true, note: str(args, "for") });
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }
    const fp = config.mode === "public" ? certificateFingerprint(p.certFile) : null;
    const link = inviteFor(config, code, fp);
    say(`\nInvite${str(args, "for") ? ` for ${str(args, "for")}` : ""} (${args.unlimited === true ? "unlimited uses" : `${uses} use${uses === 1 ? "" : "s"}`}):\n`);
    say(`  ${link}\n`);
    say("Send the whole line. They paste it into the Dauntless Reforged Revival launcher (or click it once the launcher is installed).");
    if (config.mode === "private") say(`They also need Tailscale, and access to this PC: share it from https://login.tailscale.com/admin/machines${config.shareUrl ? "" : " (or put the share link in invites with npm run setup -- --share <link>)"}.`);
}

async function gamedata(p: Paths, args: Args): Promise<void> {
    if (!fs.existsSync(p.backendDir)) fail("not set up yet: run npm run setup first");
    if (args.examples === true) {
        const copied = [...useExamples(p.backendGameData, BACKEND_GAME_DATA), ...useExamples(p.directorGameData, DIRECTOR_GAME_DATA)];
        say(copied.length ? `Copied the example data for ${copied.join(", ")}.` : "Nothing was missing.");
        say("Example data lets the services start for a test. It is not playable: export the real data from your game (docs/sdk-and-game-data.md).");
        return;
    }
    say("Generating the game data from your export (Items_Analysis):");
    const r = await generateGameData(p, { examplesForMissing: args["example-sources"] === true, logFile: path.join(p.logs, "gamedata.log"), print: say });
    for (const [label, dir, files] of [["backend", p.backendGameData, BACKEND_GAME_DATA], ["Director", p.directorGameData, DIRECTOR_GAME_DATA]] as const) {
        const g = gameDataState(dir, files);
        say(`${label}: ${g.state}${g.missing.length ? ` (missing ${g.missing.join(", ")})` : ""}${g.synthetic.length ? ` (example data in ${g.synthetic.join(", ")})` : ""}`);
    }
    if (!r.ok) process.exit(1);
}

function publish(p: Paths): void {
    let runtime;
    try {
        runtime = publishRuntime(p);
    } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
    }
    say(`Runtime ${runtime.version} published in ${p.runtimePublish}:`);
    for (const f of runtime.files) say(`  ${f.name}  ${f.size} bytes  ${f.sha256}`);
    say("Players see these hashes and accept them once in the launcher.");
    const config = readHostConfig(p.hostJson);
    if (config?.gameDir) {
        const win64 = path.dirname(path.join(config.gameDir, GAME_EXE_RELATIVE));
        const r = installServerRuntime(p, win64);
        if (r.installed.length) say(`Installed for the game servers in ${win64}: ${r.installed.join(", ")}`);
        if (r.failed.length) say(`! Could not replace ${r.failed.map((f) => f.name).join(", ")} in ${win64} (a game server still running? stop the server and run this again): ${r.failed[0].error}`);
        ensureServerFlags(win64);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0] ?? "help";
    const p = paths(findRepoRoot());
    switch (command) {
        case "setup":
            return setup(p, args);
        case "start":
            return start(p);
        case "invite":
            return invite(p, args);
        case "doctor": {
            const { fails, warns } = printChecks(await runDoctor(p, { hashExe: args["no-hash"] !== true }), say);
            say(`\n${fails} problem${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.`);
            process.exit(fails ? 1 : 0);
        }
        case "gamedata":
            return gamedata(p, args);
        case "publish-runtime":
            return publish(p);
        default:
            say("Dauntless Reforged Revival host kit. Commands (from the ReforgedHost folder):");
            say("  npm run setup -- --mode private|public [--host <address>] --name \"<server name>\" --game \"<Dauntless 1.14.7 folder>\"");
            say("                   [--game-address <IPv4>] [--registration INVITECODE|OPEN|NONE] [--share <Tailscale share link>]");
            say("                   [--mongo-uri <uri>] [--no-manage-mongo] [--mongod <path>] [--max-hunts 1-6] [--skip-install] [--force-upstream]");
            say("  npm run start");
            say("  npm run invite -- [--uses N] [--unlimited] [--for \"<who>\"] [--list]");
            say("  npm run doctor [-- --no-hash]");
            say("  npm run gamedata [-- --examples | --example-sources]");
            say("  npm run publish-runtime");
            say("See README.md and ../docs/hosting.md.");
    }
}

if (require.main === module) {
    main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
}
