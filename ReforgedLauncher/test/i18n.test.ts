// Both languages have the same keys and the same {placeholders}, and every key the page builds
// from a code (an error, a notice, a step state...) exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isStringKey, STRINGS, systemLanguage, translate, type StringKey } from "../src/shared/i18n";
import { LANGUAGES } from "../src/shared/types";

const ROOT = path.resolve(__dirname, "..", "..");

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test("every language has exactly the English keys, with the same placeholders, and no empty text", () => {
  const en = STRINGS.en;
  for (const lang of LANGUAGES) {
    const table = STRINGS[lang];
    assert.deepEqual(Object.keys(table).sort(), Object.keys(en).sort(), lang);
    for (const k of Object.keys(en) as StringKey[]) {
      assert.ok(table[k].trim().length > 0, `${lang}.${k} is empty`);
      assert.deepEqual(placeholders(table[k]), placeholders(en[k]), `${lang}.${k} placeholders`);
    }
  }
});

test("the Portuguese table is really translated", () => {
  const same = (Object.keys(STRINGS.en) as StringKey[]).filter((k) => STRINGS.en[k] === STRINGS["pt-BR"][k]);
  // Names (Ramsgate, Legendary, Dauntless 1.14.7...) may stay the same; prose may not.
  for (const k of same) assert.ok(STRINGS.en[k].split(" ").length <= 4, `pt-BR.${k} is still English: ${STRINGS.en[k]}`);
});

test("translate fills placeholders; systemLanguage maps any Portuguese locale to pt-BR", () => {
  assert.equal(translate("en", "ready_title", { user: "Ana" }), "Welcome back, Ana");
  assert.equal(translate("pt-BR", "ready_title", { user: "Ana" }), "Bem-vindo de volta, Ana");
  assert.equal(systemLanguage("pt-BR"), "pt-BR");
  assert.equal(systemLanguage("pt-PT"), "pt-BR");
  assert.equal(systemLanguage("pt"), "pt-BR");
  assert.equal(systemLanguage("en-US"), "en");
  assert.equal(systemLanguage("fi"), "en");
  assert.equal(isStringKey("btn_play"), true);
  assert.equal(isStringKey("__proto__"), false);
});

// The prefixes the page and the main process build keys from, with every value the code can produce.
const FAMILIES: Record<string, readonly string[]> = {
  err_: ["account_banned", "invite_invalid_format", "invite_invalid", "username_invalid", "username_taken", "registration_closed", "bad_request", "server_unreachable", "server_error", "key_invalid", "key_rejected", "key_storage_unavailable", "folder_invalid", "game_folder_not_found", "game_wrong_version", "runtime_unavailable", "runtime_untrusted", "runtime_failed", "runtime_different_on_server", "local_runtime_invalid", "download_failed", "disk_space", "already_running", "launch_failed", "config_failed", "busy", "cancelled", "cert_mismatch", "cert_changed", "rate_limited", "relay_port_busy", "relay_failed", "host_failed", "unknown"],
  invite_err_: ["empty", "too_long", "not_invite", "version", "params", "mode", "host", "port", "fp", "code", "name", "share"],
  reg_check_: ["empty", "too_short", "too_long", "bad_chars", "ok"],
  notice_: ["keep_open", "backup_saved", "runtime_installed", "game_verified", "sdk_imported", "host_done"],
  where_: ["menu", "city", "hunt", "dojo", "tutorial", "unknown"],
  kind_: ["city", "hunt", "dojo", "tutorial"],
  gfx_: ["menu", "0", "1", "2", "3", "4"],
  profile_: ["production", "development"],
  game_source_: ["epic", "legendary", "heroic", "chosen"],
  reg_mode_: ["OPEN", "INVITECODE", "NONE"],
  gamedata_kind_: ["real", "synthetic", "missing", "unknown"],
  runtime_state_: ["ok", "missing", "outdated", "untrusted", "unavailable", "local"],
  host_job_: ["inject", "build_runtime", "build_loader", "build_exporter", "import_sdk", "copy_exports", "synthetic_data", "publish_runtime"],
  host_job_state_: ["running", "done", "failed"],
  host_err_: ["workspace", "dumper", "folder", "no_dump", "msbuild", "cargo", "no_exports", "windows_only", "game_not_running", "exporter", "no_process"],
  set_tab_: ["game", "graphics", "account", "launcher"],
  credits_role_: ["maintainer", "creator", "contributor"],
  step_: ["join", "register", "game", "runtime", "play"],
};

test("every key built from a code exists", () => {
  for (const [prefix, values] of Object.entries(FAMILIES)) {
    for (const v of values) assert.ok(isStringKey(prefix + v), `missing key ${prefix}${v}`);
  }
});

test("every literal key in the page, the main process and index.html exists", () => {
  const files = ["src/renderer/index.ts", "src/main.ts", "src/shared/ui-model.ts", "index.html"].map((f) => path.join(ROOT, f));
  const missing: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const keys = [
      ...[...text.matchAll(/\b(?:t|translate\([^,]+,)\s*\(?\s*"([a-z][a-z0-9_]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/data-i18n(?:-aria)?="([a-z0-9_]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/(?:labelKey|titleKey|key): "([a-z][a-z0-9_]+)"/g)].map((m) => m[1]),
    ];
    for (const k of keys) if (!isStringKey(k)) missing.push(`${path.basename(file)}: ${k}`);
  }
  assert.deepEqual(missing, []);
});
