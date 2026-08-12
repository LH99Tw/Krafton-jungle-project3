import assert from "node:assert/strict";
import test from "node:test";
import { resolveServerRuntimeOptions } from "../src/game/domain/runtimeOptions";

const options = {
  heroClass: "archer",
  sessionMode: "prototype",
  difficulty: "normal",
  partyMode: "coop",
} as const;

test("uses the authoritative network scene after connecting to the game server", () => {
  assert.deepEqual(resolveServerRuntimeOptions(options), {
    ...options,
    runtimeMode: "server",
  });
});
