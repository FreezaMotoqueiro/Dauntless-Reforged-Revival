import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { hostConfigFromArgs, parseArgs, performanceFromArgs, performanceSummary } from "../src/cli";
import { performanceChecks, runtimeCpuPatches } from "../src/doctor";
import { buildEnvFiles, DEFAULT_MONGO_URI, DEFAULT_PERFORMANCE, newSecrets, QUIET_GAME_LOG_CMDS, validateHostConfig, type HostConfig } from "../src/hostconfig";
import { MONGO_CACHE_GB, mongodArgs } from "../src/mongo";
import { paths } from "../src/paths";
import { tempDir, write } from "./helpers";

const PUBLIC: HostConfig = {
    version: 1,
    mode: "public",
    host: "203.0.113.7",
    gameAddress: "203.0.113.7",
    name: "Friday Hunts",
    gameDir: "/home/reforged/games/Dauntless",
    registration: "INVITECODE",
    shareUrl: null,
    mongo: { uri: DEFAULT_MONGO_URI, manage: true, mongod: "/usr/bin/mongod" },
    maxHuntServers: 3,
};

const detect = { tailscale: () => null, mongod: () => "/usr/bin/mongod", platform: "linux" as NodeJS.Platform };
const repo = path.resolve(__dirname, "..", "..", "..", "..");

function get(entries: [string, string][], key: string): string | undefined {
    return entries.find(([k]) => k === key)?.[1];
}

describe("performance: director.env", () => {
    const s = newSecrets();
    const p = paths("/home/reforged/Reforged");

    it("caps the game servers at 30 fps (10 when nobody is on them), starts the Training Grounds on demand and keeps the game logs quiet, on Linux and Windows", () => {
        for (const platform of ["linux", "win32"] as const) {
            const f = buildEnvFiles(PUBLIC, s, p, { platform });
            assert.equal(get(f.director, "REFORGED_SERVER_MAX_FPS"), "30");
            assert.equal(get(f.director, "REFORGED_SERVER_IDLE_FPS"), "10");
            assert.equal(get(f.director, "TRAINING_ON_DEMAND"), "1");
            assert.equal(get(f.director, "GAMESERVER_LOG_CMDS"), QUIET_GAME_LOG_CMDS);
        }
    });

    it("follows host.json: no cap, Training Grounds at boot, upstream's verbose logs", () => {
        const f = buildEnvFiles({ ...PUBLIC, performance: { serverFps: 0, idleFps: 0, trainingOnDemand: false, verboseGameLogs: true } }, s, p, { platform: "linux" });
        assert.equal(get(f.director, "REFORGED_SERVER_MAX_FPS"), "0");
        assert.equal(get(f.director, "REFORGED_SERVER_IDLE_FPS"), "0");
        assert.equal(get(f.director, "TRAINING_ON_DEMAND"), "0");
        assert.equal(get(f.director, "GAMESERVER_LOG_CMDS"), undefined, "the Director keeps its own default");
    });

    it("writes only values the runtime and the Director accept", () => {
        // The Director's check for GAMESERVER_LOG_CMDS (patch 0021).
        assert.match(QUIET_GAME_LOG_CMDS, /^[A-Za-z0-9_, ]{1,512}$/);
        const runtime = fs.readFileSync(path.join(repo, "upstream", "patches", "0020-runtime-server-frame-cap.patch"), "utf8");
        assert.ok(runtime.includes('"REFORGED_SERVER_MAX_FPS", 30, 10, 240'));
        assert.ok(runtime.includes('"REFORGED_SERVER_IDLE_FPS", 0, 1, 240'));
        const director = fs.readFileSync(path.join(repo, "upstream", "patches", "0021-director-training-on-demand-and-log-levels.patch"), "utf8");
        assert.ok(director.includes("process.env.TRAINING_ON_DEMAND"));
        assert.ok(director.includes("process.env.GAMESERVER_LOG_CMDS"));
    });

    it("refuses frame rates and switches the runtime would not take", () => {
        const bad: [Partial<NonNullable<HostConfig["performance"]>>, RegExp][] = [
            [{ serverFps: 5 }, /serverFps/],
            [{ serverFps: 241 }, /serverFps/],
            [{ serverFps: 29.5 }, /serverFps/],
            [{ idleFps: -1 }, /idleFps/],
            [{ idleFps: 300 }, /idleFps/],
        ];
        for (const [perf, error] of bad) {
            assert.throws(() => validateHostConfig({ ...PUBLIC, performance: { ...DEFAULT_PERFORMANCE, ...perf } }), error);
        }
        assert.throws(() => validateHostConfig({ ...PUBLIC, performance: { ...DEFAULT_PERFORMANCE, trainingOnDemand: "yes" as unknown as boolean } }), /trainingOnDemand/);
        assert.equal(validateHostConfig({ ...PUBLIC, performance: { ...DEFAULT_PERFORMANCE, idleFps: 1 } }).performance?.idleFps, 1);
    });
});

describe("performance: setup options", () => {
    it("defaults, keeps what host.json had, and takes each option", () => {
        assert.deepEqual(performanceFromArgs(parseArgs([]), undefined), DEFAULT_PERFORMANCE);
        const set = performanceFromArgs(parseArgs(["--server-fps", "60", "--idle-fps", "0", "--training-at-boot", "--verbose-game-logs"]), undefined);
        assert.deepEqual(set, { serverFps: 60, idleFps: 0, trainingOnDemand: false, verboseGameLogs: true });
        assert.deepEqual(performanceFromArgs(parseArgs([]), set), set, "kept on the next setup");
        assert.deepEqual(performanceFromArgs(parseArgs(["--training-on-demand", "--quiet-game-logs"]), set), { ...set, trainingOnDemand: true, verboseGameLogs: false });
        assert.throws(() => performanceFromArgs(parseArgs(["--server-fps", "5"]), undefined), /--server-fps/);
        assert.throws(() => performanceFromArgs(parseArgs(["--idle-fps", "fast"]), undefined), /--idle-fps/);
    });

    it("goes into host.json with setup, and an older host.json without it gets the defaults", () => {
        const c = hostConfigFromArgs(parseArgs(["--mode", "public", "--host", "203.0.113.7", "--server-fps", "45"]), null, detect);
        assert.equal(c.performance?.serverFps, 45);
        assert.equal(validateHostConfig(c).performance?.serverFps, 45);
        const again = hostConfigFromArgs(parseArgs([]), c, detect);
        assert.equal(again.performance?.serverFps, 45);
        assert.deepEqual(hostConfigFromArgs(parseArgs([]), PUBLIC, detect).performance, DEFAULT_PERFORMANCE);
        assert.match(performanceSummary(PUBLIC), /30 fps, 10 fps after 15 s without players; Training Grounds on demand; quiet game logs; at most 3 hunts/);
    });
});

describe("performance: doctor", () => {
    it("tells whether the published runtime has the game servers' CPU patches", () => {
        const dir = tempDir("runtime-cpu");
        const both = path.join(dir, "both.dll");
        write(both, Buffer.concat([Buffer.from("MZ junk "), Buffer.from("LEGACY_EXPECTED_PLAYER_WALK.flag", "utf16le"), Buffer.from(" REFORGED_SERVER_MAX_FPS\0")]));
        const old = path.join(dir, "old.dll");
        write(old, "MZ an older runtime");
        assert.deepEqual(runtimeCpuPatches(both), { cpuFixes: true, frameCap: true });
        assert.deepEqual(runtimeCpuPatches(old), { cpuFixes: false, frameCap: false });
        assert.equal(runtimeCpuPatches(path.join(dir, "none.dll")), null);
        const warn = performanceChecks(PUBLIC, old);
        assert.equal(warn[0].level, "info");
        assert.equal(warn[1].level, "warn");
        assert.match(warn[1].text, /0019 \(CPU fixes\) and 0020 \(frame cap\)/);
        assert.equal(performanceChecks(PUBLIC, both)[1].level, "ok");
        assert.equal(performanceChecks(PUBLIC, null).length, 1, "nothing published: only the settings");
    });
});

describe("performance: MongoDB", () => {
    it("caps WiredTiger's cache instead of letting it take half of the RAM", () => {
        const args = mongodArgs("/home/reforged/Reforged/.workspace/mongodb", "/home/reforged/Reforged/.workspace/logs/mongod.log", 27017);
        const at = args.indexOf("--wiredTigerCacheSizeGB");
        assert.ok(at > 0);
        assert.equal(args[at + 1], String(MONGO_CACHE_GB));
    });
});
