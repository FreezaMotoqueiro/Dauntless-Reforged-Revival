// Where everything lives. The repository holds the code; .workspace/ (git-ignored) holds what is
// the host's own: the pinned upstream source with the patches applied, the SDK generated from
// their game, game data, builds, configuration with secrets, certificates, the database and logs.

import path from "node:path";

export const GAME_EXE_RELATIVE = path.join("Archon", "Binaries", "Win64", "Dauntless-Win64-Shipping.exe");
export const RUNTIME_FILE_NAMES = ["MysticParadox.dll", "winmm.dll"] as const;
export const GAME_CHANGELIST = 647472;
export const GAME_VERSION_TEXT = "dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472";
export const PINNED_EXE_SHA256 = "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b";

export const PORTS = {
    backend: 61000,
    director: 61001,
    content: 61002,
    allowlist: 61005,
    publicGateway: 443,
    privateGateway: 61000,
    relay: 61100,
    mongo: 27017,
    gameFirst: 8770,
    gameLast: 8777,
} as const;

export interface Paths {
    repo: string;
    // The project's server preset (preset.ts), committed with the project.
    preset: string;
    hostKit: string;
    upstreamPin: string;
    patchesDir: string;
    gatewayDir: string;
    contentDir: string;
    workspace: string;
    upstream: string;
    marker: string;
    backendDir: string;
    directorDir: string;
    runtimeSource: string;
    sdkHeader: string;
    sdkDir: string;
    runtimeDll: string;
    loaderDir: string;
    loaderDll: string;
    exporterDll: string;
    backendGameData: string;
    directorGameData: string;
    rawGameData: string;
    exports: string;
    runtimePublish: string;
    config: string;
    hostJson: string;
    tls: string;
    certFile: string;
    keyFile: string;
    mongoData: string;
    logs: string;
    gameserverLogs: string;
    branding: string;
    newsFile: string;
}

// root: the Dauntless Reforged Revival checkout (the folder with ReforgedHost/ and upstream/).
export function paths(root: string): Paths {
    const workspace = path.join(root, ".workspace");
    const upstream = path.join(workspace, "Mystic-Paradox");
    const runtimeSource = path.join(upstream, "ParadoxRuntime");
    const config = path.join(workspace, "config");
    const tls = path.join(workspace, "tls");
    const logs = path.join(workspace, "logs");
    return {
        repo: root,
        preset: path.join(root, "preset"),
        hostKit: path.join(root, "ReforgedHost"),
        upstreamPin: path.join(root, "upstream", "mystic-paradox.json"),
        patchesDir: path.join(root, "upstream"),
        gatewayDir: path.join(root, "ReforgedGateway"),
        contentDir: path.join(root, "ReforgedContent"),
        workspace,
        upstream,
        marker: path.join(upstream, ".reforged-patches.json"),
        backendDir: path.join(upstream, "ParadoxBackend"),
        directorDir: path.join(upstream, "ParadoxDirector"),
        runtimeSource,
        sdkHeader: path.join(runtimeSource, "SDK.hpp"),
        sdkDir: path.join(runtimeSource, "SDK"),
        runtimeDll: path.join(runtimeSource, "x64", "Release", "MysticParadox.dll"),
        loaderDir: path.join(upstream, "tools", "RuntimeLoader"),
        loaderDll: path.join(upstream, "tools", "RuntimeLoader", "target", "release", "winmm.dll"),
        exporterDll: path.join(upstream, "tools", "CatalogExporter", "x64", "Release", "CatalogExporter.dll"),
        backendGameData: path.join(upstream, "ParadoxBackend", "game-data"),
        directorGameData: path.join(upstream, "ParadoxDirector", "game-data"),
        rawGameData: path.join(upstream, "ParadoxBackend", "game-data", "raw"),
        exports: path.join(upstream, "Items_Analysis"),
        runtimePublish: path.join(workspace, "runtime"),
        config,
        hostJson: path.join(config, "host.json"),
        tls,
        certFile: path.join(tls, "gateway-cert.pem"),
        keyFile: path.join(tls, "gateway-key.pem"),
        mongoData: path.join(workspace, "mongodb"),
        logs,
        gameserverLogs: path.join(logs, "gameservers"),
        branding: path.join(workspace, "branding"),
        newsFile: path.join(config, "news.json"),
    };
}

// The repository root, from this file's place in it (ReforgedHost/dist/ or build/ReforgedHost/src/).
export function findRepoRoot(start: string = __dirname): string {
    const fs = require("node:fs") as typeof import("node:fs");
    let dir = start;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, "upstream", "mystic-paradox.json")) && fs.existsSync(path.join(dir, "ReforgedHost"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    throw new Error("Could not find the Dauntless Reforged Revival folder (with upstream/ and ReforgedHost/) above " + start);
}
