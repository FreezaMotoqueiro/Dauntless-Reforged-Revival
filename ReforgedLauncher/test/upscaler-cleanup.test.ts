// Launcher 1.5.5 removes the upscaler that 1.5.2 to 1.5.4 installed beside the game.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { insidePath, MANIFEST_NAME, removeUpscaler, VCRT_BACKUP_DIR } from "../src/main/upscaler-cleanup";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rr-upsclean-"));
  dirs.push(d);
  return d;
};

test("the installed files, their run-time files and the manifest go; the game's VC++ DLLs come back; nothing else is touched", async () => {
  const w = tmp();
  for (const f of ["ReShade64.dll", "OptiScaler.dll", "OptiScaler.ini", "nvngx_dlss.dll", "Luma-Unreal Engine.addon", "ReShade.ini", "ReShade.log", "OptiScaler.log", "DISABLE_UPSCALER.flag", "MysticParadox.dll", "winmm.dll", "Dauntless-Win64-Shipping.exe", "other.dll"]) writeFileSync(path.join(w, f), f);
  mkdirSync(path.join(w, "Luma", "Includes"), { recursive: true });
  writeFileSync(path.join(w, "Luma", "Includes", "Common.hlsl"), "x");
  writeFileSync(path.join(w, "Luma", "cache.bin"), "x");
  mkdirSync(path.join(w, "D3D12_Optiscaler"));
  writeFileSync(path.join(w, "D3D12_Optiscaler", "D3D12Core.dll"), "x");
  mkdirSync(path.join(w, VCRT_BACKUP_DIR));
  writeFileSync(path.join(w, VCRT_BACKUP_DIR, "msvcp140.dll"), "game 14.24");
  const files = ["ReShade64.dll", "OptiScaler.dll", "OptiScaler.ini", "nvngx_dlss.dll", "Luma-Unreal Engine.addon", "Luma\\Includes\\Common.hlsl", "D3D12_Optiscaler\\D3D12Core.dll", "MysticParadox.dll", "..\\outside.txt"];
  writeFileSync(path.join(w, MANIFEST_NAME), JSON.stringify({ files }));

  const r = await removeUpscaler(w);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.restored, ["msvcp140.dll"]);
  for (const f of ["ReShade64.dll", "OptiScaler.dll", "OptiScaler.ini", "nvngx_dlss.dll", "Luma-Unreal Engine.addon", "ReShade.ini", "ReShade.log", "OptiScaler.log", "DISABLE_UPSCALER.flag", "Luma", "D3D12_Optiscaler", VCRT_BACKUP_DIR, MANIFEST_NAME]) assert.ok(!existsSync(path.join(w, f)), f);
  for (const f of ["MysticParadox.dll", "winmm.dll", "Dauntless-Win64-Shipping.exe", "other.dll"]) assert.ok(existsSync(path.join(w, f)), f);
  assert.equal(readFileSync(path.join(w, "msvcp140.dll"), "utf8"), "game 14.24");

  // Run again: nothing left to do.
  assert.deepEqual(await removeUpscaler(w), { removed: [], restored: [], failed: [] });
});

test("without the manifest nothing is deleted (a ReShade installed by hand stays)", async () => {
  const w = tmp();
  writeFileSync(path.join(w, "ReShade64.dll"), "mine");
  writeFileSync(path.join(w, "ReShade.ini"), "mine");
  assert.deepEqual(await removeUpscaler(w), { removed: [], restored: [], failed: [] });
  assert.ok(existsSync(path.join(w, "ReShade64.dll")) && existsSync(path.join(w, "ReShade.ini")));
});

test("manifest paths outside the folder or naming the runtime are refused", () => {
  for (const p of ["../x.dll", "a/../../x", "/x", "C:/x", "", "a//b", "winmm.dll", "sub\\MysticParadox.dll"]) assert.equal(insidePath("/g", p), null, p);
  assert.equal(insidePath("/g", "Luma\\a.hlsl"), path.join("/g", "Luma", "a.hlsl"));
});
