// The whole flow through the Controller against fake servers: invite -> ServerStatus -> Register ->
// the player's own Dauntless 1.14.7 -> the server's runtime (asked, then installed and checked) ->
// Play (relay + Engine.ini + launch arguments + environment) -> game exit stops the relay.
// Public mode runs over a fake TLS gateway; private mode over plain HTTP on loopback.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Controller, type Platform } from "../src/main/controller";
import { formatInvite } from "../src/shared/invite";
import { setSink } from "../src/main/log";
import type { SpawnFn } from "../src/main/launch";
import type { Snapshot } from "../src/shared/types";
import { FakeServer, makeRuntime, sha256 } from "./fakes";
import { makeTestCert, type TestCert } from "./certs";
import { GAME_VERSION_TEXT } from "../src/main/constants";

const EXE_DATA = Buffer.from("MZ this is not really Dauntless 1.14.7");
const runtime = makeRuntime(5);

let cert: TestCert;
let other: TestCert;
let gateway: FakeServer;
let gatewayPort = 0;
let lan: FakeServer;
let lanPort = 0;
const temps: string[] = [];
const logLines: string[] = [];

function temp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function fakeGame(version = GAME_VERSION_TEXT, exe = EXE_DATA): string {
  const root = path.join(temp("rr-ctl-game-"), "Dauntless");
  const win64 = path.join(root, "Archon", "Binaries", "Win64");
  mkdirSync(win64, { recursive: true });
  writeFileSync(path.join(win64, "Dauntless-Win64-Shipping.exe"), exe);
  writeFileSync(path.join(root, "Version.txt"), version);
  return root;
}

before(async () => {
  cert = makeTestCert();
  other = makeTestCert();
  gateway = new FakeServer({ name: "Friday Hunts", validCodes: new Set(["ABCD-EFGH-JKLM", "SECOND-CODE"]), runtime });
  gatewayPort = await gateway.start(0, { cert: cert.certPem, key: cert.keyPem });
  lan = new FakeServer({ name: "LAN Party", registration: "OPEN", runtime: null, gameData: "synthetic" });
  lanPort = await lan.start();
  setSink((l) => logLines.push(l));
});

after(async () => {
  await gateway.stop();
  await lan.stop();
  cert.cleanup();
  other.cleanup();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  c: Controller;
  last: () => Snapshot;
  spawns: { exe: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[];
  child: () => EventEmitter | null;
  configDir: string;
  relayPort: number;
}

async function harness(chooseFolder: Platform["chooseFolder"] = async () => null, extra: Partial<Platform> = {}): Promise<Harness> {
  let snap: Snapshot | null = null;
  const spawns: Harness["spawns"] = [];
  let child: EventEmitter | null = null;
  const fakeSpawn = ((exe: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    spawns.push({ exe, args, cwd: opts.cwd, env: opts.env });
    const c = Object.assign(new EventEmitter(), { pid: 4242 });
    child = c;
    setImmediate(() => c.emit("spawn"));
    return c;
  }) as unknown as SpawnFn;
  const configDir = temp("rr-ctl-cfg-");
  const relayPort = await freePort();
  const p: Platform = {
    userDataDir: temp("rr-ctl-user-"),
    resourcesDir: temp("rr-ctl-res-"),
    hostPlatform: process.platform, // the temporary folders are real paths of this OS
    env: { PATH: "/usr/bin", REFORGED_BACKEND_URL: "https://should-be-replaced.invalid" },
    appVersion: "0.0.0-test",
    packaged: false,
    defaultLanguage: "en",
    systemLocale: "pt-BR",
    encryptor: {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from("enc:" + Buffer.from(plain).toString("base64")),
      decrypt: (data) => Buffer.from(data.toString().slice(4), "base64").toString(),
    },
    gameConfigDir: configDir,
    relayPort,
    qosPort: null,
    exePin: sha256(EXE_DATA),
    chooseFolder,
    chooseDll: async () => null,
    chooseSaveFile: async () => null,
    chooseOpenFile: async () => null,
    choosePack: async () => null,
    openExternal: async () => undefined,
    openPath: async () => undefined,
    emitSnapshot: (s) => {
      snap = s;
    },
    emitProgress: () => undefined,
    findTailscale: () => null,
    findRunningClients: async () => [],
    runtimeFilesExist: () => true,
    spawn: fakeSpawn,
    ...extra,
  };
  const c = new Controller(p);
  return { c, last: () => snap ?? c.snapshot(), spawns, child: () => child, configDir, relayPort };
}

function get(port: number, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("public mode end to end: join, register, game check, runtime trust and install, play, exit", async () => {
  const hx = await harness();
  await hx.c.init();
  assert.equal(hx.last().phase, "join");

  const invite = formatInvite({ mode: "public", host: "127.0.0.1", port: gatewayPort, fp: cert.fingerprint, code: "ABCD-EFGH-JKLM", name: "Friday Hunts", share: null });
  assert.deepEqual(await hx.c.submitInvite(invite), { ok: true });
  let s = hx.last();
  assert.equal(s.phase, "register");
  assert.equal(s.server?.fingerprint, cert.fingerprint);
  assert.equal(s.status?.limited, true);

  assert.deepEqual(await hx.c.register("Slayer_42"), { ok: true, username: "Slayer_42" });
  s = hx.last();
  assert.equal(s.phase, "locate", "the launcher never downloads the game");
  assert.equal(s.game.problem, "not_set");
  assert.equal(s.status?.limited, false);
  assert.equal(gateway.registrations.at(-1)?.code, "ABCD-EFGH-JKLM");

  // A 1.14.7 folder whose executable is another build.
  const wrong = fakeGame(GAME_VERSION_TEXT, Buffer.from("another build"));
  assert.deepEqual(await hx.c.useGamePath(wrong), { ok: false, error: { code: "game_wrong_version" } });
  assert.equal(hx.last().game.problem, "wrong_version");

  const root = fakeGame();
  assert.deepEqual(await hx.c.useGamePath(path.join(root, "Archon")), { ok: true });
  s = hx.last();
  assert.equal(s.game.root, root);
  assert.equal(s.game.exeVerified, true);
  assert.equal(s.phase, "runtime");
  assert.equal(s.runtime.state, "untrusted", "the player is asked before any native code is installed");
  assert.deepEqual(s.runtime.files.map((f) => f.name), ["MysticParadox.dll", "winmm.dll"]);
  assert.ok(!gateway.seen.some((r) => r.path.startsWith("/content/v1/runtime/files/")), "nothing downloaded before the player agreed");

  assert.deepEqual(await hx.c.play(), { ok: false, error: { code: "runtime_untrusted" } });

  assert.deepEqual(await hx.c.trustRuntime(), { ok: true });
  s = hx.last();
  assert.equal(s.phase, "ready");
  assert.equal(s.runtime.state, "ok");
  const win64 = path.join(root, "Archon", "Binaries", "Win64");
  for (const f of runtime) assert.ok(readFileSync(path.join(win64, f.name)).equals(f.data), f.name);

  assert.deepEqual(await hx.c.play(), { ok: true });
  s = hx.last();
  assert.equal(s.phase, "running");
  assert.equal(s.running.relayPort, hx.relayPort);
  assert.equal(hx.c.relayActive, true);

  const spawn = hx.spawns.at(-1)!;
  assert.equal(spawn.cwd, win64);
  assert.equal(path.basename(spawn.exe), "Dauntless-Win64-Shipping.exe");
  assert.ok(spawn.args.includes("-AUTH_TYPE=exchangecode"));
  assert.ok(spawn.args.some((a) => /^-AUTH_PASSWORD=RRK_[0-9a-f]{48}$/.test(a)));
  assert.ok(spawn.args.includes("-epicusername=Slayer_42"));
  assert.ok(spawn.args.includes("-epiclocale=pt-BR"), "game language auto follows the system locale");
  assert.equal(spawn.env?.REFORGED_BACKEND_URL, `http://127.0.0.1:${hx.relayPort}`);
  assert.equal(spawn.env?.MYSTICPARADOX_RUNTIME_PROFILE, "production");
  assert.ok(!logLines.some((l) => /RRK_[0-9a-f]{48}/.test(l)), "the key is never logged");

  const engineIni = readFileSync(path.join(hx.configDir, "Engine.ini"), "latin1");
  assert.ok(engineIni.includes(`ServerPort=${hx.relayPort}`) && engineIni.includes('ServerAddr="ws://127.0.0.1"'));

  // The relay answers QoS itself and carries everything else over the pinned connection.
  const qos = await get(hx.relayPort, "/QoS");
  assert.equal(qos.status, 200);
  assert.match(qos.body, /pong/);
  const before = gateway.seen.length;
  const status = await get(hx.relayPort, "/reforged/api/RegistrationStatus");
  assert.equal(status.status, 404, "the fake has no such route: the request reached it");
  assert.equal(gateway.seen.length, before + 1);

  hx.child()!.emit("exit", 0);
  await waitFor(() => hx.last().phase === "ready" && !hx.c.relayActive);

  // Closed through its console (0xC000013A): not a failure. A crash code is reported.
  assert.deepEqual(await hx.c.play(), { ok: true });
  hx.child()!.emit("exit", 0xc000013a);
  await waitFor(() => hx.last().phase === "ready" && !hx.c.relayActive);
  assert.equal(hx.last().lastError, null);
  assert.deepEqual(await hx.c.play(), { ok: true });
  hx.child()!.emit("exit", 0xc0000005);
  await waitFor(() => hx.last().phase === "ready" && !hx.c.relayActive);
  assert.deepEqual(hx.last().lastError, { code: "launch_failed", detail: "0xC0000005" });
  await hx.c.shutdown();
});

test("a public invite with another certificate: nothing is sent, and NEW INVITE is offered", async () => {
  const hx = await harness();
  await hx.c.init();
  const before = gateway.seen.length;
  const invite = formatInvite({ mode: "public", host: "127.0.0.1", port: gatewayPort, fp: other.fingerprint, code: "SECOND-CODE", name: "Fake", share: null });
  assert.deepEqual(await hx.c.submitInvite(invite), { ok: true });
  const s = hx.last();
  assert.equal(s.phase, "connect");
  assert.equal(s.connect.problem, "cert_mismatch");
  assert.equal(gateway.seen.length, before);
  await hx.c.shutdown();
});

test("private mode: open registration, a server without a runtime waits for its host", async () => {
  const local = temp("rr-ctl-local-");
  const hx = await harness(async (purpose) => (purpose === "runtime" ? local : null));
  await hx.c.init();
  const invite = formatInvite({ mode: "private", host: "127.0.0.1", port: lanPort, fp: null, code: "OPEN-ANYONE", name: "LAN Party", share: null });
  assert.deepEqual(await hx.c.submitInvite(invite), { ok: true });
  assert.deepEqual(await hx.c.register("Borealis"), { ok: true, username: "Borealis" });
  assert.deepEqual(await hx.c.useGamePath(fakeGame()), { ok: true });
  const s = hx.last();
  assert.equal(s.phase, "runtime");
  assert.equal(s.runtime.state, "unavailable");
  assert.equal(s.status?.gameData, "synthetic");
  assert.deepEqual(await hx.c.play(), { ok: false, error: { code: "runtime_unavailable" } });

  // A host testing their own build: a local runtime folder makes it playable.
  assert.deepEqual(await hx.c.chooseLocalRuntime(), { ok: false, error: { code: "local_runtime_invalid", detail: "MysticParadox.dll, winmm.dll" } });
  for (const f of makeRuntime(9)) writeFileSync(path.join(local, f.name), f.data);
  assert.deepEqual(await hx.c.chooseLocalRuntime(), { ok: true });
  assert.equal(hx.last().runtime.state, "local");
  assert.equal(hx.last().phase, "ready");
  assert.deepEqual(await hx.c.play(), { ok: true });
  const spawn = hx.spawns.at(-1)!;
  assert.ok(existsSync(path.join(spawn.cwd, "MysticParadox.dll")));
  hx.child()!.emit("exit", 0);
  await waitFor(() => !hx.c.relayActive);
  await hx.c.shutdown();
});

test("a private server at a new address (its host changed Tailscale accounts): the account goes along only when the player says so", async () => {
  const hx = await harness();
  await hx.c.init();
  // The launcher keeps the name the server itself reports (the fake one is "LAN Party"), as the host kit's invites carry it.
  const first = formatInvite({ mode: "private", host: "127.0.0.1", port: lanPort, fp: null, code: "OPEN-ANYONE", name: "LAN Party", share: null });
  assert.deepEqual(await hx.c.submitInvite(first), { ok: true });
  assert.deepEqual(await hx.c.register("Wanderer"), { ok: true, username: "Wanderer" });
  assert.equal(hx.last().account.hasKey, true);

  const moved = formatInvite({ mode: "private", host: "127.0.0.2", port: lanPort, fp: null, code: "NEW-CODE", name: "LAN Party", share: null });
  assert.deepEqual(await hx.c.checkInvite(moved), { ok: true, certificateChanged: false, previousFingerprint: null, movedFrom: "127.0.0.1" });
  const other = formatInvite({ mode: "private", host: "127.0.0.2", port: lanPort, fp: null, code: "NEW-CODE", name: "Another server", share: null });
  assert.equal(((await hx.c.checkInvite(other)) as { movedFrom: string | null }).movedFrom, null, "another server's name: not the same server");

  // Without the player's yes, nothing is taken along.
  assert.deepEqual(await hx.c.submitInvite(moved), { ok: true });
  assert.equal(hx.last().account.hasKey, false);
  // With it, the key moves to the new address and the old entry goes.
  assert.deepEqual(await hx.c.submitInvite(moved, { carryAccount: true }), { ok: true });
  assert.equal(hx.last().account.hasKey, true);
  assert.deepEqual(hx.last().savedServers.map((sv) => sv.host), ["127.0.0.2"]);
  assert.equal(((await hx.c.checkInvite(moved)) as { movedFrom: string | null }).movedFrom, null, "nothing to take along any more");
  await hx.c.shutdown();
});

test("a banned account is told why", async () => {
  const key = "RRK_" + "b".repeat(48);
  const banned = new FakeServer({ registration: "OPEN", existingUsers: new Map([["ghost", key]]), banned: new Map([[key, "cheating"]]) });
  const port = await banned.start();
  try {
    const hx = await harness();
    await hx.c.init();
    assert.deepEqual(await hx.c.submitInvite(formatInvite({ mode: "private", host: "127.0.0.1", port, fp: null, code: "STRICT-CODE", name: "Strict", share: null })), { ok: true });
    assert.deepEqual(await hx.c.useExistingKey(key), { ok: false, error: { code: "account_banned", detail: "cheating" } });
    const s = hx.last();
    assert.equal(s.phase, "register");
    assert.deepEqual(s.lastError, { code: "account_banned", detail: "cheating" });
    await hx.c.shutdown();
  } finally {
    await banned.stop();
  }
});

// A project folder whose host kit is a small script: it logs each command and answers update, setup and
// multipliers the way ReforgedHost does (--json lines, host.json).
function hostWorkspace(opts: { legacy?: boolean; dir?: string } = {}): string {
  const ws = opts.dir ?? temp("rr-ctl-ws-");
  const kit = path.join(ws, "ReforgedHost");
  mkdirSync(path.join(kit, "dist"), { recursive: true });
  mkdirSync(path.join(kit, "node_modules"), { recursive: true });
  mkdirSync(path.join(ws, ".workspace", "config"), { recursive: true });
  writeFileSync(path.join(kit, "package.json"), "{}");
  if (!opts.legacy) {
    mkdirSync(path.join(kit, "src"), { recursive: true });
    writeFileSync(path.join(kit, "src", "selfupdate.ts"), "");
  }
  writeFileSync(path.join(ws, ".workspace", "config", "host.json"), JSON.stringify({ version: 1, mode: "private", name: "Test Hunts", host: "100.64.0.1" }));
  writeFileSync(
    path.join(kit, "dist", "cli.js"),
    `
const fs = require("fs"), path = require("path");
const ws = path.join(__dirname, "..", "..");
const a = process.argv.slice(2).join(" ");
fs.appendFileSync(path.join(ws, "calls.log"), a + "\\n");
const behind = fs.existsSync(path.join(ws, "behind")) ? 3 : 0;
if (a === "update --check --json") {
  if (fs.existsSync(path.join(ws, "dirty"))) { console.log(JSON.stringify({ error: "local_changes", detail: "README.md" })); console.error("Error: local changes"); process.exit(1); }
  console.log(JSON.stringify({ branch: "main", upstream: "origin/main", head: "aaaaaaaaaaaa", remoteHead: "bbbbbbbbbbbb", behind, ahead: 0 }));
} else if (a === "update --json --no-setup") {
  console.log(JSON.stringify({ branch: "main", upstream: "origin/main", head: "bbbbbbbbbbbb", remoteHead: "bbbbbbbbbbbb", behind: 0, ahead: 0, updated: true, from: "aaaaaaaaaaaa", to: "bbbbbbbbbbbb", files: 4, runtimeChanged: true, hostKitDeps: false }));
} else if (a === "setup") {
  console.log("setup again");
} else if (process.argv[2] === "multipliers") {
  const file = path.join(ws, ".workspace", "config", "host.json");
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.argv[3] === "--off") delete c.multipliers;
  else c.multipliers = { xp: Number(process.argv[4]), rewards: Number(process.argv[6]) };
  fs.writeFileSync(file, JSON.stringify(c));
} else process.exit(9);
`,
  );
  return ws;
}

test("the Host page updates the project from GitHub, and sets the test multipliers", async () => {
  const ws = hostWorkspace();
  const hx = await harness(async () => ws, { hostServer: { findNode: () => ({ node: process.execPath, npmCli: null }), probe: async () => false } });
  await hx.c.init();
  assert.deepEqual(await hx.c.hostChooseWorkspace(), { ok: true });
  const calls = () => readFileSync(path.join(ws, "calls.log"), "utf8").trim().split("\n");

  // Up to date: it only compares.
  assert.deepEqual(await hx.c.hostUpdate(), { ok: true });
  assert.deepEqual(calls(), ["update --check --json"]);
  assert.deepEqual((await hx.c.hostKit()).update, { state: "up_to_date", head: "aaaaaaaaaaaa", files: 0, runtimeChanged: false });

  // Behind GitHub: updated, then setup runs again with this server's settings.
  writeFileSync(path.join(ws, "behind"), "");
  assert.deepEqual(await hx.c.hostUpdate(), { ok: true });
  assert.deepEqual(calls().slice(1), ["update --check --json", "update --json --no-setup", "setup"]);
  const kit = await hx.c.hostKit();
  assert.deepEqual(kit.update, { state: "updated", head: "bbbbbbbbbbbb", files: 4, runtimeChanged: true });
  assert.equal(kit.job?.kind, "update");
  assert.equal(kit.job?.state, "done");

  // The host kit's own reason has its own text on the page.
  writeFileSync(path.join(ws, "dirty"), "");
  assert.deepEqual(await hx.c.hostUpdate(), { ok: false, error: { code: "host_failed", detail: "update_local_changes" } });

  // Multipliers: on, read back from host.json, then off.
  assert.deepEqual(await hx.c.hostSetMultipliers({ xp: 5, rewards: 2.5 }), { ok: true });
  assert.ok(calls().includes("multipliers --xp 5 --rewards 2.5"));
  assert.deepEqual((await hx.c.hostKit()).serverConfig.multipliers, { xp: 5, rewards: 2.5 });
  assert.deepEqual(await hx.c.hostSetMultipliers(null), { ok: true });
  assert.equal((await hx.c.hostKit()).serverConfig.multipliers, null);

  // A public server refuses them before anything runs.
  writeFileSync(path.join(ws, ".workspace", "config", "host.json"), JSON.stringify({ version: 1, mode: "public", name: "Open", host: "203.0.113.7" }));
  assert.deepEqual(await hx.c.hostSetMultipliers({ xp: 2, rewards: 2 }), { ok: false, error: { code: "host_failed", detail: "multipliers_public" } });
  await hx.c.shutdown();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
}

test("a project from before npm run update is updated with git, once", async () => {
  const remote = temp("rr-ctl-remote-");
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  const dev = temp("rr-ctl-dev-");
  git(dev, "clone", "--quiet", remote, ".");
  git(dev, "checkout", "--quiet", "-b", "main");
  writeFileSync(path.join(dev, ".gitignore"), ".workspace/\nReforgedHost/\ncalls.log\n");
  writeFileSync(path.join(dev, "README.md"), "one\n");
  git(dev, "add", "-A");
  git(dev, "commit", "--quiet", "-m", "one");
  git(dev, "push", "--quiet", "origin", "main");
  const ws = temp("rr-ctl-clone-");
  git(ws, "clone", "--quiet", remote, ".");
  hostWorkspace({ legacy: true, dir: ws });

  const hx = await harness(async () => ws, { hostServer: { findNode: () => ({ node: process.execPath, npmCli: null }), probe: async () => false } });
  await hx.c.init();
  assert.deepEqual(await hx.c.hostChooseWorkspace(), { ok: true });
  assert.deepEqual(await hx.c.hostUpdate(), { ok: true });
  assert.equal((await hx.c.hostKit()).update?.state, "up_to_date");

  mkdirSync(path.join(dev, "upstream", "patches"), { recursive: true });
  writeFileSync(path.join(dev, "upstream", "patches", "0009-runtime-x.patch"), "x\n");
  git(dev, "add", "-A");
  git(dev, "commit", "--quiet", "-m", "two");
  git(dev, "push", "--quiet", "origin", "main");
  assert.deepEqual(await hx.c.hostUpdate(), { ok: true });
  assert.deepEqual((await hx.c.hostKit()).update, { state: "updated", head: git(dev, "rev-parse", "HEAD").slice(0, 12), files: 1, runtimeChanged: true });
  assert.equal(git(ws, "rev-parse", "HEAD"), git(dev, "rev-parse", "HEAD"));
  assert.deepEqual(readFileSync(path.join(ws, "calls.log"), "utf8").trim().split("\n"), ["setup"], "setup ran again; the host kit was not asked to update");
  await hx.c.shutdown();
});
