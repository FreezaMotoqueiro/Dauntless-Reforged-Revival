#!/usr/bin/env node
// Builds the upscaler pack the launcher installs (see docs/upscaling.md).
//
// ReforgedLauncher/src/main/upscaler-pack.json (compiled into the launcher) pins two upstream archives by SHA-256 (Luma's Unreal Engine mod and OptiScaler) and, for every
// file the launcher puts beside the game executable, the archive entry it comes from with its own SHA-256
// and size. The launcher downloads each file from the GitHub release "upscaler-<id>" of this repository,
// where it is stored under its SHA-256 as the asset name, and keeps a file only when its hash is the pinned one.
//
//   node upscaler/pack.mjs build <outDir>    downloads the archives, checks them and every listed file, and
//                                            writes each file to <outDir>/<sha256> (the release assets)
//   node upscaler/pack.mjs write <luma.zip> <optiscaler.7z>
//                                            rewrites the file list of upscaler-pack.json from local archives whose
//                                            hashes match the pinned ones (after changing a source)
//
// Needs unzip and 7z (p7zip) on PATH. Archive entries are only read by name, never extracted by path.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packFile = path.join(here, "..", "ReforgedLauncher", "src", "main", "upscaler-pack.json");
const pack = JSON.parse(readFileSync(packFile, "utf8"));

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

// The OptiScaler files a DirectX 11 game needs: the upscaler outputs (FSR 3.1/4 through FidelityFX SDK 2,
// XeSS), the Agility SDK copy OptiScaler uses for FSR 4 on Windows 10, its settings and the licenses.
// Frame generation (DirectX 12 only), Vulkan and fakenvapi (Luma needs no GPU spoofing) are left out.
const OPTISCALER_KEEP = [
  "OptiScaler.dll",
  "OptiScaler.ini",
  "amd_fidelityfx_dx12.dll",
  "amd_fidelityfx_upscaler_dx12.dll",
  "libxess.dll",
  "libxess_dx11.dll",
  "D3D12_Optiscaler/D3D12Core.dll",
];

function extract(source, archive) {
  const dir = mkdtempSync(path.join(tmpdir(), `rr-pack-${source.name}-`));
  if (source.format === "zip") execFileSync("unzip", ["-q", "-o", archive, "-d", dir], { stdio: "inherit" });
  else if (source.format === "7z") execFileSync("7z", ["x", "-y", `-o${dir}`, archive], { stdio: "ignore" });
  else fail(`unknown archive format ${source.format}`);
  return dir;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function checkSource(source, archive) {
  const h = sha256(archive);
  if (h !== source.sha256) fail(`${source.name}: ${archive} has SHA-256 ${h}, upscaler-pack.json pins ${source.sha256}`);
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "user-agent": "DauntlessReforgedRevival-pack" } });
  if (!res.ok) fail(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "write") {
  const [lumaZip, optiArchive] = args;
  if (!lumaZip || !optiArchive) fail("usage: pack.mjs write <luma.zip> <optiscaler.7z>");
  const archives = { luma: lumaZip, optiscaler: optiArchive };
  const files = [];
  for (const source of pack.sources) {
    checkSource(source, archives[source.name]);
    const dir = extract(source, archives[source.name]);
    const entries = walk(dir).sort();
    const keep = source.name === "luma" ? entries : entries.filter((e) => OPTISCALER_KEEP.includes(e) || e.startsWith("Licenses/"));
    for (const entry of keep) {
      const full = path.join(dir, ...entry.split("/"));
      // ReShade ships as the dxgi.dll proxy; installed as ReShade64.dll it never loads on its own (runtime patch 0041/0043).
      let target = entry === "dxgi.dll" ? "ReShade64.dll" : entry;
      if (source.name === "optiscaler" && entry.startsWith("Licenses/")) target = `Licenses/OptiScaler/${entry.slice("Licenses/".length)}`;
      const f = { path: target, source: source.name, entry, sha256: sha256(full), size: statSync(full).size };
      // OptiScaler.ini is a template: the launcher writes it once with its own settings, then leaves it to the player.
      if (target === "OptiScaler.ini") f.template = true;
      files.push(f);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  pack.files = files;
  writeFileSync(packFile, JSON.stringify(pack, null, 2) + "\n");
  console.log(`upscaler-pack.json: ${files.length} files, ${files.reduce((s, f) => s + f.size, 0)} bytes`);
} else if (cmd === "build") {
  const [outDir] = args;
  if (!outDir) fail("usage: pack.mjs build <outDir>");
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "rr-pack-"));
  const dirs = {};
  for (const source of pack.sources) {
    const archive = path.join(work, `${source.name}.${source.format}`);
    console.log(`downloading ${source.url}`);
    await download(source.url, archive);
    checkSource(source, archive);
    dirs[source.name] = extract(source, archive);
  }
  for (const f of pack.files) {
    const full = path.join(dirs[f.source], ...f.entry.split("/"));
    if (!existsSync(full)) fail(`${f.source} has no ${f.entry}`);
    const h = sha256(full);
    if (h !== f.sha256 || statSync(full).size !== f.size) fail(`${f.source}/${f.entry} is not the pinned file`);
    copyFileSync(full, path.join(outDir, f.sha256));
  }
  writeFileSync(path.join(outDir, "SHA256SUMS.txt"), [...new Set(pack.files.map((f) => f.sha256))].map((h) => `${h}  ${h}`).join("\n") + "\n");
  console.log(`${pack.files.length} files checked, ${readdirSync(outDir).length - 1} assets in ${outDir}`);
} else {
  fail("usage: pack.mjs build <outDir> | write <luma.zip> <optiscaler.7z>");
}
