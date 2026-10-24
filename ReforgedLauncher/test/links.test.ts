// The page names links and actions; the main process maps them. Nothing else gets through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXED_LINKS, fixedLinkUrl, isAllowedExternalUrl, isAllowedStaticUrl } from "../src/main/links";
import { externalTarget, hostAction, hostFolder, isTrustedPageUrl, relayPortOverride, settingsPatch } from "../src/main/ipc-validate";

test("every fixed link is plain https", () => {
  for (const [name, url] of Object.entries(FIXED_LINKS)) {
    const u = new URL(url);
    assert.equal(u.protocol, "https:", name);
    assert.equal(u.username + u.password, "", name);
    assert.equal(fixedLinkUrl(name), url);
    assert.equal(isAllowedStaticUrl(url), true);
  }
  assert.equal(fixedLinkUrl("__proto__"), null);
  assert.equal(fixedLinkUrl("https://example.com"), null);
  assert.equal(fixedLinkUrl("tailscale_share"), null, "comes from the invite, not a fixed URL");
});

test("external URLs: fixed ones, Tailscale share links and the host's own https source link only", () => {
  assert.equal(isAllowedStaticUrl("https://login.tailscale.com/admin/invite/abc"), true);
  assert.equal(isAllowedStaticUrl("http://login.tailscale.com/admin/invite/abc"), false);
  assert.equal(isAllowedStaticUrl("https://evil.example/"), false);
  assert.equal(isAllowedExternalUrl("https://git.example/me/server", "https://git.example/me/server"), true);
  assert.equal(isAllowedExternalUrl("https://git.example/me/other", "https://git.example/me/server"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)", "javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("https://user:pw@git.example/", "https://user:pw@git.example/"), false);
});

test("IPC values are checked by exact name", () => {
  assert.equal(externalTarget("project_docs_sdk"), "project_docs_sdk");
  assert.equal(externalTarget("https://x"), null);
  assert.equal(hostAction("publish_runtime"), "publish_runtime");
  assert.equal(hostAction("rm -rf"), null);
  assert.equal(hostFolder("dumps"), "dumps");
  assert.equal(hostFolder("C:\\Windows"), null);
  assert.deepEqual(settingsPatch({ language: "pt-BR", hostTools: true, runtimeProfile: "development" }), { language: "pt-BR", hostTools: true, runtimeProfile: "development" });
  assert.equal(settingsPatch({ language: "fi" }), null);
  assert.equal(settingsPatch({ gameRoot: "C:\\" }), null, "folders are never set from the page");
  assert.equal(settingsPatch(null), null);
  assert.equal(relayPortOverride("61200"), 61200);
  assert.equal(relayPortOverride("80"), undefined);
  assert.equal(relayPortOverride("abc"), undefined);
  assert.equal(isTrustedPageUrl("file:///app/index.html#x", undefined, "file:///app/index.html"), true);
  assert.equal(isTrustedPageUrl("https://evil.example/", undefined, "file:///app/index.html"), false);
  assert.equal(isTrustedPageUrl("http://localhost:5173/src", "http://localhost:5173", "file:///x"), true);
});

// The preload passes a settings patch on key by key; a setting it leaves out silently never reaches the main
// process (launcher 1.5.3 shipped the DLSS / FSR mode menu that way).
test("the preload forwards every setting the main process accepts", () => {
  const preload = readFileSync(path.join(__dirname, "..", "..", "src", "preload.ts"), "utf8");
  const validate = readFileSync(path.join(__dirname, "..", "..", "src", "main", "ipc-validate.ts"), "utf8");
  const body = validate.slice(validate.indexOf("export function settingsPatch"));
  const keys = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/k === "([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.includes("upscalerMode") && keys.includes("graphics"));
  for (const k of keys) assert.ok(preload.includes(`patch.${k} !== undefined`), `preload.ts drops ${k}`);
  assert.deepEqual(settingsPatch({ upscalerMode: 0, upscaler: false }), { upscalerMode: 0, upscaler: false });
});
