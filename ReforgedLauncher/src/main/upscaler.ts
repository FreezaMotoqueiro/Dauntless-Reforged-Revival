// The DLSS / FSR / XeSS upscaler for the Dauntless 1.14.7 client, installed by the launcher itself before each
// launch (docs/upscaling.md):
//
//  - Luma's Unreal Engine mod replaces the game's TAA pass with DLSS (it is a ReShade add-on; ReShade is
//    installed as ReShade64.dll, which nothing loads on its own).
//  - OptiScaler takes Luma's DLSS calls and runs FSR 4 / FSR 3.1 or XeSS through a background D3D12 device,
//    or DLSS on NVIDIA. The runtime (patch 0043) loads OptiScaler.dll on the client only, and OptiScaler
//    loads ReShade64.dll (LoadReshade=true in OptiScaler.ini).
//
// The files and their SHA-256 come from upscaler-pack.json, compiled in (upscaler/pack.mjs writes it). Each file is downloaded from this
// repository's release "upscaler-<id>", where its asset name is its SHA-256, and only kept when its hash
// matches. reforged-upscaler.json beside the game lists what is installed, in the format of
// upscaler/Install-Upscaler.ps1, so either can update or remove the other's install.

import { createHash } from "node:crypto";
import { createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pack from "./upscaler-pack.json";
import { PROJECT_URL } from "./constants";
import { hashFile } from "./verify";

export interface UpscalerFile {
  path: string; // relative to the game's Win64 folder, with "/"
  source: string;
  entry: string;
  sha256: string;
  size: number;
  template?: boolean; // OptiScaler.ini: written once with the launcher's settings, then left to the player
}

export interface UpscalerPack {
  id: string;
  sources: { name: string; version: string; url: string; sha256: string }[];
  files: UpscalerFile[];
}

export const UPSCALER_PACK: UpscalerPack = pack as UpscalerPack;

export const MANIFEST_NAME = "reforged-upscaler.json";
export const DISABLE_FLAG = "DISABLE_UPSCALER.flag";
export const VCRT_BACKUP_DIR = "reforged-vcrt-backup";
// The game ships the VC++ 14.24 runtime beside its executable. Luma needs a current one (it crashed loading a
// map with the old msvcp140), so these are moved aside and the game uses the system's (VC++ 2015-2022, which
// the launcher already requires). All of them together: a newer msvcp140 must never pick up the old vcruntime140.
export const VCRT_FILES = ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "msvcp140_codecvt_ids.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll", "vccorlib140.dll"];

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

// PCI vendor ids of the GPUs in this PC: NVIDIA when there is one (it runs DLSS), then AMD, then Intel.
export function gpuVendorFromIds(ids: readonly number[]): GpuVendor {
  if (ids.includes(0x10de)) return "nvidia";
  if (ids.includes(0x1002)) return "amd";
  if (ids.includes(0x8086)) return "intel";
  return "other";
}

// OptiScaler's DirectX 11 output for this GPU, which the player can change in its overlay (Insert):
// DLSS on NVIDIA; FSR 3.1/4 over D3D12 elsewhere (FidelityFX SDK 2 picks FSR 4 on Radeon RX 7000/9000
// and FSR 3.1 on other GPUs); XeSS over D3D12 on Intel (any Intel GPU, not only Arc).
export function dx11Upscaler(vendor: GpuVendor): string {
  return vendor === "nvidia" ? "dlss" : vendor === "intel" ? "xess_12" : "fsr31_12";
}

// OptiScaler.ini from the release's template: OptiScaler loads ReShade64.dll (and with it Luma) itself, and
// starts on the upscaler for this GPU. Every other setting keeps the template's value.
export function optiScalerIni(template: string, vendor: GpuVendor): string {
  const set: Record<string, string> = { LoadReshade: "true", Dx11Upscaler: dx11Upscaler(vendor) };
  const seen = new Set<string>();
  const lines = template.split(/\r?\n/).map((l) => {
    const m = /^([A-Za-z0-9_]+)=/.exec(l);
    if (m && m[1] in set && !seen.has(m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${set[m[1]]}`;
    }
    return l;
  });
  for (const k of Object.keys(set)) if (!seen.has(k)) throw new Error(`OptiScaler.ini template has no ${k}=`);
  return lines.join("\r\n");
}

// Luma's Unreal Engine mod starts with its HDR on ([Luma] EnableHDR in ReShade.ini), which turns the swapchain into
// scRGB. On an SDR display that gains nothing and OptiScaler's overlay (drawn for SDR) comes out washed out. The
// launcher sets it once, to match Windows HDR, only while the player has not chosen (no EnableHDR key yet).
export function lumaHdrDefault(ini: string, hdrDisplay: boolean): string {
  const lines = ini.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let section = "";
  let lumaAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*\[([^\]]*)\]/.exec(lines[i]);
    if (h) {
      section = h[1].trim().toLowerCase();
      if (section === "luma") lumaAt = i;
      continue;
    }
    if (section === "luma" && /^\s*EnableHDR\s*=/i.test(lines[i])) return ini;
  }
  const line = `EnableHDR=${hdrDisplay ? 1 : 0}`;
  if (lumaAt >= 0) lines.splice(lumaAt + 1, 0, line);
  else lines.push("", "[Luma]", line);
  return lines.join("\r\n") + "\r\n";
}

export function assetUrl(f: UpscalerFile, p: UpscalerPack = UPSCALER_PACK, project = PROJECT_URL): string {
  return `${project}/releases/download/upscaler-${p.id}/${f.sha256}`;
}

// A relative pack path inside the Win64 folder, or an error: never absolute, never "..".
export function resolveInside(win64Dir: string, rel: string): string {
  const parts = rel.split("/");
  if (rel === "" || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || parts.some((p) => p === "" || p === "." || p === ".." || /[\\:*?"<>|]/.test(p))) {
    throw new Error(`unsafe upscaler path ${rel}`);
  }
  return path.join(win64Dir, ...parts);
}

export type FetchToFile = (url: string, dest: string, maxBytes: number, onBytes: (n: number) => void, signal?: AbortSignal) => Promise<void>;

// GitHub release downloads redirect to release-assets.githubusercontent.com; nothing else is accepted.
const ALLOWED_HOSTS = /^(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)$/;

export const httpsToFile: FetchToFile = async (url, dest, maxBytes, onBytes, signal) => {
  let current = url;
  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.test(u.hostname)) throw new Error(`download host not allowed: ${u.hostname}`);
    res = await fetch(current, { redirect: "manual", signal: signal ?? AbortSignal.timeout(15 * 60 * 1000), headers: { "user-agent": "DauntlessReforgedRevivalLauncher" } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, current).href;
      continue;
    }
    break;
  }
  if (!res || res.status !== 200 || !res.body) throw new Error(`HTTP ${res?.status ?? "?"}`);
  let n = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) return cb(new Error("larger than expected"));
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, createWriteStream(dest));
};

async function hashOrNull(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

// Clears the "downloaded from the internet" mark (the Zone.Identifier stream), like Unblock-File.
async function unblock(file: string): Promise<void> {
  await fsp.unlink(`${file}:Zone.Identifier`).catch(() => undefined);
}

export async function readManifest(win64Dir: string): Promise<string[]> {
  try {
    const m = JSON.parse(await fsp.readFile(path.join(win64Dir, MANIFEST_NAME), "utf8")) as { files?: unknown };
    return Array.isArray(m.files) ? m.files.filter((f): f is string => typeof f === "string").map((f) => f.replace(/\\/g, "/")) : [];
  } catch {
    return [];
  }
}

export interface UpscalerProgress {
  totalBytes: number;
  doneBytes: number;
  filesTotal: number;
  filesDone: number;
  currentFile: string | null;
}

export interface EnsureUpscalerOptions {
  win64Dir: string;
  enabled: boolean;
  vendor: GpuVendor;
  // false when the system has no VC++ 2015-2022 runtime: the game's own old copy then stays, and Luma with it
  // would crash, so nothing is installed.
  systemVcRuntime: boolean;
  // Windows HDR is on for the display: Luma's HDR is then left on, otherwise it starts off (see lumaHdrDefault).
  hdrDisplay?: boolean;
  fetchFile?: FetchToFile;
  pack?: UpscalerPack;
  signal?: AbortSignal;
  onProgress?: (p: UpscalerProgress) => void;
  onStart?: (p: UpscalerProgress) => void; // called once before the first download, only if there is one
}

export type EnsureUpscalerResult =
  | { state: "ready"; downloaded: number; vcrtMoved: string[] }
  | { state: "disabled" }
  | { state: "skipped"; reason: "vc_runtime_missing" | "conflict"; file?: string };

// Makes the Win64 folder hold exactly the pinned upscaler files (or turns the upscaler off), before a launch.
export async function ensureUpscaler(o: EnsureUpscalerOptions): Promise<EnsureUpscalerResult> {
  const p = o.pack ?? UPSCALER_PACK;
  const fetchFile = o.fetchFile ?? httpsToFile;
  const flag = path.join(o.win64Dir, DISABLE_FLAG);
  if (!o.enabled) {
    if (await exists(path.join(o.win64Dir, "ReShade64.dll"))) await fsp.writeFile(flag, "Turned off in the launcher (Settings > Graphics).\r\n");
    return { state: "disabled" };
  }
  if (!o.systemVcRuntime) return { state: "skipped", reason: "vc_runtime_missing" };

  const previous = await readManifest(o.win64Dir);
  const prevSet = new Set(previous.map((f) => f.toLowerCase()));
  const needed: UpscalerFile[] = [];
  let template: UpscalerFile | null = null;
  for (const f of p.files) {
    const target = resolveInside(o.win64Dir, f.path);
    if (f.template) {
      if (!(await exists(target))) template = f;
      continue;
    }
    const h = await hashOrNull(target);
    if (h === f.sha256) continue;
    // A file this launcher (or the install script) did not put there is never overwritten.
    if (h !== null && !prevSet.has(f.path.toLowerCase())) return { state: "skipped", reason: "conflict", file: f.path };
    needed.push(f);
  }
  const downloads = template ? [...needed, template] : needed;
  const progress: UpscalerProgress = { totalBytes: downloads.reduce((s, f) => s + f.size, 0), doneBytes: 0, filesTotal: downloads.length, filesDone: 0, currentFile: null };
  if (downloads.length) o.onStart?.({ ...progress });

  for (const f of downloads) {
    if (o.signal?.aborted) throw new Error("cancelled");
    const target = resolveInside(o.win64Dir, f.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.rr-tmp`;
    progress.currentFile = f.path;
    o.onProgress?.({ ...progress });
    const before = progress.doneBytes;
    try {
      await fetchFile(assetUrl(f, p), tmp, f.size, (n) => {
        progress.doneBytes += n;
        o.onProgress?.({ ...progress });
      }, o.signal);
      const h = await hashOrNull(tmp);
      if (h !== f.sha256) throw new Error(`${f.path}: the downloaded file is not the pinned one`);
      if (f.template) {
        const vendor = o.vendor;
        await fsp.writeFile(target, optiScalerIni(await fsp.readFile(tmp, "latin1"), vendor), "latin1");
        await fsp.unlink(tmp).catch(() => undefined);
      } else {
        await fsp.rm(target, { force: true });
        await fsp.rename(tmp, target);
        await unblock(target);
      }
    } catch (e) {
      await fsp.unlink(tmp).catch(() => undefined);
      progress.doneBytes = before;
      throw e;
    }
    progress.filesDone++;
    progress.doneBytes = before + f.size;
    o.onProgress?.({ ...progress });
  }

  // ReShade loaded under a non-proxy name only starts when ReShade.ini exists (OptiScaler skips that check,
  // the runtime's fallback without OptiScaler does not).
  const reshadeIni = path.join(o.win64Dir, "ReShade.ini");
  const iniText = (await exists(reshadeIni)) ? await fsp.readFile(reshadeIni, "latin1") : "[INSTALL]\r\nLogging=1\r\n";
  const withHdr = lumaHdrDefault(iniText, o.hdrDisplay === true);
  if (withHdr !== iniText || !(await exists(reshadeIni))) await fsp.writeFile(reshadeIni, withHdr, "latin1");

  const vcrtMoved: string[] = [];
  for (const name of VCRT_FILES) {
    const f = path.join(o.win64Dir, name);
    if (!(await exists(f))) continue;
    const backup = path.join(o.win64Dir, VCRT_BACKUP_DIR);
    await fsp.mkdir(backup, { recursive: true });
    await fsp.rm(path.join(backup, name), { force: true });
    await fsp.rename(f, path.join(backup, name));
    vcrtMoved.push(name);
  }

  // Files of an earlier pack (or of the install script's package) that this pack no longer has.
  const current = new Set(p.files.map((f) => f.path.toLowerCase()));
  for (const old of previous) {
    if (current.has(old.toLowerCase())) continue;
    let target: string;
    try {
      target = resolveInside(o.win64Dir, old);
    } catch {
      continue;
    }
    await fsp.rm(target, { force: true });
    let d = path.dirname(target);
    while (d.length > o.win64Dir.length && d.startsWith(o.win64Dir)) {
      const left = await fsp.readdir(d).catch(() => null);
      if (!left || left.length) break;
      await fsp.rmdir(d).catch(() => undefined);
      d = path.dirname(d);
    }
  }

  const sources = p.sources.map((s) => s.version).join("; ");
  if (needed.length || template || previous.length !== p.files.length || !(await exists(path.join(o.win64Dir, MANIFEST_NAME)))) {
    const manifest = { source: `launcher, upscaler pack ${p.id}: ${sources}`, installed: new Date().toISOString().slice(0, 19), files: p.files.map((f) => f.path.split("/").join("\\")) };
    await fsp.writeFile(path.join(o.win64Dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  }
  await fsp.rm(flag, { force: true });
  return { state: "ready", downloaded: downloads.length, vcrtMoved };
}
