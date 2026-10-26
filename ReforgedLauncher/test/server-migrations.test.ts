import test from "node:test";
import assert from "node:assert/strict";
import { migratedPublicServer, REFORGED_VPS_CERTIFICATE } from "../src/main/server-migrations";

const original = { game: "reforged", mode: "public", host: "187.127.54.193", port: 4443, fp: REFORGED_VPS_CERTIFICATE, code: "EXISTING", name: "ReforgedRevival" };
test("the known VPS move retains the original identity and invite", () => {
  assert.deepEqual(migratedPublicServer(original), { ...original, host: "179.199.154.171" });
  assert.equal(original.host, "187.127.54.193");
  const moved = migratedPublicServer(original);
  assert.equal(migratedPublicServer(moved), moved);
});
test("the VPS move never redirects another certificate, game, mode, host or port", () => {
  for (const changes of [{ fp: null }, { fp: "f".repeat(64) }, { game: "revived" }, { mode: "private" }, { host: "other.example" }, { port: 8443 }]) {
    const server = { ...original, ...changes };
    assert.equal(migratedPublicServer(server), server);
  }
});
