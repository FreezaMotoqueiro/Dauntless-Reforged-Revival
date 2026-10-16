// The server's configuration: .workspace/config/host.json (what the host chose) and one env file
// per service, written from it. Secrets are made once and kept: running setup again never rotates
// a key (that would log everyone out, or break every invite already sent).

import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { formatEnv, parseEnv, type EnvMap } from "./envfile";
import { GAME_CHANGELIST, GAME_EXE_RELATIVE, PINNED_EXE_SHA256, PORTS, type Paths } from "./paths";

export type ServerMode = "private" | "public";

export interface HostConfig {
    version: 1;
    mode: ServerMode;
    // Private: this PC's Tailscale IPv4 (or MagicDNS name). Public: the public IPv4 or DNS name
    // players connect to (the invite's host).
    host: string;
    // The address the game servers announce for UDP (the Director's MY_IP): the Tailscale IPv4 or
    // the public IPv4. Defaults to host when that is an IPv4 address.
    gameAddress: string;
    name: string;
    // The Dauntless 1.14.7 folder the dedicated game servers run from (the one with Archon\).
    gameDir: string | null;
    registration: "INVITECODE" | "OPEN" | "NONE";
    shareUrl: string | null; // private mode: a Tailscale share link for invites
    mongo: {
        uri: string;
        manage: boolean; // ReforgedHost starts mongod itself
        mongod: string | null; // path to mongod(.exe) when managed
    };
    maxHuntServers: number;
    // Private servers only: multiply the XP and the loot the game servers grant, to reach late-game content quickly
    // when testing. Absent or 1 is off; the backend checks again that it runs as a private Tailscale server.
    multipliers?: { xp: number; rewards: number };
}

export const MAX_MULTIPLIER = 100;

export function multipliersOn(c: HostConfig): boolean {
    return c.mode === "private" && c.multipliers !== undefined && (c.multipliers.xp !== 1 || c.multipliers.rewards !== 1);
}

export interface Secrets {
    gatewaySecret: string;
    allowlistSecret: string;
    adminKey: string;
    gameserverKey: string;
    apiKeyHashSecret: string;
    metricsToken: string;
    jwtPrivateKeyB64: string;
    jwtPublicKeyB64: string;
}

export const SECRET_FILE = "secrets.env";

function hex(bytes = 32): string {
    return randomBytes(bytes).toString("hex");
}

export function newSecrets(): Secrets {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    return {
        gatewaySecret: hex(),
        allowlistSecret: hex(),
        adminKey: hex(),
        gameserverKey: hex(),
        apiKeyHashSecret: hex(),
        metricsToken: hex(),
        jwtPrivateKeyB64: Buffer.from(privateKey, "utf8").toString("base64"),
        jwtPublicKeyB64: Buffer.from(publicKey, "utf8").toString("base64"),
    };
}

const SECRET_KEYS: Record<keyof Secrets, string> = {
    gatewaySecret: "GATEWAY_SECRET",
    allowlistSecret: "ALLOWLIST_SECRET",
    adminKey: "REFORGED_ADMIN_KEY",
    gameserverKey: "GAMESERVER_API_KEY",
    apiKeyHashSecret: "API_KEY_HASH_SECRET",
    metricsToken: "MYSTICPARADOX_METRICS_TOKEN",
    jwtPrivateKeyB64: "AUTH_SIGNING_PRIVKEY_B64",
    jwtPublicKeyB64: "AUTH_SIGNING_PUBKEY_B64",
};

// Reads the secrets file, adding any secret that is missing (an older setup, or the first run).
export function loadOrCreateSecrets(configDir: string, make: () => Secrets = newSecrets): { secrets: Secrets; created: boolean } {
    const file = path.join(configDir, SECRET_FILE);
    const existing = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
    let fresh: Secrets | null = null;
    let created = false;
    const out = {} as Secrets;
    for (const [field, key] of Object.entries(SECRET_KEYS) as [keyof Secrets, string][]) {
        const value = existing[key];
        if (value && value.length >= 32) out[field] = value;
        else {
            fresh ??= make();
            out[field] = fresh[field];
            created = true;
        }
    }
    if (created) {
        fs.mkdirSync(configDir, { recursive: true });
        writeSecretFile(file, formatEnv(
            ["Dauntless Reforged Revival server secrets. SECRET: never share or commit this file.", "Made once by `npm run setup`; changing one logs everyone out or breaks the invites already sent."],
            (Object.entries(SECRET_KEYS) as [keyof Secrets, string][]).map(([field, key]) => [key, out[field]]),
        ));
    }
    return { secrets: out, created };
}

// Owner-only where the platform supports it.
export function writeSecretFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------ host.json

export function isTailscaleIPv4(host: string): boolean {
    if (!net.isIPv4(host)) return false;
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
}

export function isPublicIPv4(host: string): boolean {
    if (!net.isIPv4(host)) return false;
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
}

const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function cleanServerName(name: string): string {
    return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
}

// Checks a host.json, throwing the first problem.
export function validateHostConfig(c: HostConfig): HostConfig {
    if (c.mode !== "private" && c.mode !== "public") throw new Error("mode must be private or public");
    const host = c.host.trim().toLowerCase();
    if (c.mode === "private") {
        if (!isTailscaleIPv4(host) && !/\.ts\.net$/.test(host)) throw new Error(`a private server's host must be this PC's Tailscale address (100.64.0.0/10) or MagicDNS name, not ${c.host}`);
    } else if (!isPublicIPv4(host) && !DNS_NAME.test(host)) {
        throw new Error(`a public server's host must be a public IPv4 address or a DNS name, not ${c.host}`);
    }
    if (!net.isIPv4(c.gameAddress)) throw new Error(`gameAddress must be an IPv4 address (the one players' game traffic reaches), not ${c.gameAddress}`);
    if (c.mode === "private" && !isTailscaleIPv4(c.gameAddress)) throw new Error("a private server's game address must be its Tailscale IPv4");
    const name = cleanServerName(c.name);
    if (name.length === 0) throw new Error("the server needs a name");
    if (!["INVITECODE", "OPEN", "NONE"].includes(c.registration)) throw new Error("registration must be INVITECODE, OPEN or NONE");
    if (c.shareUrl !== null && !/^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.%-]+$/.test(c.shareUrl)) throw new Error("shareUrl must be a https://login.tailscale.com/ link");
    if (!/^mongodb(\+srv)?:\/\//.test(c.mongo.uri)) throw new Error("mongo.uri must be a mongodb:// connection string");
    if (!Number.isInteger(c.maxHuntServers) || c.maxHuntServers < 1 || c.maxHuntServers > 6) throw new Error("maxHuntServers must be 1 to 6 (8 game ports: Ramsgate, the Training Grounds and the hunts)");
    if (c.multipliers !== undefined) {
        for (const [what, value] of Object.entries(c.multipliers)) {
            if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > MAX_MULTIPLIER) throw new Error(`the ${what} multiplier must be a number from 1 to ${MAX_MULTIPLIER}, not ${value}`);
        }
        if (c.mode === "public" && (c.multipliers.xp !== 1 || c.multipliers.rewards !== 1)) throw new Error("XP and reward multipliers are for private (Tailscale) test servers only");
    }
    return { ...c, host, name };
}

export function readHostConfig(file: string): HostConfig | null {
    if (!fs.existsSync(file)) return null;
    return validateHostConfig(JSON.parse(fs.readFileSync(file, "utf8")) as HostConfig);
}

export function writeHostConfig(file: string, c: HostConfig): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(validateHostConfig(c), null, 2) + "\n");
}

export const DEFAULT_MONGO_URI = `mongodb://127.0.0.1:${PORTS.mongo}/?replicaSet=rs0`;

// ------------------------------------------------------------------ the env files

export interface EnvFiles {
    backend: [string, string][];
    director: [string, string][];
    content: [string, string][];
    gateway: [string, string][];
    allowlist: [string, string][] | null; // public mode only
}

export function buildEnvFiles(c: HostConfig, s: Secrets, p: Paths, extra: { sourceCommit?: string; platform?: NodeJS.Platform } = {}): EnvFiles {
    const backend: [string, string][] = [
        ["NODE_ENV", "production"],
        ["MYSTICPARADOX_SERVICE_ROLE", "api"],
        ["MYSTICPARADOX_METRICS_TOKEN", s.metricsToken],
        // Plain HTTP on this machine only; the gateway is the front door (it terminates TLS in public mode).
        ["PORT", String(PORTS.backend)],
        ["BIND_HOST", "127.0.0.1"],
        ["REFORGED_HTTP_ONLY", "true"],
        // The launcher answers the game's QoS ping itself, on its relay.
        ["QOS_PORT", "0"],
        ["QOS_TARGET_URL", `http://127.0.0.1:${PORTS.relay}/QoS`],
        // Account keys from /reforged/api/Register are the game's AUTH_PASSWORD.
        ["AUTH_MODE", "APIKEY"],
        ["ALLOW_NO_AUTH_DEV_MODE", "false"],
        ["AUTH_SIGNING_PRIVKEY_B64", s.jwtPrivateKeyB64],
        ["AUTH_SIGNING_PUBKEY_B64", s.jwtPublicKeyB64],
        ["API_KEY_HASH_SECRET", s.apiKeyHashSecret],
        ["GAMESERVER_API_KEYS", s.gameserverKey],
        ["MONGODB_URI", c.mongo.uri],
        ["MONGODB_DB", "reforged"],
        ["MONGODB_APP_NAME", "reforged-backend"],
        ["TARGET_CHANGELIST", String(GAME_CHANGELIST)],
        ["APPROVED_EXECUTABLE_SHA256", PINNED_EXE_SHA256],
        ["MATCHMAKING_MODE", "DEPLOYSERVER"],
        ["DEPLOYSERVER_URL", `127.0.0.1:${PORTS.director}`],
        ["REALTIME_XMPP_ENABLED", "true"],
        ["REALTIME_XMPP_CAPTURE", "false"],
        // The launcher's relay sends the invite's host as Host.
        ["REALTIME_XMPP_ALLOWED_HOSTS", c.host],
        ["REALTIME_XMPP_DEV_CITY_MUC", "false"],
        ["REGISTRATION_MODE", c.registration],
        ["REFORGED_ADMIN_KEY", s.adminKey],
        ["REFORGED_SERVER_NAME", c.name],
        ["REFORGED_SERVER_VERSION", "0.1.0"],
        ["REFORGED_SOURCE_URL", "https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival"],
        ["REFORGED_SOURCE_COMMIT", extra.sourceCommit ?? ""],
        // The backend multiplies XP and rewards only as a private server on a Tailscale address (testMultipliers.ts).
        ["REFORGED_SERVER_MODE", c.mode],
        ["REFORGED_SERVER_HOST", c.host],
        ...(multipliersOn(c) ? [
            ["REFORGED_XP_MULTIPLIER", String(c.multipliers!.xp)],
            ["REFORGED_REWARD_MULTIPLIER", String(c.multipliers!.rewards)],
        ] as [string, string][] : []),
        ["LOG_LEVEL", "info"],
    ];
    const exe = c.gameDir ? path.join(c.gameDir, GAME_EXE_RELATIVE) : "";
    const director: [string, string][] = [
        ["NODE_ENV", "production"],
        ["PORT", String(PORTS.director)],
        ["BIND_HOST", "127.0.0.1"],
        ["MY_IP", c.gameAddress],
        // Ramsgate on the last port, the Training Grounds on the one before, hunts below.
        ["PORT_RANGE_BEGIN", String(PORTS.gameFirst)],
        ["PORT_RANGE_END", String(PORTS.gameLast)],
        ["GAMESERVER_BINARY_PATH", exe],
        ["METAGAME_API_KEY", s.gameserverKey],
        ["SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP", "3"],
        ["GAMESERVER_READY_TIMEOUT_MS", "30000"],
        ["MAX_CONCURRENT_HUNT_SERVERS", String(c.maxHuntServers)],
        ["SERVER_RUNTIME_AUTO_UPDATE", "false"],
        ["SERVER_RUNTIME_UPDATE_REQUIRED", "false"],
        ["GAMESERVER_LOG_DIR", p.gameserverLogs],
        // The game servers inherit these: the runtime in each of them talks to the backend directly.
        ["REFORGED_BACKEND_URL", `http://127.0.0.1:${PORTS.backend}`],
        ["MYSTICPARADOX_RUNTIME_PROFILE", "production"],
        ["LOG_LEVEL", "info"],
    ];
    const content: [string, string][] = [
        ["PORT", String(PORTS.content)],
        ["BIND_HOST", "127.0.0.1"],
        ["BACKEND_URL", `http://127.0.0.1:${PORTS.backend}`],
        ["CONTENT_RUNTIME_DIR", p.runtimePublish],
        ["CONTENT_BRANDING_DIR", p.branding],
        ["CONTENT_NEWS_FILE", p.newsFile],
    ];
    const common: [string, string][] = [
        ["GATEWAY_SECRET", s.gatewaySecret],
        ["GATEWAY_BACKEND_URL", `http://127.0.0.1:${PORTS.backend}`],
        ["GATEWAY_CONTENT_URL", `http://127.0.0.1:${PORTS.content}`],
        ["GATEWAY_WS_URL", `http://127.0.0.1:${PORTS.backend}`],
    ];
    const gateway: [string, string][] = c.mode === "public"
        ? [
            ["GATEWAY_TLS", "1"],
            ["GATEWAY_BIND", "0.0.0.0"],
            ["GATEWAY_PORT", String(PORTS.publicGateway)],
            ["GATEWAY_CERT", p.certFile],
            ["GATEWAY_KEY", p.keyFile],
            ...common,
            ["ALLOWLIST_URL", `http://127.0.0.1:${PORTS.allowlist}`],
            ["ALLOWLIST_SECRET", s.allowlistSecret],
        ]
        : [
            ["GATEWAY_TLS", "0"],
            ["GATEWAY_BIND", c.gameAddress],
            ["GATEWAY_PORT", String(PORTS.privateGateway)],
            ...common,
            // Tailscale decides who can reach the game ports.
            ["GATEWAY_ALLOWLIST", "0"],
        ];
    const allowlist: [string, string][] | null = c.mode === "public"
        ? [
            // Only the real server changes Windows Firewall; anywhere else it only writes what it would do.
            ["ALLOWLIST_DRY_RUN", (extra.platform ?? process.platform) === "win32" ? "0" : "1"],
            ["ALLOWLIST_BIND", "127.0.0.1"],
            ["ALLOWLIST_PORT", String(PORTS.allowlist)],
            ["ALLOWLIST_SECRET", s.allowlistSecret],
            ["ALLOWLIST_PORTS", `${PORTS.gameFirst}-${PORTS.gameLast}`],
            ["ALLOWLIST_AUDIT_LOG", path.join(p.logs, "allowlist-audit.log")],
            ["ALLOWLIST_STATE_FILE", path.join(p.config, "allowlist-state.json")],
        ]
        : null;
    return { backend, director, content, gateway, allowlist };
}

export function writeEnvFiles(p: Paths, files: EnvFiles): string[] {
    const written: string[] = [];
    const header = ["Written by ReforgedHost (`npm run setup`) from host.json and secrets.env. SECRET: never share or commit.", "Run setup again instead of editing: it rewrites this file."];
    for (const [name, entries] of Object.entries(files) as [string, [string, string][] | null][]) {
        const file = path.join(p.config, `${name}.env`);
        if (entries === null) {
            fs.rmSync(file, { force: true });
            continue;
        }
        writeSecretFile(file, formatEnv(header, entries));
        written.push(file);
    }
    return written;
}

export function readEnvFile(file: string): EnvMap {
    return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
}
