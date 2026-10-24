// The upscaler the launcher installs beside the game (Luma + OptiScaler, docs/upscaling.md).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetUrl, DISABLE_FLAG, dx11Upscaler, ensureUpscaler, gpuVendorFromIds, MANIFEST_NAME, optiScalerIni, resolveInside, UPSCALER_PACK, VCRT_BACKUP_DIR, type FetchToFile, type UpscalerPack } from "../src/main/upscaler";
import { upscalerInstalled } from "../src/main/engineini";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rr-ups-"));
  dirs.push(d);
  return d;
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const TEMPLATE = "[Plugins]\r\n; Loads Reshade64.dll\r\nLoadReshade=auto\r\n[Upscalers]\r\nDx11Upscaler=auto\r\nDx12Upscaler=auto\r\n";
const CONTENT: Record<string, string> = {
  "ReShade64.dll": "reshade",
  "Luma-Unreal Engine.addon": "luma",
  "OptiScaler.dll": "opti",
  "Luma/Includes/Common.hlsl": "hlsl",
  "OptiScaler.ini": TEMPLATE,
};
function fakePack(content = CONTENT): UpscalerPack {
  return {
    id: "7",
    sources: [{ name: "x", version: "test", url: "https://example.invalid", sha256: "0" }],
    files: Object.entries(content).map(([p, c]) => ({ path: p, source: "x", entry: p, sha256: sha(c), size: Buffer.byteLength(c), ...(p === "OptiScaler.ini" ? { template: true } : {}) })),
  };
}
function fakeFetch(content = CONTENT, log: string[] = []): FetchToFile {
  const byHash = new Map(Object.values(content).map((c) => [sha(c), c]));
  return async (url, dest, maxBytes, onBytes) => {
    log.push(url);
    const c = byHash.get(url.split("/").pop() ?? "");
    if (c === undefined) throw new Error("HTTP 404");
    const b = Buffer.from(c);
    if (b.length > maxBytes) throw new Error("too large");
    writeFileSync(dest, b);
    onBytes(b.length);
  };
}

test("the compiled-in pack: Luma, ReShade as ReShade64.dll, OptiScaler, safe paths, no proxy names", () => {
  const paths = UPSCALER_PACK.files.map((f) => f.path.toLowerCase());
  for (const p of ["reshade64.dll", "luma-unreal engine.addon", "nvngx_dlss.dll", "optiscaler.dll", "optiscaler.ini", "amd_fidelityfx_upscaler_dx12.dll", "libxess.dll"]) assert.ok(paths.includes(p), p);
  // Never a name Windows or the game would load on its own (servers share the folder), never the runtime's.
  for (const p of ["dxgi.dll", "winmm.dll", "version.dll", "d3d12.dll", "d3d11.dll", "dbghelp.dll", "nvapi64.dll", "mysticparadox.dll"]) assert.ok(!paths.includes(p), p);
  assert.equal(new Set(paths).size, paths.length);
  for (const f of UPSCALER_PACK.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(f.size) && f.size > 0);
    resolveInside("C:\\Dauntless", f.path);
  }
  assert.deepEqual(UPSCALER_PACK.files.filter((f) => f.template).map((f) => f.path), ["OptiScaler.ini"]);
  assert.match(UPSCALER_PACK.id, /^[0-9]+$/);
  assert.equal(assetUrl(UPSCALER_PACK.files[0]), `https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/releases/download/upscaler-${UPSCALER_PACK.id}/${UPSCALER_PACK.files[0].sha256}`);
});

test("unsafe pack paths are refused", () => {
  for (const p of ["../x.dll", "a/../../x", "/x", "C:/x", "a\\b", "", "a//b"]) assert.throws(() => resolveInside("/g", p), p);
});

test("OptiScaler's first upscaler follows the GPU, and its ini loads ReShade", () => {
  assert.equal(gpuVendorFromIds([0x8086, 0x10de]), "nvidia");
  assert.equal(gpuVendorFromIds([0x8086, 0x1002]), "amd");
  assert.equal(gpuVendorFromIds([0x8086]), "intel");
  assert.equal(gpuVendorFromIds([]), "other");
  assert.equal(dx11Upscaler("nvidia"), "dlss");
  assert.equal(dx11Upscaler("amd"), "fsr31_12");
  assert.equal(dx11Upscaler("intel"), "xess_12");
  const ini = optiScalerIni(TEMPLATE, "amd");
  assert.match(ini, /^LoadReshade=true$/m);
  assert.match(ini, /^Dx11Upscaler=fsr31_12$/m);
  assert.match(ini, /^Dx12Upscaler=auto$/m);
  assert.match(ini, /^; Loads Reshade64.dll$/m);
  assert.throws(() => optiScalerIni("[x]\r\n", "amd"));
});

test("ensureUpscaler installs every file, writes the ini once, moves the old VC++ runtime aside and is idempotent", async () => {
  const win64 = tmp();
  writeFileSync(path.join(win64, "msvcp140.dll"), "old");
  writeFileSync(path.join(win64, "vcruntime140.dll"), "old");
  writeFileSync(path.join(win64, DISABLE_FLAG), "");
  const urls: string[] = [];
  const pack = fakePack();
  const r = await ensureUpscaler({ win64Dir: win64, enabled: true, vendor: "nvidia", systemVcRuntime: true, pack, fetchFile: fakeFetch(CONTENT, urls) });
  assert.equal(r.state, "ready");
  assert.equal(urls.length, 5);
  assert.ok(urls.every((u) => u.startsWith("https://github.com/FreezaMotoqueiro/Dauntless-Reforged-Revival/releases/download/upscaler-7/")));
  assert.equal(readFileSync(path.join(win64, "Luma", "Includes", "Common.hlsl"), "utf8"), "hlsl");
  assert.match(readFileSync(path.join(win64, "OptiScaler.ini"), "utf8"), /^Dx11Upscaler=dlss$/m);
  assert.ok(existsSync(path.join(win64, "ReShade.ini")));
  assert.ok(!existsSync(path.join(win64, "msvcp140.dll")) && existsSync(path.join(win64, VCRT_BACKUP_DIR, "msvcp140.dll")));
  assert.ok(!existsSync(path.join(win64, DISABLE_FLAG)));
  assert.ok(await upscalerInstalled(win64));
  const manifest = JSON.parse(readFileSync(path.join(win64, MANIFEST_NAME), "utf8"));
  assert.equal(manifest.files.length, 5);

  // The player's own OptiScaler settings stay; nothing is downloaded again.
  writeFileSync(path.join(win64, "OptiScaler.ini"), "mine");
  const again: string[] = [];
  assert.equal((await ensureUpscaler({ win64Dir: win64, enabled: true, vendor: "amd", systemVcRuntime: true, pack, fetchFile: fakeFetch(CONTENT, again) })).state, "ready");
  assert.equal(again.length, 0);
  assert.equal(readFileSync(path.join(win64, "OptiScaler.ini"), "utf8"), "mine");

  // A newer pack replaces changed files and removes files it no longer has.
  const next = { ...CONTENT, "OptiScaler.dll": "opti 2" } as Record<string, string>;
  delete next["Luma/Includes/Common.hlsl"];
  const upd: string[] = [];
  await ensureUpscaler({ win64Dir: win64, enabled: true, vendor: "amd", systemVcRuntime: true, pack: fakePack(next), fetchFile: fakeFetch(next, upd) });
  assert.equal(upd.length, 1);
  assert.equal(readFileSync(path.join(win64, "OptiScaler.dll"), "utf8"), "opti 2");
  assert.ok(!existsSync(path.join(win64, "Luma", "Includes")), "emptied folders removed");

  // Off in the settings: the flag turns it off without removing anything.
  assert.equal((await ensureUpscaler({ win64Dir: win64, enabled: false, vendor: "amd", systemVcRuntime: true, pack })).state, "disabled");
  assert.ok(existsSync(path.join(win64, DISABLE_FLAG)));
  assert.equal(await upscalerInstalled(win64), false);
});

test("ensureUpscaler never overwrites a file it did not install, keeps nothing that does not match, and needs the system VC++ runtime", async () => {
  const win64 = tmp();
  writeFileSync(path.join(win64, "OptiScaler.dll"), "someone else's");
  const r = await ensureUpscaler({ win64Dir: win64, enabled: true, vendor: "amd", systemVcRuntime: true, pack: fakePack(), fetchFile: fakeFetch() });
  assert.deepEqual(r, { state: "skipped", reason: "conflict", file: "OptiScaler.dll" });
  assert.equal(readFileSync(path.join(win64, "OptiScaler.dll"), "utf8"), "someone else's");

  const w2 = tmp();
  const bad: FetchToFile = async (_u, dest, _m, onBytes) => {
    writeFileSync(dest, "tampered");
    onBytes(8);
  };
  await assert.rejects(ensureUpscaler({ win64Dir: w2, enabled: true, vendor: "amd", systemVcRuntime: true, pack: fakePack(), fetchFile: bad }), /not the pinned one/);
  assert.ok(!existsSync(path.join(w2, "ReShade64.dll")) && !existsSync(path.join(w2, "OptiScaler.dll")));

  const w3 = tmp();
  mkdirSync(path.join(w3, "x"));
  assert.deepEqual(await ensureUpscaler({ win64Dir: w3, enabled: true, vendor: "amd", systemVcRuntime: false, pack: fakePack(), fetchFile: fakeFetch() }), { state: "skipped", reason: "vc_runtime_missing" });
});

test("an install by Install-Upscaler.ps1 (its manifest) is updated in place", async () => {
  const win64 = tmp();
  writeFileSync(path.join(win64, "ReShade64.dll"), "older reshade");
  writeFileSync(path.join(win64, "Luma-Unreal Engine.addon"), "older luma");
  writeFileSync(path.join(win64, MANIFEST_NAME), JSON.stringify({ source: "Filoppi/Luma-Framework latest-700", files: ["ReShade64.dll", "Luma-Unreal Engine.addon", "Luma\\Old.hlsl"] }));
  mkdirSync(path.join(win64, "Luma"));
  writeFileSync(path.join(win64, "Luma", "Old.hlsl"), "old");
  const r = await ensureUpscaler({ win64Dir: win64, enabled: true, vendor: "amd", systemVcRuntime: true, pack: fakePack(), fetchFile: fakeFetch() });
  assert.equal(r.state, "ready");
  assert.equal(readFileSync(path.join(win64, "ReShade64.dll"), "utf8"), "reshade");
  assert.ok(!existsSync(path.join(win64, "Luma", "Old.hlsl")));
});
