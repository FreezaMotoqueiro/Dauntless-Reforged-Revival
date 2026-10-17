// Renders the logo master (logo.png, square, transparent) into the launcher's icons: icon.png (256 px,
// the window icon), icon.ico (16-256 px, the executable and installer), the larger PNGs for listings,
// and the two sizes the launcher's page shows (logo-384.png in the rail, logo-64.png in the title bar).
//
//   npm i --no-save playwright-core   (once, anywhere on the module path)
//   node brand/build.mjs [path to a Chromium executable]
//
// Replace logo.png, never the generated files.
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "launcher");
const logo = `data:image/png;base64,${(await fsp.readFile(path.join(here, "logo.png"))).toString("base64")}`;
const executablePath = process.argv[2] || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function render(size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${logo}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
  await page.waitForFunction(() => document.images[0]?.complete);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

// An ICO with PNG-compressed images (Windows Vista and later read these).
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

await fsp.mkdir(out, { recursive: true });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of sizes) images.push({ size, data: await render(size) });
await fsp.writeFile(path.join(out, "icon.ico"), ico(images));
await fsp.writeFile(path.join(out, "icon.png"), images[images.length - 1].data);
for (const size of [512, 1024]) await fsp.writeFile(path.join(out, `icon-${size}.png`), await render(size));
for (const size of [64, 384]) await fsp.writeFile(path.join(out, `logo-${size}.png`), await render(size));
await browser.close();
console.log(`wrote ${path.relative(process.cwd(), out)}: icon.ico, icon.png, icon-512.png, icon-1024.png, logo-64.png, logo-384.png`);
