// The whole flow through the Controller against fake servers: invite -> ServerStatus -> Register ->
// the player's own Dauntless 1.14.7 -> the server's runtime (asked, then installed and checked) ->
// Play (relay + Engine.ini + launch arguments + environment) -> game exit stops the relay.
// Public mode runs over a fake TLS gateway; private mode over plain HTTP on loopback.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
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

async function harness(chooseFolder: Platform["chooseFolder"] = async () => null): Promise<Harness> {
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
