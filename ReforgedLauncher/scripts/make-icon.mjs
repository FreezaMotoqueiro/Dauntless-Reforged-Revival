// Copies the icons and the emblem from ../brand (made by brand/build.mjs) into the launcher:
// assets/icon.ico (the exe and installer), assets/icon.png (the window) and the emblem the page uses.
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.resolve(root, "..", "brand");
copyFileSync(path.join(brand, "launcher", "icon.ico"), path.join(root, "assets", "icon.ico"));
copyFileSync(path.join(brand, "launcher", "icon.png"), path.join(root, "assets", "icon.png"));
copyFileSync(path.join(brand, "emblem.svg"), path.join(root, "src", "renderer", "brand", "emblem.svg"));
console.log("icons and emblem copied from brand/");
