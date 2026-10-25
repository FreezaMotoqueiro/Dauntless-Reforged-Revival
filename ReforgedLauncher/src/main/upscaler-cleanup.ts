// Removes the DLSS / FSR upscaler (Luma + OptiScaler) that launchers 1.5.2 to 1.5.4 and upscaler/Install-Upscaler.ps1
// installed beside the game executable. The feature was withdrawn in 1.5.5; this puts the Win64 folder back as it was.
//
// Only what the install recorded in reforged-upscaler.json is deleted, plus the few files ReShade and OptiScaler
// write next to themselves, and the game's own VC++ DLLs come back from reforged-vcrt-backup. Without that
// manifest nothing is deleted, so a ReShade someone installed by hand stays.

import { promises as fsp } from "node:fs";
import path from "node:path";

export const MANIFEST_NAME = "reforged-upscaler.json";
export const VCRT_BACKUP_DIR = "reforged-vcrt-backup";
// Written beside the files at run time or by the installer, never listed in the manifest.
const EXTRA_FILES = ["ReShade.ini", "ReShade.log", "ReShade.log1", "ReShadePreset.ini", "OptiScaler.log", "DISABLE_UPSCALER.flag", "DISABLE_OPTISCALER.flag"];
// Never deleted, whatever a manifest says: the game runtime and the game's own files.
const PROTECTED = new Set(["mysticparadox.dll", "winmm.dll", "dauntless-win64-shipping.exe", "dbghelp.dll"]);

export interface CleanupResult {
  removed: string[];
  restored: string[];
  failed: string[];
}

// A manifest path as an absolute path inside win64Dir, or null when it could point anywhere else.
export function insidePath(win64Dir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || rel === "") return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === "" || p === "." || p === ".." || /[:*?"<>|]/.test(p))) return null;
  if (PROTECTED.has(parts[parts.length - 1].toLowerCase())) return null;
  return path.join(win64Dir, ...parts);
}

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(
    () => true,
    () => false,
  );
}

export async function removeUpscaler(win64Dir: string): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], restored: [], failed: [] };
  const manifestPath = path.join(win64Dir, MANIFEST_NAME);
  let listed: string[] | null = null;
  try {
    const m = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { files?: unknown };
    listed = Array.isArray(m.files) ? m.files.filter((f): f is string => typeof f === "string") : [];
  } catch {
    listed = null;
  }

  const remove = async (rel: string) => {
    const abs = insidePath(win64Dir, rel);
    if (!abs || !(await exists(abs))) return;
    try {
      await fsp.rm(abs, { force: true });
      result.removed.push(rel);
    } catch {
      result.failed.push(rel);
    }
  };

  if (listed !== null) {
    for (const rel of listed) await remove(rel);
    for (const rel of EXTRA_FILES) await remove(rel);
    // Folders the pack created, deepest first, once empty. Luma's own folder also holds shader caches it writes.
    const dirs = new Set<string>();
    for (const rel of listed) {
      const parts = rel.split(/[\\/]/);
      for (let i = parts.length - 1; i > 0; i--) dirs.add(parts.slice(0, i).join("/"));
    }
    if ([...dirs].some((d) => d.toLowerCase() === "luma")) {
      const luma = path.join(win64Dir, "Luma");
      if (await exists(luma)) {
        await fsp.rm(luma, { recursive: true, force: true }).then(
          () => result.removed.push("Luma/"),
          () => result.failed.push("Luma/"),
        );
      }
    }
    for (const d of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
      const abs = insidePath(win64Dir, d);
      if (abs) await fsp.rmdir(abs).catch(() => undefined);
    }
  }

  // The game's VC++ 14.24 DLLs, moved aside so Luma used the system's newer runtime.
  const backup = path.join(win64Dir, VCRT_BACKUP_DIR);
  const names = await fsp.readdir(backup).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+\.dll$/.test(name)) continue;
    const dest = path.join(win64Dir, name);
    try {
      if (await exists(dest)) await fsp.rm(path.join(backup, name), { force: true });
      else {
        await fsp.rename(path.join(backup, name), dest);
        result.restored.push(name);
      }
    } catch {
      result.failed.push(`${VCRT_BACKUP_DIR}/${name}`);
    }
  }
  if (names.length) await fsp.rmdir(backup).catch(() => undefined);

  // Last, so a cleanup that could not delete a file in use runs again next time.
  if (listed !== null && result.failed.length === 0) await fsp.rm(manifestPath, { force: true }).catch(() => result.failed.push(MANIFEST_NAME));
  return result;
}
